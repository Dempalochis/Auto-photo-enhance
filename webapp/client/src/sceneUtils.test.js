import { describe, expect, test } from 'vitest';
import {
  groupByScene, filterPhotosForScenes, sceneTimeRange, daysOf, UNGROUPED_KEY,
} from './sceneUtils';

const p = (relPath, dateTaken) => ({ relPath, name: relPath, dateTaken, size: 1 });
const photos = [
  p('a', '2026-08-15T10:00:00'), p('b', '2026-08-15T10:05:00'), p('c', '2026-08-15T23:58:00'),
  p('d', '2026-08-16T00:03:00'), p('e', '2026-08-16T09:00:00'), p('x', '2026-08-17T12:00:00'),
];
const scenes = [
  { id: 's1', name: 'Harbour', photos: ['a', 'b'], start: '2026-08-15T10:00:00', end: '2026-08-15T10:05:00' },
  { id: 's2', name: 'Night walk', photos: ['c', 'd'], start: '2026-08-15T23:58:00', end: '2026-08-16T00:03:00', captions: { d: 'neon street sign' } },
  { id: 's3', name: 'Breakfast', photos: ['e'], start: '2026-08-16T09:00:00', end: '2026-08-16T09:00:00' },
];

describe('groupByScene', () => {
  test('day -> scene -> photos, oldest first; a scene sits under the day it started', () => {
    const days = groupByScene(photos, scenes, 'oldest');
    expect(days.map((d) => d.key)).toEqual(['2026-08-15', '2026-08-16', UNGROUPED_KEY]);
    expect(days[0].scenes.map((s) => s.key)).toEqual(['s1', 's2']);
    expect(days[0].scenes[1].photos.map((x) => x.relPath)).toEqual(['c', 'd']); // crosses midnight
    expect(days[1].scenes.map((s) => s.key)).toEqual(['s3']);
    expect(days[0].photos.map((x) => x.relPath)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('newest first reverses days, scenes and photos', () => {
    const days = groupByScene(photos, scenes, 'newest');
    expect(days.map((d) => d.key)).toEqual(['2026-08-16', '2026-08-15', UNGROUPED_KEY]);
    expect(days[1].scenes.map((s) => s.key)).toEqual(['s2', 's1']);
    expect(days[1].scenes[1].photos.map((x) => x.relPath)).toEqual(['b', 'a']);
  });

  test('photos in no scene land in the Ungrouped bucket; nothing disappears', () => {
    const days = groupByScene(photos, scenes, 'oldest');
    const all = days.flatMap((d) => d.scenes.flatMap((s) => s.photos.map((x) => x.relPath)));
    expect(all.sort()).toEqual(photos.map((x) => x.relPath).sort());
    expect(days.at(-1).scenes[0].photos.map((x) => x.relPath)).toEqual(['x']);
  });

  test('scenes whose photos are all filtered out are hidden; no scenes = everything ungrouped', () => {
    const days = groupByScene([photos[4]], scenes, 'oldest');
    expect(days).toHaveLength(1);
    expect(days[0].scenes[0].key).toBe('s3');
    expect(groupByScene(photos, [], 'oldest')).toHaveLength(1);
  });
});

describe('filterPhotosForScenes', () => {
  test('search matches filename, scene name or caption', () => {
    const f = (search) => filterPhotosForScenes(photos, scenes, { search }).map((x) => x.relPath);
    expect(f('harb')).toEqual(['a', 'b']);
    expect(f('neon')).toEqual(['d']);
    expect(f('x')).toEqual(['x']);
  });

  test('date filter works as in Date view', () => {
    expect(filterPhotosForScenes(photos, scenes, { minDate: '2026-08-16', maxDate: '2026-08-16' }).map((x) => x.relPath)).toEqual(['d', 'e']);
  });
});

test('sceneTimeRange and daysOf', () => {
  expect(sceneTimeRange(scenes[0])).toBe('10:00–10:05');
  expect(sceneTimeRange(scenes[1])).toBe('23:58–00:03 (+1 day)');
  expect(sceneTimeRange(scenes[2])).toBe('09:00');
  expect(daysOf(photos)).toEqual(['2026-08-15', '2026-08-16', '2026-08-17']);
});
