const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteFileSync } = require('../atomicFile');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ape-atomic-test-'));
}

test('writes the exact given content and creates parent directories as needed', () => {
  const file = path.join(tempDir(), 'nested', 'dir', 'data.json');
  atomicWriteFileSync(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
});

test('leaves no leftover temp file behind after a successful write', () => {
  const dir = tempDir();
  const file = path.join(dir, 'data.json');
  atomicWriteFileSync(file, '{}');
  const entries = fs.readdirSync(dir);
  assert.deepEqual(entries, ['data.json']);
});

test('a second write fully replaces the first (no interleaving of old and new content)', () => {
  const file = path.join(tempDir(), 'data.json');
  atomicWriteFileSync(file, 'x'.repeat(50));
  atomicWriteFileSync(file, 'y'.repeat(10));
  assert.equal(fs.readFileSync(file, 'utf8'), 'y'.repeat(10));
});

test('if the rename step fails, the original file is left completely untouched', (t) => {
  const dir = tempDir();
  const file = path.join(dir, 'data.json');
  atomicWriteFileSync(file, 'original content');

  t.mock.method(fs, 'renameSync', () => { throw new Error('simulated crash before rename completes'); });
  assert.throws(() => atomicWriteFileSync(file, 'new content that should never land'), /simulated crash/);

  t.mock.reset();
  assert.equal(fs.readFileSync(file, 'utf8'), 'original content', 'target file must be untouched by a failed write');
});
