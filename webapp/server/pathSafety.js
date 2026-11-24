const path = require('path');
const { RAW_FILE_PATTERN } = require('./rawFormats');

// A "photo" is identified everywhere by its path relative to the active photos root (POSIX
// separators, e.g. "Ceremony/DSC00001.ARW", or just "DSC00001.ARW" for top-level files) rather
// than a bare filename, since scanning subfolders means two different sessions can share a
// filename. Pulled out of server.js (rather than left as inline closures) so these path-safety
// rules can be unit tested without booting the whole Express app.

function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  // Both flavours: on Windows path.isAbsolute already is the win32 check (which also rejects
  // "/etc/x"), so this is a no-op there; on a POSIX dev/CI box it additionally rejects
  // "C:\\x" style paths, keeping the security rule identical on every platform.
  if (path.win32.isAbsolute(relPath) || path.posix.isAbsolute(relPath)) return false;
  if (!RAW_FILE_PATTERN.test(relPath)) return false;
  const segments = relPath.split(/[\\/]/);
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return false;
  return true;
}

// Resolves a relPath against rootDir, re-checking the result still lands inside rootDir
// (defense in depth beyond isSafeRelPath's textual check). Returns null if it escapes.
function resolvePhotoPath(rootDir, relPath) {
  const rootResolved = path.resolve(rootDir);
  // relPaths may use either separator; Windows path.resolve already treats '\\' as one, so
  // normalising to '/' changes nothing there, and makes POSIX treat it the same way.
  const resolved = path.resolve(rootDir, String(relPath).replace(/\\/g, '/'));
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

// Flattens a relPath into a single safe path segment for use as a cache key/folder name,
// e.g. "Ceremony/DSC00001.ARW" -> "Ceremony__DSC00001".
function cacheKeyFor(relPath) {
  return relPath.replace(RAW_FILE_PATTERN, '').split(/[\\/]/).join('__');
}

function sanitizeProjectName(name) {
  const cleaned = String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return cleaned.length > 0 ? cleaned : 'project';
}

function projectFolderName(projectName, dateStr = new Date().toISOString().slice(0, 10)) {
  return `${sanitizeProjectName(projectName)}_${dateStr}`;
}

// Mirrors auto_enhance.ps1's own output naming exactly, so a cancelled job can find and delete
// the JPEG it was in the middle of writing - otherwise a half-written file left behind would be
// silently treated as "already converted" by the pipeline's own idempotency check on every future
// run of this project. No preset (or 'none') keeps the original base name, unchanged from before
// presets existed; a selected preset appends "_<preset>" so different looks of the same source
// photo don't collide/overwrite each other in the output folder.
// Version 2 Phase 4: AI-corrected runs add "_ai" before the preset suffix (<name>_ai[_<preset>]).
function outputFileFor(outputDir, relPath, preset, { ai = false } = {}) {
  const relDir = path.posix.dirname(relPath); // '.' for a top-level file
  const stem = path.posix.basename(relPath, path.posix.extname(relPath));
  const base = ai ? `${stem}_ai` : stem;
  const outBase = preset && preset !== 'none' ? `${base}_${preset}` : base;
  return relDir === '.' ? path.join(outputDir, `${outBase}.jpg`) : path.join(outputDir, relDir, `${outBase}.jpg`);
}

module.exports = {
  isSafeRelPath, resolvePhotoPath, cacheKeyFor, sanitizeProjectName, projectFolderName, outputFileFor,
};
