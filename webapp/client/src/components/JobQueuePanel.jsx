import { useEffect, useRef, useState } from 'react';
import { listJobs, cancelJob } from '../api';
import { detectFinishedJobs, snapshotStatuses } from '../jobTransitions';
import Hint from './Hint';

const NOTIFY_KEY = 'ape.notifyOnJobDone';
const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window;

const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

const STATUS_CLASS = {
  queued: 'text-[var(--text-dim)]',
  running: 'text-[var(--amber)]',
  done: 'text-[var(--cat-nature)]',
  error: 'text-[var(--danger)]',
  cancelled: 'text-[var(--text-dim)]',
  interrupted: 'text-[var(--danger)]',
};

function jobLabel(job) {
  if (job.type === 'run') return job.meta?.projectName || 'Batch run';
  if (job.type === 'preview') return `Preview: ${job.meta?.photo || '…'}`;
  return job.type;
}

function jobSubtitle(job) {
  if (job.type === 'run') {
    const count = job.meta?.photoCount ?? '?';
    const preset = job.meta?.preset && job.meta.preset !== 'none' ? job.meta.preset : 'color correction only';
    return `${count} photo${count === 1 ? '' : 's'} · ${preset}`;
  }
  return 'Renders base + all preset looks for one photo';
}

function progressPct(job) {
  const items = job.progress?.items;
  if (!items || items.length === 0) return null;
  const done = items.filter((i) => i.status === 'done' || i.status === 'failed').length;
  return Math.round((done / items.length) * 100);
}

// Polls the server's job list as the single source of truth for what's queued/running/done -
// deliberately not tracking job IDs in React state, so this stays correct even across a page
// refresh mid-batch, and shows every job (including ones queued from elsewhere) not just ones
// this particular browser tab happened to enqueue.
export default function JobQueuePanel({ limit = 12 }) {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [notifyEnabled, setNotifyEnabled] = useState(() => localStorage.getItem(NOTIFY_KEY) === 'true');
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);
  const toastTimerRef = useRef(null);
  const prevStatusRef = useRef(new Map());
  const isFirstPollRef = useRef(true);
  // The poll loop is set up once (empty effect deps below) but needs the *current* value of
  // notifyEnabled each time a job finishes, not whatever it was when the effect first ran - a
  // ref sidesteps the stale-closure trap without re-subscribing the whole poll loop on toggle.
  const notifyEnabledRef = useRef(notifyEnabled);
  useEffect(() => { notifyEnabledRef.current = notifyEnabled; }, [notifyEnabled]);
  useEffect(() => { localStorage.setItem(NOTIFY_KEY, String(notifyEnabled)); }, [notifyEnabled]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await listJobs();
        if (!cancelled) {
          const finished = detectFinishedJobs(data.jobs, prevStatusRef.current, isFirstPollRef.current);
          prevStatusRef.current = snapshotStatuses(data.jobs);
          isFirstPollRef.current = false;

          if (finished.length > 0) {
            const summary = finished.map((j) => `${jobLabel(j)}: ${STATUS_LABEL[j.status] || j.status}`).join(' · ');
            setToast(summary);
            clearTimeout(toastTimerRef.current);
            toastTimerRef.current = setTimeout(() => setToast(null), 6000);

            if (notifyEnabledRef.current && notificationsSupported && Notification.permission === 'granted') {
              finished.forEach((j) => {
                // eslint-disable-next-line no-new
                new Notification('Auto Photo Enhance', {
                  body: `${jobLabel(j)}: ${STATUS_LABEL[j.status] || j.status}`,
                });
              });
            }
          }

          setJobs(data.jobs);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) timerRef.current = setTimeout(poll, 1500);
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
      clearTimeout(toastTimerRef.current);
    };
  }, []);

  const handleToggleNotify = async () => {
    if (!notifyEnabled && notificationsSupported && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    setNotifyEnabled((v) => !v);
  };

  const handleCancel = async (id) => {
    setCancellingId(id);
    try {
      await cancelJob(id);
      const data = await listJobs();
      setJobs(data.jobs);
    } catch (err) {
      setError(err.message);
    } finally {
      setCancellingId(null);
    }
  };

  const visible = jobs.slice(0, limit);
  const activeCount = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">
          <Hint text="Runs and previews you've queued, newest first. Only one runs at a time, but you can keep queuing more while it works.">
            Job queue
          </Hint>
        </h2>
        <div className="flex items-center gap-2 shrink-0">
          {activeCount > 0 && <span className="timestamp">{activeCount} active</span>}
          {notificationsSupported && (
            <button
              type="button"
              onClick={handleToggleNotify}
              className={`btn-secondary text-[11px] px-2 py-1 ${notifyEnabled ? 'active' : ''}`}
              title="Show a desktop notification when a job finishes, even if this tab isn't focused"
            >
              {notifyEnabled ? 'Notify: on' : 'Notify: off'}
            </button>
          )}
        </div>
      </div>

      {toast && (
        <p className="text-xs text-[var(--cat-nature)] mb-2 break-words">{toast}</p>
      )}
      {error && <p className="text-xs text-[var(--danger)] mb-2">{error}</p>}
      {visible.length === 0 && !error && <p className="text-xs text-[var(--text-dim)]">No jobs yet.</p>}

      <ul className="space-y-2">
        {visible.map((job) => {
          const pct = progressPct(job);
          const cancellable = job.status === 'queued' || job.status === 'running';
          return (
            <li key={job.id} className="border border-[var(--border)] rounded-[3px] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{jobLabel(job)}</p>
                  <p className="timestamp truncate">{jobSubtitle(job)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[11px] font-medium ${STATUS_CLASS[job.status] || ''}`}>
                    {STATUS_LABEL[job.status] || job.status}
                  </span>
                  {cancellable && (
                    <button
                      type="button"
                      onClick={() => handleCancel(job.id)}
                      disabled={cancellingId === job.id}
                      className="btn-secondary text-[11px] px-2 py-1"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>

              {job.status === 'running' && pct !== null && (
                <div className="mt-2 h-1.5 rounded-[3px] bg-[var(--panel-raised)] overflow-hidden">
                  <div className="h-full bg-[var(--amber)] transition-all" style={{ width: `${pct}%` }} />
                </div>
              )}

              {job.status === 'done' && job.result && job.type === 'run' && (
                <p className="timestamp mt-1">
                  Processed {job.result.processed} · Skipped {job.result.skipped} · Failed {job.result.failed}
                  {job.result.quarantined > 0 && ` · Quarantined ${job.result.quarantined}`}
                </p>
              )}

              {(job.status === 'error' || job.status === 'interrupted' || job.status === 'cancelled') && job.error && (
                <p className="text-[11px] text-[var(--danger)] mt-1 break-words">{job.error}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
