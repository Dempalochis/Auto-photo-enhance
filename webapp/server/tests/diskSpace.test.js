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
