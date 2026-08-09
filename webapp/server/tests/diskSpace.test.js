const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDiskSpaceWarning, estimateRequiredBytes, AVG_OUTPUT_JPEG_BYTES } = require('../diskSpace');

test('estimateRequiredBytes scales linearly with file count', () => {
  assert.equal(estimateRequiredBytes(1), AVG_OUTPUT_JPEG_BYTES);
  assert.equal(estimateRequiredBytes(10), AVG_OUTPUT_JPEG_BYTES * 10);
  assert.equal(estimateRequiredBytes(0), 0);
});

test('returns null when there is plainly enough free space', () => {
  const free = estimateRequiredBytes(10) * 100;
  assert.equal(checkDiskSpaceWarning(free, 10), null);
});

test('returns a warning message when free space is less than the estimate', () => {
  const free = estimateRequiredBytes(10) / 2;
  const warning = checkDiskSpaceWarning(free, 10);
  assert.match(warning, /Low disk space/);
  assert.match(warning, /GB free/);
});

test('fails open (no warning) when free space could not be determined', () => {
  assert.equal(checkDiskSpaceWarning(null, 1000), null);
  assert.equal(checkDiskSpaceWarning(undefined, 1000), null);
});

test('returns null for a zero/negative file count rather than a nonsensical warning', () => {
  assert.equal(checkDiskSpaceWarning(0, 0), null);
});

test('is never a hard failure signal - it always returns either null or a string, never throws', () => {
  assert.doesNotThrow(() => checkDiskSpaceWarning(0, 999999));
});

test('a batch that is fine alone still warns once jobs already queued ahead of it are counted', () => {
  const free = estimateRequiredBytes(10) * 1.2; // comfortably enough for 10 files alone
  assert.equal(checkDiskSpaceWarning(free, 10), null, 'sanity check: 10 alone must not warn');

  const warning = checkDiskSpaceWarning(free, 10, 20); // 20 more photos already queued ahead
  assert.match(warning, /Low disk space/);
  assert.match(warning, /20 photos already queued ahead of it/);
});

test('an empty queue ahead behaves exactly like the original single-job check (regression)', () => {
  const free = estimateRequiredBytes(10) / 2;
  const withoutQueueArg = checkDiskSpaceWarning(free, 10);
  const withZeroQueue = checkDiskSpaceWarning(free, 10, 0);
  assert.equal(withoutQueueArg, withZeroQueue);
  assert.doesNotMatch(withZeroQueue, /queued ahead/);
});

test('a negative queuedAheadFileCount is treated as zero rather than reducing the estimate', () => {
  const free = estimateRequiredBytes(10) / 2;
  assert.equal(checkDiskSpaceWarning(free, 10, -5), checkDiskSpaceWarning(free, 10, 0));
});

test('singular vs. plural wording for exactly one photo queued ahead', () => {
  const free = 1; // force a warning regardless of exact numbers
  const warning = checkDiskSpaceWarning(free, 10, 1);
  assert.match(warning, /1 photo already queued ahead of it/);
  assert.doesNotMatch(warning, /1 photos/);
});
