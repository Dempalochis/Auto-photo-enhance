// Rough estimate from real-world samples taken during development: full-resolution Sony ARW
// (~24MP) converted to a q95 JPEG landed around 6-7MB per file. Rounded up for headroom - this
// is a warn-only heuristic, not a precise prediction, since actual size depends on scene detail.
const AVG_OUTPUT_JPEG_BYTES = 8 * 1024 * 1024;

function estimateRequiredBytes(fileCount) {
  return fileCount * AVG_OUTPUT_JPEG_BYTES;
}

// Returns a human-readable warning if free space looks tight for the batch about to run, or
// null if there's no concern. Deliberately warn-only, never a hard block: the estimate is a
// guess (real JPEG size varies with scene complexity), so refusing to run on a guess that might
// be wrong would trade a maybe-problem for a definite one. A batch that actually runs out of
// space partway through still fails safely - already-converted files stay on disk and the
// pipeline's own idempotency check picks up where it left off on a re-run.
// `freeBytes` of null/undefined means "couldn't be determined" - fails open (no warning) rather
// than alarming the user over a reading we don't actually have.
function checkDiskSpaceWarning(freeBytes, fileCount) {
  if (freeBytes == null || fileCount <= 0) return null;
  const required = estimateRequiredBytes(fileCount);
  if (freeBytes >= required) return null;

  const freeGB = (freeBytes / 1024 ** 3).toFixed(1);
  const neededGB = (required / 1024 ** 3).toFixed(1);
  return `Low disk space on the output drive: about ${freeGB} GB free, this batch could need `
    + `roughly ${neededGB} GB. It will still run - already-converted files are safe either way - `
    + 'but it may run out of space partway through.';
}

module.exports = { estimateRequiredBytes, checkDiskSpaceWarning, AVG_OUTPUT_JPEG_BYTES };
