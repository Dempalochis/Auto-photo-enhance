// Estimates "time until this job finishes" (etaMs) for every job currently queued or running,
// derived entirely from data the job store already has - no new instrumentation needed beyond
// what jobTiming.js/the progress-item lists already track.
//
// A queued job's ETA is the wait behind everything ahead of it (including the active job's own
// remaining time) plus its own estimated duration - not just its own render time in isolation,
// since that's what's actually useful to show ("this job finishes in ~4 minutes"), not "this
// job takes about 90 seconds to run once it starts."

// Historical per-unit duration (ms per photo for 'run' jobs, ms per preset render for 'preview'
// jobs) from a rolling average of the most recently *completed* jobs of the same type - the
// only data available before a job of that type has ever run.
function averageMsPerUnit(recentCompletedJobs) {
  const samples = recentCompletedJobs
    .map((j) => {
      const unitCount = j.progress?.items?.length;
      const durationMs = j.startedAt != null && j.finishedAt != null ? j.finishedAt - j.startedAt : null;
      return unitCount > 0 && durationMs != null ? durationMs / unitCount : null;
    })
    .filter((v) => v != null);
  if (samples.length === 0) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

// Remaining time for a job already running: extrapolates from its own progress so far once at
// least one item has finished (more accurate than a historical average, since it reflects this
// specific photo/batch's actual speed on this run), falling back to the historical average only
// before the first item completes.
function estimateRunningRemainingMs(job, fallbackMsPerUnit) {
  const items = job.progress?.items;
  if (!items || items.length === 0) return null;
  const doneCount = items.filter((i) => ['done', 'failed', 'cancelled'].includes(i.status)).length;
  const remaining = items.length - doneCount;
  if (remaining <= 0) return 0;
  if (doneCount > 0 && job.startedAt != null) {
    const elapsedMs = Date.now() - job.startedAt;
    return Math.round((elapsedMs / doneCount) * remaining);
  }
  return fallbackMsPerUnit != null ? Math.round(fallbackMsPerUnit * remaining) : null;
}

// Estimated total duration for a job that hasn't started yet.
function estimateOwnDurationMs(job, fallbackMsPerUnit) {
  const unitCount = job.progress?.items?.length ?? job.meta?.photoCount;
  if (!unitCount || fallbackMsPerUnit == null) return null;
  return Math.round(fallbackMsPerUnit * unitCount);
}

// `executionOrder`: [activeJobOrNull, ...queuedJobsInActualFifoOrder] (see
// jobQueue.listExecutionOrder). `recentByType(type)`: returns recently completed jobs of that
// type, newest first, for the historical-average fallback. Returns a Map<jobId, etaMs|null>.
function computeEtas(executionOrder, recentByType) {
  const etaById = new Map();
  let cumulativeMs = 0;
  const fallbackCache = new Map();
  const fallbackFor = (type) => {
    if (!fallbackCache.has(type)) fallbackCache.set(type, averageMsPerUnit(recentByType(type)));
    return fallbackCache.get(type);
  };

  for (const job of executionOrder.filter(Boolean)) {
    // A paused job has no ETA - there's no telling when (or if) it'll be re-queued - and,
    // crucially, doesn't contribute to cumulativeMs: runNext() skips over paused entries, so a
    // paused job sitting ahead of a queued one in the array does not delay that queued job at
    // all (unlike an ordinary queued job, which genuinely runs before it).
    if (job.status === 'paused') {
      etaById.set(job.id, null);
      continue;
    }

    const fallback = fallbackFor(job.type);
    if (job.status === 'running') {
      const remaining = estimateRunningRemainingMs(job, fallback);
      etaById.set(job.id, remaining);
      cumulativeMs = remaining ?? 0;
    } else {
      const own = estimateOwnDurationMs(job, fallback);
      if (own == null) {
        etaById.set(job.id, null);
      } else {
        cumulativeMs += own;
        etaById.set(job.id, cumulativeMs);
      }
    }
  }
  return etaById;
}

module.exports = {
  averageMsPerUnit, estimateRunningRemainingMs, estimateOwnDurationMs, computeEtas,
};
