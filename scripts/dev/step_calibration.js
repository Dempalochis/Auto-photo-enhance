#!/usr/bin/env node
// Version 2 Phase 0, task 4a: calibrate the step table (webapp/server/correctionTable.js) by eye.
// For each photo, renders the base draft and every single step at -2, -1, +1, +2 (all other
// steps 0), through the real AI-overlay code path, and writes an HTML grid. Use it to check that
// "+1" is a sensible amount, and that tint/warmth actually change the image with auto-ITC WB.
//
//   node scripts/dev/step_calibration.js <photo folder or file> [--max 5] [--steps exposure,tint]
//        [--mode draft|fullSmall] [--out <dir>]
//
// --mode fullSmall renders without -f (full-quality pipeline, resized) - slower, but shows
// highlight recovery and white balance exactly as a final render would.
const fs = require('fs');
const path = require('path');
const {
  REPO, req, parseArgs, readRawConfig, tools, listRaws, render, esc, PAGE_CSS,
} = require('./devlib');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args._[0] || path.join(REPO, '_samples');
  const cfg = readRawConfig(args.config);
  const t = tools(cfg);
  const { STEP_KEYS, TABLE_STATUS } = req('correctionTable');
  const { validatePlan } = req('correctionPlan');
  const { correctionToPp3 } = req('correctionToPp3');
  const { resolveBaseProfile, effectiveBase } = req('baseProfile');
  const { getPhotoMetadata } = req('captureDates');

  const files = fs.statSync(target).isDirectory() ? listRaws(target, args.max ? +args.max : 5) : [target];
  const steps = args.steps ? String(args.steps).split(',') : STEP_KEYS;
  const mode = args.mode === 'fullSmall' ? 'fullSmall' : 'draft';
  const out = args.out || path.join(REPO, '.webapp_cache', 'step_calibration');
  fs.mkdirSync(out, { recursive: true });
  const meta = await getPhotoMetadata(t.exiftool, files);

  let html = `<!doctype html><meta charset="utf-8"><title>Step calibration</title><style>${PAGE_CSS}</style>`
    + `<h1>Step calibration (table status: ${esc(TABLE_STATUS)}, mode ${mode})</h1>`
    + '<p class="dim">Each row is one step at -2, -1, 0, +1, +2 with every other step at 0. Edit webapp/server/correctionTable.js and re-run.</p>';
  for (const f of files) {
    const iso = (meta[path.resolve(f)] || {}).iso;
    const resolved = resolveBaseProfile({ profilesDir: path.join(REPO, 'profiles'), rawConfig: cfg, exiftoolAvailable: fs.existsSync(t.exiftool) }, f, iso);
    const baseParsed = effectiveBase(resolved);
    const stem = path.basename(f).replace(/\W+/g, '_');
    const baseOut = path.join(out, `${stem}__base.jpg`);
    const r0 = await render(t, { source: f, out: baseOut, base: resolved.profilePath, formatOverlay: resolved.formatOverlayPath, mode });
    console.log(`${path.basename(f)} base (${resolved.profileName}) ${r0.ok ? 'ok' : 'FAILED'} ${r0.ms} ms`);
    html += `<h2>${esc(path.basename(f))} <span class="dim">ISO ${iso ?? '?'}, base ${esc(resolved.profileName)}</span></h2>`;
    for (const step of steps) {
      html += `<p class="dim">${esc(step)}</p><div class="row">`;
      for (const v of [-2, -1, 0, 1, 2]) {
        let img = path.basename(baseOut);
        if (v !== 0) {
          const { plan } = validatePlan({ adjustments: { [step]: v } });
          const overlay = correctionToPp3(plan, baseParsed);
          const ovFile = path.join(out, `${stem}__${step}_${v}.pp3`);
          fs.writeFileSync(ovFile, overlay.text);
          const o = path.join(out, `${stem}__${step}_${v}.jpg`);
          const r = await render(t, { source: f, out: o, base: resolved.profilePath, formatOverlay: resolved.formatOverlayPath, aiOverlay: ovFile, mode });
          console.log(`  ${step} ${v > 0 ? '+' : ''}${v}: ${r.ok ? 'ok' : 'FAILED'} ${r.ms} ms`);
          img = path.basename(o);
        }
        html += `<figure><img loading="lazy" src="${esc(img)}"><figcaption>${esc(step)} ${v > 0 ? '+' : ''}${v}</figcaption></figure>`;
      }
      html += '</div>';
    }
  }
  fs.writeFileSync(path.join(out, 'index.html'), html);
  console.log(`Grid: ${path.join(out, 'index.html')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
