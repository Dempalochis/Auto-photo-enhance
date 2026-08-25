// Single source of truth for which raw file extensions this app accepts - used by both the
// photo-listing logic (server.js) and the security-critical path-safety check (pathSafety.js),
// so the two can never drift apart from each other. V9: expanded beyond the original Sony
// .ARW-only restriction, which was never an engine limitation - RawTherapee itself already
// renders these formats natively. See V9_PLAN.md (local-only, not shipped) for the full
// reasoning, including the open question of whether the existing Sony-tuned profiles/presets
// need format-specific variants - that's a separate, unverified question from "is the file
// accepted at all," which is all this module is responsible for.
const SUPPORTED_RAW_EXTENSIONS = ['arw', 'nef', 'dng', 'raf'];

// Case-insensitive; matches any supported extension at the end of a filename/path.
const RAW_FILE_PATTERN = new RegExp(`\\.(${SUPPORTED_RAW_EXTENSIONS.join('|')})$`, 'i');

function isRawFile(name) {
  return RAW_FILE_PATTERN.test(name);
}

module.exports = { SUPPORTED_RAW_EXTENSIONS, RAW_FILE_PATTERN, isRawFile };
