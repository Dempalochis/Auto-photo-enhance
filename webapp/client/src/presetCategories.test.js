import { describe, expect, test } from 'vitest';
import { CATEGORIES, categoryFor } from './presetCategories';

describe('presetCategories', () => {
  test('every preset name across all categories is unique - no preset double-counted in the grid', () => {
    const all = CATEGORIES.flatMap((c) => c.presets);
    expect(new Set(all).size).toBe(all.length);
  });

  test('categoryFor finds the right category for a preset in any section', () => {
    expect(categoryFor('golden_hour')?.key).toBe('nature');
    expect(categoryFor('teal_orange')?.key).toBe('urban');
    expect(categoryFor('neon_nights')?.key).toBe('night');
    expect(categoryFor('natural_skin')?.key).toBe('portrait');
    expect(categoryFor('analog_fade')?.key).toBe('mood');
  });

  test('categoryFor returns null for an unknown preset name rather than throwing', () => {
    expect(categoryFor('does_not_exist')).toBeNull();
  });

  test('the two newest presets (dramatic_mono, analog_fade) are correctly categorized', () => {
    expect(categoryFor('dramatic_mono')?.key).toBe('nature');
    expect(categoryFor('analog_fade')?.key).toBe('mood');
  });
});
