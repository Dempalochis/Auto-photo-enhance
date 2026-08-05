// Formats an ETA in milliseconds as a short "~Xm Ys remaining" string for the job queue panel.
// null means "no estimate yet" (e.g. no historical data for this job type, or the running job
// hasn't finished its first item yet) - shown as "estimating…" rather than a misleading number.
export function formatEta(etaMs) {
  if (etaMs == null) return 'estimating…';
  if (etaMs <= 0) return 'almost done';

  const totalSeconds = Math.round(etaMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `~${seconds}s remaining`;
  if (seconds === 0) return `~${minutes}m remaining`;
  return `~${minutes}m ${seconds}s remaining`;
}
