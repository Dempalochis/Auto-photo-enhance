// Version 2 Phase 4 task 6: hand-over of AI plans from the analyze lane to a running render.
//
// Each photo of an AI run has one slot. The analyze lane fills it (resolve) or marks it failed
// (fail -> an all-zero entry straight away, so the run never waits for a failed analysis). The
// run's plan-wait timeout starts ONLY when the run reaches that photo (runWaiting), never at
// queue time, so a long queue can't time out photos that simply haven't been reached yet.
//
// onEntry(key, entry) is called exactly once per slot, with the final entry the run will use.

function createPlanBoard({ planWaitMs, onEntry, makeSkippedEntry, now = Date.now }) {
  const slots = new Map(); // key -> { settled, entry, timer, waiters: [], waitStartedAt }

  const skipped = makeSkippedEntry || ((note) => ({ overlay: null, summary: 'none', scene: '', note }));

  function slot(key) {
    if (!slots.has(key)) slots.set(key, { settled: false, entry: null, timer: null, waiters: [], waitStartedAt: null });
    return slots.get(key);
  }

  function settle(key, entry) {
    const s = slot(key);
    if (s.settled) return false;
    s.settled = true;
    s.entry = entry;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (onEntry) onEntry(key, entry);
    s.waiters.splice(0).forEach((w) => w(entry));
    return true;
  }

  return {
    add(key) { slot(key); },
    resolve(key, entry) { return settle(key, entry); },
    fail(key, note) { return settle(key, skipped(`AI correction skipped: ${note}`)); },
    // The run has reached this photo: start its timeout now (if it isn't settled yet).
    runWaiting(key) {
      const s = slot(key);
      if (s.settled || s.timer) return;
      s.waitStartedAt = now();
      s.timer = setTimeout(() => settle(key, skipped(`AI correction skipped: no plan after ${Math.round(planWaitMs / 1000)} s`)), planWaitMs);
    },
    wait(key) {
      const s = slot(key);
      if (s.settled) return Promise.resolve(s.entry);
      return new Promise((r) => s.waiters.push(r));
    },
    isSettled(key) { return slot(key).settled; },
    entry(key) { return slot(key).entry; },
    pendingKeys() { return [...slots.entries()].filter(([, s]) => !s.settled).map(([k]) => k); },
    // Settles everything still open (run finished/cancelled) and clears timers.
    close(note = 'run ended before the analysis finished') {
      for (const [k, s] of slots) if (!s.settled) settle(k, skipped(`AI correction skipped: ${note}`));
    },
  };
}

module.exports = { createPlanBoard };
