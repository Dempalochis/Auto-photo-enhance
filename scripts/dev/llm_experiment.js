#!/usr/bin/env node
// Version 2 Phase 0, task 4 (LLM plan §9 Phase 0): run real photos through the LLM and write a
// before/after HTML page, and compare the plans made from different input images.
//
//   node scripts/dev/llm_experiment.js <photo folder> [--max 40] [--inputs draftRender,embedded,fullSmall]
//        [--model qwen3.5:9b] [--provider ollama|mock] [--base-url http://localhost:11434]
//        [--strength 1] [--timeout 120000] [--out <dir>]
//
// Per photo: base draft render ("before"), plans from each input image, an AI draft render
// ("after", from the first input's plan), and a table comparing the plans. Uses the server's
// real modules (prompt, schema, validation, step table, overlay writer), so what you see is what
// the app would do. Nothing in the app's caches or outputs is touched.
//
// Decides at the manual test (Version 2 plan §9.3):
//  - AI correction gate: does "after" actually look better than "before"?
//  - llm.inputImage: if draftRender and embedded plans mostly agree, the free embedded JPEG is
//    good enough.
//  - Dropped steps: steps the model uses badly (e.g. tint) can be removed.
const fs = require('fs');
const path = require('path');
const {
  REPO, req, parseArgs, readRawConfig, tools, listRaws, render, extractEmbedded, esc, PAGE_CSS,
} = require('./devlib');

function planDistance(a, b, keys) {
  return keys.reduce((s, k) => s + Math.abs((a.adjustments[k] || 0) - (b.adjustments[k] || 0)), 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args._[0] || path.join(REPO, '_samples');
  const cfg = readRawConfig(args.config);
  const t = tools(cfg);
  const { createProvider } = req('llm');
  const { correctionSchema } = req('llm/correctionSchema');
  const { systemPrompt, userText, PROMPT_VERSION } = req('llm/prompt');
  const { validatePlan, allZeroPlan, summarizePlan } = req('correctionPlan');
  const { correctionToPp3 } = req('correctionToPp3');
  const { STEP_KEYS, TABLE_STATUS } = req('correctionTable');
  const { resolveBaseProfile, effectiveBase } = req('baseProfile');
  const { getPhotoMetadata } = req('captureDates');

  const llmCfg = {
    ...(cfg.llm || {}),
    enabled: true,
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args['base-url'] ? { baseUrl: args['base-url'] } : {}),
    timeoutMs: args.timeout ? +args.timeout : ((cfg.llm && cfg.llm.timeoutMs) || 120000),
  };
  const provider = createProvider(llmCfg);
  const health = await provider.checkHealth();
  console.log(`LLM: ${provider.name} ${provider.model} -> ${health.status} (${health.detail})`);
  if (health.status !== 'reachable') process.exit(1);

  const inputs = String(args.inputs || 'draftRender,embedded').split(',').filter((i) => ['draftRender', 'embedded', 'fullSmall'].includes(i));
  const files = listRaws(dir, args.max ? +args.max : 40);
  const out = args.out || path.join(REPO, '.webapp_cache', 'llm_experiment');
  fs.mkdirSync(out, { recursive: true });
  const meta = await getPhotoMetadata(t.exiftool, files);
  const results = [];

  for (const f of files) {
    const stem = path.basename(f).replace(/\W+/g, '_');
    const m = meta[path.resolve(f)] || {};
    const resolved = resolveBaseProfile({ profilesDir: path.join(REPO, 'profiles'), rawConfig: cfg, exiftoolAvailable: fs.existsSync(t.exiftool) }, f, m.iso);
    const before = path.join(out, `${stem}__before.jpg`);
    const rb = await render(t, { source: f, out: before, base: resolved.profilePath, formatOverlay: resolved.formatOverlayPath, mode: 'draft' });
    const row = { file: path.basename(f), iso: m.iso, base: resolved.profileName, beforeMs: rb.ms, plans: {}, timings: {} };
    console.log(`${row.file}: before draft ${rb.ms} ms`);

    for (const input of inputs) {
      let img = before;
      if (input === 'embedded') {
        img = path.join(out, `${stem}__embedded.jpg`);
        if (!(await extractEmbedded(t, f, img))) { row.plans[input] = { error: 'no embedded JPEG' }; continue; }
      } else if (input === 'fullSmall') {
        img = path.join(out, `${stem}__fullsmall.jpg`);
        const r = await render(t, { source: f, out: img, base: resolved.profilePath, formatOverlay: resolved.formatOverlayPath, mode: 'fullSmall' });
        row.timings.fullSmallRenderMs = r.ms;
      }
      const t0 = Date.now();
      let plan;
      let error = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reply = await provider.analyzeImage({
            images: [{ base64: fs.readFileSync(img).toString('base64'), mediaType: 'image/jpeg' }],
            systemPrompt: systemPrompt(), userText: userText({ exif: m }), jsonSchema: correctionSchema(),
          });
          plan = validatePlan(reply.text).plan;
          error = null;
          break;
        } catch (e) { error = e.message; }
      }
      if (!plan) plan = allZeroPlan(`AI correction skipped: ${error}`);
      row.plans[input] = { plan, error, summary: summarizePlan(plan) };
      row.timings[`${input}LlmMs`] = Date.now() - t0;
      console.log(`  ${input}: ${row.plans[input].summary}${error ? ` (error: ${error})` : ''} in ${Date.now() - t0} ms`);
    }

    const primary = row.plans[inputs[0]] && row.plans[inputs[0]].plan;
    if (primary) {
      const overlay = correctionToPp3(primary, effectiveBase(resolved), { strength: args.strength ? +args.strength : (cfg.llm && cfg.llm.strength) || 1 });
      if (overlay) {
        const ov = path.join(out, `${stem}__ai.pp3`);
        fs.writeFileSync(ov, overlay.text);
        const after = path.join(out, `${stem}__after.jpg`);
        const ra = await render(t, { source: f, out: after, base: resolved.profilePath, formatOverlay: resolved.formatOverlayPath, aiOverlay: ov, mode: 'draft' });
        row.after = ra.ok ? path.basename(after) : null;
      } else row.after = path.basename(before);
    }
    row.before = path.basename(before);
    results.push(row);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION, inputs, results }, null, 2));
  }

  // Agreement between inputs: mean absolute step difference per photo (0 = identical plans).
  const agreement = {};
  for (let i = 1; i < inputs.length; i += 1) {
    const d = results.map((r) => (r.plans[inputs[0]] && r.plans[inputs[i]] && r.plans[inputs[i]].plan
      ? planDistance(r.plans[inputs[0]].plan, r.plans[inputs[i]].plan, STEP_KEYS) : null)).filter((x) => x !== null);
    agreement[`${inputs[0]} vs ${inputs[i]}`] = d.length ? { meanStepDiff: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), identical: d.filter((x) => x === 0).length, photos: d.length } : null;
  }
  const usage = Object.fromEntries(STEP_KEYS.map((k) => [k, results.filter((r) => r.plans[inputs[0]] && r.plans[inputs[0]].plan && r.plans[inputs[0]].plan.adjustments[k]).length]));

  let html = `<!doctype html><meta charset="utf-8"><title>AI correction before/after</title><style>${PAGE_CSS}</style>`
    + `<h1>AI correction: before / after (${esc(provider.name)} ${esc(provider.model)}, prompt ${PROMPT_VERSION}, step table ${TABLE_STATUS})</h1>`
    + `<p class="dim">Before = base profile draft render. After = the same with the AI overlay from the <b>${esc(inputs[0])}</b> plan. `
    + 'Gate: does "after" look better on most photos?</p>'
    + `<p>Agreement between input images: ${esc(JSON.stringify(agreement))}</p><p>How often each step was used: ${esc(JSON.stringify(usage))}</p>`;
  for (const r of results) {
    html += `<h2>${esc(r.file)} <span class="dim">ISO ${r.iso ?? '?'} · base ${esc(r.base)}</span></h2><div class="row">`
      + `<figure><img loading="lazy" src="${esc(r.before)}"><figcaption>before</figcaption></figure>`
      + `<figure><img loading="lazy" src="${esc(r.after || r.before)}"><figcaption>after: ${esc((r.plans[inputs[0]] || {}).summary || '')}</figcaption></figure></div><table><tr><th>input</th>`
      + `${STEP_KEYS.map((k) => `<th>${k}</th>`).join('')}<th>scene / lighting / issues / tags</th><th>notes</th><th>LLM ms</th></tr>`;
    for (const input of inputs) {
      const p = r.plans[input];
      if (!p || !p.plan) { html += `<tr><td>${input}</td><td colspan="${STEP_KEYS.length + 3}">${esc(p && p.error)}</td></tr>`; continue; }
      const tags = p.plan.sceneTags ? `${p.plan.sceneTags.setting}/${p.plan.sceneTags.subject}: ${p.plan.sceneTags.caption}` : '';
      html += `<tr><td>${input}</td>${STEP_KEYS.map((k) => `<td>${p.plan.adjustments[k] || ''}</td>`).join('')}`
        + `<td>${esc(`${p.plan.scene} / ${p.plan.lighting} / ${p.plan.issues.join(',')} / ${tags}`)}</td><td>${esc(p.plan.notes)}</td><td>${r.timings[`${input}LlmMs`]}</td></tr>`;
    }
    html += '</table>';
  }
  fs.writeFileSync(path.join(out, 'index.html'), html);
  console.log(`Agreement: ${JSON.stringify(agreement)}`);
  console.log(`Page: ${path.join(out, 'index.html')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
