import { expect, test } from 'vitest';
import { planSceneRuns } from './scenePresets';

test('planSceneRuns: one run per assigned scene, in time order, existing photos only', () => {
  const scenes = [
    { id: 'b', name: 'Dinner', photos: ['b1', 'gone'], start: '2026-01-01T19:00:00' },
    { id: 'a', name: 'Beach', photos: ['a1', 'a2'], start: '2026-01-01T10:00:00' },
    { id: 'c', name: 'Unassigned', photos: ['c1'], start: '2026-01-01T12:00:00' },
  ];
  const runs = planSceneRuns(scenes, { a: 'golden_hour', b: 'none' }, ['a1', 'a2', 'b1', 'c1']);
  expect(runs).toEqual([
    { sceneId: 'a', name: 'Beach', preset: 'golden_hour', files: ['a1', 'a2'] },
    { sceneId: 'b', name: 'Dinner', preset: 'none', files: ['b1'] },
  ]);
});
