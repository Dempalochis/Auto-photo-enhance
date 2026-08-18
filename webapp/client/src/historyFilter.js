// Matches a job against a free-text History filter, by project name (run jobs), photo filename
// (preview jobs), or preset - case-insensitive substring match. Kept as a small pure function
// (like dragReorder.js/jobTransitions.js) so the matching rule itself is unit tested without
// needing to render the whole panel.
//
// The main job-queue poll already fetches every kept job (up to the store's history cap) in one
// unpaginated GET /api/jobs response, so filtering/paging History is a client-side slice over
// data already in memory - no new endpoint or round trip needed for "search the rest of the
// jobs kept" (see V6_PLAN.md Phase 2).
export function matchesHistoryFilter(job, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [job.meta?.projectName, job.meta?.preset, job.meta?.photo].filter(Boolean);
  return haystacks.some((h) => String(h).toLowerCase().includes(q));
}
