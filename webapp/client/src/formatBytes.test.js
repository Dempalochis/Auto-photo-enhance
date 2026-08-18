import { describe, expect, test } from 'vitest';
import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  test('null/undefined/NaN render as an em dash, not "0 B" or "NaN"', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
  });

  test('zero bytes renders explicitly as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  test('formats bytes with no decimal places', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  test('formats KB/MB/GB with one decimal place', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(2.3 * 1024 ** 3)).toBe('2.3 GB');
  });

  test('rolls over to the next unit right at 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
  });
});
