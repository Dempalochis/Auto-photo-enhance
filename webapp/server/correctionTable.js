// Step -> RawTherapee mapping for AI-guided correction (LLM plan §3, Version 2 plan Phase 4).
//
// STATUS: **UNCALIBRATED** starting values from llm_integration_plan.md §3. They are meant to be
// tuned by eye (Phase 0b, on Windows) with scripts/dev/step_calibration.js. Change values here
// only: the LLM never sees this table, and the overlay is regenerated from the cached plan at
// render time, so a change applies without asking the LLM again.
//
// Every key below must be one that NO preset sets (enforced by tests/presetKeyOwnership.test.js),
// otherwise the preset stacked after the AI overlay would silently erase it.
//
// Not here on purpose (Version 2 plan, review note 3): noise reduction and sharpening. They can't
// be judged on a downscaled image; code sets them from ISO via the lowlight.pp3 branch.
//
// Row fields:
//   section/key   the pp3 key written (absolute value = base value + step * perStep * strength)
//   base          fallback when the photo's base profile doesn't set the key
//   perStep       change per +1 step
//   min/max       clamp of the final absolute value
//   atTwo         optional extra keys written only when |step| reaches 2 in that direction
//   dropped       true = the step is accepted from the LLM but has no effect (see note)

const TABLE_STATUS = 'uncalibrated';

const CORRECTION_TABLE = {
  exposure: { section: 'Exposure', key: 'Compensation', base: 0.25, perStep: 0.3, min: -3, max: 3 },
  highlights: {
    section: 'Exposure', key: 'HighlightCompr', base: 12, perStep: 15, min: 0, max: 200,
    atTwo: { positive: { section: 'Shadows & Highlights', key: 'Highlights', value: 20 } },
  },
  shadows: {
    section: 'Exposure', key: 'ShadowCompr', base: 35, perStep: 12, min: 0, max: 100,
    atTwo: { positive: { section: 'Shadows & Highlights', key: 'Shadows', value: 20 } },
  },
  contrast: { section: 'Exposure', key: 'Contrast', base: 0, perStep: 10, min: -100, max: 100 },
  clarity: { section: 'Local Contrast', key: 'Amount', base: 0.08, perStep: 0.06, min: 0, max: 1, enable: true },
  dehaze: { section: 'Dehaze', key: 'Strength', base: 6, perStep: 10, min: -100, max: 100, enable: true },
  saturation: { section: 'Exposure', key: 'Saturation', base: 0, perStep: 8, min: -100, max: 100 },
  // Warmth: [White Balance] Equal (RawTherapee's blue/red equaliser, 1 = neutral, > 1 = warmer).
  // Measured in Phase 0a (RT 5.10, Linux, a7M3 draft): Equal 1.1 -> mean R +18 / B -6, 0.9 the
  // reverse; auto-ITC stays in charge. The plan's TemperatureBias had NO effect under
  // Setting=autitcgreen (it only applies to the "autold" method), so it was replaced.
  warmth: { section: 'White Balance', key: 'Equal', base: 1, perStep: 0.05, min: 0.8, max: 1.5 },
  // Tint: [White Balance] Green does take effect under auto-ITC (Phase 0a), but a HIGHER Green
  // multiplier makes the image GREENER, so perStep is negative: + step = more magenta.
  tint: { section: 'White Balance', key: 'Green', base: 1.053, perStep: -0.04, min: 0.8, max: 1.3 },
};

const STEP_KEYS = Object.keys(CORRECTION_TABLE);

// Short labels for log/CSV output ("exp+1 sh+1 cla+2").
const SHORT_LABELS = {
  exposure: 'exp', highlights: 'hl', shadows: 'sh', contrast: 'con', clarity: 'cla', dehaze: 'dhz', saturation: 'sat', warmth: 'wrm', tint: 'tnt',
};

module.exports = {
  CORRECTION_TABLE, STEP_KEYS, SHORT_LABELS, TABLE_STATUS,
};
