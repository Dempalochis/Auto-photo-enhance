const test = require('node:test');
const assert = require('node:assert/strict');
const { finalizeProgressItems } = require('../runProgress');

test('a normal completed run backfills any straggler pending/running items to done', () => {
  const items = [
    { name: 'a', status: 'done' },
    { name: 'b', status: 'failed' },
    { name: 'c', status: 'pending' }, // missed status line, but the run genuinely finished
  ];
  finalizeProgressItems(items, { cancelled: false });
  assert.deepEqual(items.map((i) => i.status), ['done', 'failed', 'done']);
});

test('a cancelled run does NOT claim pending/running items are done - this was a real observed bug', () => {
  const items = [
    { name: 'a', status: 'done' }, // genuinely converted before cancel
    { name: 'b', status: 'cancelled' }, // the in-flight file at cancel time (flipped by caller's onCancel)
    { name: 'c', status: 'pending' }, // never started
    { name: 'd', status: 'pending' }, // never started
  ];
  finalizeProgressItems(items, { cancelled: true });
  assert.deepEqual(items.map((i) => i.status), ['done', 'cancelled', 'cancelled', 'cancelled']);
});

test('a cancelled run leaves already-failed items as failed, not cancelled', () => {
  const items = [{ name: 'a', status: 'failed' }, { name: 'b', status: 'pending' }];
  finalizeProgressItems(items, { cancelled: true });
  assert.deepEqual(items.map((i) => i.status), ['failed', 'cancelled']);
});

// ---- Version 2 Phase 2 ----
const { cancelCleanupPaths } = require('../runProgress');
const { outputFileFor } = require('../pathSafety');

test('cancelCleanupPaths: Version 1 deletes only the in-flight output; a batch also loses its temp folder', () => {
  assert.deepEqual(cancelCleanupPaths({ currentOutput: '/o/a.jpg' }), ['/o/a.jpg']);
  assert.deepEqual(cancelCleanupPaths({ currentOutput: null, batchTempDir: '/o/.rt_batch_1' }), ['/o/.rt_batch_1', '/o/.rt_batch_1.stdout.txt', '/o/.rt_batch_1.stderr.txt']);
  assert.deepEqual(cancelCleanupPaths({}), []);
});

test('outputFileFor adds _ai before the preset suffix for AI-corrected runs (Phase 4)', () => {
  const path = require('node:path');
  assert.equal(outputFileFor('/o', 'A/x.ARW', 'teal', { ai: true }), path.join('/o', 'A', 'x_ai_teal.jpg'));
  assert.equal(outputFileFor('/o', 'x.ARW', 'none', { ai: true }), path.join('/o', 'x_ai.jpg'));
  assert.equal(outputFileFor('/o', 'x.ARW', 'teal'), path.join('/o', 'x_teal.jpg'));
});
