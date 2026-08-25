const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  isSafeRelPath, resolvePhotoPath, cacheKeyFor, sanitizeProjectName, projectFolderName, outputFileFor,
} = require('../pathSafety');

test('isSafeRelPath accepts plain and nested .arw paths', () => {
  assert.equal(isSafeRelPath('DSC00001.ARW'), true);
  assert.equal(isSafeRelPath('Ceremony/DSC00001.arw'), true);
  assert.equal(isSafeRelPath('Ceremony\\DSC00001.arw'), true);
});

// V9: multi-format support - the security boundary (not just the listing filter) needs its own
// coverage per format, since a gap here means an unintended extension could be resolved to a
// real filesystem path.
test('isSafeRelPath accepts the other three V9-supported formats too', () => {
  assert.equal(isSafeRelPath('DSC00001.NEF'), true);
  assert.equal(isSafeRelPath('DSC00001.dng'), true);
  assert.equal(isSafeRelPath('Ceremony/DSC00001.RAF'), true);
});

test('isSafeRelPath rejects path traversal and non-raw files', () => {
  assert.equal(isSafeRelPath('../secrets.txt'), false);
  assert.equal(isSafeRelPath('../../etc/passwd.arw'), false);
  assert.equal(isSafeRelPath('Ceremony/../../../DSC00001.arw'), false);
  assert.equal(isSafeRelPath('DSC00001.jpg'), false);
  assert.equal(isSafeRelPath('DSC00001.raw'), false); // deliberately unsupported - see V9_PLAN.md
  assert.equal(isSafeRelPath(''), false);
  assert.equal(isSafeRelPath(null), false);
  assert.equal(isSafeRelPath(42), false);
});

test('isSafeRelPath rejects absolute paths', () => {
  assert.equal(isSafeRelPath('C:\\Windows\\System32\\evil.arw'), false);
  assert.equal(isSafeRelPath('/etc/evil.arw'), false);
});

test('resolvePhotoPath stays inside root for a valid relative path', () => {
  const root = path.resolve('C:\\photos');
  const resolved = resolvePhotoPath(root, 'Ceremony/DSC00001.ARW');
  assert.equal(resolved, path.resolve(root, 'Ceremony/DSC00001.ARW'));
});

test('resolvePhotoPath returns null for a traversal that escapes root', () => {
  const root = path.resolve('C:\\photos');
  assert.equal(resolvePhotoPath(root, '../../evil.arw'), null);
});

test('resolvePhotoPath returns null for a sibling-prefixed folder name (defense in depth)', () => {
  // "C:\photos-evil" startsWith "C:\photos" as a raw string but is NOT inside root -
  // the path.sep-suffixed check in resolvePhotoPath must reject this.
  const root = path.resolve('C:\\photos');
  const resolved = resolvePhotoPath(root, '..\\photos-evil\\DSC00001.arw');
  assert.equal(resolved, null);
});

test('cacheKeyFor flattens subfolders into a single safe segment', () => {
  assert.equal(cacheKeyFor('Ceremony/DSC00001.ARW'), 'Ceremony__DSC00001');
  assert.equal(cacheKeyFor('DSC00001.arw'), 'DSC00001');
  assert.equal(cacheKeyFor('A/B/DSC00001.ARW'), 'A__B__DSC00001');
});

test('cacheKeyFor strips any of the V9-supported extensions, not just .arw', () => {
  assert.equal(cacheKeyFor('DSC00001.NEF'), 'DSC00001');
  assert.equal(cacheKeyFor('Ceremony/DSC00001.dng'), 'Ceremony__DSC00001');
  assert.equal(cacheKeyFor('DSC00001.RAF'), 'DSC00001');
});

test('sanitizeProjectName strips filesystem-unsafe characters and falls back on empty', () => {
  assert.equal(sanitizeProjectName('Summer Wedding'), 'Summer Wedding');
  assert.equal(sanitizeProjectName('A/B:C*D?E'), 'A_B_C_D_E');
  assert.equal(sanitizeProjectName('   '), 'project');
  assert.equal(sanitizeProjectName(''), 'project');
  assert.equal(sanitizeProjectName(undefined), 'project');
});

test('projectFolderName appends the given date', () => {
  assert.equal(projectFolderName('Summer Wedding', '2026-08-04'), 'Summer Wedding_2026-08-04');
  assert.equal(projectFolderName('', '2026-08-04'), 'project_2026-08-04');
});

test('outputFileFor keeps the original base name when no preset is selected', () => {
  const out = path.resolve('C:\\out');
  assert.equal(outputFileFor(out, 'DSC00001.ARW', null), path.join(out, 'DSC00001.jpg'));
  assert.equal(outputFileFor(out, 'DSC00001.ARW', undefined), path.join(out, 'DSC00001.jpg'));
  assert.equal(outputFileFor(out, 'DSC00001.ARW', 'none'), path.join(out, 'DSC00001.jpg'));
});

test('outputFileFor appends _<preset> to the base name when a preset is selected', () => {
  const out = path.resolve('C:\\out');
  assert.equal(outputFileFor(out, 'DSC00001.ARW', 'teal_orange'), path.join(out, 'DSC00001_teal_orange.jpg'));
});

test('outputFileFor preserves a nested subfolder either way', () => {
  const out = path.resolve('C:\\out');
  assert.equal(outputFileFor(out, 'Ceremony/DSC00001.ARW', null), path.join(out, 'Ceremony', 'DSC00001.jpg'));
  assert.equal(
    outputFileFor(out, 'Ceremony/DSC00001.ARW', 'teal_orange'),
    path.join(out, 'Ceremony', 'DSC00001_teal_orange.jpg'),
  );
});
