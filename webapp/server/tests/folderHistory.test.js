const test = require('node:test');
const assert = require('node:assert/strict');
const { addToHistory, MAX_HISTORY } = require('../folderHistory');

test('adds a new path to the front of an empty/missing history', () => {
  assert.deepEqual(addToHistory(undefined, 'C:\\Photos\\A'), ['C:\\Photos\\A']);
  assert.deepEqual(addToHistory([], 'C:\\Photos\\A'), ['C:\\Photos\\A']);
});

test('prepends a new path ahead of existing entries', () => {
  assert.deepEqual(
    addToHistory(['C:\\Photos\\A'], 'C:\\Photos\\B'),
    ['C:\\Photos\\B', 'C:\\Photos\\A'],
  );
});

test('re-selecting an already-present path moves it to the front instead of duplicating it', () => {
  const history = ['C:\\Photos\\A', 'C:\\Photos\\B', 'C:\\Photos\\C'];
  assert.deepEqual(
    addToHistory(history, 'C:\\Photos\\B'),
    ['C:\\Photos\\B', 'C:\\Photos\\A', 'C:\\Photos\\C'],
  );
});

test(`caps history at ${MAX_HISTORY} entries, dropping the oldest`, () => {
  const history = ['A', 'B', 'C', 'D', 'E'];
  assert.equal(history.length, MAX_HISTORY);
  assert.deepEqual(addToHistory(history, 'F'), ['F', 'A', 'B', 'C', 'D']);
});

test('a malformed (non-array) history is treated as empty rather than throwing', () => {
  assert.deepEqual(addToHistory(null, 'C:\\Photos\\A'), ['C:\\Photos\\A']);
  assert.deepEqual(addToHistory('not-an-array', 'C:\\Photos\\A'), ['C:\\Photos\\A']);
});
