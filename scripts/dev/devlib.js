// Shared helpers for the Version 2 Phase 0 experiment scripts in scripts/dev/ (Node, no extra
// dependencies; reuses the server's modules). Dev tooling only: nothing here is used by the app.
// They call rawtherapee-cli directly with the SAME -p order the pipeline uses:
//   base -> format overlay -> AI overlay -> preset -> (draft only) draft override, + -f for drafts.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO, 'webapp', 'server');
const req = (m) => require(path.join(SERVER, m));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function readRawConfig(configPath) {
  const p = configPath || path.join(REPO, 'config', 'config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function findTool(configured, names) {
  if (configured && fs.existsSync(configured)) return configured;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) for (const n of names) { const f = path.join(d, n); if (fs.existsSync(f)) return f; }
  return configured || names[0];
}

function tools(rawConfig) {
  return {
    rt: findTool(rawConfig.rtPath, ['rawtherapee-cli.exe', 'rawtherapee-cli']),
    exiftool: findTool(rawConfig.exiftoolPath, ['exiftool.exe', 'exiftool']),
  };
}

function run(cmd, args, { capture = true } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    if (capture) { p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; }); }
    p.on('error', (e) => resolve({ code: -1, out, err: String(e), ms: Date.now() - t0 }));
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}

function listRaws(dir, max) {
  const { isRawFile } = req('rawFormats');
  const files = fs.readdirSync(dir).filter(isRawFile).sort().map((f) => path.join(dir, f));
  return max ? files.slice(0, max) : files;
}

// Draft render (-f + draft override last) or a full-pipeline render at draft size (no -f).
async function render(t, { source, out, base, formatOverlay, aiOverlay, preset, mode = 'draft' }) {
  const draftPp3 = fs.existsSync(path.join(REPO, 'profiles', 'draft_override.pp3'))
    ? path.join(REPO, 'profiles', 'draft_override.pp3') : path.join(REPO, 'profiles', 'preview_fast_resize.pp3');
  const a = [];
  if (mode === 'draft') a.push('-f');
  a.push('-p', base);
  if (formatOverlay) a.push('-p', formatOverlay);
  if (aiOverlay) a.push('-p', aiOverlay);
  if (preset) a.push('-p', preset);
  if (mode === 'draft' || mode === 'fullSmall') a.push('-p', draftPp3);
  a.push('-o', out, '-j92', '-Y', '-q', '-c', source);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = await run(t.rt, a);
  return { ...r, ok: r.code === 0 && fs.existsSync(out) && !/Usage:/.test(r.out) };
}

async function extractEmbedded(t, source, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  for (const tag of ['-PreviewImage', '-JpgFromRaw', '-ThumbnailImage']) {
    const r = await new Promise((resolve) => {
      const p = spawn(t.exiftool, ['-b', tag, source]);
      const chunks = [];
      p.stdout.on('data', (d) => chunks.push(d));
      p.on('error', () => resolve(null));
      p.on('close', () => resolve(Buffer.concat(chunks)));
    });
    if (r && r.length > 1000) { fs.writeFileSync(out, r); return true; }
  }
  return false;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const PAGE_CSS = `body{font-family:sans-serif;background:#111;color:#eee;margin:0;padding:24px}
h1{font-size:18px;font-weight:normal} h2{font-size:15px;color:#ccc;margin-top:28px}
.row{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-bottom:18px}
figure{margin:0;background:#1a1a1a;border-radius:6px;overflow:hidden} img{width:100%;display:block}
figcaption{padding:6px 8px;font-size:12px;color:#bbb} .chip{display:inline-block;background:#333;border-radius:3px;padding:1px 6px;margin:1px;font-size:12px}
table{border-collapse:collapse;font-size:12px} td,th{border:1px solid #333;padding:3px 6px} .dim{color:#888}`;

module.exports = {
  REPO, SERVER, req, parseArgs, readRawConfig, tools, run, listRaws, render, extractEmbedded, esc, PAGE_CSS,
};
