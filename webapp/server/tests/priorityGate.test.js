// Decision after the browser test: AI runs get priority over review analyses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPriorityGate, PRIORITY } = require('../llm/priorityGate');
const { createMockProvider } = require('../llm/mockProvider');
const { createAnalyzer } = require('../analyzer');
const { createCorrectionsCache } = require('../correctionsCache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('waiting high-priority calls go before waiting low-priority ones; FIFO within a priority', async () => {
  const gate = createPriorityGate(1);
  const order = [];
  const first = await gate.acquire(PRIORITY.REVIEW); // occupies the only slot
  const p = [
    gate.acquire(PRIORITY.REVIEW).then((rel) => { order.push('review-1'); rel(); }),
    gate.acquire(PRIORITY.REVIEW).then((rel) => { order.push('review-2'); rel(); }),
    gate.acquire(PRIORITY.RUN).then((rel) => { order.push('run-1'); rel(); }),
    gate.acquire(PRIORITY.RUN).then((rel) => { order.push('run-2'); rel(); }),
  ];
  first();
  await Promise.all(p);
  assert.deepEqual(order, ['run-1', 'run-2', 'review-1', 'review-2']);
});

test('a running call is never interrupted; concurrency is respected', async () => {
  const gate = createPriorityGate(2);
  const a = await gate.acquire(PRIORITY.REVIEW);
  const b = await gate.acquire(PRIORITY.REVIEW);
  assert.deepEqual(gate.stats(), { active: 2, waiting: 0 });
  let got = false;
  const c = gate.acquire(PRIORITY.RUN).then((rel) => { got = true; return rel; });
  await sleep(10);
  assert.equal(got, false, 'the run waits for a free slot, it does not preempt');
  a();
  (await c)();
  b();
  assert.deepEqual(gate.stats(), { active: 0, waiting: 0 });
});

test('an aborted waiter leaves the queue', async () => {
  const gate = createPriorityGate(1);
  const hold = await gate.acquire();
  const ctrl = new AbortController();
  const w = gate.acquire(PRIORITY.RUN, ctrl.signal);
  ctrl.abort(new Error('cancelled'));
  await assert.rejects(w, /cancelled/);
  assert.equal(gate.stats().waiting, 0);
  hold();
});

test('scenario: a run analysis started during a slow review analysis is served next, not after it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-prio-'));
  const mk = (prefix, n) => Array.from({ length: n }, (_, i) => {
    const abs = path.join(root, `${prefix}${i}.ARW`);
    fs.writeFileSync(abs, `${prefix}${i}`);
    fs.writeFileSync(abs.replace(/\.ARW$/, '.jpg'), 'jpg');
    return { abs, relPath: `${prefix}${i}.ARW`, size: 1, mtime: i + 1, exif: {} };
  });
  const review = mk('rv', 6);
  const run = mk('run', 2);
  const gate = createPriorityGate(1);
  const raw = createMockProvider({}, { delayMs: 40 });
  const cache = createCorrectionsCache(path.join(root, 'c'));
  const base = {
    llmCfg: { concurrency: 1 }, cache, profileCtx: { profilesDir: path.resolve(__dirname, '..', '..', '..', 'profiles'), rawConfig: {}, exiftoolAvailable: false },
    renderDrafts: async () => {}, extractEmbedded: async (p) => p.abs.replace(/\.ARW$/, '.jpg'),
  };
  const done = [];
  const reviewP = createAnalyzer({ ...base, provider: gate.wrap(raw, PRIORITY.REVIEW) })
    .analyze(review, { inputKind: 'embedded', onResult: (p) => done.push(p.relPath) });
  await sleep(60); // review is on its 2nd call
  const runP = createAnalyzer({ ...base, provider: gate.wrap(raw, PRIORITY.RUN) })
    .analyze(run, { inputKind: 'embedded', onResult: (p) => done.push(p.relPath) });
  await Promise.all([reviewP, runP]);
  const runAt = done.indexOf('run1.ARW');
  const lastReview = done.indexOf('rv5.ARW');
  assert.ok(runAt < lastReview, `run finished at ${runAt}, review at ${lastReview}: ${done.join(',')}`);
  assert.ok(runAt <= 4, `both run photos come right after the review call in flight: ${done.join(',')}`);
});
