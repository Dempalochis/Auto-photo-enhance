// Version 2 Phase 4 (LLM plan §6.2): the per-photo AI analysis used by the `analyze` lane.
//
// For each photo, in the given (render) order:
//   1. the user's edited plan, if any (always wins);
//   2. a cached plan for this photo + provider + model + prompt + base profile (any input kind,
//      the draft-render plan preferred);
//   3. otherwise: input image -> provider call (llm.timeoutMs) -> validate (one retry on a reply
//      that isn't JSON) -> cache.
// Results are reported per photo through onResult as soon as they exist, so a running render
// can use photo N's plan while photo N+1 is still being analysed.
//
// Input images: 'draftRender' = a small RawTherapee render through the photo's base profile
// (rendered ahead, one at a time, by renderDrafts), 'embedded' = the camera's preview JPEG.
// A failed draft falls back to the embedded JPEG for that photo.
const fs = require('fs');
const { validatePlan, allZeroPlan, summarizePlan } = require('./correctionPlan');
const { correctionSchema } = require('./llm/correctionSchema');
const prompt = require('./llm/prompt');
const { resolveBaseProfile, effectiveBase } = require('./baseProfile');
const {
  photoKey, baseFingerprint, planKey,
} = require('./correctionsCache');

const INPUT_KINDS = ['draftRender', 'embedded'];

function describePhoto(photo, ctx) {
  const resolved = resolveBaseProfile(ctx, photo.abs, photo.exif && photo.exif.iso);
  const baseFp = baseFingerprint(resolved);
  const pk = photoKey(photo.abs, photo.size, photo.mtime);
  return { resolved, baseFp, pk };
}

/**
 * deps: { provider, llmCfg, cache, profileCtx: { profilesDir, rawConfig, exiftoolAvailable },
 *         renderDrafts(jobs, onDone) -> Promise, extractEmbedded(photo) -> Promise<path>,
 *         stats?(imagePath) -> Promise<stats|null>   (Phase 6, optional) }
 */
function createAnalyzer(deps) {
  const {
    provider, llmCfg, cache, profileCtx,
  } = deps;

  function keysFor(photo, d, kind) {
    return planKey({
      photo: d.pk, provider: provider.name, model: provider.model, promptVersion: prompt.PROMPT_VERSION, inputKind: kind, baseFp: d.baseFp,
    });
  }

  // The plan the app would use right now for this photo without calling the LLM, or null.
  function lookup(photo) {
    const d = describePhoto(photo, profileCtx);
    const edit = cache.getEdit(d.pk);
    if (edit && edit.plan) return { plan: edit.plan, source: 'edit', llmPlan: lookupCached(photo, d), ...d };
    const cached = lookupCached(photo, d);
    if (cached) return { plan: cached.plan, source: 'cache', meta: cached.meta, ...d };
    return { plan: null, source: null, ...d };
  }

  function lookupCached(photo, d) {
    for (const kind of INPUT_KINDS) {
      const rec = cache.getPlan(keysFor(photo, d, kind));
      if (rec && rec.plan) return rec;
    }
    return null;
  }

  async function callLlm({ images, userText, systemPrompt, jsonSchema, signal }) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let reply;
      try {
        reply = await provider.analyzeImage({
          images, systemPrompt, userText, jsonSchema, signal,
        });
      } catch (err) {
        // A transport error/timeout is not retried (the run must not wait twice as long).
        throw err;
      }
      try {
        const { plan, warnings } = validatePlan(reply.text);
        return { plan, warnings, usage: reply.usage, model: reply.model };
      } catch (err) {
        lastErr = err; // not JSON at all: one retry
      }
    }
    throw new Error(`invalid reply from the model (${lastErr && lastErr.message})`);
  }

  /**
   * photos: [{ abs, relPath, size, mtime, exif }] in render order.
   * opts: { inputKind: 'draftRender'|'embedded', signal, onResult(photo, result), force }
   * result: { plan, source: 'edit'|'cache'|'llm', summary } or { error }.
   */
  async function analyze(photos, opts = {}) {
    const { signal, onResult = () => {}, force = false } = opts;
    const inputKind = opts.inputKind === 'embedded' ? 'embedded' : 'draftRender';
    const todo = [];
    const counts = {
      edit: 0, cache: 0, llm: 0, failed: 0,
    };

    for (const photo of photos) {
      const found = force ? { ...describePhoto(photo, profileCtx), plan: null } : lookup(photo);
      if (found.plan) {
        counts[found.source] += 1;
        onResult(photo, { plan: found.plan, source: found.source, summary: summarizePlan(found.plan), describe: found });
      } else {
        todo.push({ photo, d: found });
      }
    }
    if (todo.length === 0) return counts;

    // Input images, prepared ahead in render order.
    const imageWaiters = new Map();
    const imagePromise = (i) => imageWaiters.get(i).promise;
    todo.forEach((_, i) => {
      const w = { done: false };
      w.promise = new Promise((r) => { w.resolve = (v) => { if (!w.done) { w.done = true; r(v); } }; });
      imageWaiters.set(i, w);
    });
    const embeddedFor = async (i) => {
      try { return { path: await deps.extractEmbedded(todo[i].photo), kind: 'embedded' }; } catch (err) { return { error: `no input image (${err.message})` }; }
    };
    if (inputKind === 'draftRender') {
      const jobs = todo.map(({ photo, d }) => ({ source: photo.abs, out: cache.draftPath(d.pk, d.baseFp, null), aiOverlay: null }));
      deps.renderDrafts(jobs, (i, out, note) => {
        if (!imageWaiters.has(i)) return;
        if (out && fs.existsSync(out)) imageWaiters.get(i).resolve({ path: out, kind: 'draftRender' });
        else embeddedFor(i).then((r) => imageWaiters.get(i).resolve(r.error ? { error: `draft failed (${note}); ${r.error}` } : r));
      }, signal).then(() => {
        // Anything the draft script never reported (crash, cancel) falls back to embedded.
        todo.forEach((_, i) => { if (!imageWaiters.get(i).done) embeddedFor(i).then((r) => imageWaiters.get(i).resolve(r)); });
      }, () => todo.forEach((_, i) => imageWaiters.get(i).resolve({ error: 'draft render failed' })));
    } else {
      todo.forEach((_, i) => embeddedFor(i).then((r) => imageWaiters.get(i).resolve(r)));
    }

    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = next;
        next += 1;
        const { photo, d } = todo[i];
        if (signal && signal.aborted) { onResult(photo, { error: 'cancelled' }); counts.failed += 1; continue; }
        const img = await imagePromise(i);
        if (img.error) { counts.failed += 1; onResult(photo, { error: img.error }); continue; }
        const t0 = Date.now();
        try {
          const stats = deps.stats && llmCfg.histogramStats ? await deps.stats(img.path) : null;
          const res = await callLlm({
            images: [{ base64: fs.readFileSync(img.path).toString('base64'), mediaType: 'image/jpeg' }],
            systemPrompt: prompt.systemPrompt(),
            userText: prompt.userText({ exif: photo.exif, stats }),
            jsonSchema: correctionSchema(),
            signal,
          });
          const record = {
            plan: res.plan,
            meta: {
              file: photo.relPath, provider: provider.name, model: res.model || provider.model, promptVersion: prompt.PROMPT_VERSION,
              inputKind: img.kind, baseProfile: d.resolved.profileName, ms: Date.now() - t0, usage: res.usage, warnings: res.warnings, createdAt: Date.now(),
            },
          };
          cache.putPlan(keysFor(photo, d, img.kind), record);
          counts.llm += 1;
          onResult(photo, {
            plan: res.plan, source: 'llm', summary: summarizePlan(res.plan), meta: record.meta, describe: d, inputImage: img.path,
          });
        } catch (err) {
          counts.failed += 1;
          onResult(photo, { error: err && err.message ? err.message : String(err) });
        }
      }
    };
    const n = Math.max(1, Math.min(llmCfg.concurrency || 1, todo.length));
    await Promise.all(Array.from({ length: n }, worker));
    return counts;
  }

  return { analyze, lookup, describePhoto: (p) => describePhoto(p, profileCtx) };
}

// The entry auto_enhance.ps1 gets for one photo (-CorrectionsJson), from a plan.
function entryFromPlan({ plan, describe, cache, strength, note = '' }) {
  const { correctionToPp3 } = require('./correctionToPp3');
  const overlay = plan ? correctionToPp3(plan, effectiveBase(describe.resolved), { strength }) : null;
  const written = overlay ? cache.writeOverlay(overlay.text) : null;
  return {
    overlay: written ? written.path : null,
    overlayHash: written ? written.hash : null,
    summary: plan ? summarizePlan(plan) : 'none',
    scene: plan && plan.scene && plan.scene !== 'other' ? plan.scene : '',
    note,
  };
}

module.exports = {
  createAnalyzer, entryFromPlan, INPUT_KINDS, allZeroPlan,
};
