const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { atomicWriteFileSync } = require('./atomicFile');

// Job manager: a persistent, single-active-job FIFO queue.
//
// Only one RawTherapee-invoking job runs at a time, server-wide: running several
// rawtherapee-cli processes in parallel was measured to give no real speedup on this
// hardware (RT already saturates the CPU per process) and only adds contention, so
// extra requests are queued instead of run concurrently or rejected outright.
//
// Persistence: job records (not live process handles, not full logs) are written to a JSON
// file on every state change so the queue/history survives a server restart. A job's actual
// work is an in-memory closure (`fn`) supplied at enqueue time - that closure cannot survive a
// process restart, so on startup any job still marked 'queued' or 'running' from a previous
// process is recovered as 'interrupted' (its record is kept as history, it is never silently
// resumed or silently dropped). Re-queuing after a crash is a deliberate user action from the
// UI, not automatic - there is no safe way to reconstruct "resume this batch" from a JSON blob
// alone (which file was mid-write, etc.).

const DEFAULT_HISTORY_CAP = 200;
const ACTIVE_STATUSES = ['queued', 'running'];

let storeFile = null;
let historyCap = DEFAULT_HISTORY_CAP;
let jobs = new Map(); // id -> job record (includes non-persisted runtime fields)
let jobOrder = []; // insertion order of ids
const pending = []; // [{ job, fn }], FIFO
let active = null;

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

function appendLog(job, line) {
  job.log.push(line);
  if (job.log.length > 2000) job.log.shift();
}

function runNext() {
  if (active || pending.length === 0) return;
  const { job, fn } = pending.shift();
  if (job.status === 'cancelled') { runNext(); return; } // defensive: cancelled while queued

  active = job;
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
      active = null;
      persist();
      runNext();
    });
}

// fn(job) does the actual work (spawns a process, updates job.progress/job.log as it goes)
// and returns/throws the final result. meta is arbitrary, serializable, job-identifying
// data (project name, preset, photo count, ...) surfaced to the frontend before the job finishes.
function enqueue(type, fn, meta) {
  const job = createJob(type, meta);
  pending.push({ job, fn });
  runNext();
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

  if (job.status === 'queued') {
    const idx = pending.findIndex((p) => p.job.id === id);
    if (idx !== -1) pending.splice(idx, 1);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    job.error = 'cancelled before it started';
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

// Test-only: resets all in-memory state so tests don't bleed into each other. Not used by
// server.js.
function _resetForTests() {
  storeFile = null;
  historyCap = DEFAULT_HISTORY_CAP;
  jobs = new Map();
  jobOrder = [];
  pending.length = 0;
  active = null;
}

module.exports = {
  initJobStore, enqueue, getJob, listJobs, appendLog, cancelJob, _resetForTests,
};
