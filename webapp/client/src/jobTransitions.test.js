import { describe, expect, test } from 'vitest';
import { detectFinishedJobs, snapshotStatuses } from './jobTransitions';

describe('detectFinishedJobs', () => {
  test('returns nothing on the first poll, even if jobs are already terminal', () => {
    const jobs = [{ id: 'a', status: 'done' }];
    const prev = new Map();
    expect(detectFinishedJobs(jobs, prev, true)).toEqual([]);
  });

  test('detects a job that moved from running to done since the last poll', () => {
    const jobs = [{ id: 'a', status: 'done' }];
    const prev = new Map([['a', 'running']]);
    expect(detectFinishedJobs(jobs, prev, false)).toEqual([{ id: 'a', status: 'done' }]);
  });

  test('detects a job that moved from queued straight to cancelled', () => {
    const jobs = [{ id: 'a', status: 'cancelled' }];
    const prev = new Map([['a', 'queued']]);
    expect(detectFinishedJobs(jobs, prev, false)).toEqual([{ id: 'a', status: 'cancelled' }]);
  });

  test('does not re-report a job that was already terminal on the previous poll', () => {
    const jobs = [{ id: 'a', status: 'done' }];
    const prev = new Map([['a', 'done']]);
    expect(detectFinishedJobs(jobs, prev, false)).toEqual([]);
  });

  test('ignores a brand-new job never seen before (no previous status to compare against)', () => {
    const jobs = [{ id: 'new', status: 'done' }];
    const prev = new Map();
    expect(detectFinishedJobs(jobs, prev, false)).toEqual([]);
  });

  test('ignores a job that is still active', () => {
    const jobs = [{ id: 'a', status: 'running' }];
    const prev = new Map([['a', 'queued']]);
    expect(detectFinishedJobs(jobs, prev, false)).toEqual([]);
  });

  test('handles a mixed batch, only reporting the ones that actually finished', () => {
    const jobs = [
      { id: 'a', status: 'done' }, // just finished
      { id: 'b', status: 'running' }, // still going
      { id: 'c', status: 'error' }, // just finished
      { id: 'd', status: 'done' }, // was already done last poll
    ];
    const prev = new Map([
      ['a', 'running'], ['b', 'running'], ['c', 'queued'], ['d', 'done'],
    ]);
    expect(detectFinishedJobs(jobs, prev, false).map((j) => j.id)).toEqual(['a', 'c']);
  });
});

describe('snapshotStatuses', () => {
  test('builds an id -> status map from a job list', () => {
    const jobs = [{ id: 'a', status: 'done' }, { id: 'b', status: 'running' }];
    expect(snapshotStatuses(jobs)).toEqual(new Map([['a', 'done'], ['b', 'running']]));
  });
});
