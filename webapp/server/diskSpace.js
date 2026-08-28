// Rough per-file estimate for a full-resolution raw -> q95 JPEG. Started life calibrated on Sony
// ARW (~24MP: 6-7MB per file). V9 spot-checks against real files of the newly-supported formats
// (Nikon D200 10MP ~4MB, Leica M9 18MP ~5.4MB, Fujifilm X-T2 24MP X-Trans ~9.4MB) showed a
// detailed high-MP frame can exceed the old 8MB figure, so it's bumped to 12MB: a single
// cross-format rough average, deliberately not a per-format/per-resolution model. This is a
// warn-only heuristic that never blocks a run (see checkDiskSpaceWarning), so erring high (warn
// a bit early) is the safe direction; a 40MP+ body on very detailed scenes may still exceed it,
// which the "advisory only" design absorbs the same way it already does for scene-complexity
// variance within a single format.
const AVG_OUTPUT_JPEG_BYTES = 12 * 1024 * 1024;

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
// `queuedAheadFileCount` is the photo count of every other still-open 'run' job (queued or
// running) at the moment this one is submitted - all of that work will also consume disk space
// before this job even starts, so a job that looks fine in isolation can still land on a drive
// that's actually about to fill up. Defaults to 0 so a caller that doesn't know about the queue
// (or a direct unit test) gets the exact old single-job behavior.
function checkDiskSpaceWarning(freeBytes, fileCount, queuedAheadFileCount = 0) {
  if (freeBytes == null || fileCount <= 0) return null;
  const aheadCount = Math.max(0, queuedAheadFileCount);
  const totalFileCount = fileCount + aheadCount;
  const required = estimateRequiredBytes(totalFileCount);
  if (freeBytes >= required) return null;

  const freeGB = (freeBytes / 1024 ** 3).toFixed(1);
  const neededGB = (required / 1024 ** 3).toFixed(1);
  const queueNote = aheadCount > 0
    ? ` (including ${aheadCount} photo${aheadCount === 1 ? '' : 's'} already queued ahead of it)`
    : '';
  return `Low disk space on the output drive: about ${freeGB} GB free, this batch could need `
    + `roughly ${neededGB} GB${queueNote}. It will still run - already-converted files are safe `
    + 'either way - but it may run out of space partway through.';
}

module.exports = { estimateRequiredBytes, checkDiskSpaceWarning, AVG_OUTPUT_JPEG_BYTES };
