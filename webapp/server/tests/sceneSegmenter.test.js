const test = require('node:test');
const assert = require('node:assert/strict');
const {
  exposureValue, segmentPhotos, segmentName, sceneOptions, timeMs,
} = require('../sceneSegmenter');

const day = { iso: 100, exposureTime: 1 / 500, fNumber: 8 }; // EV100 ~15
const indoor = { iso: 1600, exposureTime: 1 / 60, fNumber: 2.8 }; // EV100 ~5
const p = (relPath, time, extra = {}) => ({ relPath, dateTaken: `2026-08-15T${time}`, model: 'ILCE-7M3', flash: false, ...day, ...extra });

test('exposureValue matches the EV100 formula and is null with missing inputs', () => {
  assert.ok(Math.abs(exposureValue(day) - 14.97) < 0.05);
  assert.ok(Math.abs(exposureValue(indoor) - 4.88) < 0.05);
  assert.equal(exposureValue({ iso: 100, exposureTime: 0.01 }), null);
  assert.equal(exposureValue({ iso: 100, exposureTime: 0.01, fNumber: 0 }), null);
});

test('photos within the gap stay in one segment, a long gap starts a new one', () => {
  const { segments } = segmentPhotos([p('a', '10:00:00'), p('b', '10:05:00'), p('c', '10:14:00'), p('d', '10:30:00')]);
  assert.deepEqual(segments.map((s) => s.photos), [['a', 'b', 'c'], ['d']]);
  assert.match(segments[1].startReason, /^gap 16 min/);
});

test('exactly maxGapMinutes does not split (strictly greater than)', () => {
  const { segments } = segmentPhotos([p('a', '10:00:00'), p('b', '10:10:00')]);
  assert.equal(segments.length, 1);
});

test('an EV jump above the threshold splits even with no time gap', () => {
  const { segments } = segmentPhotos([p('a', '10:00:00'), p('b', '10:01:00', indoor), p('c', '10:02:00', indoor)]);
  assert.deepEqual(segments.map((s) => s.photos), [['a'], ['b', 'c']]);
  assert.match(segments[1].startReason, /^EV jump -10/);
});

test('EV is ignored when either photo lacks exposure data', () => {
  const { segments } = segmentPhotos([p('a', '10:00:00'), p('b', '10:01:00', { ...indoor, fNumber: null })]);
  assert.equal(segments.length, 1);
});

test('flash on/off splits; can be turned off', () => {
  const photos = [p('a', '10:00:00'), p('b', '10:01:00', { flash: true })];
  assert.equal(segmentPhotos(photos).segments.length, 2);
  assert.equal(segmentPhotos(photos, { splitByFlash: false }).segments.length, 1);
});

test('camera change splits only when splitByCamera is on', () => {
  const photos = [p('a', '10:00:00'), p('b', '10:01:00', { model: 'X-T2' })];
  assert.equal(segmentPhotos(photos).segments.length, 2);
  assert.equal(segmentPhotos(photos, { splitByCamera: false }).segments.length, 1);
});

test('scenes may cross midnight', () => {
  const photos = [
    { ...p('a', '23:58:00') },
    { ...p('b', '00:00:00'), dateTaken: '2026-08-16T00:03:00' },
  ];
  assert.equal(segmentPhotos(photos).segments.length, 1);
});

test('photos are sorted by time (then relPath) regardless of input order', () => {
  const { segments } = segmentPhotos([p('c', '10:02:00'), p('a', '10:00:00'), p('b', '10:00:00')]);
  assert.deepEqual(segments[0].photos, ['a', 'b', 'c']);
});

test('photos without a capture time go to ungrouped', () => {
  const { segments, ungrouped } = segmentPhotos([p('a', '10:00:00'), { relPath: 'x', dateTaken: null }]);
  assert.equal(segments.length, 1);
  assert.deepEqual(ungrouped, ['x']);
});

test('names come from the time range and count', () => {
  const { segments } = segmentPhotos([p('a', '14:05:00'), p('b', '14:12:00'), p('c', '14:20:00')]);
  assert.equal(segments[0].name, '14:05–14:20 · 3 photos');
  assert.equal(segmentName({ start: '2026-08-15T09:01:00', end: '2026-08-15T09:01:30', photos: ['a'] }), '09:01 · 1 photo');
});

test('sceneOptions fills defaults and keeps explicit falsy values', () => {
  const o = sceneOptions({ maxGapMinutes: 5, splitByCamera: false });
  assert.equal(o.maxGapMinutes, 5);
  assert.equal(o.splitByCamera, false);
  assert.equal(o.evJumpThreshold, 3);
  assert.equal(timeMs('garbage'), null);
});
