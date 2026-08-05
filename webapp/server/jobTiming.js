// Derives queue-wait vs. actual-work timing from a job's own createdAt/startedAt/finishedAt
// timestamps (already recorded by jobQueue.js for every job - nothing new to instrument here).
// This directly answers the question the GPU spike exists to answer: for a 'run' job, is wall
// time dominated by waiting in the FIFO queue behind another job, or by the RawTherapee render
// itself? See docs/gpu_spike_findings.md.
function computeJobTiming(job) {
  const { createdAt, startedAt, finishedAt } = job;
  return {
    // Time spent sitting in 'queued' before this job became active. null while still queued -
    // there's nothing to report yet, not zero (which would misleadingly imply no wait at all).
    queueWaitMs: startedAt != null ? startedAt - createdAt : null,
    // Time spent actually running (spawning/awaiting the PowerShell + RawTherapee process).
    runDurationMs: startedAt != null && finishedAt != null ? finishedAt - startedAt : null,
    totalMs: finishedAt != null ? finishedAt - createdAt : null,
  };
}

module.exports = { computeJobTiming };
