const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeStateStore } = require('../state');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ape-state-test-'));
}

test('read() returns {} when no state file exists yet', () => {
  const store = makeStateStore(tempDir());
  assert.deepEqual(store.read(), {});
});

test('write() then read() round-trips', () => {
  const store = makeStateStore(tempDir());
  store.write({ photosDir: 'C:\\Photos\\Shoot1' });
  assert.deepEqual(store.read(), { photosDir: 'C:\\Photos\\Shoot1' });
});

test('write() merges with existing state instead of replacing it', () => {
  const store = makeStateStore(tempDir());
  store.write({ photosDir: 'C:\\Photos\\Shoot1' });
  store.write({ otherSetting: 'value' });
  assert.deepEqual(store.read(), { photosDir: 'C:\\Photos\\Shoot1', otherSetting: 'value' });
});

test('write() creates the state directory if missing', () => {
  const dir = path.join(tempDir(), 'nested', 'cache');
  const store = makeStateStore(dir);
  store.write({ a: 1 });
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), true);
});

test('read() tolerates a corrupt state file by returning {}', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not valid json');
  const store = makeStateStore(dir);
  assert.deepEqual(store.read(), {});
});
