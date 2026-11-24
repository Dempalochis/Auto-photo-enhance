// Version 2 Phase 4 (LLM plan §8): on-disk cache for AI correction plans, user edits, generated
// overlays and analysis draft renders, under .webapp_cache/corrections/:
//   plans/<planKey>.json   LLM plan for one photo + provider/model/prompt/input/base profile
//   edits/<photoKey>.json  the user's edited plan for one photo: ALWAYS wins over the LLM's
//   pp3/<sha1>.pp3         overlays, content-addressed (same values = same file = same batch signature)
//   drafts/*.jpg           draft renders used as LLM input and for the review page
//   runs/<jobId>.json      the -CorrectionsJson map handed to auto_enhance.ps1 for one run
// The overlay is regenerated from the plan at render time, never cached as the source of truth,
// so changing the step table or the strength applies without asking the LLM again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFileSync } = require('./atomicFile');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function statSig(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

// Identity of one photo's content: path + size + mtime (a replaced file is a new photo).
function photoKey(absPath, size, mtime) {
  return sha1(`${String(absPath).toLowerCase()}|${size}|${Math.round(mtime || 0)}`).slice(0, 20);
}

// The base profile + format overlay files the plan was made against.
function baseFingerprint(resolved) {
  return sha1(`${resolved.profilePath}|${statSig(resolved.profilePath)}|${resolved.formatOverlayPath || ''}|${resolved.formatOverlayPath ? statSig(resolved.formatOverlayPath) : ''}`).slice(0, 12);
}

function planKey({ photo, provider, model, promptVersion, inputKind, baseFp }) {
  return sha1([photo, provider, model, promptVersion, inputKind, baseFp].join('|')).slice(0, 24);
}

function createCorrectionsCache(rootDir) {
  const dirs = {
    plans: path.join(rootDir, 'plans'),
    edits: path.join(rootDir, 'edits'),
    pp3: path.join(rootDir, 'pp3'),
    drafts: path.join(rootDir, 'drafts'),
    runs: path.join(rootDir, 'runs'),
  };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

  return {
    dirs,
    getPlan: (key) => readJson(path.join(dirs.plans, `${key}.json`)),
    putPlan: (key, record) => atomicWriteFileSync(path.join(dirs.plans, `${key}.json`), JSON.stringify(record, null, 2)),
    getEdit: (pk) => readJson(path.join(dirs.edits, `${pk}.json`)),
    putEdit: (pk, record) => atomicWriteFileSync(path.join(dirs.edits, `${pk}.json`), JSON.stringify(record, null, 2)),
    deleteEdit: (pk) => fs.rmSync(path.join(dirs.edits, `${pk}.json`), { force: true }),
    // Content-addressed overlay file; returns { path, hash }.
    writeOverlay(text) {
      const hash = sha1(text);
      const file = path.join(dirs.pp3, `${hash}.pp3`);
      if (!fs.existsSync(file)) atomicWriteFileSync(file, text);
      return { path: file, hash };
    },
    draftPath: (pk, baseFp, overlayHash) => path.join(dirs.drafts, `${pk}_${baseFp}${overlayHash ? `_ai_${overlayHash.slice(0, 12)}` : ''}.jpg`),
    runFile: (jobId) => path.join(dirs.runs, `${jobId}.json`),
    writeRunFile: (jobId, map) => atomicWriteFileSync(path.join(dirs.runs, `${jobId}.json`), JSON.stringify(map, null, 2)),
  };
}

module.exports = {
  createCorrectionsCache, photoKey, baseFingerprint, planKey, statSig,
};
