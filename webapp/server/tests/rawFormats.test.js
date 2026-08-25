const test = require('node:test');
const assert = require('node:assert/strict');
const { SUPPORTED_RAW_EXTENSIONS, RAW_FILE_PATTERN, isRawFile } = require('../rawFormats');

test('SUPPORTED_RAW_EXTENSIONS lists exactly the four V9 formats, lowercase, no dots', () => {
  assert.deepEqual(SUPPORTED_RAW_EXTENSIONS, ['arw', 'nef', 'dng', 'raf']);
});

test('isRawFile accepts every supported extension, case-insensitively', () => {
  assert.equal(isRawFile('DSC00001.ARW'), true);
  assert.equal(isRawFile('DSC00001.arw'), true);
  assert.equal(isRawFile('DSC00001.NEF'), true);
  assert.equal(isRawFile('DSC00001.nef'), true);
  assert.equal(isRawFile('DSC00001.DNG'), true);
  assert.equal(isRawFile('DSC00001.dng'), true);
  assert.equal(isRawFile('DSC00001.RAF'), true);
  assert.equal(isRawFile('DSC00001.raf'), true);
});

test('isRawFile rejects non-raw extensions and near-misses', () => {
  assert.equal(isRawFile('DSC00001.jpg'), false);
  assert.equal(isRawFile('DSC00001.raw'), false); // deliberately not supported - see V9_PLAN.md
  assert.equal(isRawFile('DSC00001.arwx'), false);
  assert.equal(isRawFile('arw'), false); // no dot, not an extension match
  assert.equal(isRawFile(''), false);
});

test('isRawFile matches at the end of a full relative path, not just a bare filename', () => {
  assert.equal(isRawFile('Ceremony/DSC00001.NEF'), true);
  assert.equal(isRawFile('Ceremony\\DSC00001.dng'), true);
});

test('RAW_FILE_PATTERN is exported directly for callers needing regex replace/strip semantics', () => {
  assert.equal('Ceremony/DSC00001.RAF'.replace(RAW_FILE_PATTERN, ''), 'Ceremony/DSC00001');
});
