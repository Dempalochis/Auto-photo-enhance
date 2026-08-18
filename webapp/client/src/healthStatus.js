// Derives the header health pill's visual state from GET /api/health's response - kept as a
// pure function (like jobTransitions.js/dragReorder.js) so the status logic is unit tested
// without rendering the component or mocking fetch timing.
//   'error'   - config problems that break previews/runs (e.g. rtPath not found)
//   'warning' - degrades gracefully but something's not ideal (e.g. exiftool missing)
//   'ok'      - no errors, no warnings
//   'unknown' - no response yet (still loading)
export function healthStatus(health) {
  if (!health) return 'unknown';
  if (!health.ok || (health.errors && health.errors.length > 0)) return 'error';
  if (health.warnings && health.warnings.length > 0) return 'warning';
  return 'ok';
}
