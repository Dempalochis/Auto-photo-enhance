const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These tests boot the *real* app (require('../server') runs the real config/startup code
// against this machine's actual config/config.json and .webapp_cache) on an ephemeral port
// (`app.listen(0)`) and make real HTTP requests with the built-in fetch - no supertest
// dependency needed. That does mean they're coupled to this dev machine's local setup, same as
// every other manually-verified behavior already documented in the README; there's no CI for
// this project and no aim to make it portable, so that tradeoff matches how the rest of the
// app has always been tested.
const { app } = require('../server');
const { loadConfig } = require('../config');
// Requiring '../server' above already called jobQueue.initJobStore() once (module-level side
// effect) - requiring jobQueue here reaches the exact same singleton, so a job enqueued through
// it is immediately visible to the real app being tested via HTTP, without needing to route it
// through a real /api/run call (which would spawn a real PowerShell/RawTherapee process).
const jobQueue = require('../jobQueue');

function waitForStatus(jobId, status, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (jobQueue.getJob(jobId).status === status) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for job ${jobId} to reach "${status}"`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

// Some tests need to enqueue a real job to exercise the retry endpoint's status checks. Doing
// that against the module's real, already-initialized store would write test job records
// straight into *this dev machine's actual job history* (the same file the real running app
// reads/writes) - not a sandbox, real user-visible data. This swaps the jobQueue singleton onto
// a throwaway temp-file store for the duration of `fn`, then swaps it back to the real store
// (re-reading it fresh from disk, unmodified) - the app under test never touches the real store
// while this is active, and every other test in this file is unaffected either side of it.
async function withTempJobStore(fn) {
  const realStoreFile = loadConfig().jobsStoreFile;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-server-integration-test-'));
  jobQueue._resetForTests();
  jobQueue.initJobStore(path.join(tmpDir, 'jobs.json'));
  try {
    await fn();
  } finally {
    jobQueue._resetForTests();
    jobQueue.initJobStore(realStoreFile);
  }
}

function withServer(fn) {
  return async () => {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      await fn(`http://localhost:${port}`);
    } finally {
      server.close();
    }
  };
}

test('a malformed JSON request body returns a clean JSON 400, not Express\'s default HTML error page', withServer(async (base) => {
  const res = await fetch(`${base}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not valid json',
  });
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
}));

test('GET /api/projects responds with a projects array (project browser wired up end to end)', withServer(async (base) => {
  const res = await fetch(`${base}/api/projects`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.projects));
}));

test('GET /api/health reports the startup config check result', withServer(async (base) => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.ok, 'boolean');
  assert.ok(Array.isArray(body.errors));
  assert.ok(Array.isArray(body.warnings));
}));

test('GET /api/jobs responds with a jobs array (job manager wired up end to end)', withServer(async (base) => {
  const res = await fetch(`${base}/api/jobs`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.jobs));
}));

test('DELETE /api/jobs/:id on an unknown id returns a clean 404 JSON error', withServer(async (base) => {
  const res = await fetch(`${base}/api/jobs/not-a-real-id`, { method: 'DELETE' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /not found/);
}));

test('POST /api/source-folder returns the full photo list, not just a count - so the frontend never has to make a redundant follow-up GET /api/photos that would redo the exiftool scan a second time', withServer(async (base) => {
  const current = await (await fetch(`${base}/api/source-folder`)).json();

  const res = await fetch(`${base}/api/source-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: current.path }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.photos), 'response must include the photo array, not just photoCount');
  assert.equal(body.photos.length, body.photoCount);

  const viaGet = await (await fetch(`${base}/api/photos`)).json();
  assert.deepEqual(body.photos.map((p) => p.relPath).sort(), viaGet.photos.map((p) => p.relPath).sort());
}));

test('POST /api/jobs/reorder validates its body and returns a clean 400 on malformed input', withServer(async (base) => {
  const missingType = await fetch(`${base}/api/jobs/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds: ['a', 'b'] }),
  });
  assert.equal(missingType.status, 400);

  const badIds = await fetch(`${base}/api/jobs/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'run', orderedIds: 'not-an-array' }),
  });
  assert.equal(badIds.status, 400);
}));

test('POST /api/jobs/reorder on an empty/unknown lane succeeds as a harmless no-op', withServer(async (base) => {
  const res = await fetch(`${base}/api/jobs/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'run', orderedIds: [] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.orderedIds, []);
}));

test('POST /api/jobs/:id/pause and /requeue return a clean 404 for an unknown job', withServer(async (base) => {
  const pauseRes = await fetch(`${base}/api/jobs/not-a-real-id/pause`, { method: 'POST' });
  assert.equal(pauseRes.status, 404);

  const requeueRes = await fetch(`${base}/api/jobs/not-a-real-id/requeue`, { method: 'POST' });
  assert.equal(requeueRes.status, 404);
}));

test('POST /api/jobs/:id/retry returns a clean 404 for an unknown job', withServer(async (base) => {
  const res = await fetch(`${base}/api/jobs/not-a-real-id/retry`, { method: 'POST' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /not found/);
}));

// These use a trivial fn (no real spawn) rather than routing through a real /api/run call - a
// *successful* retry enqueues real work (see makeRunJobFn in server.js), which this suite
// deliberately never triggers for the same reason it never calls /api/run directly: no real
// RawTherapee/photo fixture is available to a portable automated test. The negative-path checks
// below only need a job to already exist in a given state, which a trivial fn provides for free.
// Each wraps itself in withTempJobStore (see above) so enqueueing that test job never touches
// this machine's real job history.
test('POST /api/jobs/:id/retry rejects a job that already succeeded', withServer(async (base) => withTempJobStore(async () => {
  const job = jobQueue.enqueue('run', async () => 'ok', { projectName: 'retry-test' });
  await waitForStatus(job.id, 'done');

  const res = await fetch(`${base}/api/jobs/${job.id}/retry`, { method: 'POST' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /cannot retry a job with status "done"/);
})));

test('POST /api/jobs/:id/retry rejects a non-run job type', withServer(async (base) => withTempJobStore(async () => {
  const job = jobQueue.enqueue('preview', async () => 'ok', { photo: 'x.ARW' });
  await waitForStatus(job.id, 'done');

  const res = await fetch(`${base}/api/jobs/${job.id}/retry`, { method: 'POST' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /type "preview"/);
})));

test('POST /api/jobs/:id/retry rejects an errored run job whose meta predates the retry feature (no files list)', withServer(async (base) => withTempJobStore(async () => {
  const job = jobQueue.enqueue('run', async () => { throw new Error('boom'); }, { projectName: 'retry-test-no-files' });
  await waitForStatus(job.id, 'error');

  const res = await fetch(`${base}/api/jobs/${job.id}/retry`, { method: 'POST' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /no retryable file list/);
})));
