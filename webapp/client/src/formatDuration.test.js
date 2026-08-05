import { describe, expect, test } from 'vitest';
import { formatEta } from './formatDuration';

describe('formatEta', () => {
  test('null shows "estimating…" rather than a fake number', () => {
    expect(formatEta(null)).toBe('estimating…');
  });

  test('zero or negative shows "almost done"', () => {
    expect(formatEta(0)).toBe('almost done');
    expect(formatEta(-500)).toBe('almost done');
  });

  test('under a minute shows seconds only', () => {
    expect(formatEta(45000)).toBe('~45s remaining');
  });

  test('an exact number of minutes omits seconds', () => {
    expect(formatEta(120000)).toBe('~2m remaining');
  });

  test('minutes and seconds both shown when both are non-zero', () => {
    expect(formatEta(125000)).toBe('~2m 5s remaining');
  });

  test('rounds to the nearest second', () => {
    expect(formatEta(44600)).toBe('~45s remaining');
  });
});
