// Version 2 Phase 6: harmonization, burst reuse, image stats, refine pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { harmonizeScene, medianInt } = require('../harmonize');
const { findBursts } = require('../bursts');
const { statsFromRgb } = require('../imageStats');
const { createAnalyzer } = require('../analyzer');
const { createCorrectionsCache } = require('../correctionsCache');
const { createMockProvider } = require('../llm/mockProvider');
const { validatePlan } = require('../correctionPlan');

const planWith = (adj) => validatePlan({ adjustments: adj }).plan;

test('harmonizeScene: warmth/tint/dehaze to the median, clarity/saturation/contrast halfway, exposure etc. untouched', () => {
  const items = [
    { key: 'a', plan: planWith({ warmth: 2, tint: 0, dehaze: 1, clarity: 2, exposure: 1 }) },
    { key: 'b', plan: planWith({ warmth: 0, tint: 1, dehaze: 1, clarity: 0, exposure: -1 }) },
    { key: 'c', plan: planWith({ warmth: 1, tint: 1, dehaze: 0, clarity: 0, shadows: 2 }) },
  ];
  const out = harmonizeScene(items);
  for (const k of ['a', 'b', 'c']) {
    assert.equal(out.get(k).adjustments.warmth, 1);
    assert.equal(out.get(k).adjustments.tint, 1);
    assert.equal(out.get(k).adjustments.dehaze, 1);
  }
  assert.equal(out.get('a').adjustments.clarity, 1); // (2 + 0) / 2
  assert.equal(out.get('a').adjustments.exposure, 1);
  assert.equal(out.get('b').adjustments.exposure, -1);
  assert.equal(out.get('c').adjustments.shadows, 2);
  assert.equal(medianInt([1, 2]), 2);
});

test('harmonizeScene leaves edited plans alone and needs two AI plans', () => {
  const edited = { key: 'e', plan: planWith({ warmth: -2 }), edited: true };
  const one = { key: 'a', plan: planWith({ warmth: 2 }) };
  assert.equal(harmonizeScene([edited, one]).get('a').adjustments.warmth, 2);
  const out = harmonizeScene([edited, one, { key: 'b', plan: planWith({ warmth: 0 }) }]);
  assert.equal(out.get('e').adjustments.warmth, -2);
  assert.equal(out.get('a').adjustments.warmth, 1);
});

test('findBursts: same exposure within 2 s chains; the leader is first in input order', () => {
  const ex = (t, extra = {}) => ({ exif: { dateTaken: `2026-01-01T10:00:${String(t).padStart(2, '0')}`, iso: 100, exposureTime: 0.004, fNumber: 4, ...extra } });
  const photos = [ex(3), ex(1), ex(2), ex(9), ex(10, { iso: 200 }), ex(20), ex(23)];
  const f = findBursts(photos);
  assert.deepEqual([...f.entries()].sort(), [[1, 0], [2, 0]]);
  assert.equal(f.has(4), false, 'different ISO is not a burst');
  assert.equal(f.has(6), false, '3 s apart is not a burst');
});

test('statsFromRgb', () => {
  const data = Buffer.from([255, 255, 255, 0, 0, 0, 128, 64, 32, 10, 10, 10]);
  const s = statsFromRgb(data, 3);
  assert.equal(s.clippedHighlightsPct, 25);
  assert.equal(s.clippedShadowsPct, 25);
  assert.deepEqual(s.brightRgb, [255, 255, 255]);
  assert.ok(s.meanLuma > 0 && s.meanSaturation > 0);
});

function analyzerSetup(n, { burstReuse = false, refinePass = false, reply } = {}, exifFor = () => ({ iso: 100 })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-p6-'));
  const photos = Array.from({ length: n }, (_, i) => {
    const abs = path.join(root, `p${i}.ARW`);
    fs.writeFileSync(abs, `raw ${i}`);
    fs.writeFileSync(path.join(root, `p${i}.jpg`), 'jpeg');
    return {
      abs, relPath: `p${i}.ARW`, size: 5, mtime: 1000 + i, exif: exifFor(i),
    };
  });
  const cache = createCorrectionsCache(path.join(root, 'corr'));
  const provider = createMockProvider({}, { reply });
  const rendered = [];
  const analyzer = createAnalyzer({
    provider,
    llmCfg: { concurrency: 1, burstReuse, refinePass, strength: 1 },
    cache,
    profileCtx: { profilesDir: path.resolve(__dirname, '..', '..', '..', 'profiles'), rawConfig: {}, exiftoolAvailable: false },
    renderDrafts: async (jobs, onDone) => { jobs.forEach((j, i) => { fs.mkdirSync(path.dirname(j.out), { recursive: true }); fs.writeFileSync(j.out, 'jpg'); rendered.push(j); onDone(i, j.out); }); },
    extractEmbedded: async (p) => p.abs.replace(/\.ARW$/, '.jpg'),
  });
  return {
    photos, analyzer, provider, rendered,
  };
}

test('burst reuse: one LLM call per burst, followers get the leader plan', async () => {
  const s = analyzerSetup(3, { burstReuse: true }, (i) => ({
    iso: 100, exposureTime: 0.01, fNumber: 4, dateTaken: `2026-01-01T10:00:0${i}`,
  }));
  const got = [];
  const counts = await s.analyzer.analyze(s.photos, { inputKind: 'embedded', onResult: (p, r) => got.push([p.relPath, r.source]) });
  assert.equal(s.provider.calls, 1);
  assert.equal(counts.burst, 2);
  assert.deepEqual(got.map((g) => g[1]).sort(), ['burst', 'burst', 'llm']);
});

test('refine pass: real before/after draft renders, at most +-1 per step, one round', async () => {
  // pass 1: exposure +1; refine reply asks exposure +2 (clamped to +1) and warmth -1
  const s = analyzerSetup(1, {
    refinePass: true,
    reply: (i) => (i === 0
      ? { adjustments: { exposure: 1 }, sceneTags: null }
      : { adjustments: { exposure: 2, warmth: -1 } }),
  });
  const got = [];
  await s.analyzer.analyze(s.photos, { inputKind: 'embedded', onResult: (p, r) => got.push(r) });
  assert.equal(s.provider.calls, 2);
  assert.equal(got[0].plan.adjustments.exposure, 2);
  assert.equal(got[0].plan.adjustments.warmth, -1);
  assert.deepEqual(got[0].plan.refineDelta, { exposure: 1, warmth: -1 });
  assert.equal(s.rendered.length, 2, 'before + after drafts were rendered');
  assert.ok(s.rendered[1].aiOverlay, 'the after render carries the pass-1 overlay');
});

test('refine pass off: a single LLM call (default)', async () => {
  const s = analyzerSetup(1);
  await s.analyzer.analyze(s.photos, { inputKind: 'embedded', onResult: () => {} });
  assert.equal(s.provider.calls, 1);
});
