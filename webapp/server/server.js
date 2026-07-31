const fs = require('fs');
const path = require('path');
const express = require('express');

const { loadConfig } = require('./config');
const { enqueue, getJob } = require('./jobQueue');
const { runPowerShellScript } = require('./runner');
const { extractThumbnail } = require('./thumbnails');
const { getCaptureDates } = require('./captureDates');

const cfg = loadConfig();
const app = express();
app.use(express.json());

fs.mkdirSync(cfg.thumbCacheDir, { recursive: true });
fs.mkdirSync(cfg.previewCacheDir, { recursive: true });
fs.mkdirSync(cfg.projectsDir, { recursive: true });

app.use('/webapp-cache/thumbnails', express.static(cfg.thumbCacheDir));
app.use('/webapp-cache/previews', express.static(cfg.previewCacheDir));

// A "photo" is identified everywhere by its path relative to photosDir (POSIX separators,
// e.g. "Ceremony/DSC00001.ARW", or just "DSC00001.ARW" for top-level files) rather than a
// bare filename, since scanning subfolders means two different sessions can share a filename.

function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (path.isAbsolute(relPath)) return false;
  if (!/\.arw$/i.test(relPath)) return false;
  const segments = relPath.split(/[\\/]/);
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return false;
  return true;
}

// Resolves a relPath to an absolute path, re-checking the result still lands inside
// photosDir (defense in depth beyond isSafeRelPath's textual check).
function resolvePhotoPath(relPath) {
  const rootResolved = path.resolve(cfg.photosDir);
  const resolved = path.resolve(cfg.photosDir, relPath);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

// Flattens a relPath into a single safe path segment for use as a cache key/folder name,
// e.g. "Ceremony/DSC00001.ARW" -> "Ceremony__DSC00001".
function cacheKeyFor(relPath) {
  return relPath.replace(/\.arw$/i, '').split(/[\\/]/).join('__');
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

async function listPhotos() {
  const found = cfg.scanSubfolders
    ? walkArwFiles(cfg.photosDir, cfg.photosDir)
    : fs.readdirSync(cfg.photosDir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.arw$/i.test(d.name))
      .map((d) => ({ relPath: d.name, name: d.name, dir: '' }));

  const entries = found.map((f) => {
    const stat = fs.statSync(path.join(cfg.photosDir, f.relPath));
    return { ...f, size: stat.size, mtime: stat.mtimeMs };
  });

  let dateMap = {};
  if (cfg.exiftoolPath && fs.existsSync(cfg.exiftoolPath) && entries.length > 0) {
    dateMap = await getCaptureDates(cfg.exiftoolPath, entries.map((e) => path.join(cfg.photosDir, e.relPath)));
  }

  return entries
    .map((e) => ({
      ...e,
      dateTaken: dateMap[path.resolve(cfg.photosDir, e.relPath)] || new Date(e.mtime).toISOString().slice(0, 19),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function listPresetNames() {
  if (!fs.existsSync(cfg.presetsDir)) return [];
  return fs.readdirSync(cfg.presetsDir)
    .filter((f) => f.toLowerCase().endsWith('.pp3'))
    .map((f) => path.parse(f).name)
    .sort();
}

// ---- photos ----

app.get('/api/photos', async (req, res) => {
  res.json({ photosDir: cfg.photosDir, scanSubfolders: cfg.scanSubfolders, photos: await listPhotos() });
});

app.get('/api/photos/thumbnail', async (req, res) => {
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
});

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
  });

  res.json({ jobId: job.id });
});

// ---- run: batch-convert selected files with color correction + chosen preset ----

function sanitizeProjectName(name) {
  const cleaned = String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return cleaned.length > 0 ? cleaned : 'project';
}

function projectFolderName(projectName) {
  const safeName = sanitizeProjectName(projectName);
  const date = new Date().toISOString().slice(0, 10);
  return `${safeName}_${date}`;
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

app.post('/api/run', (req, res) => {
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

  const job = enqueue('run', async (job) => {
    job.progress = { total: files.length, items: files.map((relPath) => ({ name: relPath, status: 'pending' })) };

    const args = [
      '-OutputDir', outputDir,
      '-LogDir', logDir,
      '-ConfigPath', cfg.configPath,
      '-PhotosRoot', cfg.photosDir,
      '-FilesJson', JSON.stringify(absoluteFiles),
    ];
    if (preset && preset !== 'none') args.push('-Preset', preset);

    const scriptPath = path.join(cfg.scriptsDir, 'auto_enhance.ps1');
    let summary = { processed: 0, skipped: 0, failed: 0, quarantined: 0 };

    // Positional, not name-based: the script processes -FilesJson in the exact order given,
    // so this stays correct even when two subfolders share a filename (name alone wouldn't).
    let fileIndex = -1;
    let current = null;
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

    job.progress.items.forEach((i) => { if (i.status !== 'done' && i.status !== 'failed') i.status = 'done'; });
    return { outputDir, folderName, exitCode, ...summary };
  });

  res.json({ jobId: job.id });
});

// ---- jobs ----

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
    log: job.log.slice(-100),
  });
});

const PORT = process.env.PORT || 5175;
app.listen(PORT, () => {
  console.log(`Auto-photo-enhance server listening on http://localhost:${PORT}`);
  console.log(`Photos dir: ${cfg.photosDir} (recursive: ${cfg.scanSubfolders})`);
  console.log(`Projects dir: ${cfg.projectsDir}`);
});
