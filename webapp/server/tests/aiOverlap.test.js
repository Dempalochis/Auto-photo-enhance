// Version 2 Phase 4 task 6: analysis/render overlap with the mock provider and fake timings.
// A fake "renderer" walks the photos in order like auto_enhance.ps1 -WaitForCorrections does:
// runWaiting(photo) -> wait for the entry -> render for `renderMs`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlanBoard } = require('../planBoard');
const { createAnalyzer, entryFromPlan } = require('../analyzer');
const { createCorrectionsCache } = require('../correctionsCache');
const { createMockProvider } = require('../llm/mockProvider');

const PROFILES = path.resolve(__dirname, '..', '..', '..', 'profiles');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(n, providerHooks, { planWaitMs = 300, concurrency = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-overlap-'));
  const photos = Array.from({ length: n }, (_, i) => {
    const abs = path.join(root, `p${i}.ARW`);
    fs.writeFileSync(abs, `raw ${i}`);
    fs.writeFileSync(path.join(root, `p${i}.jpg`), 'jpeg');
    return {
      abs, relPath: `p${i}.ARW`, size: 5, mtime: 1000 + i, exif: { iso: 100 },
    };
  });
  const cache = createCorrectionsCache(path.join(root, 'corr'));
  const provider = createMockProvider({}, providerHooks);
  const analyzer = createAnalyzer({
    provider,
    llmCfg: { concurrency },
    cache,
    profileCtx: { profilesDir: PROFILES, rawConfig: {}, exiftoolAvailable: false },
    renderDrafts: async () => {},
    extractEmbedded: async (p) => p.abs.replace(/\.ARW$/, '.jpg'),
  });
  const entries = {};
  const settledAt = {};
  const t0 = Date.now();
  const board = createPlanBoard({ planWaitMs, onEntry: (k, e) => { entries[k] = e; settledAt[k] = Date.now() - t0; } });
  photos.forEach((p) => board.add(p.abs));
  const startAnalysis = () => analyzer.analyze(photos, {
    inputKind: 'embedded',
    onResult: (photo, r) => (r.error ? board.fail(photo.abs, r.error) : board.resolve(photo.abs, entryFromPlan({ plan: r.plan, describe: r.describe, cache, strength: 1 }))),
  });
  const render = async (renderMs) => {
    const waited = [];
    for (const p of photos) {
      const w0 = Date.now();
      board.runWaiting(p.abs);
      await board.wait(p.abs);
      waited.push(Date.now() - w0);
      await sleep(renderMs);
    }
    return waited;
  };
  return {
    photos, board, entries, settledAt, startAnalysis, render, provider, cache, analyzer,
  };
}

test('a slow provider on photo 3 does not time out photos 4-20', async () => {
  const s = setup(20, { delayMs: (i) => (i === 2 ? 600 : 5) }, { planWaitMs: 300 });
  const analysis = s.startAnalysis();
  await s.render(15);
  await analysis;
  const notes = s.photos.map((p) => s.entries[p.abs].note);
  assert.match(notes[2], /no plan after/, 'photo 3 itself times out (600 ms > 300 ms wait)');
  notes.forEach((n, i) => { if (i !== 2) assert.equal(n, '', `photo ${i + 1} must get its plan`); });
  assert.ok(s.photos.slice(3).every((p) => s.entries[p.abs].overlay), 'photos 4-20 got real overlays');
});

test('a provider faster than rendering never makes the run wait', async () => {
  const s = setup(8, { delayMs: 10 }, { planWaitMs: 2000 });
  const analysis = s.startAnalysis();
  await sleep(40); // the run starts a moment after the analysis
  const waited = await s.render(60);
  await analysis;
  assert.ok(waited.slice(1).every((w) => w < 15), `waits after the first photo should be ~0, got ${waited}`);
  assert.ok(s.photos.every((p) => s.entries[p.abs].note === ''));
});

test('a dead provider gives all-zero entries immediately, without waiting for the timeout', async () => {
  const s = setup(5, { fail: () => new Error('connect ECONNREFUSED 127.0.0.1:11434') }, { planWaitMs: 5000 });
  const t0 = Date.now();
  const analysis = s.startAnalysis();
  await s.render(1);
  await analysis;
  assert.ok(Date.now() - t0 < 1000, 'no 5 s timeout was hit');
  for (const p of s.photos) {
    assert.equal(s.entries[p.abs].overlay, null);
    assert.match(s.entries[p.abs].note, /AI correction skipped: connect ECONNREFUSED/);
  }
});

test('the wait timer starts when the run reaches a photo, not at queue time', async () => {
  const s = setup(1, {}, { planWaitMs: 100 });
  await sleep(250); // queued longer than planWaitMs, but the run hasn't reached the photo
  assert.equal(s.board.isSettled(s.photos[0].abs), false);
  s.board.runWaiting(s.photos[0].abs);
  await sleep(150);
  assert.match(s.entries[s.photos[0].abs].note, /no plan after/);
});

test('cached plans and user edits are used without calling the LLM; edits win', async () => {
  const s = setup(2, { delayMs: 1 });
  await s.startAnalysis();
  assert.equal(s.provider.calls, 2);
  const s2Counts = await s.analyzer.analyze(s.photos, { inputKind: 'embedded', onResult: () => {} });
  assert.equal(s.provider.calls, 2, 'second pass is served from the cache');
  assert.equal(s2Counts.cache, 2);
  const d = s.analyzer.describePhoto(s.photos[0]);
  s.cache.putEdit(d.pk, { plan: { ...s.analyzer.lookup(s.photos[0]).plan, adjustments: { exposure: -2 } } });
  const got = [];
  await s.analyzer.analyze(s.photos, { inputKind: 'embedded', onResult: (p, r) => got.push([p.relPath, r.source]) });
  assert.deepEqual(got, [['p0.ARW', 'edit'], ['p1.ARW', 'cache']]);
});

test('a reply that is not JSON is retried once, then the photo fails', async () => {
  const s = setup(1, { reply: (i) => (i === 0 ? 'sorry, I cannot' : undefined) });
  const res = [];
  await s.analyzer.analyze(s.photos, { inputKind: 'embedded', onResult: (p, r) => res.push(r) });
  assert.equal(res[0].source, 'llm');
  assert.equal(s.provider.calls, 2);
  const s2 = setup(1, { reply: () => 'never json' });
  const res2 = [];
  await s2.analyzer.analyze(s2.photos, { inputKind: 'embedded', onResult: (p, r) => res2.push(r) });
  assert.match(res2[0].error, /invalid reply/);
});

test('board.close settles every open slot', () => {
  const entries = {};
  const b = createPlanBoard({ planWaitMs: 1000, onEntry: (k, e) => { entries[k] = e; } });
  b.add('a'); b.add('b');
  b.resolve('a', { overlay: 'x', note: '' });
  b.close();
  assert.equal(entries.a.overlay, 'x');
  assert.match(entries.b.note, /run ended/);
  assert.deepEqual(b.pendingKeys(), []);
});
