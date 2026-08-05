const fs = require('fs');
const path = require('path');
const express = require('express');

const { loadConfig } = require('./config');
const {
  enqueue, getJob, listJobs, listExecutionOrder, listLaneTypes, listQueuedIds, reorderQueue,
  cancelJob, pauseJob, requeueJob, initJobStore,
} = require('./jobQueue');
const { runPowerShellScript } = require('./runner');
const { extractThumbnail } = require('./thumbnails');
const { getCaptureDates } = require('./captureDates');
const { makeStateStore } = require('./state');
const { listDrives, getFreeSpaceBytes } = require('./drives');
const {
  isSafeRelPath, resolvePhotoPath: resolvePhotoPathPure, cacheKeyFor, sanitizeProjectName, projectFolderName,
} = require('./pathSafety');
const { finalizeProgressItems } = require('./runProgress');
const { checkStartupConfig } = require('./startupChecks');
const { checkDiskSpaceWarning } = require('./diskSpace');
const { computeJobTiming } = require('./jobTiming');
const { addToHistory } = require('./folderHistory');
const { computeEtas } = require('./jobEta');

const cfg = loadConfig();
const app = express();
app.use(express.json());

// Express 4 doesn't catch rejected promises from `async (req, res) => {...}` handlers - an
// error thrown deep in one (e.g. the ENAMETOOLONG crash a 4500+ file library triggered) becomes
// an unhandled rejection that takes the *entire* server down, not just that one request.
function asyncHandler(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[server] Error handling ${req.method} ${req.path}:`, err);
      if (!res.headersSent) res.status(500).json({ error: err.message || 'internal server error' });
    });
  };
}

// Last-resort net: log and keep serving rather than let one bad request kill every other
// in-flight request and job. This is a local single-user tool, not a multi-tenant service,
// so "stay up" beats "crash safely" here.
process.on('unhandledRejection', (err) => {
  console.error('[server] Unhandled promise rejection (server staying up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception (server staying up):', err);
});

// A clean Ctrl+C/window-close just logs and exits - it does not try to gracefully drain an
// in-flight job. That's deliberate, not an oversight: initJobStore()'s restart recovery (below)
// already marks anything left 'running'/'queued' as 'interrupted' on the next startup, so a
// clean shutdown and an unclean crash converge on the same, single recovery path instead of
// this app maintaining two different ways of handling "a job didn't finish."
function shutdown(signal) {
  console.log(`[server] Received ${signal}, shutting down. Any in-flight job will show as `
    + "'interrupted' the next time this server starts, and can be re-queued from the UI.");
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

fs.mkdirSync(cfg.thumbCacheDir, { recursive: true });
fs.mkdirSync(cfg.previewCacheDir, { recursive: true });
fs.mkdirSync(cfg.projectsDir, { recursive: true });

// Recovers job history (and marks anything left running/queued from a previous process as
// 'interrupted') before any request can enqueue new work.
initJobStore(cfg.jobsStoreFile);

// Surfaces a broken rtPath/missing scripts folder/etc. loudly and immediately, rather than as a
// cryptic failure the first time a preview or run is attempted. Deliberately does not refuse to
// start - see checkStartupConfig's own comment for why.
const startupCheck = checkStartupConfig(cfg);
if (startupCheck.errors.length > 0) {
  console.error('[server] Configuration problems found at startup:');
  startupCheck.errors.forEach((e) => console.error(`[server]   ERROR: ${e}`));
}
if (startupCheck.warnings.length > 0) {
  console.warn('[server] Configuration warnings:');
  startupCheck.warnings.forEach((w) => console.warn(`[server]   WARNING: ${w}`));
}

// The active source folder can be changed from the UI at runtime (see /api/source-folder
// below); it starts from config.json's photosDir, or wherever the user last pointed it.
const stateStore = makeStateStore(path.join(cfg.repoRoot, '.webapp_cache'));
const savedPhotosDir = stateStore.read().photosDir;
let activePhotosDir = (savedPhotosDir && fs.existsSync(savedPhotosDir)) ? savedPhotosDir : cfg.photosDir;

app.use('/webapp-cache/thumbnails', express.static(cfg.thumbCacheDir));
app.use('/webapp-cache/previews', express.static(cfg.previewCacheDir));

// isSafeRelPath/resolvePhotoPath/cacheKeyFor live in ./pathSafety (pure, unit-tested there).
// This wrapper just closes over the mutable activePhotosDir.
function resolvePhotoPath(relPath) {
  return resolvePhotoPathPure(activePhotosDir, relPath);
}

function walkArwFiles(dir, baseDir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'failed' || entry.name === '_logs') continue;
      results.push(...walkArwFiles(full, baseDir));
    } else if (entry.isFile() && /\.arw$/i.test(entry.name)) {
      const relDir = path.relative(baseDir, dir).split(path.sep).join('/');
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      results.push({ relPath, name: entry.name, dir: relDir });
    }
  }
  return results;
}

// Times its two real stages (filesystem walk/stat vs. the batched exiftool metadata read)
// separately - see docs/gpu_spike_findings.md. This is the other candidate bottleneck besides
// the RawTherapee render itself: on a library of thousands of files, EXIF reads are not free.
async function listPhotos() {
  const walkStart = Date.now();
  const found = cfg.scanSubfolders
    ? walkArwFiles(activePhotosDir, activePhotosDir)
    : fs.readdirSync(activePhotosDir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.arw$/i.test(d.name))
      .map((d) => ({ relPath: d.name, name: d.name, dir: '' }));

  const entries = found.map((f) => {
    const stat = fs.statSync(path.join(activePhotosDir, f.relPath));
    return { ...f, size: stat.size, mtime: stat.mtimeMs };
  });
  const walkMs = Date.now() - walkStart;

  const captureDatesStart = Date.now();
  let dateMap = {};
  if (cfg.exiftoolPath && fs.existsSync(cfg.exiftoolPath) && entries.length > 0) {
    dateMap = await getCaptureDates(cfg.exiftoolPath, entries.map((e) => path.join(activePhotosDir, e.relPath)));
  }
  const captureDatesMs = Date.now() - captureDatesStart;

  const photos = entries
    .map((e) => ({
      ...e,
      dateTaken: dateMap[path.resolve(activePhotosDir, e.relPath)] || new Date(e.mtime).toISOString().slice(0, 19),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { photos, timing: { fileCount: photos.length, walkMs, captureDatesMs } };
}

function listPresetNames() {
  if (!fs.existsSync(cfg.presetsDir)) return [];
  return fs.readdirSync(cfg.presetsDir)
    .filter((f) => f.toLowerCase().endsWith('.pp3'))
    .map((f) => path.parse(f).name)
    .sort();
}

// Surfaces the same startup-config findings over the API (not just the console) so the UI
// could show a banner for a broken rtPath etc. instead of a confusing failure only once the
// user tries to preview or run something.
app.get('/api/health', (req, res) => {
  res.json({ ok: startupCheck.errors.length === 0, errors: startupCheck.errors, warnings: startupCheck.warnings });
});

// ---- source folder: where photos are read from, changeable at runtime from the UI ----
// (a browser can't hand JS a real absolute filesystem path from any native picker, so the
// UI offers a path text field plus this lightweight server-side folder browser instead.)

app.get('/api/source-folder', (req, res) => {
  res.json({
    path: activePhotosDir,
    scanSubfolders: cfg.scanSubfolders,
    history: stateStore.read().photosDirHistory || [],
  });
});

app.post('/api/source-folder', asyncHandler(async (req, res) => {
  const requestedPath = String(req.body?.path || '').trim();
  if (!requestedPath) return res.status(400).json({ error: 'path is required' });

  let stat;
  try {
    stat = fs.statSync(requestedPath);
  } catch {
    return res.status(400).json({ error: 'folder not found' });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'not a folder' });

  activePhotosDir = path.resolve(requestedPath);
  const history = addToHistory(stateStore.read().photosDirHistory, activePhotosDir);
  stateStore.write({ photosDir: activePhotosDir, photosDirHistory: history });

  // Returns the full photo list (not just a count) so the frontend can use it directly instead
  // of immediately firing a second GET /api/photos that would redo the same EXIF-metadata scan
  // a second time - listPhotos() (specifically its exiftool batch read) is the expensive part of
  // switching folders, and doing it twice back-to-back made every folder switch slower than it
  // needed to be for no benefit.
  const { photos } = await listPhotos();
  res.json({
    path: activePhotosDir, photoCount: photos.length, photos, history,
  });
}));

app.get('/api/browse-folders', asyncHandler(async (req, res) => {
  const requestedPath = String(req.query.path || '').trim();

  if (!requestedPath) {
    // Starting point: real drive names/types (e.g. "LaCie (F:)"), same as Windows Explorer,
    // so an external/USB drive is identifiable at a glance instead of a bare letter.
    const drives = await listDrives();
    return res.json({ path: '', parent: null, folders: drives });
  }

  let entries;
  try {
    entries = fs.readdirSync(requestedPath, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `cannot read folder: ${err.message}` });
  }

  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(requestedPath, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // At a drive root (e.g. "C:\"), path.dirname returns the same path - "no parent" would
  // normally mean hide the up button, but here it should instead go back to the drive list
  // (empty path), otherwise there's no way to reach a *different* drive once inside one.
  const parentPath = path.dirname(requestedPath);
  const parent = parentPath !== requestedPath ? parentPath : '';

  res.json({ path: requestedPath, parent, folders });
}));

// ---- photos ----

app.get('/api/photos', asyncHandler(async (req, res) => {
  const { photos, timing } = await listPhotos();
  res.json({
    photosDir: activePhotosDir, scanSubfolders: cfg.scanSubfolders, photos, timing,
  });
}));

app.get('/api/photos/thumbnail', asyncHandler(async (req, res) => {
  const relPath = req.query.path;
  if (!isSafeRelPath(relPath)) return res.status(400).json({ error: 'invalid photo path' });
  const sourceFile = resolvePhotoPath(relPath);
  if (!sourceFile || !fs.existsSync(sourceFile)) return res.status(404).json({ error: 'photo not found' });
  if (!cfg.exiftoolPath || !fs.existsSync(cfg.exiftoolPath)) {
    return res.status(503).json({ error: 'exiftool not configured/found (set exiftoolPath in config/config.json)' });
  }

  const destFile = path.join(cfg.thumbCacheDir, `${cacheKeyFor(relPath)}.jpg`);
  try {
    if (!fs.existsSync(destFile)) {
      await extractThumbnail(cfg.exiftoolPath, sourceFile, destFile);
    }
    res.sendFile(destFile);
  } catch (err) {
    res.status(500).json({ error: `failed to extract thumbnail: ${err.message}` });
  }
}));

// ---- presets ----

app.get('/api/presets', (req, res) => {
  res.json({ presets: listPresetNames() });
});

// ---- preview: render base + all presets for one photo ----

app.post('/api/preview', (req, res) => {
  const { photo } = req.body || {};
  if (!isSafeRelPath(photo)) return res.status(400).json({ error: 'invalid photo' });
  const sourceFile = resolvePhotoPath(photo);
  if (!sourceFile || !fs.existsSync(sourceFile)) return res.status(404).json({ error: 'photo not found' });

  const photoKey = cacheKeyFor(photo);
  const cacheDir = path.join(cfg.previewCacheDir, photoKey);
  const manifestPath = path.join(cacheDir, '_manifest.json');
  const currentPresets = listPresetNames();

  const job = enqueue('preview', async (job) => {
    const cached = fs.existsSync(manifestPath)
      && JSON.stringify(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).presets) === JSON.stringify(currentPresets);

    const urlFor = (label) => `/webapp-cache/previews/${photoKey}/${label}.jpg`;
    const labels = ['00_base_only', ...currentPresets];
    job.progress = {
      total: labels.length,
      items: labels.map((label) => ({ label, status: cached ? 'done' : 'pending', url: cached ? urlFor(label) : null })),
    };

    if (!cached) {
      const args = ['-SourceFile', sourceFile, '-OutputDir', cacheDir, '-ConfigPath', cfg.configPath];
      const scriptPath = path.join(cfg.scriptsDir, 'preview_presets.ps1');

      const { exitCode } = await runPowerShellScript(scriptPath, args, job, (line, job) => {
        let m;
        if ((m = line.match(/^Rendering (.+)\.\.\.$/))) {
          const item = job.progress.items.find((i) => i.label === m[1]);
          if (item) item.status = 'running';
        } else if ((m = line.match(/^Rendered (.+)$/))) {
          const item = job.progress.items.find((i) => i.label === m[1]);
          if (item) { item.status = 'done'; item.url = urlFor(m[1]); }
        } else if ((m = line.match(/^FAILED rendering (.+?) \(/))) {
          const item = job.progress.items.find((i) => i.label === m[1]);
          if (item) item.status = 'failed';
        }
      });

      const allOk = job.progress.items.every((i) => i.status === 'done');
      if (allOk) {
        fs.writeFileSync(manifestPath, JSON.stringify({ presets: currentPresets, generatedAt: Date.now() }));
      } else if (exitCode !== 0) {
        // leave manifest absent so a retry re-renders; still return whatever succeeded below
      }
    }

    const images = job.progress.items.map((i) => ({
      label: i.label,
      status: i.status,
      url: i.status === 'done' ? `/webapp-cache/previews/${photoKey}/${i.label}.jpg` : null,
    }));
    return { photo, images };
  }, { photo });

  res.json({ jobId: job.id });
});

// ---- run: batch-convert selected files with color correction + chosen preset ----

// Mirrors auto_enhance.ps1's own output naming ($outSubdir/$BaseName.jpg) so a cancelled job
// can find and delete the JPEG it was in the middle of writing - otherwise a half-written file
// left behind would be silently treated as "already converted" by the pipeline's own
// idempotency check (README: "if edited_jpg/<name>.jpg already exists, the file is skipped")
// on every future run of this project.
function outputFileFor(outputDir, relPath) {
  const relDir = path.posix.dirname(relPath); // '.' for a top-level file
  const base = path.posix.basename(relPath, path.posix.extname(relPath));
  return relDir === '.' ? path.join(outputDir, `${base}.jpg`) : path.join(outputDir, relDir, `${base}.jpg`);
}

// Lets the UI proactively warn ("this folder already has files in it") before Run is even
// clicked, rather than only finding out from the log after a batch has already started.
app.get('/api/output-status', (req, res) => {
  const folderName = projectFolderName(req.query.projectName);
  const outputDir = path.join(cfg.projectsDir, folderName);
  const exists = fs.existsSync(outputDir);
  const fileCount = exists ? fs.readdirSync(outputDir).length : 0;
  res.json({ folderName, exists, fileCount });
});

app.post('/api/run', asyncHandler(async (req, res) => {
  const { files, preset, projectName } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files must be a non-empty array' });
  }
  const absoluteFiles = [];
  for (const f of files) {
    const resolved = isSafeRelPath(f) ? resolvePhotoPath(f) : null;
    if (!resolved || !fs.existsSync(resolved)) {
      return res.status(400).json({ error: `invalid or missing file: ${f}` });
    }
    absoluteFiles.push(resolved);
  }
  const availablePresets = listPresetNames();
  if (preset && preset !== 'none' && !availablePresets.includes(preset)) {
    return res.status(400).json({ error: `unknown preset: ${preset}` });
  }

  const folderName = projectFolderName(projectName);
  const outputDir = path.join(cfg.projectsDir, folderName);
  const logDir = path.join(outputDir, '_logs');

  // Warn-only (see diskSpace.js) - never blocks the run itself.
  const freeBytes = await getFreeSpaceBytes(outputDir);
  const spaceWarning = checkDiskSpaceWarning(freeBytes, files.length);

  const job = enqueue('run', async (job) => {
    job.progress = { total: files.length, items: files.map((relPath) => ({ name: relPath, status: 'pending' })) };

    const args = [
      '-OutputDir', outputDir,
      '-LogDir', logDir,
      '-ConfigPath', cfg.configPath,
      '-PhotosRoot', activePhotosDir,
      '-FilesJson', JSON.stringify(absoluteFiles),
    ];
    if (preset && preset !== 'none') args.push('-Preset', preset);

    const scriptPath = path.join(cfg.scriptsDir, 'auto_enhance.ps1');
    let summary = { processed: 0, skipped: 0, failed: 0, quarantined: 0 };

    // Positional, not name-based: the script processes -FilesJson in the exact order given,
    // so this stays correct even when two subfolders share a filename (name alone wouldn't).
    let fileIndex = -1;
    let current = null;
    // Reads `current` at cancellation time (closure over the same `let`), not just at setup
    // time - always points at whichever file is actually in flight when Cancel is clicked.
    // Known race, observed during manual testing, considered acceptable: killing a process
    // tree on Windows is not instantaneous, so if RawTherapee was mere moments from finishing
    // this exact file, it can still complete the write after this delete runs. That's harmless
    // either way it resolves - a genuinely partial file gets removed (the case this exists for),
    // or a fully-valid file survives and a future run of this project correctly skips it via the
    // pipeline's own idempotency check, same as any other already-converted file. The only
    // downside in the latter case is this job's own record calls that one file 'cancelled' even
    // though it's actually fine on disk - cosmetic, not a correctness problem.
    job.onCancel = () => {
      if (current) {
        const outFile = outputFileFor(outputDir, current.name);
        fs.rm(outFile, { force: true }, () => {});
        current.status = 'cancelled';
      }
    };
    const { exitCode } = await runPowerShellScript(scriptPath, args, job, (line, job) => {
      let m;
      if (line.match(/^Enhancing (.+?) \(/) || line.match(/^Skipping (.+?) \(/)) {
        if (current && current.status === 'running') current.status = 'done';
        fileIndex += 1;
        current = job.progress.items[fileIndex] || null;
        if (current) current.status = line.startsWith('Skipping') ? 'done' : 'running';
        if (line.startsWith('Skipping')) current = null;
      } else if (line.match(/^\s*FAILED: /)) {
        if (current) current.status = 'failed';
      } else if ((m = line.match(/^Processed: (\d+)\s+Skipped: (\d+)\s+Failed: (\d+)\s+Quarantined: (\d+)/))) {
        summary = { processed: +m[1], skipped: +m[2], failed: +m[3], quarantined: +m[4] };
      }
    });

    finalizeProgressItems(job.progress.items, { cancelled: job.cancelRequested });
    return { outputDir, folderName, exitCode, ...summary };
  }, {
    projectName: sanitizeProjectName(projectName),
    preset: preset && preset !== 'none' ? preset : 'none',
    photoCount: files.length,
    sourceFolder: activePhotosDir,
    outputDir,
    folderName,
  });

  res.json({ jobId: job.id, spaceWarning });
}));

// ---- jobs ----

// Shared shape for both the list and single-job views (list omits the log - it's the one field
// that can get large, and the queue panel only needs it once a job is selected/expanded).
// `etaMs` is computed per-request across the whole queue (see computeAllEtas) since a queued
// job's ETA depends on every job ahead of it, not just itself - null for terminal jobs.
function jobSummary(job, etaMs = null, queuePosition = null) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    meta: job.meta,
    progress: job.progress,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    // Queue-wait vs. actual-render breakdown - see jobTiming.js and docs/gpu_spike_findings.md.
    // Free (derived from timestamps already recorded), so it's included for every job rather
    // than gated behind a debug flag.
    timing: computeJobTiming(job),
    etaMs,
    // 0-indexed position among still-queued jobs of the same type (0 = next to start), null for
    // anything not currently queued. This is the real run order, which can now differ from
    // creation order once a queue has been reordered - the UI's "Up next" list sorts by this,
    // not by createdAt.
    queuePosition,
  };
}

// Estimated "time until finished" for every currently queued/running job - see jobEta.js.
// Recomputed fresh per request (cheap: a handful of jobs, no I/O) rather than cached, since it
// changes constantly as jobs progress. Computed per lane (job type) and merged, since each type
// now runs in its own independent FIFO (see jobQueue.js) - a queued 'preview' job's wait no
// longer has anything to do with what's ahead of it in the 'run' lane, or vice versa.
function computeAllEtas() {
  const recentByType = (type) => listJobs({ type, status: ['done'] }).slice(0, 5);
  const merged = new Map();
  for (const type of listLaneTypes()) {
    const etas = computeEtas(listExecutionOrder(type), recentByType);
    etas.forEach((value, key) => merged.set(key, value));
  }
  return merged;
}

function computeAllQueuePositions() {
  const merged = new Map();
  for (const type of listLaneTypes()) {
    listQueuedIds(type).forEach((id, i) => merged.set(id, i));
  }
  return merged;
}

// Backs the job queue/history panel: every queued/running/finished job, newest first, so the
// UI can stay useful (browse folders, filter photos, queue another run) without needing to
// track which job IDs it personally enqueued - the server is the single source of truth.
app.get('/api/jobs', (req, res) => {
  const { type } = req.query;
  const status = req.query.status ? String(req.query.status).split(',') : undefined;
  const etas = computeAllEtas();
  const positions = computeAllQueuePositions();
  res.json({
    jobs: listJobs({ type, status }).map((j) => jobSummary(j, etas.get(j.id) ?? null, positions.get(j.id) ?? null)),
  });
});

// Reorders a lane's not-yet-started jobs (drag-and-drop in the "Up next" list). Body:
// { type: 'run', orderedIds: [...] } - the full desired order for that job type's queue.
app.post('/api/jobs/reorder', (req, res) => {
  const { type, orderedIds } = req.body || {};
  if (typeof type !== 'string' || !type) return res.status(400).json({ error: 'type is required' });
  if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === 'string')) {
    return res.status(400).json({ error: 'orderedIds must be an array of job id strings' });
  }
  reorderQueue(type, orderedIds);
  res.json({ ok: true, orderedIds: listQueuedIds(type) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const etas = computeAllEtas();
  const positions = computeAllQueuePositions();
  res.json({
    ...jobSummary(job, etas.get(job.id) ?? null, positions.get(job.id) ?? null),
    log: job.log.slice(-100),
  });
});

// Cancels a still-queued job outright, or requests cancellation of an active one (kills its
// process and cleans up any partial output - see outputFileFor's comment above).
app.delete('/api/jobs/:id', (req, res) => {
  const result = cancelJob(req.params.id);
  if (!result.ok) {
    return res.status(result.error === 'job not found' ? 404 : 400).json({ error: result.error });
  }
  res.json({ ok: true });
});

// Pauses a queued job (it stays in the queue, in place, but stops being eligible to run) or
// re-queues a paused one (flips it back to runnable, right where it already sits) - see
// jobQueue.js's pauseJob/requeueJob for why only queued jobs can be paused, never active ones.
app.post('/api/jobs/:id/pause', (req, res) => {
  const result = pauseJob(req.params.id);
  if (!result.ok) {
    return res.status(result.error === 'job not found' ? 404 : 400).json({ error: result.error });
  }
  res.json({ ok: true });
});

app.post('/api/jobs/:id/requeue', (req, res) => {
  const result = requeueJob(req.params.id);
  if (!result.ok) {
    return res.status(result.error === 'job not found' ? 404 : 400).json({ error: result.error });
  }
  res.json({ ok: true });
});

// Registered after every route: catches errors passed via next(err) that never reach
// asyncHandler - most notably express.json() rejecting a malformed request body - and returns
// the same {error} JSON shape every other endpoint uses, instead of Express's default HTML
// error page (which the client's jsonFetch() can't parse as JSON at all).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[server] Unhandled error on ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ error: err.message || 'invalid request' });
});

// app.listen() only runs when this file is executed directly (`node server.js`, or via
// start_all.bat) - not when required as a module, which is how the test suite loads `app` to
// make real HTTP requests against it without also binding a port.
if (require.main === module) {
  const PORT = process.env.PORT || 5175;
  app.listen(PORT, () => {
    console.log(`[server] Auto-photo-enhance server listening on http://localhost:${PORT}`);
    console.log(`[server] Photos dir: ${activePhotosDir} (recursive: ${cfg.scanSubfolders})`);
    console.log(`[server] Projects dir: ${cfg.projectsDir}`);
  });
}

module.exports = { app };
