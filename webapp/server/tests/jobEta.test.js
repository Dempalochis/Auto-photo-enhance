const test = require('node:test');
const assert = require('node:assert/strict');
const {
  averageMsPerUnit, estimateRunningRemainingMs, estimateOwnDurationMs, computeEtas,
} = require('../jobEta');

function doneJob({ startedAt, finishedAt, unitCount }) {
  return {
    startedAt,
    finishedAt,
    progress: { items: Array.from({ length: unitCount }, () => ({ status: 'done' })) },
  };
}

test('averageMsPerUnit returns null when there is no history', () => {
  assert.equal(averageMsPerUnit([]), null);
});

test('averageMsPerUnit averages ms-per-unit across completed jobs', () => {
  const jobs = [
    doneJob({ startedAt: 0, finishedAt: 10000, unitCount: 10 }), // 1000ms/unit
    doneJob({ startedAt: 0, finishedAt: 6000, unitCount: 10 }), // 600ms/unit
  ];
  assert.equal(averageMsPerUnit(jobs), 800);
});

test('averageMsPerUnit ignores samples with no timing or zero units', () => {
  const jobs = [
    doneJob({ startedAt: 0, finishedAt: 10000, unitCount: 10 }), // 1000ms/unit
    { startedAt: null, finishedAt: null, progress: { items: [] } },
    doneJob({ startedAt: 0, finishedAt: 5000, unitCount: 0 }),
  ];
  assert.equal(averageMsPerUnit(jobs), 1000);
});

test('estimateRunningRemainingMs extrapolates from progress made so far', () => {
  const now = Date.now();
  const job = {
    startedAt: now - 4000, // 4s elapsed
    progress: { items: [{ status: 'done' }, { status: 'done' }, { status: 'pending' }, { status: 'pending' }] },
  };
  // 2 done in 4s -> 2s/unit -> 2 remaining -> ~4000ms
  const remaining = estimateRunningRemainingMs(job, null);
  assert.ok(remaining >= 3500 && remaining <= 4500, `expected ~4000ms, got ${remaining}`);
});

test('estimateRunningRemainingMs falls back to the historical average before anything has finished', () => {
  const job = {
    startedAt: Date.now(),
    progress: { items: [{ status: 'pending' }, { status: 'pending' }] },
  };
  assert.equal(estimateRunningRemainingMs(job, 1500), 3000);
});

test('estimateRunningRemainingMs returns null with no fallback and nothing finished yet', () => {
  const job = { startedAt: Date.now(), progress: { items: [{ status: 'pending' }] } };
  assert.equal(estimateRunningRemainingMs(job, null), null);
});

test('estimateRunningRemainingMs returns 0 once every item is finished', () => {
  const job = { startedAt: Date.now() - 1000, progress: { items: [{ status: 'done' }, { status: 'failed' }] } };
  assert.equal(estimateRunningRemainingMs(job, null), 0);
});

test('estimateOwnDurationMs multiplies the fallback rate by unit count', () => {
  const job = { meta: { photoCount: 5 } };
  assert.equal(estimateOwnDurationMs(job, 2000), 10000);
});

test('estimateOwnDurationMs returns null without a fallback rate or unit count', () => {
  assert.equal(estimateOwnDurationMs({ meta: {} }, 2000), null);
  assert.equal(estimateOwnDurationMs({ meta: { photoCount: 5 } }, null), null);
});

test('computeEtas: a queued job\'s eta includes the active job\'s remaining time plus its own', () => {
  const now = Date.now();
  const active = {
    id: 'active', type: 'run', status: 'running', startedAt: now - 5000,
    progress: { items: [{ status: 'done' }, { status: 'pending' }] }, // 1 done in 5s -> 5s remaining
  };
  const queued = {
    id: 'queued', type: 'run', status: 'queued', meta: { photoCount: 3 },
  };
  const history = [doneJob({ startedAt: 0, finishedAt: 3000, unitCount: 3 })]; // 1000ms/unit

  const etas = computeEtas([active, queued], () => history);
  assert.ok(etas.get('active') >= 4500 && etas.get('active') <= 5500);
  // queued: active's ~5000ms remaining + queued's own 3*1000ms = ~8000ms
  assert.ok(etas.get('queued') >= 7500 && etas.get('queued') <= 8500);
});

test('computeEtas: with no history anywhere, etas are null rather than wrong numbers', () => {
  const queued = { id: 'q1', type: 'run', status: 'queued', meta: { photoCount: 3 } };
  const etas = computeEtas([queued], () => []);
  assert.equal(etas.get('q1'), null);
});

test('computeEtas: skips a null active slot (nothing currently running)', () => {
  const queued = { id: 'q1', type: 'run', status: 'queued', meta: { photoCount: 2 } };
  const history = [doneJob({ startedAt: 0, finishedAt: 2000, unitCount: 2 })]; // 1000ms/unit
  const etas = computeEtas([null, queued], () => history);
  assert.equal(etas.get('q1'), 2000);
});

test('computeEtas: a paused job always gets a null eta - there is no telling when it will resume', () => {
  const paused = { id: 'p1', type: 'run', status: 'paused', meta: { photoCount: 5 } };
  const history = [doneJob({ startedAt: 0, finishedAt: 5000, unitCount: 5 })];
  const etas = computeEtas([paused], () => history);
  assert.equal(etas.get('p1'), null);
});

test('computeEtas: a paused job ahead in line does not delay a queued job behind it - runNext skips paused entries entirely', () => {
  const paused = { id: 'p1', type: 'run', status: 'paused', meta: { photoCount: 100 } }; // would be huge if counted
  const queued = { id: 'q1', type: 'run', status: 'queued', meta: { photoCount: 2 } };
  const history = [doneJob({ startedAt: 0, finishedAt: 2000, unitCount: 2 })]; // 1000ms/unit
  const etas = computeEtas([null, paused, queued], () => history);
  assert.equal(etas.get('p1'), null);
  assert.equal(etas.get('q1'), 2000, 'queued job\'s eta must not include the paused job\'s (huge) duration');
});
