import { describe, expect, test, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useJob } from './useJob';
import * as api from './api';

vi.mock('./api', () => ({
  getJob: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useJob', () => {
  test('returns null before any jobId is set', () => {
    const { result } = renderHook(() => useJob(null));
    expect(result.current).toBeNull();
  });

  test('fetches and returns the job once a jobId is given', async () => {
    api.getJob.mockResolvedValue({ id: 'job-1', status: 'done', progress: { items: [] } });
    const { result } = renderHook(() => useJob('job-1'));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current.id).toBe('job-1');
  });

  test('drops the previous job data immediately when jobId switches, before the new poll resolves', async () => {
    api.getJob.mockResolvedValue({ id: 'job-1', status: 'done', progress: { items: [{ label: 'a', status: 'done' }] } });
    const { result, rerender } = renderHook(({ jobId }) => useJob(jobId), { initialProps: { jobId: 'job-1' } });
    await waitFor(() => expect(result.current?.id).toBe('job-1'));

    // A new preview job for a different photo - the previous job's data must not linger under
    // the new id while its own first fetch is still in flight.
    let resolveSecond;
    api.getJob.mockReturnValue(new Promise((resolve) => { resolveSecond = resolve; }));
    rerender({ jobId: 'job-2' });
    expect(result.current).toBeNull();

    resolveSecond({ id: 'job-2', status: 'done', progress: { items: [] } });
    await waitFor(() => expect(result.current?.id).toBe('job-2'));
  });

  // Regression test for a real bug reproduced during V8 acceptance verification on an actual
  // machine: an early transient failure (a 502 during the server's brief cold-start window)
  // permanently killed this poll loop, so a preview job that went on to finish successfully
  // server-side never got its thumbnails to appear client-side - stuck until a full page
  // refresh. The fix always reschedules the next poll, matching HealthIndicator.jsx's and
  // JobQueuePanel.jsx's own pattern, instead of only rescheduling inside the try block.
  test('a transient poll failure keeps retrying instead of permanently stopping', async () => {
    api.getJob
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValue({ id: 'job-1', status: 'done', progress: { items: [{ label: 'a', status: 'done' }] } });

    const { result } = renderHook(() => useJob('job-1'));

    // First poll fails - surfaces as a (transient) error state, not silence.
    await waitFor(() => expect(result.current?.status).toBe('error'));

    // The retry (scheduled 800ms after the failure) succeeds and overwrites the error state with
    // the job's real status - this is the actual bug: before the fix, no retry was ever
    // scheduled here, so this would time out with result.current stuck at status 'error' forever.
    await waitFor(() => expect(result.current?.status).toBe('done'), { timeout: 2000 });
    expect(result.current.progress.items).toEqual([{ label: 'a', status: 'done' }]);
  });
});
