const ACTIVE_STATUSES = new Set(['queued', 'running']);
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted']);

// Given the latest job list and a Map of {id -> previous status} from the last poll, returns
// the jobs that just transitioned from active to terminal - the ones worth notifying about.
// `isFirstPoll` skips everything on the very first poll after mount, so opening the app doesn't
// "notify" about jobs that finished before this tab was even open.
export function detectFinishedJobs(jobs, prevStatusById, isFirstPoll) {
  if (isFirstPoll) return [];
  return jobs.filter((job) => {
    const prevStatus = prevStatusById.get(job.id);
    return prevStatus !== undefined && ACTIVE_STATUSES.has(prevStatus) && TERMINAL_STATUSES.has(job.status);
  });
}

export function snapshotStatuses(jobs) {
  return new Map(jobs.map((j) => [j.id, j.status]));
}
