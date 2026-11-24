// Node mirror of lib_common.ps1's Initialize-BaseProfileContext + Get-BaseProfileForFile: which
// base profile (ISO-branched) and format overlay a photo is rendered with. The AI overlay needs
// it to write absolute values (base + change). Kept deliberately identical to the PowerShell
// rules - tests/baseProfile.test.js pins them.
const fs = require('fs');
const path = require('path');
const { readPp3File } = require('./pp3');

function resolveBaseProfile({ profilesDir, rawConfig, exiftoolAvailable }, filePath, iso) {
  const c = rawConfig || {};
  const staticName = c.defaultProfile || 'default';
  let profileName = staticName;
  const auto = c.autoProfile;
  if (auto && auto.enabled && exiftoolAvailable && Number.isFinite(iso)) {
    const threshold = auto.isoThreshold || 800;
    profileName = iso >= threshold ? auto.highIsoProfile : auto.lowIsoProfile;
  }
  const profilePath = path.join(profilesDir, `${profileName}.pp3`);
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const overlay = ext ? path.join(profilesDir, `${ext}.pp3`) : null;
  return {
    profilePath,
    profileName,
    formatOverlayPath: overlay && fs.existsSync(overlay) ? overlay : null,
  };
}

// The effective key/value view of base + format overlay (overlay keys win), used as the "base
// value" for each AI step.
function effectiveBase(resolved) {
  const merged = {};
  for (const file of [resolved.profilePath, resolved.formatOverlayPath]) {
    if (!file || !fs.existsSync(file)) continue;
    const parsed = readPp3File(file);
    for (const [sec, keys] of Object.entries(parsed)) merged[sec] = { ...(merged[sec] || {}), ...keys };
  }
  return merged;
}

module.exports = { resolveBaseProfile, effectiveBase };
