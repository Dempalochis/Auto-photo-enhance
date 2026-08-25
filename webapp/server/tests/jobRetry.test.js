const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canRetry, resolveRetryFiles } = require('../jobRetry');

function tempPhotosDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-jobretry-test-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'fake raw bytes');
  return dir;
}

test('canRetry rejects an unknown job', () => {
  const result = canRetry(null);
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('canRetry rejects a non-run job type', () => {
  const result = canRetry({ type: 'preview', status: 'error' });
  assert.equal(result.ok, false);
  assert.match(result.error, /type "preview"/);
});

for (const status of ['error', 'cancelled', 'interrupted']) {
  test(`canRetry allows a "${status}" run job`, () => {
    assert.equal(canRetry({ type: 'run', status }).ok, true);
  });
}

for (const status of ['queued', 'running', 'paused']) {
  test(`canRetry rejects a "${status}" run job`, () => {
    const result = canRetry({ type: 'run', status });
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`status "${status}"`));
  });
}

// A 'done' job is *not* a single case: the script can complete without crashing/cancelling/
// interrupting (status stays 'done') while still failing every file it touched - a done job is
// only "nothing left to retry" when it actually succeeded. Reproduced live during V8 Phase 1 QA
// (a 2-corrupt-file batch landed as done/processed:0/failed:2 with no way to retry it) - this is
// the fix for that finding.
test('canRetry rejects a "done" run job with no failures', () => {
  const result = canRetry({ type: 'run', status: 'done', result: { processed: 3, failed: 0 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /status "done"/);
});

test('canRetry rejects a "done" run job with no result at all (predates the failed-count feature)', () => {
  const result = canRetry({ type: 'run', status: 'done' });
  assert.equal(result.ok, false);
  assert.match(result.error, /status "done"/);
});

test('canRetry allows a "done" run job where every file failed', () => {
  const result = canRetry({ type: 'run', status: 'done', result: { processed: 0, failed: 2 } });
  assert.equal(result.ok, true);
});

test('canRetry allows a "done" run job where some (not all) files failed', () => {
  const result = canRetry({ type: 'run', status: 'done', result: { processed: 1, failed: 1 } });
  assert.equal(result.ok, true);
});

test('resolveRetryFiles resolves every original file against the job\'s original source folder', () => {
  const dir = tempPhotosDir(['DSC00001.ARW', 'DSC00002.ARW']);
  const result = resolveRetryFiles({ files: ['DSC00001.ARW', 'DSC00002.ARW'], sourceFolder: dir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.absoluteFiles.sort(), [
    path.join(dir, 'DSC00001.ARW'),
    path.join(dir, 'DSC00002.ARW'),
  ].sort());
});

test('resolveRetryFiles fails clearly when a source photo no longer exists', () => {
  const dir = tempPhotosDir(['DSC00001.ARW']);
  const result = resolveRetryFiles({ files: ['DSC00001.ARW', 'DSC00099.ARW'], sourceFolder: dir });
  assert.equal(result.ok, false);
  assert.match(result.error, /DSC00099\.ARW/);
});

test('resolveRetryFiles fails on a job that predates the files-in-meta feature', () => {
  const result = resolveRetryFiles({ sourceFolder: 'C:\\photos' });
  assert.equal(result.ok, false);
  assert.match(result.error, /no retryable file list/);
});

test('resolveRetryFiles fails when meta has no sourceFolder at all', () => {
  const result = resolveRetryFiles({ files: ['DSC00001.ARW'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /no retryable file list/);
});

test('resolveRetryFiles rejects a path-traversal attempt smuggled into a job record', () => {
  const dir = tempPhotosDir(['DSC00001.ARW']);
  const result = resolveRetryFiles({ files: ['../../evil.ARW'], sourceFolder: dir });
  assert.equal(result.ok, false);
});
