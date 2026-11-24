// Plan + the photo's actual base profile -> the AI correction overlay (.pp3 text). Pure.
// Stacked after base/format overlay and BEFORE the user's preset (Version 2 plan, Phase 1 builder
// order). Values are absolute (base + step * perStep * strength) because a later -p replaces a
// key rather than adding to it.
const crypto = require('crypto');
const { CORRECTION_TABLE, STEP_KEYS, TABLE_STATUS } = require('./correctionTable');
const { getNumber, stringifyPp3 } = require('./pp3');
const { isAllZero } = require('./correctionPlan');

const STRENGTHS = { subtle: 0.5, normal: 1.0, punchy: 1.5 };

function strengthValue(s) {
  if (typeof s === 'number' && Number.isFinite(s) && s > 0) return Math.min(2, s);
  if (typeof s === 'string' && STRENGTHS[s.toLowerCase()]) return STRENGTHS[s.toLowerCase()];
  return 1.0;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/**
 * plan: validated plan; baseParsed: parsePp3() of the base profile (merged with the format
 * overlay where it overrides a key); opts.strength: number or 'subtle'|'normal'|'punchy'.
 * Returns null for an all-zero plan (= no overlay at all = Version 1 output), else
 * { text, sections }.
 */
function correctionToPp3(plan, baseParsed, opts = {}) {
  if (isAllZero(plan)) return null;
  const strength = strengthValue(opts.strength);
  const sections = {};
  const put = (section, key, value) => {
    if (!sections[section]) sections[section] = {};
    sections[section][key] = value;
  };

  for (const step of STEP_KEYS) {
    const s = plan.adjustments[step] || 0;
    if (!s) continue;
    const row = CORRECTION_TABLE[step];
    if (row.dropped) continue;
    const base = getNumber(baseParsed, row.section, row.key, row.base);
    const v = clamp(base + s * row.perStep * strength, row.min, row.max);
    put(row.section, row.key, row.integer ? Math.round(v) : v);
    if (row.enable) sections[row.section] = { Enabled: true, ...sections[row.section] };
    if (row.atTwo && row.atTwo.positive && s >= 2) {
      const x = row.atTwo.positive;
      put(x.section, 'Enabled', true);
      put(x.section, x.key, Math.round(x.value * strength));
    }
  }
  if (Object.keys(sections).length === 0) return null;
  const header = `AI correction overlay (auto-generated; step table ${TABLE_STATUS}). Stacked before the preset.`;
  return { text: stringifyPp3(sections, header), sections };
}

function contentHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

module.exports = {
  correctionToPp3, strengthValue, contentHash, STRENGTHS,
};
