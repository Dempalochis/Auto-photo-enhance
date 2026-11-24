const test = require('node:test');
const assert = require('node:assert/strict');
const { applySceneReply, refineDay } = require('../sceneGrouper');
const { createMockProvider } = require('../llm/mockProvider');

const segs = [
  { photos: ['a', 'b'], start: '2026-08-15T10:00:00', startReason: 'first photo' },
  { photos: ['c'], start: '2026-08-15T10:30:00', startReason: 'gap 25 min' },
  { photos: ['d', 'e', 'f', 'g'], start: '2026-08-15T12:00:00', startReason: 'gap 80 min' },
  { photos: ['h'], start: '2026-08-15T15:00:00', startReason: 'gap 170 min' },
];
const photos = (s) => s.groups.map((g) => g.photos);

test('merges neighbouring segments and names groups', () => {
  const r = applySceneReply(segs, { groups: [{ segments: [0, 1], name: 'Harbour' }, { segments: [2], name: 'Market' }, { segments: [3], name: 'Temple' }] });
  assert.deepEqual(photos(r), [['a', 'b', 'c'], ['d', 'e', 'f', 'g'], ['h']]);
  assert.deepEqual(r.groups.map((g) => g.name), ['Harbour', 'Market', 'Temple']);
  assert.deepEqual(r.warnings, []);
});

test('non-neighbouring, overlapping and unknown groups are dropped; missing segments stay alone', () => {
  const r = applySceneReply(segs, { groups: [{ segments: [0, 2], name: 'x' }, { segments: [1, 9], name: 'y' }, { segments: [3], name: 'z' }, { segments: [3], name: 'dup' }] });
  assert.deepEqual(photos(r), [['a', 'b'], ['c'], ['d', 'e', 'f', 'g'], ['h']]);
  assert.deepEqual(r.groups.map((g) => g.name), [null, null, null, 'z']);
  assert.equal(r.warnings.length, 3);
});

test('a split cuts a lone segment after the given photo; the second part carries the reason', () => {
  const r = applySceneReply(segs, { groups: [{ segments: [2], name: 'Market' }], splits: [{ segment: 2, afterPhotoIndex: 1, reason: 'market -> temple' }] });
  assert.deepEqual(photos(r), [['a', 'b'], ['c'], ['d', 'e'], ['f', 'g'], ['h']]);
  assert.equal(r.groups[2].name, 'Market');
  assert.equal(r.groups[3].name, null);
  assert.equal(r.groups[3].reason, 'market -> temple');
});

test('splits on merged segments or out of range are dropped', () => {
  const r = applySceneReply(segs, {
    groups: [{ segments: [0, 1], name: 'H' }],
    splits: [{ segment: 0, afterPhotoIndex: 0 }, { segment: 2, afterPhotoIndex: 3 }, { segment: 9, afterPhotoIndex: 0 }],
  });
  assert.deepEqual(photos(r), [['a', 'b', 'c'], ['d', 'e', 'f', 'g'], ['h']]);
  assert.equal(r.warnings.length, 3);
});

test('garbage replies keep the code segments unchanged', () => {
  for (const reply of [null, {}, { groups: 'x' }, { groups: [{}] }]) {
    assert.deepEqual(photos(applySceneReply(segs, reply)), segs.map((s) => s.photos));
  }
});

test('refineDay names scenes from the LLM and falls back cleanly when it fails', async () => {
  const byRel = Object.fromEntries('abcdefgh'.split('').map((r, i) => [r, { relPath: r, dateTaken: `2026-08-15T1${i}:00:00` }]));
  const tagsFor = (r) => ({ setting: 'beach', subject: 'people', light: 'overcast', caption: `cap ${r}` });
  const ok = createMockProvider({}, { reply: { groups: [{ segments: [0, 1], name: 'Beach walk' }] } });
  const r = await refineDay({ day: '2026-08-15', segments: segs, photosByRel: byRel, tagsFor, provider: ok });
  assert.equal(r.llm, 'ok');
  assert.equal(r.scenes[0].name, 'Beach walk');
  assert.equal(r.scenes[0].source, 'llm');
  assert.equal(r.scenes[0].captions.c, 'cap c');
  assert.equal(r.scenes[1].source, 'auto');
  const bad = createMockProvider({}, { fail: () => true });
  const f = await refineDay({ day: '2026-08-15', segments: segs, photosByRel: byRel, tagsFor, provider: bad });
  assert.equal(f.scenes, null);
  assert.equal(f.llm, 'failed');
});
