const fs = require('fs');

// Validates the pieces of config a working batch-conversion pipeline actually needs, so a
// missing/misconfigured path is reported clearly and immediately at startup instead of
// surfacing later as a cryptic failure deep inside a spawned rawtherapee-cli/exiftool process.
//
// Deliberately does not refuse to start the server on an error: this is a local single-user
// tool, and half of it (browsing/filtering photos) works fine even with a broken RawTherapee
// path - locking the whole UI out over one bad config field would be worse than surfacing the
// problem loudly and letting the user fix config/config.json (or the source folder, from the
// UI itself) without losing access to everything else. See GET /api/health in server.js.
function checkStartupConfig(cfg) {
  const errors = [];
  const warnings = [];

  if (!cfg.rtPath || !fs.existsSync(cfg.rtPath)) {
    errors.push(`rawtherapee-cli not found at "${cfg.rtPath}" - set "rtPath" in config/config.json. Previews and batch runs will fail until this is fixed.`);
  }
  if (!cfg.scriptsDir || !fs.existsSync(cfg.scriptsDir)) {
    errors.push(`scripts folder not found at "${cfg.scriptsDir}" - the repo layout looks wrong.`);
  }
  if (!cfg.presetsDir || !fs.existsSync(cfg.presetsDir)) {
    warnings.push(`presets folder not found at "${cfg.presetsDir}" - the preset preview grid will be empty.`);
  }
  if (!cfg.exiftoolPath || !fs.existsSync(cfg.exiftoolPath)) {
    warnings.push('exiftoolPath not set or not found in config/config.json - photo capture dates will fall back to file-modified time, and thumbnails will be unavailable.');
  }
  if (!cfg.photosDir || !fs.existsSync(cfg.photosDir)) {
    warnings.push(`configured photosDir "${cfg.photosDir}" does not exist - use the Source folder picker in the UI to point at a real folder.`);
  }

  return { errors, warnings };
}

module.exports = { checkStartupConfig };
