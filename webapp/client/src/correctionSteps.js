// Version 2 Phase 4/5: the AI correction steps as shown in the review UI (same keys as the
// server's correctionTable.js; every value is an integer step -2..+2, 0 = leave as is).
export const STEPS = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'shadows', label: 'Shadows' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'clarity', label: 'Clarity' },
  { key: 'dehaze', label: 'Dehaze' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'warmth', label: 'Warmth' },
  { key: 'tint', label: 'Tint' },
];

export function clampStep(v) {
  return Math.max(-2, Math.min(2, Math.round(Number(v) || 0)));
}

// Returns a new adjustments object with `key` moved by `delta`, clamped.
export function bumpStep(adjustments, key, delta) {
  return { ...adjustments, [key]: clampStep((adjustments[key] || 0) + delta) };
}

export function formatStep(v) {
  if (!v) return '0';
  return v > 0 ? `+${v}` : String(v);
}

export function nonZeroSteps(adjustments) {
  return STEPS.filter((s) => adjustments && adjustments[s.key]);
}
