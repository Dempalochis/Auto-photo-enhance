import { useEffect, useRef, useState } from 'react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  listJobs, cancelJob, reorderJobs, pauseJob, requeueJob, retryJob,
} from '../api';
import { detectFinishedJobs, snapshotStatuses } from '../jobTransitions';
import { computeReorderedIds } from '../dragReorder';
import { formatEta } from '../formatDuration';
import { matchesHistoryFilter } from '../historyFilter';
import Hint from './Hint';

const NOTIFY_KEY = 'ape.notifyOnJobDone';
const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window;

const STATUS_LABEL = {
  queued: 'Queued',
  paused: 'Paused',
  running: 'Running',
  done: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

const STATUS_CLASS = {
  queued: 'text-[var(--text-dim)]',
  paused: 'text-[var(--amber-dim)]',
  running: 'text-[var(--amber)]',
  done: 'text-[var(--cat-nature)]',
  error: 'text-[var(--danger)]',
  cancelled: 'text-[var(--text-dim)]',
  interrupted: 'text-[var(--danger)]',
};

// Mirrors jobRetry.js's isRetryableStatus on the server - a 'run' job that finished without
// succeeding can be retried; nothing else can (a 'preview' job just re-renders for free the next
// time its photo is previewed, and a still-open job has nothing to retry yet). A 'done' job isn't
// automatically excluded: the script can complete without crashing/cancelling/interrupting while
// still failing every file it touched (e.g. a batch of corrupt input) - that's just as
// "didn't finish, want to try again" as an 'error' job. See jobRetry.js for the full reasoning.
const RETRYABLE_STATUSES = new Set(['error', 'cancelled', 'interrupted']);
function isRetryable(job) {
  if (job.type !== 'run') return false;
  return RETRYABLE_STATUSES.has(job.status) || (job.status === 'done' && job.result?.failed > 0);
}

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

// One job's card - shared by every section (active/up-next/queued-previews/history). Only the
// "Up next" section wraps this in drag-and-drop machinery (see SortableJobRow below); everywhere
// else it renders plain, since reordering only makes sense for jobs that haven't started yet.
function JobRow({
  job, onCancel, cancelling, onPause, onRequeue, pausing, onRetry, retrying, dragHandleProps, isDragging,
}) {
  const pct = progressPct(job);
  const cancellable = job.status === 'queued' || job.status === 'running' || job.status === 'paused';
  return (
    <li className={`border border-[var(--border)] rounded-[3px] px-3 py-2 ${isDragging ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {dragHandleProps && (
            // eslint-disable-next-line react/jsx-props-no-spreading
            <span
              {...dragHandleProps}
              className="cursor-grab active:cursor-grabbing text-[var(--text-dim)] shrink-0 select-none touch-none px-0.5"
              title="Drag to reorder"
            >
              ⠿
            </span>
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium truncate">{jobLabel(job)}</p>
            <p className="timestamp truncate">{jobSubtitle(job)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[11px] font-medium ${STATUS_CLASS[job.status] || ''}`}>
            {STATUS_LABEL[job.status] || job.status}
          </span>
          {job.status === 'queued' && onPause && (
            <button
              type="button"
              onClick={() => onPause(job.id)}
              disabled={pausing}
              className="btn-secondary text-[11px] px-2 py-1"
              title="Hold this job - it stays in the queue but won't run until re-queued"
            >
              Pause
            </button>
          )}
          {job.status === 'paused' && onRequeue && (
            <button
              type="button"
              onClick={() => onRequeue(job.id)}
              disabled={pausing}
              className="btn-secondary text-[11px] px-2 py-1"
              title="Make this job runnable again - it will not run on its own until you do this"
            >
              Re-queue
            </button>
          )}
          {cancellable && (
            <button
              type="button"
              onClick={() => onCancel(job.id)}
              disabled={cancelling}
              className="btn-secondary text-[11px] px-2 py-1"
            >
              Cancel
            </button>
          )}
          {isRetryable(job) && onRetry && (
            <button
              type="button"
              onClick={() => onRetry(job.id)}
              disabled={retrying}
              className="btn-secondary text-[11px] px-2 py-1"
              title="Queue a new job with the same photos, preset, and output folder as this one"
            >
              Retry
            </button>
          )}
        </div>
      </div>

      {job.status === 'running' && pct !== null && (
        <>
          <div className="mt-2 h-1.5 rounded-[3px] bg-[var(--panel-raised)] overflow-hidden">
            <div className="h-full bg-[var(--amber)] transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="timestamp mt-1">{formatEta(job.etaMs)}</p>
        </>
      )}

      {job.status === 'queued' && (
        <p className="timestamp mt-1">{formatEta(job.etaMs)}</p>
      )}

      {job.status === 'paused' && (
        <p className="timestamp mt-1 text-[var(--amber-dim)]">Held - will not run until re-queued.</p>
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
}

function SortableJobRow({
  job, onCancel, cancelling, onPause, onRequeue, pausing,
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: job.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style}>
      <JobRow
        job={job}
        onCancel={onCancel}
        cancelling={cancelling}
        onPause={onPause}
        onRequeue={onRequeue}
        pausing={pausing}
        dragHandleProps={{ ...attributes, ...listeners }}
        isDragging={isDragging}
      />
    </div>
  );
}

// Polls the server's job list as the single source of truth for what's queued/running/done -
// deliberately not tracking job IDs in React state, so this stays correct even across a page
// refresh mid-batch, and shows every job (including ones queued from elsewhere) not just ones
// this particular browser tab happened to enqueue.
//
// Split into sections since V5: "Active" (currently running), "Up next" (queued *batch runs*,
// drag-to-reorder), "Queued previews" (queued preview renders - shown plainly, not reorderable;
// in practice there's rarely more than one at a time since previewing is a one-photo-at-a-time
// action), and "History" (everything finished). Reordering is scoped to batch runs specifically
// because that's the queue that actually grows in real use (queuing several projects) and where
// prioritizing one over another has real value.
export default function JobQueuePanel({ historyLimit = 8 }) {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [pausingId, setPausingId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const [notifyEnabled, setNotifyEnabled] = useState(() => localStorage.getItem(NOTIFY_KEY) === 'true');
  const [toast, setToast] = useState(null);
  // Optimistic local override of the "Up next" order while a drag is in flight / just landed -
  // cleared as soon as the next poll confirms the server's own order, so this never drifts from
  // reality for long even if the reorder request itself fails silently for some reason.
  const [localRunQueueOrder, setLocalRunQueueOrder] = useState(null);
  // History browsing: the main poll below already fetches every kept job in one unpaginated
  // response (see historyFilter.js), so "page/search the rest of the jobs kept" is a client-side
  // slice + filter over data already in memory, not a second endpoint. historyPageSize grows via
  // "Load more"; historyQuery resets it back to the default page so a fresh search isn't stuck
  // showing however many items a previous "Load more" click had expanded to.
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyPageSize, setHistoryPageSize] = useState(historyLimit);
  const timerRef = useRef(null);
  const toastTimerRef = useRef(null);
  const prevStatusRef = useRef(new Map());
  const isFirstPollRef = useRef(true);
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
          setLocalRunQueueOrder(null); // server has caught up - drop any optimistic override
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
      // requestPermission() can reject (not just resolve "denied") on some browser/OS setups -
      // e.g. notifications locked out entirely by a managed-browser policy. Without this catch,
      // an unhandled rejection here aborts the whole handler and the toggle silently never
      // flips - reproduced on a real machine (V8 acceptance verification). The button's own
      // state is "does the user want notifications", independent of whether the browser actually
      // grants them; the real notification-firing code elsewhere already checks
      // `Notification.permission === 'granted'` before firing, so decoupling the toggle from a
      // possibly-throwing permission call loses nothing.
      try {
        await Notification.requestPermission();
      } catch {
        // Permission blocked/unavailable - fall through and still flip the toggle below.
      }
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

  const handlePause = async (id) => {
    setPausingId(id);
    try {
      await pauseJob(id);
      const data = await listJobs();
      setJobs(data.jobs);
    } catch (err) {
      setError(err.message);
    } finally {
      setPausingId(null);
    }
  };

  const handleRequeue = async (id) => {
    setPausingId(id);
    try {
      await requeueJob(id);
      const data = await listJobs();
      setJobs(data.jobs);
    } catch (err) {
      setError(err.message);
    } finally {
      setPausingId(null);
    }
  };

  const handleRetry = async (id) => {
    setRetryingId(id);
    try {
      await retryJob(id);
      const data = await listJobs();
      setJobs(data.jobs);
    } catch (err) {
      setError(err.message);
    } finally {
      setRetryingId(null);
    }
  };

  const activeJobs = jobs.filter((j) => j.status === 'running');
  // Paused jobs stay in "Up next" (see jobQueue.js: pausing doesn't remove a job from its lane,
  // just marks it un-runnable in place) so they can still be dragged and re-queued from the same
  // list, per the same reasoning that keeps reordering scoped to batch runs (see file header).
  const runQueued = jobs
    .filter((j) => (j.status === 'queued' || j.status === 'paused') && j.type === 'run')
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const otherQueued = jobs
    .filter((j) => j.status === 'queued' && j.type !== 'run')
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  // Already newest-first from the API. allHistory is every terminal job currently held in
  // memory (up to the store's history cap); filteredHistory narrows that by the History search
  // box; history is just the currently-visible page of filteredHistory ("Load more" grows
  // historyPageSize rather than fetching anything new).
  const allHistory = jobs.filter((j) => !['running', 'queued', 'paused'].includes(j.status));
  const filteredHistory = historyQuery ? allHistory.filter((j) => matchesHistoryFilter(j, historyQuery)) : allHistory;
  const history = filteredHistory.slice(0, historyPageSize);
  const hasMoreHistory = filteredHistory.length > history.length;

  const handleHistoryQueryChange = (value) => {
    setHistoryQuery(value);
    setHistoryPageSize(historyLimit); // a fresh search starts back at the default page size
  };

  const displayRunQueue = localRunQueueOrder
    ? localRunQueueOrder.map((id) => runQueued.find((j) => j.id === id)).filter(Boolean)
    : runQueued;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = async (event) => {
    const ids = displayRunQueue.map((j) => j.id);
    const newOrder = computeReorderedIds(ids, event.active.id, event.over?.id);
    if (newOrder === ids) return; // no-op drag (no target, dropped on itself, or unknown id)

    setLocalRunQueueOrder(newOrder);
    try {
      await reorderJobs('run', newOrder);
    } catch (err) {
      setError(err.message);
      setLocalRunQueueOrder(null); // revert to the server's actual order on failure
    }
  };

  const totalCount = activeJobs.length + runQueued.length + otherQueued.length + allHistory.length;
  const activeCount = activeJobs.length + runQueued.length + otherQueued.length;

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">
          <Hint text="Runs and previews you've queued. Batch runs and previews run independently, so one never waits behind the other - drag items in 'Up next' to reorder queued batch runs.">
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
      {totalCount === 0 && !error && <p className="text-xs text-[var(--text-dim)]">No jobs yet.</p>}

      {activeJobs.length > 0 && (
        <div className="mb-3">
          <p className="field-label mb-1.5">Active</p>
          <ul className="space-y-2">
            {activeJobs.map((job) => (
              <JobRow key={job.id} job={job} onCancel={handleCancel} cancelling={cancellingId === job.id} />
            ))}
          </ul>
        </div>
      )}

      {displayRunQueue.length > 0 && (
        <div className="mb-3">
          <p className="field-label mb-1.5">
            <Hint text="These haven't started yet - drag to change which one runs next.">Up next</Hint>
          </p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={displayRunQueue.map((j) => j.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {displayRunQueue.map((job) => (
                  <SortableJobRow
                    key={job.id}
                    job={job}
                    onCancel={handleCancel}
                    cancelling={cancellingId === job.id}
                    onPause={handlePause}
                    onRequeue={handleRequeue}
                    pausing={pausingId === job.id}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      )}

      {otherQueued.length > 0 && (
        <div className="mb-3">
          <p className="field-label mb-1.5">Queued previews</p>
          <ul className="space-y-2">
            {otherQueued.map((job) => (
              <JobRow key={job.id} job={job} onCancel={handleCancel} cancelling={cancellingId === job.id} />
            ))}
          </ul>
        </div>
      )}

      {allHistory.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <p className="field-label">History</p>
            <input
              type="text"
              value={historyQuery}
              onChange={(e) => handleHistoryQueryChange(e.target.value)}
              placeholder="Filter by project or preset…"
              aria-label="Filter history by project or preset"
              className="text-[11px] bg-[var(--panel-raised)] border border-[var(--border)] rounded-[3px] px-2 py-1 w-40 min-w-0"
            />
          </div>

          {history.length === 0 ? (
            <p className="text-xs text-[var(--text-dim)]">No history matches &quot;{historyQuery}&quot;.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onCancel={handleCancel}
                  cancelling={cancellingId === job.id}
                  onRetry={handleRetry}
                  retrying={retryingId === job.id}
                />
              ))}
            </ul>
          )}

          {hasMoreHistory && (
            <button
              type="button"
              onClick={() => setHistoryPageSize((n) => n + historyLimit)}
              className="btn-secondary text-[11px] px-2 py-1 mt-2 w-full"
            >
              {`Load more (${filteredHistory.length - history.length} more)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
