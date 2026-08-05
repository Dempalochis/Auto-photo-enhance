const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBatches } = require('../captureDates');

test('makeBatches returns no batches for an empty list', () => {
  assert.deepEqual(makeBatches([]), []);
});

test('makeBatches keeps small lists in a single batch', () => {
  const files = ['C:\\photos\\a.arw', 'C:\\photos\\b.arw', 'C:\\photos\\c.arw'];
  assert.deepEqual(makeBatches(files), [files]);
});

test('makeBatches splits once the file-count cap (300) is exceeded', () => {
  const files = Array.from({ length: 301 }, (_, i) => `C:\\p\\f${i}.arw`);
  const batches = makeBatches(files);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 300);
  assert.equal(batches[1].length, 1);
  // nothing lost or reordered across the split
  assert.deepEqual(batches.flat(), files);
});

test('makeBatches does not split at exactly the file-count cap', () => {
  const files = Array.from({ length: 300 }, (_, i) => `C:\\p\\f${i}.arw`);
  const batches = makeBatches(files);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 300);
});

test('makeBatches splits once the char-length cap (6000) is exceeded, even under the file cap', () => {
  const longPath = `C:\\${'a'.repeat(200)}\\file.arw`; // ~207 chars each
  const files = Array.from({ length: 30 }, () => longPath); // ~6210 chars total
  const batches = makeBatches(files);
  assert.ok(batches.length >= 2, 'expected more than one batch once char cap is exceeded');
  assert.deepEqual(batches.flat(), files);
});

test('makeBatches puts a single file longer than the char cap in its own batch rather than dropping it', () => {
  const hugePath = `C:\\${'x'.repeat(7000)}\\file.arw`;
  const files = [hugePath, 'C:\\p\\normal.arw'];
  const batches = makeBatches(files);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0], hugePath);
  assert.deepEqual(batches.flat(), files);
});
