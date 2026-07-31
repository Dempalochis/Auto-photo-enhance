import { useEffect, useRef, useState } from 'react';
import { getJob } from './api';

// Polls /api/jobs/:id while a job is queued/running, stops once done/error.
export function useJob(jobId) {
  const [job, setJob] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return undefined;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const data = await getJob(jobId);
        if (cancelled) return;
        setJob(data);
        if (data.status === 'queued' || data.status === 'running') {
          timerRef.current = setTimeout(poll, 800);
        }
      } catch (err) {
        if (!cancelled) setJob({ status: 'error', error: err.message });
      }
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
  }, [jobId]);

  return job;
}
