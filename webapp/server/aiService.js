// Version 2 Phase 4: wires the LLM pieces into the server - provider + health, the `analyze`
// lane, and the AI side of a run (plan board -> -CorrectionsJson file -> auto_enhance.ps1
// -WaitForCorrections). Kept out of server.js so it can be read on its own; server.js passes in
// the few server functions it needs.
const fs = require('fs');
const path = require('path');
const { createProvider } = require('./llm');
const { createCorrectionsCache } = require('./correctionsCache');
const { createAnalyzer, entryFromPlan } = require('./analyzer');
const { createPlanBoard } = require('./planBoard');
const { getPhotoMetadata } = require('./captureDates');
const { createRunProgressHandler } = require('./runEvents');
const { extractThumbnail } = require('./thumbnails');
const { cacheKeyFor } = require('./pathSafety');
const { strengthValue } = require('./correctionToPp3');
const { validatePlan, extractJson } = require('./correctionPlan');
const { tagsOnlySchema } = require('./llm/correctionSchema');
const { tagsOnlySystemPrompt, PROMPT_VERSION } = require('./llm/prompt');
const { refineDay } = require('./sceneGrouper');
const { autoScenesFromSegments } = require('./scenesStore');
const { photoKey } = require('./correctionsCache');
const { atomicWriteFileSync } = require('./atomicFile');

const HEALTH_TTL_MS = 10000;

function createAiService({
  cfg, enqueue, listExecutionOrder, runPowerShellScript, psOpts, getJob, cancelJob,
}) {
  const llmCfg = cfg.llm;
  const provider = createProvider(llmCfg);
  const cache = createCorrectionsCache(cfg.correctionsDir);
  let health = { at: 0, value: null };

  async function llmHealth() {
    if (!llmCfg.enabled) return { enabled: false, status: 'disabled', provider: llmCfg.provider, model: llmCfg.model, detail: 'llm.enabled is false in config/config.json' };
    if (Date.now() - health.at < HEALTH_TTL_MS && health.value) return health.value;
    const h = await provider.checkHealth();
    health = {
      at: Date.now(),
      value: {
        enabled: true, provider: provider.name, model: provider.model, status: h.status, detail: h.detail, local: provider.isLocal, inputImage: llmCfg.inputImage,
      },
    };
    return health.value;
  }
  const available = async () => (await llmHealth()).status === 'reachable';

  const exiftoolAvailable = Boolean(cfg.exiftoolPath && fs.existsSync(cfg.exiftoolPath));
  const profileCtx = { profilesDir: cfg.profilesDir, rawConfig: cfg.raw, exiftoolAvailable };

  // Draft renders through scripts/render_draft.ps1 (the one argument builder), one at a time.
  function makeRenderDrafts(job) {
    return (jobs, onDone, signal) => new Promise((resolve, reject) => {
      if (signal && signal.aborted) { resolve(); return; }
      const listFile = path.join(cache.dirs.runs, `drafts_${job.id}_${Date.now()}.json`);
      fs.mkdirSync(path.dirname(listFile), { recursive: true });
      fs.writeFileSync(listFile, JSON.stringify(jobs));
      const script = path.join(cfg.scriptsDir, 'render_draft.ps1');
      // A child-job object so this process gets its own log/handle without replacing the
      // parent's (a run job keeps its own _proc for cancel).
      const sub = { id: `${job.id}-drafts`, log: job.log || [], _proc: null };
      job._draftsProc = sub;
      runPowerShellScript(script, ['-JobsJson', listFile, '-ConfigPath', cfg.configPath, '-EmitEvents'], sub, (line) => {
        if (!line.startsWith('@@EVENT ')) return;
        try {
          const e = JSON.parse(line.slice(8));
          if (e.event === 'draft_completed') onDone(e.index, e.out, null);
          if (e.event === 'draft_failed') onDone(e.index, null, e.note);
        } catch { /* ignore malformed */ }
      }, psOpts).then(() => { fs.rm(listFile, { force: true }, () => {}); resolve(); }, reject);
      if (signal) signal.addEventListener('abort', () => { try { if (sub._proc) sub._proc.kill(); } catch { /* best effort */ } }, { once: true });
    });
  }

  async function extractEmbedded(photo) {
    if (!exiftoolAvailable) throw new Error('exiftool not configured');
    const dest = path.join(cfg.thumbCacheDir, `${cacheKeyFor(photo.cacheRel || photo.relPath)}.jpg`);
    if (!fs.existsSync(dest)) await extractThumbnail(cfg.exiftoolPath, photo.abs, dest);
    return dest;
  }

  function analyzerFor(job, extra = {}) {
    return createAnalyzer({
      provider, llmCfg, cache, profileCtx, renderDrafts: makeRenderDrafts(job), extractEmbedded, ...extra,
    });
  }

  // { abs, relPath, size, mtime, exif } for the given files (one batched exiftool read).
  async function describeFiles(files, absoluteFiles) {
    const meta = exiftoolAvailable ? await getPhotoMetadata(cfg.exiftoolPath, absoluteFiles) : {};
    return files.map((relPath, i) => {
      const abs = absoluteFiles[i];
      const st = fs.statSync(abs);
      return {
        abs, relPath, size: st.size, mtime: st.mtimeMs, exif: meta[path.resolve(abs)] || {},
      };
    });
  }

  // 'auto' = embedded JPEG while a run is rendering (no CPU contention with the run), else draft.
  function resolveInputKind(requested) {
    const want = requested || llmCfg.inputImage;
    if (want === 'draftRender' || want === 'embedded') return want;
    const runActive = Boolean(listExecutionOrder('run')[0]);
    return runActive ? 'embedded' : 'draftRender';
  }

  /** POST /api/analyze: analysis for review (results cached; nothing is rendered). */
  function startAnalyzeJob({ files, absoluteFiles, inputImage, force }) {
    return enqueue('analyze', async (job) => {
      const ctrl = new AbortController();
      job.onCancel = () => ctrl.abort(new Error('cancelled'));
      const photos = await describeFiles(files, absoluteFiles);
      job.progress = { total: photos.length, items: photos.map((p) => ({ name: p.relPath, status: 'pending' })) };
      if (!(await available())) throw new Error(`LLM not available: ${(await llmHealth()).detail}`);
      const results = {};
      const counts = await analyzerFor(job).analyze(photos, {
        inputKind: resolveInputKind(inputImage),
        signal: ctrl.signal,
        force: force === true,
        onResult: (photo, r) => {
          const item = job.progress.items.find((it) => it.name === photo.relPath);
          if (item) { item.status = r.error ? 'failed' : 'done'; item.note = r.error || r.summary; }
          results[photo.relPath] = r.error ? { error: r.error } : { summary: r.summary, source: r.source };
        },
      });
      // Before/after draft renders for the review page (Phase 5).
      if (!ctrl.signal.aborted) await renderReviewImages(job, photos.filter((p) => results[p.relPath] && !results[p.relPath].error));
      return { counts, results };
    }, {
      purpose: 'review', photoCount: files.length, model: provider.model, files,
    });
  }

  /**
   * The AI side of an AI run. Returns { extraArgs, onEvent, finish } for makeRunJobFn:
   *  - extraArgs: -CorrectionsJson <file> -WaitForCorrections
   *  - onEvent: feed every @@EVENT (waiting_for_plan starts that photo's timeout)
   *  - finish(): settle/close everything once the render process has exited
   */
  async function prepareAiRun(job, { files, absoluteFiles, strength }) {
    const runFile = cache.runFile(job.id);
    const entries = {};
    cache.writeRunFile(job.id, entries);
    const board = createPlanBoard({
      planWaitMs: llmCfg.planWaitMs,
      onEntry: (abs, entry) => { entries[abs] = entry; cache.writeRunFile(job.id, entries); },
    });
    const photos = await describeFiles(files, absoluteFiles);
    photos.forEach((p) => board.add(p.abs));
    job.aiNotes = [];
    const st = strengthValue(strength);

    const onResult = (photo, r) => {
      if (r.error) { board.fail(photo.abs, r.error); return; }
      board.resolve(photo.abs, entryFromPlan({ plan: r.plan, describe: r.describe, cache, strength: st }));
    };

    let analyzeJob = null;
    if (!(await available())) {
      const note = `LLM not available (${(await llmHealth()).detail})`;
      photos.forEach((p) => board.fail(p.abs, note));
      job.aiNotes.push(`AI correction skipped for this run: ${note}`);
    } else {
      // Cached/edited plans go straight onto the board; the rest is analysed in the analyze
      // lane, in render order, while the run renders.
      const analyzer = analyzerFor(job);
      const missing = [];
      for (const p of photos) {
        const found = analyzer.lookup(p);
        if (found.plan) onResult(p, { plan: found.plan, describe: found });
        else missing.push(p);
      }
      if (missing.length > 0) {
        const inputKind = resolveInputKind();
        analyzeJob = enqueue('analyze', async (aj) => {
          const ctrl = new AbortController();
          aj.onCancel = () => ctrl.abort(new Error('cancelled'));
          aj.progress = { total: missing.length, items: missing.map((p) => ({ name: p.relPath, status: 'pending' })) };
          const counts = await analyzerFor(aj).analyze(missing, {
            inputKind,
            signal: ctrl.signal,
            onResult: (photo, r) => {
              const item = aj.progress.items.find((it) => it.name === photo.relPath);
              if (item) { item.status = r.error ? 'failed' : 'done'; item.note = r.error || r.summary; }
              onResult(photo, r);
            },
          });
          return { counts, runJobId: job.id };
        }, {
          purpose: 'run', runJobId: job.id, projectName: job.meta && job.meta.projectName, photoCount: missing.length, model: provider.model, inputImage: inputKind,
        });
      }
    }

    return {
      extraArgs: ['-CorrectionsJson', runFile, '-WaitForCorrections'],
      onEvent(evt) {
        if (evt.event === 'waiting_for_plan' && evt.file) board.runWaiting(evt.file);
        if (evt.event === 'file_started' && evt.file) {
          const e = board.entry(evt.file);
          const item = job.progress.items[evt.index];
          if (item && e) { item.ai = e.summary; if (e.note) item.note = e.note; }
        }
      },
      finish() {
        board.close();
        if (analyzeJob) {
          const aj = getJob(analyzeJob.id);
          if (aj && (aj.status === 'queued' || aj.status === 'running' || aj.status === 'paused')) cancelJob(analyzeJob.id);
        }
        const skipped = Object.values(entries).filter((e) => e.note).length;
        return { aiSkipped: skipped, aiNotes: job.aiNotes };
      },
    };
  }

  // ---- Phase 5: scene tags + LLM scene refinement ----
  const tagsDir = path.join(cfg.correctionsDir, 'tags');
  const tagFile = (photo) => path.join(tagsDir, `${photoKey(photo.abs, photo.size, photo.mtime)}_${provider.name}_${String(provider.model).replace(/[^\w.-]+/g, '_')}_${PROMPT_VERSION}.json`);

  // Tags for one photo: from a cached correction plan if there is one, else a tags-only call on
  // the embedded JPEG (cheap, short prompt), cached per photo.
  async function tagsFor(photo, signal) {
    const found = analyzerFor({ id: 'tags', log: [] }).lookup(photo);
    const fromPlan = found.plan && found.plan.sceneTags ? found.plan.sceneTags
      : (found.llmPlan && found.llmPlan.plan && found.llmPlan.plan.sceneTags) || null;
    if (fromPlan) return fromPlan;
    try { return JSON.parse(fs.readFileSync(tagFile(photo), 'utf8')); } catch { /* not cached */ }
    const img = await extractEmbedded(photo);
    const reply = await provider.analyzeImage({
      images: [{ base64: fs.readFileSync(img).toString('base64'), mediaType: 'image/jpeg' }],
      systemPrompt: tagsOnlySystemPrompt(),
      userText: 'Label this photo.',
      jsonSchema: tagsOnlySchema(),
      signal,
    });
    const { plan } = validatePlan({ adjustments: {}, sceneTags: (extractJson(reply.text) || {}).sceneTags });
    if (plan.sceneTags) atomicWriteFileSync(tagFile(photo), JSON.stringify(plan.sceneTags));
    return plan.sceneTags;
  }

  // Evenly spread sample of a segment's photos to tag (first and last always included).
  function sampleIndexes(n, k) {
    if (n <= k) return [...Array(n).keys()];
    const out = new Set([0, n - 1]);
    for (let i = 1; out.size < k; i += 1) out.add(Math.round((i * (n - 1)) / (k - 1)));
    return [...out].sort((a, b) => a - b);
  }

  /**
   * Phase 3 segments -> scenes. With scenes.useLlm (default true) and a reachable LLM: tag a
   * sample of each segment's photos, then one text-only call per day to merge/split/name.
   * Any failure falls back to the code segments for that day.
   */
  async function refineScenes(plan, photos, job) {
    const codeScenes = autoScenesFromSegments(plan.segments);
    const useLlm = !(cfg.raw.scenes && cfg.raw.scenes.useLlm === false);
    if (!useLlm || !llmCfg.enabled || plan.segments.length === 0) return { scenes: codeScenes, llm: useLlm ? 'off (llm disabled)' : 'off', notes: [] };
    if (!(await available())) return { scenes: codeScenes, llm: 'unavailable', notes: [`LLM not available: ${(await llmHealth()).detail}`] };

    const byRel = Object.fromEntries(photos.map((p) => [p.relPath, p]));
    const asPhoto = (rel) => {
      const p = byRel[rel];
      return {
        abs: path.join(p.root || '', p.relPath), relPath: p.relPath, cacheRel: p.relPath, size: p.size, mtime: p.mtime, exif: p,
      };
    };
    const maxTags = (cfg.raw.scenes && cfg.raw.scenes.maxTagsPerSegment) || 6;
    const wanted = plan.segments.flatMap((s) => sampleIndexes(s.photos.length, maxTags).map((i) => s.photos[i]));
    const tags = {};
    const notes = [];
    if (job) job.progress.items.splice(2, 0, { label: `tag ${wanted.length} photos`, status: 'running' });
    for (const rel of wanted) {
      try { tags[rel] = await tagsFor(asPhoto(rel)); } catch (err) { notes.push(`tags for ${rel}: ${err.message}`); }
    }
    if (job) job.progress.items[2].status = 'done';

    const byDay = new Map();
    for (const seg of plan.segments) {
      const day = seg.start.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(seg);
    }
    const scenes = [];
    let ok = 0;
    for (const [day, segs] of byDay) {
      const r = await refineDay({
        day, segments: segs, photosByRel: byRel, tagsFor: (rel) => tags[rel] || null, provider,
      });
      notes.push(...r.warnings);
      if (r.scenes) { scenes.push(...r.scenes); ok += 1; } else scenes.push(...autoScenesFromSegments(segs));
    }
    return { scenes, llm: `ok (${ok}/${byDay.size} days named)`, notes: notes.slice(0, 50) };
  }

  // Phase 5 review helpers.
  function lookupForReview(photo) {
    return analyzerFor({ id: 'lookup', log: [] }).lookup(photo);
  }

  // Before = base draft, after = base + AI overlay (at llm.strength) draft. Cached by file name
  // (photo + base profile + overlay hash), so an edit only renders the new "after".
  function reviewImages(photo, found = lookupForReview(photo)) {
    const before = cache.draftPath(found.pk, found.baseFp, null);
    const entry = found.plan ? entryFromPlan({ plan: found.plan, describe: found, cache, strength: llmCfg.strength }) : null;
    const after = entry && entry.overlay ? cache.draftPath(found.pk, found.baseFp, entry.overlayHash) : null;
    return {
      before, after, overlay: entry && entry.overlay, overlayHash: entry && entry.overlayHash,
    };
  }

  async function renderReviewImages(job, photos) {
    const list = [];
    for (const p of photos) {
      const img = reviewImages(p);
      list.push({ source: p.abs, out: img.before, aiOverlay: null });
      if (img.after) list.push({ source: p.abs, out: img.after, aiOverlay: img.overlay });
    }
    if (list.length) await makeRenderDrafts(job)(list, () => {});
    return list.length;
  }

  /** Re-render before/after images for some photos (after an edit) in the `review` lane. */
  function startReviewRenderJob({ files, absoluteFiles }) {
    return enqueue('review', async (job) => {
      const photos = await describeFiles(files, absoluteFiles);
      job.progress = { total: photos.length, items: photos.map((p) => ({ name: p.relPath, status: 'running' })) };
      const n = await renderReviewImages(job, photos);
      job.progress.items.forEach((i) => { i.status = 'done'; });
      return { rendered: n };
    }, { purpose: 'review images', photoCount: files.length, files });
  }

  return {
    llmCfg, provider, cache, llmHealth, available, startAnalyzeJob, prepareAiRun, describeFiles,
    lookupForReview, analyzerFor, resolveInputKind, makeRenderDrafts, extractEmbedded, profileCtx,
    createRunProgressHandler, refineScenes, tagsFor, sampleIndexes, reviewImages, renderReviewImages, startReviewRenderJob,
  };
}

module.exports = { createAiService };
