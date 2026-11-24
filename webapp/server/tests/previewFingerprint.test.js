// Version 2 Phase 1: the composite preview-cache fingerprint. Changing any one input on its own
// must invalidate the cache; an unchanged set must not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { previewFingerprint, isPreviewManifestFresh } = require('../previewCache');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-fp-'));
  const presetsDir = path.join(root, 'presets');
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(presetsDir);
  fs.mkdirSync(profilesDir);
  fs.writeFileSync(path.join(presetsDir, 'teal.pp3'), '[Vibrance]\n');
  for (const n of ['default', 'lowlight', 'raf', 'draft_override']) fs.writeFileSync(path.join(profilesDir, `${n}.pp3`), `[${n}]\n`);
  const sourceFile = path.join(root, 'a.ARW');
  fs.writeFileSync(sourceFile, 'raw');
  const exiftoolPath = path.join(root, 'exiftool');
  fs.writeFileSync(exiftoolPath, '');
  const rawConfig = { defaultProfile: 'default', autoProfile: { enabled: true, isoThreshold: 800 } };
  const args = () => ({
    presetsDir, presetNames: ['teal'], profilesDir, rawConfig, exiftoolPath, sourceFile,
  });
  return { root, presetsDir, profilesDir, sourceFile, rawConfig, exiftoolPath, args };
}

// Bumps a file's mtime deterministically (fs timestamps can be coarse).
function touch(file, content) {
  if (content !== undefined) fs.writeFileSync(file, content);
  const t = new Date(Date.now() + 5000 + Math.random() * 1000);
  fs.utimesSync(file, t, t);
}

test('an unchanged input set is fresh', () => {
  const f = fixture();
  const manifest = previewFingerprint(f.args());
  assert.equal(isPreviewManifestFresh(JSON.parse(JSON.stringify(manifest)), previewFingerprint(f.args())), true);
});

test('old Version 1 manifests (presetsFingerprint only) are stale', () => {
  const f = fixture();
  assert.equal(isPreviewManifestFresh({ presetsFingerprint: [] }, previewFingerprint(f.args())), false);
  assert.equal(isPreviewManifestFresh(null, previewFingerprint(f.args())), false);
});

const cases = [
  ['a preset edit', (f) => touch(path.join(f.presetsDir, 'teal.pp3'), '[Vibrance]\nEnabled=true\n')],
  ['a base profile edit', (f) => touch(path.join(f.profilesDir, 'default.pp3'), '[x]\nchanged=1\n')],
  ['the high-ISO profile', (f) => touch(path.join(f.profilesDir, 'lowlight.pp3'))],
  ['a format overlay edit', (f) => touch(path.join(f.profilesDir, 'raf.pp3'))],
  ['the draft profile', (f) => touch(path.join(f.profilesDir, 'draft_override.pp3'), '[Resize]\nScale=0.25\n')],
  ['a new profile file', (f) => fs.writeFileSync(path.join(f.profilesDir, 'nef.pp3'), '[x]\n')],
  ['config defaultProfile', (f) => { f.rawConfig.defaultProfile = 'lowlight'; }],
  ['config autoProfile', (f) => { f.rawConfig.autoProfile.isoThreshold = 1600; }],
  ['exiftool going missing', (f) => fs.rmSync(f.exiftoolPath)],
  ['the source file replaced under the same name', (f) => touch(f.sourceFile, 'other raw bytes')],
];

for (const [name, change] of cases) {
  test(`changing ${name} invalidates the cache`, () => {
    const f = fixture();
    const before = previewFingerprint(f.args());
    change(f);
    assert.equal(isPreviewManifestFresh(before, previewFingerprint(f.args())), false);
  });
}

test('the AI overlay hash is part of the fingerprint (Phase 5 00_ai_base tile)', () => {
  const f = fixture();
  const a = previewFingerprint({ ...f.args(), aiOverlayHash: 'abc' });
  assert.equal(isPreviewManifestFresh(a, previewFingerprint({ ...f.args(), aiOverlayHash: 'abc' })), true);
  assert.equal(isPreviewManifestFresh(a, previewFingerprint({ ...f.args(), aiOverlayHash: 'def' })), false);
  assert.equal(isPreviewManifestFresh(a, previewFingerprint(f.args())), false);
});
