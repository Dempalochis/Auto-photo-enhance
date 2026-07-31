const { randomUUID } = require('crypto');

// Only one RawTherapee-invoking job runs at a time, server-wide: running several
// rawtherapee-cli processes in parallel was measured to give no real speedup on this
// hardware (RT already saturates the CPU per process) and only adds contention, so
// extra requests are queued instead of run concurrently or rejected outright.
const jobs = new Map();
const pending = [];
let active = null;

function createJob(type) {
  const job = {
    id: randomUUID(),
    type,
    status: 'queued',
    log: [],
    progress: null,
    result: null,
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id);
}

function appendLog(job, line) {
  job.log.push(line);
  if (job.log.length > 2000) job.log.shift();
}

function runNext() {
  if (active || pending.length === 0) return;
  const { job, fn } = pending.shift();
  active = job;
  job.status = 'running';
  Promise.resolve()
    .then(() => fn(job))
    .then((result) => {
      job.status = 'done';
      job.result = result;
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message || String(err);
    })
    .finally(() => {
      active = null;
      runNext();
    });
}

// fn(job) does the actual work (spawns a process, updates job.progress/job.log as it goes)
// and returns/throws the final result.
function enqueue(type, fn) {
  const job = createJob(type);
  pending.push({ job, fn });
  runNext();
  return job;
}

module.exports = { enqueue, getJob, appendLog };
