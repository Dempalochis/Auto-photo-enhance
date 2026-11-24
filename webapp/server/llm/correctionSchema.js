// The single JSON schema for the per-photo analysis (LLM plan §3 + §7.1 step 2), passed to every
// provider adapter as structured output. correctionPlan.validatePlan() still runs afterwards:
// local models don't always follow a schema strictly.
const { STEP_KEYS } = require('../correctionTable');
const {
  SCENES, LIGHTING, ISSUES, SETTINGS, SUBJECTS,
} = require('../correctionPlan');

const stepSchema = { type: 'integer', minimum: -2, maximum: 2 };

function correctionSchema({ withSceneTags = true } = {}) {
  const properties = {
    scene: { type: 'string', enum: SCENES },
    lighting: { type: 'string', enum: LIGHTING },
    issues: { type: 'array', items: { type: 'string', enum: ISSUES } },
    adjustments: {
      type: 'object',
      properties: Object.fromEntries(STEP_KEYS.map((k) => [k, stepSchema])),
      required: STEP_KEYS,
      additionalProperties: false,
    },
    notes: { type: 'string' },
  };
  const required = ['scene', 'lighting', 'issues', 'adjustments', 'notes'];
  if (withSceneTags) {
    properties.sceneTags = sceneTagsSchema();
    required.push('sceneTags');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function sceneTagsSchema() {
  return {
    type: 'object',
    properties: {
      setting: { type: 'string', enum: SETTINGS },
      subject: { type: 'string', enum: SUBJECTS },
      light: { type: 'string', enum: LIGHTING },
      caption: { type: 'string' },
    },
    required: ['setting', 'subject', 'light', 'caption'],
    additionalProperties: false,
  };
}

// Tags-only mode (Phase 5): grouping a whole folder cheaply from the embedded JPEG.
function tagsOnlySchema() {
  return { type: 'object', properties: { sceneTags: sceneTagsSchema() }, required: ['sceneTags'], additionalProperties: false };
}

module.exports = { correctionSchema, tagsOnlySchema, sceneTagsSchema };
