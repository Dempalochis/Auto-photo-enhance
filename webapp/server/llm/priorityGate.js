// Decision after the browser test (2026-11-24): AI runs get priority over review analyses.
//
// One gate in front of the LLM for the whole server. At most `concurrency` calls run at once;
// when a slot frees up, the waiting call with the HIGHEST priority gets it (FIFO within a
// priority). A call already running is never interrupted - aborting it would throw its work away.
//
// Priorities used: RUN (an AI run is waiting for the plan) > REVIEW (Analyze button, scene
// naming/tagging).
const PRIORITY = { REVIEW: 1, RUN: 2 };

function createPriorityGate(concurrency = 1) {
  let active = 0;
  let seq = 0;
  const waiting = []; // { priority, seq, grant }

  function next() {
    while (active < concurrency && waiting.length > 0) {
      let best = 0;
      for (let i = 1; i < waiting.length; i += 1) {
        const w = waiting[i];
        const b = waiting[best];
        if (w.priority > b.priority || (w.priority === b.priority && w.seq < b.seq)) best = i;
      }
      const [w] = waiting.splice(best, 1);
      active += 1;
      w.grant();
    }
  }

  // Resolves to a release() function once the caller may start its call.
  function acquire(priority = PRIORITY.REVIEW, signal) {
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => { if (!released) { released = true; active -= 1; next(); } };
      const entry = { priority, seq: seq += 1, grant: () => resolve(release) };
      if (signal) {
        if (signal.aborted) { reject(signal.reason || new Error('aborted')); return; }
        signal.addEventListener('abort', () => {
          const i = waiting.indexOf(entry);
          if (i !== -1) { waiting.splice(i, 1); reject(signal.reason || new Error('aborted')); }
        }, { once: true });
      }
      waiting.push(entry);
      next();
    });
  }

  // A provider whose calls go through this gate at the given priority (same interface).
  function wrap(provider, priority) {
    const gated = (method) => async (args = {}) => {
      const release = await acquire(priority, args.signal);
      try { return await provider[method](args); } finally { release(); }
    };
    return {
      ...provider,
      name: provider.name,
      model: provider.model,
      isLocal: provider.isLocal,
      analyzeImage: gated('analyzeImage'),
      completeText: gated('completeText'),
      checkHealth: () => provider.checkHealth(),
    };
  }

  return {
    acquire, wrap, stats: () => ({ active, waiting: waiting.length }),
  };
}

module.exports = { createPriorityGate, PRIORITY };
