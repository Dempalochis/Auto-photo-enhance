const fs = require('fs');
const path = require('path');

// A cached preview grid for one photo is only valid if it matches the *current* preset files -
// both which presets exist (added/removed/renamed - the original check) and each one's actual
// content. Content is tracked cheaply via mtime+size (not a full file hash, which would mean
// reading every .pp3's bytes on every /api/preview call just to maybe not use them) - editing a
// .pp3 in place, same filename, now correctly invalidates the cache instead of silently serving
// a stale render forever (V6 Phase 5). Note this invalidates the *whole* per-photo cache, not
// just the one edited preset's tile: preview_presets.ps1 always re-renders every preset in one
// pass (it has no per-file freshness check of its own), so there's no cheaper granularity to
// invalidate at today without changing that script's own behavior.
function presetsFingerprint(presetsDir, presetNames) {
  return presetNames.map((name) => {
    try {
      const stat = fs.statSync(path.join(presetsDir, `${name}.pp3`));
      return { name, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      // Vanished between listPresetNames() and this stat (e.g. deleted mid-request) - a
      // deliberately unstable marker so this fingerprint can never accidentally equal a real
      // previous one, rather than throwing and failing the whole preview request over it.
      return { name, mtimeMs: null, size: null };
    }
  });
}

// Whether a previously-written manifest still matches `currentFingerprint`. Tolerates a missing
// manifest (no cache yet) and an old-format manifest (written before this feature existed, which
// only recorded a bare preset-name list under `presets`, not `presetsFingerprint`) by treating
// both as "not fresh" rather than crashing on the shape mismatch - a cache miss just means a
// normal re-render, same as any other first-time preview.
function isManifestFresh(manifest, currentFingerprint) {
  if (!manifest || !Array.isArray(manifest.presetsFingerprint)) return false;
  return JSON.stringify(manifest.presetsFingerprint) === JSON.stringify(currentFingerprint);
}

module.exports = { presetsFingerprint, isManifestFresh };
