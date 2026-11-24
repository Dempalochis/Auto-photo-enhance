// Version 2 Phase 6 (LLM plan §7.5): consistent corrections within a scene.
// A scene has one light source, so it should have one white balance:
//   warmth, tint, dehaze            -> the scene's median value
//   clarity, saturation, contrast   -> pulled halfway toward the scene median
//   exposure, highlights, shadows   -> left per photo (bracketing and framing really differ)
// Pure code on top of the plans: no extra LLM calls. User-edited plans are never changed and
// don't count toward the median (your edits always win).
const { STEP_KEYS } = require('./correctionTable');
const { clampStep } = require('./correctionPlan');

const SCENE_LEVEL = ['warmth', 'tint', 'dehaze'];
const HALFWAY = ['clarity', 'saturation', 'contrast'];

function medianInt(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/**
 * items: [{ key, plan, edited }] of ONE scene. Returns Map key -> harmonized plan (edited plans
 * and scenes with fewer than 2 AI plans come back unchanged).
 */
function harmonizeScene(items) {
  const out = new Map(items.map((it) => [it.key, it.plan]));
  const ai = items.filter((it) => it.plan && !it.edited);
  if (ai.length < 2) return out;
  const med = {};
  for (const k of [...SCENE_LEVEL, ...HALFWAY]) med[k] = medianInt(ai.map((it) => it.plan.adjustments[k] || 0));
  for (const it of ai) {
    const adj = { ...it.plan.adjustments };
    for (const k of SCENE_LEVEL) adj[k] = med[k];
    for (const k of HALFWAY) adj[k] = clampStep(((adj[k] || 0) + med[k]) / 2);
    for (const k of STEP_KEYS) if (adj[k] === undefined) adj[k] = 0;
    out.set(it.key, { ...it.plan, adjustments: adj, harmonized: true });
  }
  return out;
}

module.exports = {
  harmonizeScene, medianInt, SCENE_LEVEL, HALFWAY,
};
