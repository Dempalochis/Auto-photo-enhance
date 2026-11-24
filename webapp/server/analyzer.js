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

const { findBursts } = require('./bursts');
const { clampStep } = require('./correctionPlan');

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

  // The refine pass and histogram stats change what the plan is made from, so they are part of
  // the cache key (turning one on never reuses plans made without it).
  const variant = `${prompt.PROMPT_VERSION}${llmCfg.refinePass ? '+refine' : ''}${llmCfg.histogramStats && deps.stats ? '+stats' : ''}`;
  function keysFor(photo, d, kind) {
    return planKey({
      photo: d.pk, provider: provider.name, model: provider.model, promptVersion: variant, inputKind: kind, baseFp: d.baseFp,
    });
  }

  async function imagePayload(file) {
    const resized = deps.resize ? await deps.resize(file, llmCfg.maxImagePx) : null;
    return { base64: (resized || fs.readFileSync(file)).toString('base64'), mediaType: 'image/jpeg' };
  }

  // Phase 6 refine pass (LLM §4): a REAL draft render with the pass-1 overlay ("after") next to
  // the base draft ("before"); the model may correct each step by at most +-1, one round.
  // Any failure keeps the pass-1 plan.
  async function refine(photo, d, plan1, signal) {
    const { correctionToPp3 } = require('./correctionToPp3');
    const overlay = correctionToPp3(plan1, effectiveBase(d.resolved), { strength: llmCfg.strength });
    if (!overlay) return { plan: plan1, refined: false, note: 'pass 1 changed nothing' };
    const written = cache.writeOverlay(overlay.text);
    const before = cache.draftPath(d.pk, d.baseFp, null);
    const after = cache.draftPath(d.pk, d.baseFp, written.hash);
    const done = {};
    await deps.renderDrafts([
      { source: photo.abs, out: before, aiOverlay: null },
      { source: photo.abs, out: after, aiOverlay: written.path },
    ], (i, out) => { done[i] = Boolean(out); }, signal);
    if (!done[0] || !done[1]) return { plan: plan1, refined: false, note: 'refine renders failed' };
    const res = await callLlm({
      images: [await imagePayload(before), await imagePayload(after)],
      systemPrompt: prompt.systemPrompt(),
      userText: prompt.refineUserText({ exif: photo.exif, previous: plan1 }),
      jsonSchema: correctionSchema(),
      signal,
    });
    const adjustments = { ...plan1.adjustments };
    const delta = {};
    for (const k of Object.keys(adjustments)) {
      const dv = Math.max(-1, Math.min(1, res.plan.adjustments[k] || 0));
      if (dv) delta[k] = dv;
      adjustments[k] = clampStep((adjustments[k] || 0) + dv);
    }
    return { plan: { ...plan1, adjustments, refineDelta: delta }, refined: true };
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

    // Phase 6 burst reuse: followers (same exposure, within 2 s of the previous frame) take the
    // leader's plan instead of their own LLM call.
    const followers = llmCfg.burstReuse ? findBursts(todo.map((t) => ({ exif: { ...t.photo.exif } }))) : new Map();
    const leaderDone = new Map();
    const leaderResult = (i) => {
      if (!leaderDone.has(i)) {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        leaderDone.set(i, { promise, resolve });
      }
      return leaderDone.get(i);
    };

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
      // Followers of a burst need no image; their slot gets a placeholder that's never read.
      const jobs = todo.map(({ photo, d }, i) => (followers.has(i)
        ? { source: photo.abs, out: cache.draftPath(d.pk, d.baseFp, null), aiOverlay: null, skip: true }
        : { source: photo.abs, out: cache.draftPath(d.pk, d.baseFp, null), aiOverlay: null }));
      followers.forEach((_, i) => imageWaiters.get(i).resolve({ follower: true }));
      const realJobs = jobs.map((j, i) => ({ j, i })).filter((x) => !x.j.skip);
      deps.renderDrafts(realJobs.map((x) => x.j), (k, out, note) => {
        const i = realJobs[k] ? realJobs[k].i : -1;
        if (!imageWaiters.has(i)) return;
        if (out && fs.existsSync(out)) imageWaiters.get(i).resolve({ path: out, kind: 'draftRender' });
        else embeddedFor(i).then((r) => imageWaiters.get(i).resolve(r.error ? { error: `draft failed (${note}); ${r.error}` } : r));
      }, signal).then(() => {
        // Anything the draft script never reported (crash, cancel) falls back to embedded.
        todo.forEach((_, i) => { if (!imageWaiters.get(i).done) embeddedFor(i).then((r) => imageWaiters.get(i).resolve(r)); });
      }, () => todo.forEach((_, i) => imageWaiters.get(i).resolve({ error: 'draft render failed' })));
    } else {
      todo.forEach((_, i) => (followers.has(i) ? imageWaiters.get(i).resolve({ follower: true }) : embeddedFor(i).then((r) => imageWaiters.get(i).resolve(r))));
    }

    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = next;
        next += 1;
        const { photo, d } = todo[i];
        if (signal && signal.aborted) { onResult(photo, { error: 'cancelled' }); counts.failed += 1; if (!followers.has(i)) leaderResult(i).resolve(null); continue; }
        if (followers.has(i)) {
          const lead = await leaderResult(followers.get(i)).promise;
          if (!lead) { counts.failed += 1; onResult(photo, { error: 'burst leader analysis failed' }); continue; }
          const record = { plan: lead.plan, meta: { ...lead.meta, file: photo.relPath, burstOf: todo[followers.get(i)].photo.relPath } };
          cache.putPlan(keysFor(photo, d, lead.meta.inputKind), record);
          counts.burst = (counts.burst || 0) + 1;
          onResult(photo, {
            plan: lead.plan, source: 'burst', summary: summarizePlan(lead.plan), meta: record.meta, describe: d,
          });
          continue;
        }
        const img = await imagePromise(i);
        if (img.error) { counts.failed += 1; leaderResult(i).resolve(null); onResult(photo, { error: img.error }); continue; }
        const t0 = Date.now();
        try {
          const stats = deps.stats && llmCfg.histogramStats ? await deps.stats(img.path) : null;
          const res = await callLlm({
            images: [await imagePayload(img.path)],
            systemPrompt: prompt.systemPrompt(),
            userText: prompt.userText({ exif: photo.exif, stats }),
            jsonSchema: correctionSchema(),
            signal,
          });
          let finalPlan = res.plan;
          let refineInfo = null;
          if (llmCfg.refinePass) {
            try {
              const r = await refine(photo, d, res.plan, signal);
              finalPlan = r.plan;
              refineInfo = { refined: r.refined, note: r.note || null, delta: r.plan.refineDelta || null };
            } catch (err) {
              refineInfo = { refined: false, note: `refine failed: ${err.message}` };
            }
          }
          const record = {
            plan: finalPlan,
            meta: {
              file: photo.relPath, provider: provider.name, model: res.model || provider.model, promptVersion: prompt.PROMPT_VERSION,
              inputKind: img.kind, baseProfile: d.resolved.profileName, ms: Date.now() - t0, usage: res.usage, warnings: res.warnings, createdAt: Date.now(),
              stats, refine: refineInfo, pass1: refineInfo ? res.plan.adjustments : undefined,
            },
          };
          cache.putPlan(keysFor(photo, d, img.kind), record);
          counts.llm += 1;
          leaderResult(i).resolve(record);
          onResult(photo, {
            plan: finalPlan, source: 'llm', summary: summarizePlan(finalPlan), meta: record.meta, describe: d, inputImage: img.path,
          });
        } catch (err) {
          leaderResult(i).resolve(null);
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
