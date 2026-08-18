import { describe, expect, test } from 'vitest';
import { healthStatus } from './healthStatus';

describe('healthStatus', () => {
  test('no response yet is "unknown"', () => {
    expect(healthStatus(null)).toBe('unknown');
    expect(healthStatus(undefined)).toBe('unknown');
  });

  test('ok with no errors or warnings is "ok"', () => {
    expect(healthStatus({ ok: true, errors: [], warnings: [] })).toBe('ok');
  });

  test('ok=false is "error", regardless of the errors array', () => {
    expect(healthStatus({ ok: false, errors: [], warnings: [] })).toBe('error');
  });

  test('a non-empty errors array is "error" even if ok happens to be true', () => {
    expect(healthStatus({ ok: true, errors: ['rtPath not found'], warnings: [] })).toBe('error');
  });

  test('warnings with no errors is "warning"', () => {
    expect(healthStatus({ ok: true, errors: [], warnings: ['exiftool missing'] })).toBe('warning');
  });

  test('errors take priority over warnings', () => {
    const result = healthStatus({ ok: false, errors: ['a'], warnings: ['b'] });
    expect(result).toBe('error');
  });
});
