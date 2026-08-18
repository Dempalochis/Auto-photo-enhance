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
    // Drop the previous job's data immediately, before the first poll for the new id resolves -
    // otherwise a caller (e.g. PresetPreview switching to a newly-clicked photo) would briefly
    // render the old job's thumbnails/progress under the new jobId instead of the fresh
    // "preparing" state.
    setJob(null);

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
