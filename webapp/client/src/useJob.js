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
        if (cancelled) return;
        // Keep retrying rather than giving up permanently - a failed request here doesn't mean
        // the job itself failed (e.g. a transient network blip, or hitting the server during its
        // brief startup window before it's fully listening). Reproduced live during V8
        // acceptance verification: an early 502 during server cold-start killed this poll loop
        // for good, so a preview job that went on to finish successfully server-side never got
        // its thumbnails to appear client-side - it looked permanently stuck until a full page
        // refresh restarted polling from scratch. Matches HealthIndicator.jsx's and
        // JobQueuePanel.jsx's own always-reschedule-via-`finally` pattern, which useJob.js was
        // the only poll loop in the codebase *not* following - the UI now self-heals once the
        // transient issue clears, instead of requiring the user to know to refresh.
        setJob({ status: 'error', error: err.message });
        timerRef.current = setTimeout(poll, 800);
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
