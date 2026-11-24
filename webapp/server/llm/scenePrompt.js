// Version 2 Phase 5 (LLM plan §7.1 step 3): one TEXT-ONLY call per day. The model gets the
// day's candidate segments (time range, EXIF summary, tags and captions of their photos) and may
// merge NEIGHBOURING segments, split one where the tags clearly change, and name the groups.
// Its reply is validated against the segment list (sceneGrouper.js); anything invalid is dropped.

const SCENE_PROMPT_VERSION = 's1';

function sceneSystemPrompt() {
  return [
    'You group a photographer\'s photos from ONE day into scenes and name them.',
    'You get candidate segments, already split by time gaps and light changes, in time order.',
    'You may:',
    '- merge NEIGHBOURING segments that are clearly the same scene (e.g. same place after a short break);',
    '- split a segment after a photo index where the setting clearly changes (e.g. market -> temple);',
    '- give every group a short, concrete name (2-5 words, e.g. "Harbour at golden hour", "Seafood dinner").',
    'Only neighbouring segments may be merged. Every segment must appear in exactly one group, in order.',
    'When unsure, keep segments separate. Reply with JSON only.',
  ].join('\n');
}

function sceneSchema() {
  return {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: { segments: { type: 'array', items: { type: 'integer' } }, name: { type: 'string' } },
          required: ['segments', 'name'],
        },
      },
      splits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { segment: { type: 'integer' }, afterPhotoIndex: { type: 'integer' }, reason: { type: 'string' } },
          required: ['segment', 'afterPhotoIndex'],
        },
      },
    },
    required: ['groups'],
  };
}

function fmtTime(dt) { return typeof dt === 'string' ? dt.slice(11, 16) : '?'; }

// segments: [{ index, start, end, photos: [{ relPath, tags, caption }], evMedian, camera, flash }]
function sceneUserText(day, segments) {
  const lines = [`Day ${day}. ${segments.length} candidate segments:`];
  for (const s of segments) {
    const tagCounts = {};
    for (const p of s.photos) {
      if (!p.tags) continue;
      for (const v of [p.tags.setting, p.tags.subject, p.tags.light]) if (v && v !== 'other') tagCounts[v] = (tagCounts[v] || 0) + 1;
    }
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t}x${n}`).join(', ');
    const captions = s.photos.map((p, i) => (p.caption ? `${i}: ${p.caption}` : null)).filter(Boolean).slice(0, 12).join(' | ');
    lines.push(`Segment ${s.index}: ${fmtTime(s.start)}-${fmtTime(s.end)}, ${s.photos.length} photos, EV ${s.evMedian ?? '?'}`
      + `${s.flash ? ', flash' : ''}${s.camera ? `, ${s.camera}` : ''}. Tags: ${topTags || 'none'}. Captions: ${captions || 'none'}`);
  }
  lines.push('Return { "groups": [{ "segments": [..], "name": ".." }], "splits": [{ "segment": n, "afterPhotoIndex": i, "reason": ".." }] }.');
  return lines.join('\n');
}

// Phase 6 (LLM §7.1): two-thumbnail boundary check, "same scene? yes/no".
function boundarySystemPrompt() {
  return 'You compare two photos taken a few minutes apart. Answer whether they show the SAME scene (same place and occasion). Reply with JSON only: {"sameScene": true|false}.';
}
function boundarySchema() {
  return { type: 'object', properties: { sameScene: { type: 'boolean' } }, required: ['sameScene'] };
}

module.exports = {
  SCENE_PROMPT_VERSION, sceneSystemPrompt, sceneSchema, sceneUserText, boundarySystemPrompt, boundarySchema,
};
