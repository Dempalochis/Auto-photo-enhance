const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../scenesStore');

const ph = (relPath, dateTaken, extra = {}) => ({
  relPath, dateTaken, size: 100, mtime: 1, iso: 100, exposureTime: 0.002, fNumber: 8, flash: false, model: 'A', ...extra,
});

// Two days: day 1 has two scenes (gap), day 2 has one.
const base = () => [
  ph('a', '2026-08-15T10:00:00'), ph('b', '2026-08-15T10:05:00'),
  ph('c', '2026-08-15T12:00:00'),
  ph('d', '2026-08-16T09:00:00'), ph('e', '2026-08-16T09:01:00'),
];

function detect(prev, photos, opts) {
  const plan = S.planDetection(prev, photos, {}, opts);
  return { plan, store: S.finalizeDetection(plan, S.autoScenesFromSegments(plan.segments), photos, '/f', 1) };
}

test('first detection groups every day', () => {
  const { store, plan } = detect(S.emptyStore('/f'), base());
  assert.deepEqual(store.scenes.map((s) => s.photos), [['a', 'b'], ['c'], ['d', 'e']]);
  assert.deepEqual(plan.affectedDays, ['2026-08-15', '2026-08-16']);
  assert.ok(store.scenes.every((s) => s.source === 'auto' && s.id.startsWith('s_')));
  assert.equal(store.scenes[0].name, '10:00–10:05 · 2 photos');
});

test('unchanged folder: nothing is regrouped and ids stay stable', () => {
  const first = detect(S.emptyStore('/f'), base()).store;
  const { plan, store } = detect(first, base());
  assert.deepEqual(plan.affectedDays, []);
  assert.deepEqual(store.scenes.map((s) => s.id), first.scenes.map((s) => s.id));
});

test('a new photo only regroups its own day', () => {
  const first = detect(S.emptyStore('/f'), base()).store;
  const renamedDay2 = { ...first, scenes: first.scenes.map((s) => (s.day === '2026-08-16' ? { ...s, name: 'keep me', source: 'llm' } : s)) };
  const { plan, store } = detect(renamedDay2, [...base(), ph('f', '2026-08-15T12:03:00')]);
  assert.deepEqual(plan.affectedDays, ['2026-08-15']);
  assert.deepEqual(store.scenes.map((s) => s.photos), [['a', 'b'], ['c', 'f'], ['d', 'e']]);
  assert.equal(store.scenes[2].name, 'keep me');
});

test('edited scenes are never regrouped, only lose vanished photos', () => {
  const first = detect(S.emptyStore('/f'), base()).store;
  const merged = S.mergeScenes(first, [first.scenes[0].id, first.scenes[1].id], Object.fromEntries(base().map((p) => [p.relPath, p]))).store;
  assert.equal(merged.scenes[0].source, 'edited');
  const photos = base().filter((p) => p.relPath !== 'b');
  photos.push(ph('g', '2026-08-15T18:00:00'));
  const { store } = detect(merged, photos, { force: true });
  assert.deepEqual(store.scenes.map((s) => s.photos), [['a', 'c'], ['g'], ['d', 'e']]);
  assert.equal(store.scenes[0].source, 'edited');
});

test('a replaced file (same name, new size/mtime) regroups its day', () => {
  const first = detect(S.emptyStore('/f'), base()).store;
  const photos = base().map((p) => (p.relPath === 'd' ? { ...p, mtime: 2 } : p));
  assert.deepEqual(detect(first, photos).plan.affectedDays, ['2026-08-16']);
});

test('changed segmentation options regroup everything', () => {
  const first = detect(S.emptyStore('/f'), base()).store;
  const plan = S.planDetection(first, base(), { maxGapMinutes: 300 });
  assert.equal(plan.affectedDays.length, 2);
  assert.deepEqual(plan.segments.map((s) => s.photos), [['a', 'b', 'c'], ['d', 'e']]);
});

test('rename / split / move are edits; merge only for neighbours', () => {
  const photos = base();
  const byRel = Object.fromEntries(photos.map((p) => [p.relPath, p]));
  const st = detect(S.emptyStore('/f'), photos).store;
  const [s1, s2, s3] = st.scenes;

  const r = S.renameScene(st, s1.id, '  Harbour  ').store;
  assert.equal(r.scenes[0].name, 'Harbour');
  assert.equal(r.scenes[0].source, 'edited');
  assert.equal(S.renameScene(st, 'nope', 'x').error, 'scene not found');

  assert.match(S.mergeScenes(st, [s1.id, s3.id], byRel).error, /neighbouring/);

  const sp = S.splitScene(st, s1.id, 'a', byRel).store;
  assert.deepEqual(sp.scenes.map((s) => s.photos), [['a'], ['b'], ['c'], ['d', 'e']]);
  assert.equal(sp.scenes[1].name, '10:05 · 1 photo');
  assert.match(S.splitScene(st, s1.id, 'b', byRel).error, /last photo/);

  const mv = S.moveToScene(st, ['c'], s3.id, byRel).store;
  assert.deepEqual(mv.scenes.map((s) => s.photos), [['a', 'b'], ['c', 'd', 'e']]);
  assert.equal(mv.scenes[1].start, '2026-08-15T12:00:00');
  assert.ok(!mv.scenes.some((s) => s.id === s2.id), 'an emptied scene disappears');
});

test('ungroupedPhotos lists photos in no scene', () => {
  const st = detect(S.emptyStore('/f'), base()).store;
  assert.deepEqual(S.ungroupedPhotos(st, [...base(), ph('z', '2026-09-01T00:00:00')]), ['z']);
});

test('the store round-trips through disk, keyed per folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-scenes-'));
  const st = detect(S.emptyStore('/photos/A'), base()).store;
  S.writeStore(dir, '/photos/A', st);
  assert.deepEqual(S.readStore(dir, '/photos/A'), st);
  assert.equal(S.readStore(dir, '/photos/B').detectedAt, null);
  assert.notEqual(S.folderKey('/photos/A'), S.folderKey('/photos/B'));
});
