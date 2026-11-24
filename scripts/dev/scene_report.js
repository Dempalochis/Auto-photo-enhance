#!/usr/bin/env node
// Version 2 Phase 0, task 5: run the time/EXIF scene segmentation (LLM plan §7.1 step 1) on a
// real shoot and write an HTML report with thumbnails per segment, so you can compare it with
// how you'd group the photos by hand.
//
//   node scripts/dev/scene_report.js <photo folder> [--out <dir>] [--gap 10] [--ev 3]
//        [--no-camera] [--no-flash] [--thumbs 8]
//
// Output: <out>/index.html (default: .webapp_cache/scene_report/<folder name>/).
const fs = require('fs');
const path = require('path');
const {
  REPO, req, parseArgs, readRawConfig, tools, extractEmbedded, esc, PAGE_CSS,
} = require('./devlib');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args._[0];
  if (!dir || !fs.existsSync(dir)) {
    console.error('usage: node scripts/dev/scene_report.js <photo folder> [--gap 10] [--ev 3] [--no-camera] [--no-flash]');
    process.exit(2);
  }
  const cfg = readRawConfig(args.config);
  const t = tools(cfg);
  const { getPhotoMetadata } = req('captureDates');
  const { segmentPhotos, exposureValue } = req('sceneSegmenter');
  const { isRawFile } = req('rawFormats');

  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return (e.name === 'failed' || e.name.startsWith('.')) ? [] : walk(f);
    return isRawFile(e.name) ? [f] : [];
  });
  const files = walk(path.resolve(dir));
  const meta = await getPhotoMetadata(t.exiftool, files);
  const photos = files.map((f) => {
    const m = meta[path.resolve(f)] || {};
    const rel = path.relative(dir, f).split(path.sep).join('/');
    return { relPath: rel, abs: f, ...m, dateTaken: m.dateTaken || new Date(fs.statSync(f).mtimeMs).toISOString().slice(0, 19) };
  });
  const opts = {
    maxGapMinutes: args.gap ? +args.gap : (cfg.scenes && cfg.scenes.maxGapMinutes),
    evJumpThreshold: args.ev ? +args.ev : (cfg.scenes && cfg.scenes.evJumpThreshold),
    splitByCamera: args['no-camera'] ? false : (cfg.scenes && cfg.scenes.splitByCamera),
    splitByFlash: !args['no-flash'],
  };
  const { segments, ungrouped } = segmentPhotos(photos, opts);

  const out = args.out || path.join(REPO, '.webapp_cache', 'scene_report', path.basename(path.resolve(dir)));
  const thumbDir = path.join(out, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  const byRel = Object.fromEntries(photos.map((p) => [p.relPath, p]));
  const maxThumbs = args.thumbs ? +args.thumbs : 8;

  let html = `<!doctype html><meta charset="utf-8"><title>Scene report - ${esc(dir)}</title><style>${PAGE_CSS}</style>`;
  html += `<h1>Scene segmentation for ${esc(dir)}</h1><p class="dim">${photos.length} photos -> ${segments.length} segments `
    + `(gap ${opts.maxGapMinutes ?? 10} min, EV jump ${opts.evJumpThreshold ?? 3}, camera split ${opts.splitByCamera !== false}, flash split ${opts.splitByFlash}). `
    + 'Compare with your own grouping: note segments you would merge or split.</p>';
  for (const s of segments) {
    html += `<h2>#${s.index} ${esc(s.name)} <span class="dim">starts because: ${esc(s.startReason)}; EV ${s.evMedian ?? '?'}; ${esc(s.camera || '')}${s.flash ? '; flash' : ''}</span></h2><div class="row">`;
    const shown = s.photos.length <= maxThumbs ? s.photos : [...s.photos.slice(0, maxThumbs - 1), s.photos[s.photos.length - 1]];
    for (const rel of shown) {
      const p = byRel[rel];
      const thumb = `${rel.replace(/[\\/]/g, '__')}.jpg`;
      const thumbPath = path.join(thumbDir, thumb);
      if (!fs.existsSync(thumbPath)) await extractEmbedded(t, p.abs, thumbPath);
      const ev = exposureValue(p);
      html += `<figure><img loading="lazy" src="thumbs/${esc(thumb)}"><figcaption>${esc(rel)}<br>${esc(p.dateTaken.replace('T', ' '))} · ISO ${p.iso ?? '?'} · EV ${ev === null ? '?' : ev.toFixed(1)}</figcaption></figure>`;
    }
    if (shown.length < s.photos.length) html += `<p class="dim">… ${s.photos.length - shown.length} more</p>`;
    html += '</div>';
  }
  if (ungrouped.length) html += `<h2>Ungrouped (no capture time)</h2><p>${ungrouped.map(esc).join(', ')}</p>`;
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.writeFileSync(path.join(out, 'segments.json'), JSON.stringify({ options: opts, segments, ungrouped }, null, 2));
  console.log(`${photos.length} photos -> ${segments.length} segments`);
  for (const s of segments) console.log(`  #${s.index} ${s.name}  (${s.startReason})`);
  console.log(`Report: ${path.join(out, 'index.html')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
