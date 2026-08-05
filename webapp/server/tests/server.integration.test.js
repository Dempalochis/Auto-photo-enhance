const test = require('node:test');
const assert = require('node:assert/strict');

// These tests boot the *real* app (require('../server') runs the real config/startup code
// against this machine's actual config/config.json and .webapp_cache) on an ephemeral port
// (`app.listen(0)`) and make real HTTP requests with the built-in fetch - no supertest
// dependency needed. That does mean they're coupled to this dev machine's local setup, same as
// every other manually-verified behavior already documented in the README; there's no CI for
// this project and no aim to make it portable, so that tradeoff matches how the rest of the
// app has always been tested.
const { app } = require('../server');

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
