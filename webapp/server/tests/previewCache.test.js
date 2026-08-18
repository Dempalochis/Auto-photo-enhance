const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { presetsFingerprint, isManifestFresh } = require('../previewCache');

function tempPresetsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-previewcache-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.pp3`), content);
  }
  return dir;
}

test('presetsFingerprint records mtime and size per preset file', () => {
  const dir = tempPresetsDir({ teal_orange: 'abc' });
  const fp = presetsFingerprint(dir, ['teal_orange']);
  assert.equal(fp.length, 1);
  assert.equal(fp[0].name, 'teal_orange');
  assert.equal(fp[0].size, 3);
  assert.equal(typeof fp[0].mtimeMs, 'number');
});

test('presetsFingerprint marks a vanished file with a marker that can never match a real fingerprint', () => {
  const dir = tempPresetsDir({});
  const fp = presetsFingerprint(dir, ['does_not_exist']);
  assert.deepEqual(fp, [{ name: 'does_not_exist', mtimeMs: null, size: null }]);
});

test('isManifestFresh is false when there is no manifest yet', () => {
  assert.equal(isManifestFresh(null, []), false);
  assert.equal(isManifestFresh(undefined, []), false);
});

test('isManifestFresh is false for an old-format manifest (bare preset-name list, no fingerprint) - treated as a miss, not a crash', () => {
  const oldManifest = { presets: ['teal_orange'], generatedAt: Date.now() };
  assert.doesNotThrow(() => isManifestFresh(oldManifest, presetsFingerprint('/nonexistent', ['teal_orange'])));
  assert.equal(isManifestFresh(oldManifest, presetsFingerprint('/nonexistent', ['teal_orange'])), false);
});

test('isManifestFresh is true when the fingerprint matches exactly', () => {
  const dir = tempPresetsDir({ teal_orange: 'abc' });
  const fp = presetsFingerprint(dir, ['teal_orange']);
  const manifest = { presetsFingerprint: fp, generatedAt: Date.now() };
  assert.equal(isManifestFresh(manifest, fp), true);
});

test('isManifestFresh is false once a preset\'s content changes in place (same filename) - the actual bug this phase fixes', () => {
  const dir = tempPresetsDir({ teal_orange: 'original contents' });
  const before = presetsFingerprint(dir, ['teal_orange']);
  const manifest = { presetsFingerprint: before, generatedAt: Date.now() };
  assert.equal(isManifestFresh(manifest, before), true);

  // Rewrite the same file with different content/size - simulates editing the .pp3 in the
  // RawTherapee GUI and re-saving over the same filename.
  fs.writeFileSync(path.join(dir, 'teal_orange.pp3'), 'edited contents, different size');
  const after = presetsFingerprint(dir, ['teal_orange']);
  assert.equal(isManifestFresh(manifest, after), false);
});

test('isManifestFresh is false when the preset list itself changes (added/removed), same as before this feature', () => {
  const dir = tempPresetsDir({ a: '1', b: '2' });
  const before = presetsFingerprint(dir, ['a', 'b']);
  const manifest = { presetsFingerprint: before, generatedAt: Date.now() };

  const afterRemoval = presetsFingerprint(dir, ['a']);
  assert.equal(isManifestFresh(manifest, afterRemoval), false);
});
