// Reconciles a run job's per-file progress items once the underlying script process has
// exited, for both the normal-completion and cancelled-mid-batch cases. Pulled out of
// server.js's /api/run closure (rather than left inline) so this reconciliation - the source of
// a real bug caught during manual verification, see below - is unit tested directly.
//
// A normal completed run may have a straggler item whose status line got missed by the line
// parser - those really did finish, so backfill them to 'done'.
//
// A CANCELLED run must not do that: everything still 'pending'/'running' at cancel time
// genuinely never got processed. The original implementation unconditionally backfilled every
// non-done/non-failed item to 'done' regardless of cancellation, which meant a cancelled
// 55-photo batch reported all 55 as "done" in the UI even though only 2 JPEGs actually existed
// on disk - a real, observed bug, not a hypothetical one. `current` (the one item that was
// mid-write when cancelled) is expected to already be flipped to 'cancelled' by the caller's
// onCancel hook, alongside deleting its partial output file; this function catches every other
// item still sitting at 'pending'/'running'.
function finalizeProgressItems(items, { cancelled }) {
  if (cancelled) {
    items.forEach((i) => {
      if (i.status === 'pending' || i.status === 'running') i.status = 'cancelled';
    });
  } else {
    items.forEach((i) => { if (i.status !== 'done' && i.status !== 'failed') i.status = 'done'; });
  }
  return items;
}

module.exports = { finalizeProgressItems };
