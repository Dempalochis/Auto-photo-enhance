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

// ---- Version 2 Phase 1: composite fingerprint over EVERY input a preview tile is rendered from ----
// Version 1 fingerprinted only the presets, so editing a base profile, a format overlay, the draft
// profile, the profile settings in config.json, or replacing the source raw under the same name
// kept serving stale tiles (a known Version 1 bug). Every input is still mtime + size only (no
// file contents read). Old manifests (no `version: 2`) count as stale: a one-time re-render.
const PREVIEW_MANIFEST_VERSION = 2;

function statEntry(file) {
  try {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { mtimeMs: null, size: null };
  }
}

function profilesFingerprint(profilesDir) {
  let names = [];
  try {
    names = fs.readdirSync(profilesDir).filter((f) => f.toLowerCase().endsWith('.pp3')).sort();
  } catch {
    names = [];
  }
  return names.map((name) => ({ name, ...statEntry(path.join(profilesDir, name)) }));
}

// The config.json fields that decide which profile Get-BaseProfileForFile picks.
function profileConfigFingerprint(rawConfig, exiftoolPath) {
  const c = rawConfig || {};
  return {
    defaultProfile: c.defaultProfile ?? null,
    autoProfile: c.autoProfile ? JSON.parse(JSON.stringify(c.autoProfile)) : null,
    exiftoolPresent: Boolean(exiftoolPath && fs.existsSync(exiftoolPath)),
  };
}

function previewFingerprint({
  presetsDir, presetNames, profilesDir, rawConfig, exiftoolPath, sourceFile, aiOverlayHash = null,
}) {
  return {
    version: PREVIEW_MANIFEST_VERSION,
    inputs: {
      presets: presetsFingerprint(presetsDir, presetNames),
      profiles: profilesFingerprint(profilesDir),
      config: profileConfigFingerprint(rawConfig, exiftoolPath),
      source: statEntry(sourceFile),
      aiOverlay: aiOverlayHash,
    },
  };
}

function isPreviewManifestFresh(manifest, current) {
  if (!manifest || manifest.version !== PREVIEW_MANIFEST_VERSION || !manifest.inputs) return false;
  return JSON.stringify(manifest.inputs) === JSON.stringify(current.inputs);
}

module.exports.PREVIEW_MANIFEST_VERSION = PREVIEW_MANIFEST_VERSION;
module.exports.previewFingerprint = previewFingerprint;
module.exports.isPreviewManifestFresh = isPreviewManifestFresh;
module.exports.profilesFingerprint = profilesFingerprint;
