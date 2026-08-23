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
});
