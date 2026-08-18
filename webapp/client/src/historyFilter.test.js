import { describe, expect, test } from 'vitest';
import { matchesHistoryFilter } from './historyFilter';

describe('matchesHistoryFilter', () => {
  test('an empty query matches everything', () => {
    expect(matchesHistoryFilter({ meta: {} }, '')).toBe(true);
    expect(matchesHistoryFilter({ meta: {} }, '   ')).toBe(true);
  });

  test('matches a run job by project name, case-insensitively', () => {
    const job = { type: 'run', meta: { projectName: 'Summer Wedding' } };
    expect(matchesHistoryFilter(job, 'summer')).toBe(true);
    expect(matchesHistoryFilter(job, 'WEDDING')).toBe(true);
    expect(matchesHistoryFilter(job, 'autumn')).toBe(false);
  });

  test('matches a run job by preset', () => {
    const job = { type: 'run', meta: { projectName: 'Shoot A', preset: 'teal_orange' } };
    expect(matchesHistoryFilter(job, 'teal')).toBe(true);
  });

  test('matches a preview job by photo filename', () => {
    const job = { type: 'preview', meta: { photo: 'Ceremony/DSC00042.ARW' } };
    expect(matchesHistoryFilter(job, 'dsc00042')).toBe(true);
    expect(matchesHistoryFilter(job, 'dsc99999')).toBe(false);
  });

  test('does not throw on a job with no meta at all', () => {
    expect(matchesHistoryFilter({}, 'anything')).toBe(false);
  });
});
