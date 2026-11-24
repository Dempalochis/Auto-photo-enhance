const test = require('node:test');
const assert = require('node:assert/strict');
const { previewBusy, waitForIdle } = require('../folderSwitch');

test('previewBusy: a queued, running or paused preview job blocks; finished ones do not', () => {
  assert.equal(previewBusy([null]), false);
  assert.equal(previewBusy([{ status: 'running' }]), true);
  assert.equal(previewBusy([null, { status: 'queued' }]), true);
  assert.equal(previewBusy([{ status: 'done' }, { status: 'cancelled' }]), false);
});

test('waitForIdle waits for in-flight requests and gives up after the timeout', async () => {
  let n = 2;
  setTimeout(() => { n = 0; }, 60);
  assert.equal(await waitForIdle(() => n, { timeoutMs: 1000, pollMs: 10 }), true);
  assert.equal(await waitForIdle(() => 1, { timeoutMs: 50, pollMs: 10 }), false);
  assert.equal(await waitForIdle(() => 0), true);
});
