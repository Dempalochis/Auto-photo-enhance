// Prompts for the per-photo analysis (LLM plan §2.4). PROMPT_VERSION is part of the corrections
// cache key (§8): bump it whenever the wording, the steps or the schema change, so cached plans
// made with an older prompt are not reused.
const { SETTINGS, SUBJECTS } = require('../correctionPlan');

const PROMPT_VERSION = 'v2.1';

const STEP_GUIDE = [
  'exposure: overall brightness. +1 = about a third of a stop brighter.',
  'highlights: + recovers detail in bright areas (sky, lamps), - leaves them bright.',
  'shadows: + lifts detail in dark areas noticeably (not flat), - deepens them.',
  'contrast: global contrast. + punchier, - softer.',
  'clarity: local/micro contrast, the main "stand out" control. + crisper texture.',
  'dehaze: + cuts haze/fog/flatness, - adds atmosphere.',
  'saturation: overall colour intensity. Use small steps only.',
  'warmth: white balance. + warmer (more yellow), - cooler (more blue).',
  'tint: + more magenta, - more green.',
].join('\n');

function systemPrompt() {
  return [
    'You are a photo retoucher doing the technical BASE correction of one photo.',
    'A separate creative look will be applied after you, so aim for a clean, well-exposed, vivid but natural photo, not a style.',
    'You see the photo as it is rendered right now. Each adjustment is an integer step from -2 to +2 RELATIVE to what you see:',
    STEP_GUIDE,
    '0 is a valid and very common answer: leave anything that already looks right at 0. Most photos need only 1-3 non-zero steps.',
    'Use +-2 only for an obvious problem. Never change everything.',
    'Also describe the scene with sceneTags: setting, subject, light, and a caption of at most 8 words.',
    `setting is one of: ${SETTINGS.join(', ')}. subject is one of: ${SUBJECTS.join(', ')}.`,
    'Examples:',
    '- Bright beach at noon, slightly hazy, colours fine -> dehaze +1, everything else 0.',
    '- Dim restaurant, orange cast, dark faces -> exposure +1, shadows +1, warmth -1.',
    '- Well exposed overcast forest, a bit flat -> clarity +1, contrast +1.',
    'Reply with JSON only, matching the schema. notes: 1-2 short sentences on what you changed and why.',
  ].join('\n');
}

function fmtExposure(t) {
  if (!(t > 0)) return null;
  return t >= 1 ? `${Math.round(t * 10) / 10} s` : `1/${Math.round(1 / t)} s`;
}

// EXIF context helps small models a lot (LLM §2.2). Stats (Phase 6, §2.3) are optional.
function userText({ exif, stats } = {}) {
  const parts = [];
  if (exif) {
    const bits = [
      exif.iso ? `ISO ${exif.iso}` : null,
      fmtExposure(exif.exposureTime),
      exif.fNumber ? `f/${exif.fNumber}` : null,
      typeof exif.flash === 'boolean' ? (exif.flash ? 'flash fired' : 'no flash') : null,
      exif.dateTaken ? `taken ${exif.dateTaken.replace('T', ' ')}` : null,
      exif.model ? `camera ${exif.model}` : null,
    ].filter(Boolean);
    if (bits.length) parts.push(`Camera data: ${bits.join(', ')}.`);
  }
  if (stats) {
    parts.push(`Measured on this render: mean brightness ${stats.meanLuma}/255, ${stats.clippedHighlightsPct}% clipped highlights, `
      + `${stats.clippedShadowsPct}% crushed shadows, mean saturation ${stats.meanSaturation}/255, `
      + `brightest 5% average RGB ${stats.brightRgb.join('/')}.`);
  }
  parts.push('Analyse the photo and return the correction plan.');
  return parts.join('\n');
}

// Refine pass (Phase 6, LLM §4): before = image 1, after = image 2.
function refineUserText({ exif, previous }) {
  return [
    userText({ exif }).replace('Analyse the photo and return the correction plan.', ''),
    'Image 1 is BEFORE, image 2 is AFTER your first correction:',
    JSON.stringify(previous.adjustments),
    'Look at image 2. Return the SAME schema with small FURTHER corrections relative to image 2, each only -1, 0 or +1.',
    'If image 2 already looks right, return all zeros.',
  ].filter(Boolean).join('\n');
}

function tagsOnlySystemPrompt() {
  return [
    'You label photos for grouping into scenes. Reply with JSON only.',
    `setting is one of: ${SETTINGS.join(', ')}.`,
    `subject is one of: ${SUBJECTS.join(', ')}.`,
    'light is one of: golden_hour, blue_hour, daylight_harsh, overcast, indoor_tungsten, indoor_mixed, night, flash, other.',
    'caption: at most 8 words, concrete (e.g. "couple on pier at sunset").',
  ].join('\n');
}

module.exports = {
  PROMPT_VERSION, systemPrompt, userText, refineUserText, tagsOnlySystemPrompt,
};
