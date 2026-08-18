const fs = require('fs');
const { isSafeRelPath, resolvePhotoPath } = require('./pathSafety');

// Only a job that finished *without* succeeding is retryable - a still-open job
// (queued/running/paused) makes no sense to retry, and a successfully 'done' job has nothing
// left to retry. 'interrupted' (server restarted mid-job) counts too: from the user's
// perspective that's the same "didn't finish, want to try again" situation as an error.
const RETRYABLE_STATUSES = ['error', 'cancelled', 'interrupted'];

// Whether `job` can be retried at all, independent of whether its original files still exist
// (see resolveRetryFiles for that). Only 'run' jobs are retryable - a 'preview' job re-renders
// for free the next time its photo is previewed, so there's no separate retry action for it.
function canRetry(job) {
  if (!job) return { ok: false, error: 'job not found' };
  if (job.type !== 'run') return { ok: false, error: `cannot retry a job of type "${job.type}"` };
  if (!RETRYABLE_STATUSES.includes(job.status)) {
    return { ok: false, error: `cannot retry a job with status "${job.status}"` };
  }
  return { ok: true };
}

// Re-resolves every original file against the *original* source folder recorded on the job's
// meta (not necessarily today's active folder, which may have changed since the original run) -
// a file moved/renamed/deleted since then fails the whole retry with a clear error up front,
// rather than silently queuing a batch that can only partially succeed. `meta.files` only exists
// on jobs created after this feature landed; an older job predating it fails the same way a
// job with genuinely missing files would, with a message that says so.
function resolveRetryFiles(meta) {
  const { files, sourceFolder } = meta || {};
  if (!Array.isArray(files) || files.length === 0 || !sourceFolder) {
    return { ok: false, error: 'original job has no retryable file list' };
  }
  const absoluteFiles = [];
  for (const relPath of files) {
    const resolved = isSafeRelPath(relPath) ? resolvePhotoPath(sourceFolder, relPath) : null;
    if (!resolved || !fs.existsSync(resolved)) {
      return { ok: false, error: `source photo no longer available: ${relPath}` };
    }
    absoluteFiles.push(resolved);
  }
  return { ok: true, absoluteFiles };
}

module.exports = { RETRYABLE_STATUSES, canRetry, resolveRetryFiles };
