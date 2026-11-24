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

// ---- Version 2, Phase 3: extended metadata read ----
const { parseExifEntry } = require('../captureDates');

test('parseExifEntry reads the -n numeric fields and keeps the date format', () => {
  const m = parseExifEntry({
    SourceFile: 'a.ARW', DateTimeOriginal: '2017:07:13 16:58:20', ISO: 400, ExposureTime: 0.004, FNumber: 4, Flash: 16, Model: 'ILCE-7S ',
  });
  assert.deepEqual(m, {
    dateTaken: '2017-07-13T16:58:20', iso: 400, exposureTime: 0.004, fNumber: 4, flash: false, model: 'ILCE-7S',
  });
});

test('parseExifEntry: flash bit 0 means fired; FNumber 0 / missing fields become null', () => {
  const m = parseExifEntry({ DateTimeOriginal: '2017:01:15 21:38:27', ISO: 100, FNumber: 0, Flash: 15 });
  assert.equal(m.flash, true);
  assert.equal(m.fNumber, null);
  assert.equal(m.exposureTime, null);
  assert.equal(m.model, null);
  assert.equal(parseExifEntry({ Flash: 'On, Did not fire' }).flash, false);
  assert.equal(parseExifEntry({ Flash: 'Fired' }).flash, true);
  assert.equal(parseExifEntry({}).flash, null);
});
