const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { atomicWriteFileSync } = require('./atomicFile');

// Job manager: a persistent FIFO queue, one per job type ("lane").
//
// Only one RawTherapee-invoking job runs at a time *per lane*: running several rawtherapee-cli
// processes in parallel was measured to give no real speedup on this hardware for full-size
// batch conversions (RT already saturates the CPU per process), so extra 'run' requests queue
// behind each other rather than running concurrently. Lanes are per job *type* (currently 'run'
// and 'preview'), so a preview render no longer waits behind a queued/running batch conversion
// or vice versa - each type gets its own single-active-job FIFO, independent of the others. (A
// preview render is now deliberately small/fast - see preview_presets.ps1 - specifically so
// running one alongside one full batch conversion doesn't reintroduce the CPU contention that
// ruled out parallel *full* renders in the first place.)
//
// Persistence: job records (not live process handles, not full logs) are written to a JSON
// file on every state change so the queue/history survives a server restart. A job's actual
// work is an in-memory closure (`fn`) supplied at enqueue time - that closure cannot survive a
// process restart, so on startup any job still marked 'queued'/'running'/'paused' from a
// previous process is recovered as 'interrupted' (its record is kept as history, it is never
// silently resumed or silently dropped) - a paused job has no more of a surviving closure than a
// queued one does, so it gets the same treatment. Re-queuing after a crash is a deliberate user
// action from the UI, not automatic - there is no safe way to reconstruct "resume this batch"
// from a JSON blob alone (which file was mid-write, etc.).
//
// Pausing: a paused job is NOT removed from its lane's pending array (unlike a cancelled one) -
// it just gets skipped over by runNext() (see below) while it stays 'paused', which means it
// keeps its exact position for free when the "Up next" list is drag-reordered (reorderQueue
// doesn't need to know or care which entries are paused) and needs no repositioning logic when
// re-queued (see requeueJob) - it simply flips back to 'queued' right where it already sits.

const DEFAULT_HISTORY_CAP = 200;
// Every status that represents "still-open work, not history yet" - never evicted from the
// persisted store by history-cap trimming, and recovered as 'interrupted' (not silently resumed)
// on a restart, since none of them have a surviving closure to actually continue running.
const ACTIVE_STATUSES = ['queued', 'running', 'paused'];

let storeFile = null;
let historyCap = DEFAULT_HISTORY_CAP;
let jobs = new Map(); // id -> job record (includes non-persisted runtime fields)
let jobOrder = []; // insertion order of ids
let lanes = new Map(); // type -> { pending: [{ job, fn }], active: jobOrNull }

function getLane(type) {
  if (!lanes.has(type)) lanes.set(type, { pending: [], active: null });
  return lanes.get(type);
}

// Only a safe, serializable subset is persisted - not the log (can be large), not the live
// child-process handle, not the onCancel closure.
function toPersisted(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    meta: job.meta,
    progress: job.progress,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function persist() {
  if (!storeFile) return;
  const activeRecords = [];
  const terminalRecords = [];
  for (const id of jobOrder) {
    const job = jobs.get(id);
    if (!job) continue;
    (ACTIVE_STATUSES.includes(job.status) ? activeRecords : terminalRecords).push(job);
  }
  // Cap only terminal (finished) history, oldest evicted first - active jobs are never evicted.
  const cappedTerminal = terminalRecords.slice(-historyCap);
  const keepIds = new Set([...activeRecords, ...cappedTerminal].map((j) => j.id));
  for (const id of [...jobs.keys()]) if (!keepIds.has(id)) jobs.delete(id);
  jobOrder = jobOrder.filter((id) => keepIds.has(id));

  atomicWriteFileSync(storeFile, JSON.stringify([...activeRecords, ...cappedTerminal].map(toPersisted), null, 2));
}

// Loads persisted job history from `file` and recovers any job left queued/running from a
// previous process as 'interrupted'. Call once at server startup.
function initJobStore(file, opts = {}) {
  storeFile = file;
  historyCap = opts.historyCap || DEFAULT_HISTORY_CAP;
  jobs = new Map();
  jobOrder = [];

  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(records)) records = [];
  } catch {
    records = [];
  }

  for (const rec of records) {
    const job = {
      ...rec, log: [], cancelRequested: false, _proc: null, onCancel: null,
    };
    if (ACTIVE_STATUSES.includes(job.status)) {
      job.status = 'interrupted';
      job.finishedAt = job.finishedAt || Date.now();
      job.error = job.error || 'server restarted while this job was queued/running';
    }
    jobs.set(job.id, job);
    jobOrder.push(job.id);
  }
  persist();
}

function createJob(type, meta) {
  const job = {
    id: randomUUID(),
    type,
    status: 'queued',
    log: [],
    progress: null,
    result: null,
    error: null,
    meta: meta || {},
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    _proc: null, // set by runner.js while a child process is active, for cancellation
    onCancel: null, // optional (job) => void, set by the enqueuing code for domain cleanup
  };
  jobs.set(job.id, job);
  jobOrder.push(job.id);
  persist();
  return job;
}

function getJob(id) {
  return jobs.get(id);
}

// Newest first; optionally filtered by type and/or a list of statuses.
function listJobs({ type, status } = {}) {
  return jobOrder
    .map((id) => jobs.get(id))
    .filter(Boolean)
    .filter((j) => !type || j.type === type)
    .filter((j) => !status || status.includes(j.status))
    .slice()
    .reverse();
}

// The actual execution order *for one lane* (job type): the currently active job (or null if
// idle) followed by every still-queued job of that type in real FIFO order - not the same as
// listJobs()'s newest-first display order mixing every type together. Used for ETA math
// (jobEta.js), where a queued job's wait depends only on what's actually ahead of it *in its own
// lane*, since a different type now runs independently.
function listExecutionOrder(type) {
  const lane = getLane(type);
  return [lane.active, ...lane.pending.map((p) => p.job)];
}

// Every job type that currently has (or has ever had, this process) a lane - so callers like
// server.js's ETA computation don't need to hardcode the set of known job types.
function listLaneTypes() {
  return [...lanes.keys()];
}

// Ids of a lane's still-queued jobs, in their actual run order (index 0 = next to start) - the
// basis for the "Up next" queue-position shown/reordered in the UI.
function listQueuedIds(type) {
  return getLane(type).pending.map((p) => p.job.id);
}

// Reorders a lane's not-yet-started jobs to match `orderedIds` (as produced by dragging items in
// the "Up next" list). Ids not currently queued (already started, finished, or simply unknown)
// are ignored rather than erroring - the list the UI dragged from is a snapshot that can go
// slightly stale between fetch and drop. Any currently-queued job *not* mentioned in
// `orderedIds` (e.g. one that was queued by someone else between that fetch and this request)
// is appended at the end in its original relative order, rather than silently dropped from the
// queue entirely.
function reorderQueue(type, orderedIds) {
  const lane = getLane(type);
  const byId = new Map(lane.pending.map((p) => [p.job.id, p]));
  const reordered = [];
  for (const id of orderedIds) {
    if (byId.has(id)) {
      reordered.push(byId.get(id));
      byId.delete(id);
    }
  }
  for (const p of lane.pending) {
    if (byId.has(p.job.id)) reordered.push(p);
  }
  lane.pending = reordered;
}

function appendLog(job, line) {
  job.log.push(line);
  if (job.log.length > 2000) job.log.shift();
}

function runNext(type) {
  const lane = getLane(type);
  if (lane.active) return;
  // Skips over any paused entries rather than always taking index 0 - a paused job stays in
  // place in `pending` (see the file header) instead of being removed, so the next *runnable*
  // job may not be at the front.
  const idx = lane.pending.findIndex((p) => p.job.status === 'queued');
  if (idx === -1) return; // nothing runnable right now (empty, or everything paused)
  const { job, fn } = lane.pending.splice(idx, 1)[0];
  if (job.status === 'cancelled') { runNext(type); return; } // defensive: cancelled while queued

  lane.active = job;
  job.status = 'running';
  job.startedAt = Date.now();
  persist();

  Promise.resolve()
    .then(() => fn(job))
    .then((result) => {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        job.error = job.error || 'cancelled by user';
      } else {
        job.status = 'done';
        job.result = result;
      }
    })
    .catch((err) => {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        job.error = job.error || 'cancelled by user';
      } else {
        job.status = 'error';
        job.error = err.message || String(err);
      }
    })
    .finally(() => {
      job.finishedAt = Date.now();
      job._proc = null;
      lane.active = null;
      persist();
      runNext(type);
    });
}

// fn(job) does the actual work (spawns a process, updates job.progress/job.log as it goes)
// and returns/throws the final result. meta is arbitrary, serializable, job-identifying
// data (project name, preset, photo count, ...) surfaced to the frontend before the job finishes.
function enqueue(type, fn, meta) {
  const job = createJob(type, meta);
  getLane(type).pending.push({ job, fn });
  runNext(type);
  return job;
}

// Cancels a job: removes it before it ever runs if still queued, or requests cancellation of
// an active job (kills its child process and runs its onCancel cleanup hook, if any - e.g.
// deleting a partial output file so a killed mid-write JPEG doesn't get treated as a
// successfully converted file by the pipeline's own idempotency check on future runs).
// The job's actual terminal status is still decided by runNext once `fn` settles, not here.
function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: 'job not found' };

  if (job.status === 'queued' || job.status === 'paused') {
    const wasPaused = job.status === 'paused';
    const lane = getLane(job.type);
    const idx = lane.pending.findIndex((p) => p.job.id === id);
    if (idx !== -1) lane.pending.splice(idx, 1);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    job.error = wasPaused ? 'cancelled while paused' : 'cancelled before it started';
    persist();
    return { ok: true };
  }

  if (job.status === 'running') {
    job.cancelRequested = true;
    if (typeof job.onCancel === 'function') {
      try { job.onCancel(job); } catch (err) { console.error(`onCancel hook failed for job ${id}:`, err); }
    }
    if (job._proc) {
      try { job._proc.kill(); } catch (err) { console.error(`failed to kill process for job ${id}:`, err); }
      // Belt-and-suspenders on Windows: killing the direct child (powershell.exe) does not
      // necessarily kill its grandchild (rawtherapee-cli.exe) - ask Windows to kill the whole
      // tree too. Best-effort: a stale/already-dead PID just fails harmlessly here.
      if (job._proc.pid) {
        try {
          const killer = spawn('taskkill', ['/pid', String(job._proc.pid), '/T', '/F']);
          killer.on('error', () => {}); // e.g. taskkill not found - nothing more to do
        } catch { /* best effort */ }
      }
    }
    persist();
    return { ok: true };
  }

  return { ok: false, error: `cannot cancel a job with status "${job.status}"` };
}

// Pauses a still-queued job: it stops being eligible to run (see runNext's skip-over-paused
// logic) but stays exactly where it is in its lane's pending array - not removed, not moved -
// so its position survives both a subsequent drag-reorder and the eventual re-queue. Only a
// queued job can be paused; RawTherapee has no pause/resume for an already-running process, so
// an active job can only be cancelled (killed), never paused.
function pauseJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.status !== 'queued') return { ok: false, error: `cannot pause a job with status "${job.status}"` };
  job.status = 'paused';
  persist();
  return { ok: true };
}

// Flips a paused job back to 'queued' in place - no repositioning needed, it never left its
// slot in the lane's pending array - and kicks the lane in case it's currently idle (a lane with
// nothing but paused jobs in it stays idle until one of them is re-queued).
function requeueJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.status !== 'paused') return { ok: false, error: `cannot re-queue a job with status "${job.status}"` };
  job.status = 'queued';
  persist();
  runNext(job.type);
  return { ok: true };
}

// Test-only: resets all in-memory state so tests don't bleed into each other. Not used by
// server.js.
function _resetForTests() {
  storeFile = null;
  historyCap = DEFAULT_HISTORY_CAP;
  jobs = new Map();
  jobOrder = [];
  lanes = new Map();
}

module.exports = {
  initJobStore,
  enqueue,
  getJob,
  listJobs,
  listExecutionOrder,
  listLaneTypes,
  listQueuedIds,
  reorderQueue,
  appendLog,
  cancelJob,
  pauseJob,
  requeueJob,
  _resetForTests,
};
