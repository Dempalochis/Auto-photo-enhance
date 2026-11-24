// Validation of an LLM correction plan (LLM plan §3 "Validation", Version 2 Phase 4).
// A schema failure NEVER fails a job: anything unusable becomes the all-zero plan, which
// renders exactly like Version 1 (no overlay at all).
const { STEP_KEYS, SHORT_LABELS } = require('./correctionTable');

const SCENES = ['landscape', 'portrait', 'street', 'architecture', 'night', 'astro', 'food', 'macro', 'event', 'other'];
const LIGHTING = ['golden_hour', 'blue_hour', 'daylight_harsh', 'overcast', 'indoor_tungsten', 'indoor_mixed', 'night', 'flash', 'other'];
const ISSUES = ['underexposed', 'overexposed', 'blown_highlights', 'crushed_shadows', 'colour_cast_warm', 'colour_cast_cool',
  'colour_cast_green', 'colour_cast_magenta', 'hazy', 'flat', 'oversaturated', 'noisy', 'soft'];
// Phase 5 scene tags (LLM §7.1 step 2): small fixed vocabularies, so a small model can't invent.
const SETTINGS = ['beach', 'sea', 'mountain', 'forest', 'park', 'field', 'desert', 'snow', 'lake_river', 'street', 'city',
  'market', 'building_exterior', 'indoor_home', 'indoor_restaurant', 'indoor_venue', 'indoor_other', 'vehicle', 'sky', 'other'];
const SUBJECTS = ['people', 'group', 'portrait', 'landscape', 'cityscape', 'architecture', 'food', 'animal', 'plant', 'object', 'vehicle', 'night_sky', 'other'];

const MIN_STEP = -2;
const MAX_STEP = 2;

function zeroAdjustments() {
  return Object.fromEntries(STEP_KEYS.map((k) => [k, 0]));
}

function allZeroPlan(note) {
  return {
    scene: 'other', lighting: 'other', issues: [], adjustments: zeroAdjustments(), notes: note || '', sceneTags: null,
  };
}

function oneOf(v, allowed, fallback = 'other') {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  return allowed.includes(s) ? s : fallback;
}

function clampStep(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(MIN_STEP, Math.min(MAX_STEP, Math.round(n))) || 0; // no -0
}

function validateSceneTags(t) {
  if (!t || typeof t !== 'object') return null;
  const caption = typeof t.caption === 'string' ? t.caption.trim().split(/\s+/).slice(0, 8).join(' ') : '';
  return {
    setting: oneOf(t.setting, SETTINGS),
    subject: oneOf(t.subject, SUBJECTS),
    light: oneOf(t.light, LIGHTING),
    caption,
  };
}

// Pulls the first JSON object out of a model reply: tolerates ```json fences, leading prose and
// trailing text, which small local models produce even with structured output switched on.
function extractJson(text) {
  if (text && typeof text === 'object') return text;
  if (typeof text !== 'string') throw new Error('empty reply');
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in reply');
  return JSON.parse(stripped.slice(start, end + 1));
}

// Returns { plan, warnings }. Never throws for a bad *shape*; throws only if `raw` is not JSON
// at all (the caller then retries once, then falls back to allZeroPlan).
function validatePlan(raw) {
  const obj = extractJson(raw);
  const warnings = [];
  const adjIn = obj && typeof obj.adjustments === 'object' && obj.adjustments ? obj.adjustments : {};
  const adjustments = zeroAdjustments();
  for (const k of Object.keys(adjIn)) {
    if (!STEP_KEYS.includes(k)) { warnings.push(`dropped unknown adjustment "${k}"`); continue; }
    const before = adjIn[k];
    adjustments[k] = clampStep(before);
    if (typeof before !== 'number' || before !== adjustments[k]) warnings.push(`${k}: ${JSON.stringify(before)} -> ${adjustments[k]}`);
  }
  const issues = Array.isArray(obj.issues)
    ? [...new Set(obj.issues.map((i) => oneOf(i, ISSUES, null)).filter(Boolean))]
    : [];
  return {
    plan: {
      scene: oneOf(obj.scene, SCENES),
      lighting: oneOf(obj.lighting, LIGHTING),
      issues,
      adjustments,
      notes: typeof obj.notes === 'string' ? obj.notes.slice(0, 400) : '',
      sceneTags: validateSceneTags(obj.sceneTags),
    },
    warnings,
  };
}

function isAllZero(plan) {
  return !plan || !plan.adjustments || STEP_KEYS.every((k) => !plan.adjustments[k]);
}

// "exp+1 sh+1 cla+2" - compact, for the CSV log's AiCorrection column and the UI.
function summarizePlan(plan) {
  if (isAllZero(plan)) return 'none';
  return STEP_KEYS.filter((k) => plan.adjustments[k])
    .map((k) => `${SHORT_LABELS[k]}${plan.adjustments[k] > 0 ? '+' : ''}${plan.adjustments[k]}`)
    .join(' ');
}

// Applies a user's edits on top of an LLM plan: the user's values always win.
function mergeUserEdits(plan, edits) {
  const base = plan || allZeroPlan();
  if (!edits || typeof edits !== 'object') return base;
  const adjustments = { ...base.adjustments };
  for (const k of STEP_KEYS) if (edits.adjustments && edits.adjustments[k] !== undefined) adjustments[k] = clampStep(edits.adjustments[k]);
  return { ...base, adjustments };
}

module.exports = {
  SCENES, LIGHTING, ISSUES, SETTINGS, SUBJECTS, MIN_STEP, MAX_STEP,
  allZeroPlan, zeroAdjustments, validatePlan, extractJson, clampStep, isAllZero, summarizePlan, mergeUserEdits,
};
