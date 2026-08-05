import { describe, expect, test } from 'vitest';
import { computeReorderedIds } from './dragReorder';

describe('computeReorderedIds', () => {
  test('moves the active item to the dropped-on position', () => {
    expect(computeReorderedIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(computeReorderedIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  test('returns the same array reference when there is no drop target', () => {
    const ids = ['a', 'b', 'c'];
    expect(computeReorderedIds(ids, 'a', undefined)).toBe(ids);
    expect(computeReorderedIds(ids, 'a', null)).toBe(ids);
  });

  test('returns the same array reference when dropped back on itself (no-op drag)', () => {
    const ids = ['a', 'b', 'c'];
    expect(computeReorderedIds(ids, 'b', 'b')).toBe(ids);
  });

  test('returns the same array reference if either id is unknown, rather than throwing', () => {
    const ids = ['a', 'b', 'c'];
    expect(computeReorderedIds(ids, 'not-real', 'b')).toBe(ids);
    expect(computeReorderedIds(ids, 'a', 'not-real')).toBe(ids);
  });

  test('moving an item one slot down works correctly', () => {
    expect(computeReorderedIds(['a', 'b', 'c', 'd'], 'a', 'b')).toEqual(['b', 'a', 'c', 'd']);
  });
});
