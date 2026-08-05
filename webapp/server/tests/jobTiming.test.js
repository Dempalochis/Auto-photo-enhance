const test = require('node:test');
const assert = require('node:assert/strict');
const { computeJobTiming } = require('../jobTiming');

test('a still-queued job (no startedAt yet) reports null for everything - nothing to measure yet', () => {
  const timing = computeJobTiming({ createdAt: 1000, startedAt: null, finishedAt: null });
  assert.deepEqual(timing, { queueWaitMs: null, runDurationMs: null, totalMs: null });
});

test('a running job (started but not finished) reports queue wait but not run duration yet', () => {
  const timing = computeJobTiming({ createdAt: 1000, startedAt: 1400, finishedAt: null });
  assert.equal(timing.queueWaitMs, 400);
  assert.equal(timing.runDurationMs, null);
  assert.equal(timing.totalMs, null);
});

test('a finished job reports queue wait, run duration, and total, which sum correctly', () => {
  const timing = computeJobTiming({ createdAt: 1000, startedAt: 1400, finishedAt: 5400 });
  assert.equal(timing.queueWaitMs, 400);
  assert.equal(timing.runDurationMs, 4000);
  assert.equal(timing.totalMs, 4400);
  assert.equal(timing.queueWaitMs + timing.runDurationMs, timing.totalMs);
});

test('a job that started immediately (no queue wait) reports queueWaitMs of 0, not null', () => {
  const timing = computeJobTiming({ createdAt: 1000, startedAt: 1000, finishedAt: 2000 });
  assert.equal(timing.queueWaitMs, 0);
  assert.equal(timing.runDurationMs, 1000);
});
