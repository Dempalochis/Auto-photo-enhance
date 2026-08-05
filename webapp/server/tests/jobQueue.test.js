const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jobQueue = require('../jobQueue');

function tempStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-jobqueue-test-'));
  return path.join(dir, 'jobs.json');
}

// Every test gets a fresh in-memory queue + its own store file, so tests never bleed into
// each other despite jobQueue being a module-level singleton.
function freshQueue(opts) {
  const file = tempStoreFile();
  jobQueue._resetForTests();
  jobQueue.initJobStore(file, opts);
  return file;
}

function waitForSettled(jobId, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const job = jobQueue.getJob(jobId);
      if (['done', 'error', 'cancelled'].includes(job.status)) return resolve(job);
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for job'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('enqueue runs jobs FIFO, one at a time', async () => {
  freshQueue();
  const order = [];
  let releaseA;
  const gateA = new Promise((res) => { releaseA = res; });

  const jobA = jobQueue.enqueue('test', async () => {
    order.push('A start');
    await gateA;
    order.push('A end');
    return 'a-result';
  });
  const jobB = jobQueue.enqueue('test', async () => {
    order.push('B start');
    return 'b-result';
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jobQueue.getJob(jobA.id).status, 'running');
  assert.equal(jobQueue.getJob(jobB.id).status, 'queued');
  assert.deepEqual(order, ['A start']);

  releaseA();
  const doneA = await waitForSettled(jobA.id);
  const doneB = await waitForSettled(jobB.id);

  assert.equal(doneA.status, 'done');
  assert.equal(doneA.result, 'a-result');
  assert.equal(doneB.status, 'done');
  assert.equal(doneB.result, 'b-result');
  assert.deepEqual(order, ['A start', 'A end', 'B start']);
});

test('a job that throws is recorded as status "error", and the queue continues', async () => {
  freshQueue();
  const failing = jobQueue.enqueue('test', async () => { throw new Error('boom'); });
  const after = jobQueue.enqueue('test', async () => 'ok');

  const doneFailing = await waitForSettled(failing.id);
  const doneAfter = await waitForSettled(after.id);

  assert.equal(doneFailing.status, 'error');
  assert.equal(doneFailing.error, 'boom');
  assert.equal(doneAfter.status, 'done');
});

test('appendLog caps a job\'s log at 2000 lines, dropping the oldest first', () => {
  freshQueue();
  const job = { log: [] };
  for (let i = 0; i < 2005; i += 1) jobQueue.appendLog(job, `line ${i}`);
  assert.equal(job.log.length, 2000);
  assert.equal(job.log[0], 'line 5');
  assert.equal(job.log[job.log.length - 1], 'line 2004');
});

test('job records persist to disk and round-trip through a fresh store', async () => {
  const file = freshQueue();
  const job = jobQueue.enqueue('run', async () => 'result', { projectName: 'Test Project' });
  await waitForSettled(job.id);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].id, job.id);
  assert.equal(onDisk[0].status, 'done');
  assert.equal(onDisk[0].meta.projectName, 'Test Project');
});

test('restart recovery: a job left running/queued from a previous process is marked interrupted', async () => {
  const file = freshQueue();
  let releaseRunning;
  let markSettled;
  const gate = new Promise((res) => { releaseRunning = res; });
  const orphanSettled = new Promise((res) => { markSettled = res; });

  const runningJob = jobQueue.enqueue('run', async () => { await gate; markSettled(); return 'never seen'; });
  const queuedJob = jobQueue.enqueue('run', async () => 'never seen either');

  // Let the first job actually reach 'running' and get persisted before "restarting".
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jobQueue.getJob(runningJob.id).status, 'running');
  assert.equal(jobQueue.getJob(queuedJob.id).status, 'queued');

  // Simulate a server restart: fresh in-memory state, re-init from the same file.
  jobQueue._resetForTests();
  jobQueue.initJobStore(file);

  assert.equal(jobQueue.getJob(runningJob.id).status, 'interrupted');
  assert.equal(jobQueue.getJob(queuedJob.id).status, 'interrupted');

  // Drain the orphaned pre-"restart" promise fully (fn resolution + jobQueue's own .then/
  // .finally chain, which references the *old* job object) before the next test runs -
  // otherwise its deferred persist()/runNext() calls could interleave with the next test's
  // freshQueue(), since jobQueue's module-level state is a singleton shared across tests.
  releaseRunning();
  await orphanSettled;
  await new Promise((r) => setTimeout(r, 0)); // flush jobQueue's .then/.catch/.finally microtasks
});

test('cancelling a queued job removes it before it ever runs', async () => {
  freshQueue();
  let bStarted = false;
  const jobA = jobQueue.enqueue('test', async () => new Promise((res) => setTimeout(() => res('a'), 50)));
  const jobB = jobQueue.enqueue('test', async () => { bStarted = true; return 'b'; });

  const result = jobQueue.cancelJob(jobB.id);
  assert.equal(result.ok, true);
  assert.equal(jobQueue.getJob(jobB.id).status, 'cancelled');

  await waitForSettled(jobA.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bStarted, false, 'a cancelled-while-queued job must never run its fn');
});

test('cancelling an active job kills its process handle and runs its onCancel cleanup hook', async () => {
  freshQueue();
  const killCalls = [];
  let cleanupRan = false;
  let resolveJob;
  const gate = new Promise((res) => { resolveJob = res; });

  const job = jobQueue.enqueue('run', async (job) => {
    job._proc = { pid: 999999, kill: () => killCalls.push('killed') };
    job.onCancel = () => { cleanupRan = true; };
    await gate;
    return 'result';
  });

  await new Promise((r) => setTimeout(r, 20)); // let it reach 'running' and set _proc/onCancel
  assert.equal(jobQueue.getJob(job.id).status, 'running');

  const result = jobQueue.cancelJob(job.id);
  assert.equal(result.ok, true);
  assert.deepEqual(killCalls, ['killed']);
  assert.equal(cleanupRan, true);

  resolveJob(); // the underlying fn settles normally, as a real killed process's promise would
  const settled = await waitForSettled(job.id);
  assert.equal(settled.status, 'cancelled', 'cancelRequested must override the fn\'s own resolution');
});

test('cannot cancel a job that has already finished', async () => {
  freshQueue();
  const job = jobQueue.enqueue('test', async () => 'done already');
  await waitForSettled(job.id);
  const result = jobQueue.cancelJob(job.id);
  assert.equal(result.ok, false);
});

test('cancelling an unknown job id returns an error', () => {
  freshQueue();
  const result = jobQueue.cancelJob('does-not-exist');
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('listJobs returns newest first and supports type/status filters', async () => {
  freshQueue();
  const runJob = jobQueue.enqueue('run', async () => 'r');
  const previewJob = jobQueue.enqueue('preview', async () => 'p');
  await waitForSettled(runJob.id);
  await waitForSettled(previewJob.id);

  const all = jobQueue.listJobs();
  assert.deepEqual(all.map((j) => j.id), [previewJob.id, runJob.id]);

  const onlyRun = jobQueue.listJobs({ type: 'run' });
  assert.deepEqual(onlyRun.map((j) => j.id), [runJob.id]);

  const onlyDone = jobQueue.listJobs({ status: ['done'] });
  assert.equal(onlyDone.length, 2);
});

test('terminal job history is capped, oldest evicted first, but active jobs are never evicted', async () => {
  const file = freshQueue({ historyCap: 3 });
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await waitForSettled(jobQueue.enqueue('test', async () => `r${i}`).id);
  }
  const remaining = jobQueue.listJobs();
  assert.equal(remaining.length, 3);
  // newest-first: the 3 most recently finished jobs survive
  assert.deepEqual(remaining.map((j) => j.result), ['r4', 'r3', 'r2']);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.length, 3);
});

test('listExecutionOrder(type) returns that lane\'s active job first, then its queued jobs in real FIFO order - not listJobs()\'s newest-first display order', async () => {
  freshQueue();
  let releaseA;
  const gateA = new Promise((res) => { releaseA = res; });
  const jobA = jobQueue.enqueue('test', async () => { await gateA; return 'a'; });
  const jobB = jobQueue.enqueue('test', async () => 'b');
  const jobC = jobQueue.enqueue('test', async () => 'c');

  await new Promise((r) => setTimeout(r, 20));
  const order = jobQueue.listExecutionOrder('test');
  assert.deepEqual(order.map((j) => j.id), [jobA.id, jobB.id, jobC.id]);

  releaseA();
  await waitForSettled(jobC.id);
});

test('listExecutionOrder(type) has a null first slot when nothing of that type is currently running', () => {
  freshQueue();
  assert.deepEqual(jobQueue.listExecutionOrder('test'), [null]);
});

test('different job types run in independent lanes - a queued job of type B is not blocked by an active job of type A', async () => {
  freshQueue();
  let releaseA;
  const gateA = new Promise((res) => { releaseA = res; });
  let bStarted = false;
  const jobA = jobQueue.enqueue('run', async () => { await gateA; return 'a'; });
  const jobB = jobQueue.enqueue('preview', async () => { bStarted = true; return 'b'; });

  await waitForSettled(jobB.id);
  assert.equal(bStarted, true, 'a different-typed job must not wait behind an unrelated active job');
  assert.equal(jobQueue.getJob(jobA.id).status, 'running', 'the original job is untouched by the other lane');

  releaseA();
  await waitForSettled(jobA.id);
});

test('listLaneTypes reports every job type that has been enqueued this process', () => {
  freshQueue();
  jobQueue.enqueue('run', async () => 'r');
  jobQueue.enqueue('preview', async () => 'p');
  assert.deepEqual(new Set(jobQueue.listLaneTypes()), new Set(['run', 'preview']));
});

// Helper: enqueues one job that blocks the lane (so everything after it stays queued, not
// immediately run) plus N queued follower jobs, for testing listQueuedIds/reorderQueue.
function enqueueBlockedLane(type, followerCount) {
  let release;
  const gate = new Promise((res) => { release = res; });
  const blocker = jobQueue.enqueue(type, async () => { await gate; return 'blocker'; });
  const followers = Array.from(
    { length: followerCount },
    (_, i) => jobQueue.enqueue(type, async () => `follower${i}`),
  );
  return { blocker, followers, release };
}

test('listQueuedIds reports a lane\'s not-yet-started jobs in FIFO order', async () => {
  freshQueue();
  const { blocker, followers, release } = enqueueBlockedLane('run', 3);
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(jobQueue.listQueuedIds('run'), followers.map((j) => j.id));

  release();
  await waitForSettled(blocker.id);
  await Promise.all(followers.map((j) => waitForSettled(j.id)));
});

test('reorderQueue rearranges a lane\'s pending jobs to match the given order, and that order is what actually runs next', async () => {
  freshQueue();
  let releaseBlocker;
  const gate = new Promise((res) => { releaseBlocker = res; });
  const executionOrder = [];
  const blocker = jobQueue.enqueue('run', async () => { await gate; return 'blocker'; });
  // Each follower blocks on its own gate too, so run order is observable instead of racing -
  // trivial no-delay jobs would otherwise all settle within the same tick, making "did c really
  // run before a" unobservable via status alone.
  const gates = [0, 1, 2].map(() => { let release; const p = new Promise((res) => { release = res; }); return { p, release }; });
  const followers = [0, 1, 2].map((i) => jobQueue.enqueue('run', async () => {
    executionOrder.push(i);
    await gates[i].p;
    return `follower${i}`;
  }));
  const [a, b, c] = followers;
  await new Promise((r) => setTimeout(r, 20));

  jobQueue.reorderQueue('run', [c.id, a.id, b.id]);
  assert.deepEqual(jobQueue.listQueuedIds('run'), [c.id, a.id, b.id]);

  releaseBlocker();
  await waitForSettled(blocker.id);
  gates.forEach((g) => g.release());
  await Promise.all(followers.map((j) => waitForSettled(j.id)));

  assert.deepEqual(executionOrder, [2, 0, 1], 'c (index 2) must run first, matching the new order');
});

test('reorderQueue ignores ids that are no longer queued, without throwing', async () => {
  freshQueue();
  const { blocker, followers, release } = enqueueBlockedLane('run', 2);
  await new Promise((r) => setTimeout(r, 20));

  assert.doesNotThrow(() => jobQueue.reorderQueue('run', ['not-a-real-id', followers[1].id, followers[0].id]));
  assert.deepEqual(jobQueue.listQueuedIds('run'), [followers[1].id, followers[0].id]);

  release();
  await waitForSettled(blocker.id);
  await Promise.all(followers.map((j) => waitForSettled(j.id)));
});

test('reorderQueue appends any currently-queued job missing from the given order, rather than dropping it', async () => {
  freshQueue();
  const { blocker, followers, release } = enqueueBlockedLane('run', 3);
  await new Promise((r) => setTimeout(r, 20));
  const [a, b, c] = followers;

  jobQueue.reorderQueue('run', [b.id]); // a and c are not mentioned
  assert.deepEqual(jobQueue.listQueuedIds('run'), [b.id, a.id, c.id]);

  release();
  await waitForSettled(blocker.id);
  await Promise.all(followers.map((j) => waitForSettled(j.id)));
});

test('pauseJob pauses a queued job, which runNext then skips over', async () => {
  freshQueue();
  const { blocker, followers, release } = enqueueBlockedLane('run', 2);
  await new Promise((r) => setTimeout(r, 20));
  const [a, b] = followers;

  const result = jobQueue.pauseJob(a.id);
  assert.equal(result.ok, true);
  assert.equal(jobQueue.getJob(a.id).status, 'paused');
  // Still counted by listQueuedIds (it's still "in the queue", just not runnable) - this is what
  // keeps its position stable for reordering and re-queuing.
  assert.deepEqual(jobQueue.listQueuedIds('run'), [a.id, b.id]);

  release();
  await waitForSettled(blocker.id);
  await waitForSettled(b.id);
  // b (queued) ran to completion even though a (paused, ahead of it) never did.
  assert.equal(jobQueue.getJob(b.id).status, 'done');
  assert.equal(jobQueue.getJob(a.id).status, 'paused', 'a is still paused, never ran');

  jobQueue.cancelJob(a.id); // clean up
});

test('pauseJob refuses to pause a job that is not queued', async () => {
  freshQueue();
  const job = jobQueue.enqueue('run', async () => 'done');
  await waitForSettled(job.id);
  const result = jobQueue.pauseJob(job.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot pause/);
});

test('requeueJob flips a paused job back to queued in place, and it runs next once the lane is free', async () => {
  freshQueue();
  const { blocker, followers, release } = enqueueBlockedLane('run', 2);
  await new Promise((r) => setTimeout(r, 20));
  const [a, b] = followers;

  jobQueue.pauseJob(a.id);
  const result = jobQueue.requeueJob(a.id);
  assert.equal(result.ok, true);
  assert.equal(jobQueue.getJob(a.id).status, 'queued');
  assert.deepEqual(jobQueue.listQueuedIds('run'), [a.id, b.id], 're-queuing must not move it from its slot');

  release();
  await waitForSettled(blocker.id);
  await waitForSettled(a.id);
  await waitForSettled(b.id);
  assert.equal(jobQueue.getJob(a.id).status, 'done');
});

test('requeueJob on a lane that is currently idle (all other work finished) actually starts it', async () => {
  freshQueue();
  let release;
  const gate = new Promise((res) => { release = res; });
  const blocker = jobQueue.enqueue('run', async () => { await gate; return 'blocker'; });
  const toPause = jobQueue.enqueue('run', async () => 'resumed');
  await new Promise((r) => setTimeout(r, 20));
  jobQueue.pauseJob(toPause.id);

  release();
  await waitForSettled(blocker.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jobQueue.getJob(toPause.id).status, 'paused', 'lane is idle but toPause stays paused until explicitly re-queued');

  jobQueue.requeueJob(toPause.id);
  await waitForSettled(toPause.id);
  assert.equal(jobQueue.getJob(toPause.id).status, 'done');
});

test('requeueJob refuses to re-queue a job that is not paused', async () => {
  freshQueue();
  const job = jobQueue.enqueue('run', async () => 'done');
  await waitForSettled(job.id);
  const result = jobQueue.requeueJob(job.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot re-queue/);
});

test('cancelJob on a paused job removes it from the queue entirely, same as cancelling a queued one', async () => {
  freshQueue();
  const { blocker, followers, release } = enqueueBlockedLane('run', 1);
  await new Promise((r) => setTimeout(r, 20));
  const [a] = followers;

  jobQueue.pauseJob(a.id);
  const result = jobQueue.cancelJob(a.id);
  assert.equal(result.ok, true);
  assert.equal(jobQueue.getJob(a.id).status, 'cancelled');
  assert.deepEqual(jobQueue.listQueuedIds('run'), []);

  release();
  await waitForSettled(blocker.id);
});

test('reorderQueue can reposition a mix of paused and queued jobs together', async () => {
  freshQueue();
  const { blocker, followers, release } = enqueueBlockedLane('run', 3);
  await new Promise((r) => setTimeout(r, 20));
  const [a, b, c] = followers;
  jobQueue.pauseJob(b.id);

  jobQueue.reorderQueue('run', [c.id, b.id, a.id]);
  assert.deepEqual(jobQueue.listQueuedIds('run'), [c.id, b.id, a.id]);
  assert.equal(jobQueue.getJob(b.id).status, 'paused', 'reordering does not change pause state');

  release();
  await waitForSettled(blocker.id);
  await waitForSettled(c.id);
  await waitForSettled(a.id); // a runs after c, skipping paused b entirely
  assert.equal(jobQueue.getJob(b.id).status, 'paused', 'b is still paused and never ran');

  jobQueue.cancelJob(b.id); // clean up
});
