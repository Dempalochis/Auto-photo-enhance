const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  validatePlan, allZeroPlan, isAllZero, summarizePlan, extractJson, mergeUserEdits,
} = require('../correctionPlan');
const { correctionToPp3, strengthValue, contentHash } = require('../correctionToPp3');
const { parsePp3, readPp3File, stringifyPp3 } = require('../pp3');
const { resolveBaseProfile, effectiveBase } = require('../baseProfile');
const { CORRECTION_TABLE, STEP_KEYS } = require('../correctionTable');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PROFILES = path.join(REPO, 'profiles');
const defaultBase = readPp3File(path.join(PROFILES, 'default.pp3'));

test('pp3 round trip keeps sections and keys', () => {
  const p = parsePp3('[A]\nx=1\n# c\n[B C]\ny=two\n');
  assert.deepEqual(p, { A: { x: '1' }, 'B C': { y: 'two' } });
  assert.deepEqual(parsePp3(stringifyPp3({ A: { x: 1.23456789, e: true } }, 'hdr')), { A: { x: '1.2346', e: 'true' } });
});

test('validatePlan clamps, rounds, drops unknown keys and maps unknown enums to other', () => {
  const { plan, warnings } = validatePlan(JSON.stringify({
    scene: 'Spaceship', lighting: 'golden hour', issues: ['flat', 'bogus', 'flat'],
    adjustments: { exposure: 5, shadows: '1.6', clarity: -0.4, noiseReduction: 2, sharpening: 1 },
    notes: 'x',
  }));
  assert.equal(plan.scene, 'other');
  assert.equal(plan.lighting, 'golden_hour');
  assert.deepEqual(plan.issues, ['flat']);
  assert.equal(plan.adjustments.exposure, 2);
  assert.equal(plan.adjustments.shadows, 2);
  assert.equal(plan.adjustments.clarity, 0);
  assert.equal(plan.adjustments.noiseReduction, undefined, 'noise reduction is not an AI step in Version 2');
  assert.ok(warnings.some((w) => w.includes('noiseReduction')));
  assert.deepEqual(Object.keys(plan.adjustments).sort(), [...STEP_KEYS].sort());
});

test('extractJson tolerates fences and prose; throws on no JSON', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJson('no json here'));
  assert.throws(() => validatePlan('{broken'));
});

test('sceneTags are validated and the caption capped at 8 words', () => {
  const { plan } = validatePlan({
    adjustments: {}, sceneTags: { setting: 'Beach', subject: 'people', light: 'nope', caption: 'one two three four five six seven eight nine' },
  });
  assert.deepEqual(plan.sceneTags, { setting: 'beach', subject: 'people', light: 'other', caption: 'one two three four five six seven eight' });
});

test('all-zero plan -> no overlay at all (Version 1 output)', () => {
  assert.equal(correctionToPp3(allZeroPlan(), defaultBase), null);
  assert.ok(isAllZero(allZeroPlan()));
  assert.equal(summarizePlan(allZeroPlan()), 'none');
});

test('overlay writes absolute base + step values read from the real base profile', () => {
  const { plan } = validatePlan({ adjustments: { exposure: 1, shadows: -1, clarity: 2, warmth: -1 } });
  const out = correctionToPp3(plan, defaultBase);
  const p = parsePp3(out.text);
  assert.equal(+p.Exposure.Compensation, 0.55); // 0.25 + 0.3
  assert.equal(+p.Exposure.ShadowCompr, 23); // 35 - 12
  assert.equal(+p['Local Contrast'].Amount, 0.2); // 0.08 + 2 * 0.06
  assert.equal(p['Local Contrast'].Enabled, 'true');
  assert.equal(+p['White Balance'].Equal, 0.95);
  assert.equal(p['Shadows & Highlights'], undefined, 'S&H only engages at +2 highlights/shadows');
  assert.equal(summarizePlan(plan), 'exp+1 sh-1 cla+2 wrm-1');
});

test('+2 shadows also engages Shadows & Highlights; strength scales every delta', () => {
  const { plan } = validatePlan({ adjustments: { shadows: 2, exposure: 1 } });
  const p = parsePp3(correctionToPp3(plan, defaultBase, { strength: 'subtle' }).text);
  assert.equal(+p.Exposure.ShadowCompr, 47); // 35 + 2 * 12 * 0.5
  assert.equal(+p.Exposure.Compensation, 0.4);
  assert.equal(p['Shadows & Highlights'].Enabled, 'true');
  assert.equal(+p['Shadows & Highlights'].Shadows, 10);
  assert.equal(strengthValue('punchy'), 1.5);
  assert.equal(strengthValue(7), 2);
  assert.equal(strengthValue('weird'), 1);
});

test('values are clamped to the table range', () => {
  const { plan } = validatePlan({ adjustments: { warmth: 2 } });
  const p = parsePp3(correctionToPp3(plan, { 'White Balance': { Equal: '1.45' } }).text);
  assert.equal(+p['White Balance'].Equal, CORRECTION_TABLE.warmth.max);
  const { plan: tintPlan } = validatePlan({ adjustments: { tint: 1 } });
  assert.equal(+parsePp3(correctionToPp3(tintPlan, defaultBase).text)['White Balance'].Green, 1.013, '+tint = magenta = lower Green');
});

test('content hash is stable for identical overlays', () => {
  const { plan } = validatePlan({ adjustments: { exposure: 1 } });
  assert.equal(contentHash(correctionToPp3(plan, defaultBase).text), contentHash(correctionToPp3(plan, defaultBase).text));
});

test('user edits override the LLM plan', () => {
  const { plan } = validatePlan({ adjustments: { exposure: 1, clarity: 1 } });
  const merged = mergeUserEdits(plan, { adjustments: { exposure: 0, dehaze: 5 } });
  assert.equal(merged.adjustments.exposure, 0);
  assert.equal(merged.adjustments.dehaze, 2);
  assert.equal(merged.adjustments.clarity, 1);
});

test('resolveBaseProfile mirrors the PowerShell ISO branching and format overlays', () => {
  const rawConfig = { autoProfile: { enabled: true, isoThreshold: 800, lowIsoProfile: 'default', highIsoProfile: 'lowlight' } };
  const ctx = { profilesDir: PROFILES, rawConfig, exiftoolAvailable: true };
  assert.equal(resolveBaseProfile(ctx, 'a.ARW', 400).profileName, 'default');
  assert.equal(resolveBaseProfile(ctx, 'a.ARW', 800).profileName, 'lowlight');
  assert.equal(resolveBaseProfile({ ...ctx, exiftoolAvailable: false }, 'a.ARW', 3200).profileName, 'default');
  assert.equal(resolveBaseProfile(ctx, 'a.ARW', null).profileName, 'default');
  assert.equal(path.basename(resolveBaseProfile(ctx, 'x.RAF', 100).formatOverlayPath), 'raf.pp3');
  assert.equal(resolveBaseProfile(ctx, 'x.nef', 100).formatOverlayPath, null);
  // effective base: raf.pp3 overrides the white-balance setting
  assert.equal(effectiveBase(resolveBaseProfile(ctx, 'x.RAF', 100))['White Balance'].Setting, 'Camera');
});

test('integer-only RawTherapee keys are always written as whole numbers, at every strength', () => {
  for (const strength of [0.5, 1, 1.5, 'subtle', 'punchy', 1.3]) {
    for (const step of STEP_KEYS) {
      for (const v of [-2, -1, 1, 2]) {
        const { plan } = validatePlan({ adjustments: { [step]: v } });
        const out = correctionToPp3(plan, defaultBase, { strength });
        const row = CORRECTION_TABLE[step];
        const value = parsePp3(out.text)[row.section][row.key];
        if (row.integer) assert.match(value, /^-?\d+$/, `${step} ${v} @ ${strength} -> ${value}`);
        const extra = out.sections['Shadows & Highlights'];
        if (extra) for (const [k, x] of Object.entries(extra)) if (k !== 'Enabled') assert.ok(Number.isInteger(x), `S&H ${k}=${x}`);
      }
    }
  }
});
