// Version 2 Phase 5 (LLM plan §7.1 steps 2-3): LLM refinement of the code-made scene segments.
//   - per-photo scene tags: from the correction analysis when cached (plan.sceneTags), else a
//     cheap tags-only call on the embedded JPEG (cached per photo);
//   - one text-only merge/split/naming call per day;
//   - strict validation against the segment list; any failure = the Phase 3 segments, named by
//     code. Grouping always produces something usable.
const { extractJson } = require('./correctionPlan');
const { segmentName } = require('./sceneSegmenter');
const { sceneId, dayOf } = require('./scenesStore');

/**
 * Pure. Applies a model reply to the day's segments.
 * segments: [{ index, photos: [relPath], start, end, ... }] (index = position in this list).
 * Rules: groups cover each segment at most once and only contiguous neighbouring runs; segments
 * missing from every group stay on their own; a split applies only to a segment that is not
 * merged, at 0 <= afterPhotoIndex < photos.length - 1. Returns { groups, warnings } where each
 * group = { photos, name|null, reason|null, segmentIndexes }.
 */
function applySceneReply(segments, reply) {
  const warnings = [];
  const n = segments.length;
  const owner = new Array(n).fill(null);
  const named = [];
  const groupsIn = reply && Array.isArray(reply.groups) ? reply.groups : [];
  for (const g of groupsIn) {
    const segs = Array.isArray(g.segments) ? [...new Set(g.segments.filter((x) => Number.isInteger(x)))].sort((a, b) => a - b) : [];
    if (segs.length === 0) { warnings.push('empty group dropped'); continue; }
    if (segs[0] < 0 || segs[segs.length - 1] >= n) { warnings.push(`group ${JSON.stringify(g.segments)} has an unknown segment - dropped`); continue; }
    if (segs.some((x, i) => i > 0 && x !== segs[i - 1] + 1)) { warnings.push(`group ${JSON.stringify(g.segments)} is not contiguous - dropped`); continue; }
    if (segs.some((x) => owner[x] !== null)) { warnings.push(`group ${JSON.stringify(g.segments)} overlaps another group - dropped`); continue; }
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 80) : null;
    const id = named.length;
    named.push({ segs, name });
    segs.forEach((x) => { owner[x] = id; });
  }

  const splitBySeg = new Map();
  for (const sp of (reply && Array.isArray(reply.splits) ? reply.splits : [])) {
    if (!Number.isInteger(sp.segment) || sp.segment < 0 || sp.segment >= n) { warnings.push('split on an unknown segment dropped'); continue; }
    const g = owner[sp.segment];
    if (g !== null && named[g].segs.length > 1) { warnings.push(`split of merged segment ${sp.segment} dropped`); continue; }
    const len = segments[sp.segment].photos.length;
    if (!Number.isInteger(sp.afterPhotoIndex) || sp.afterPhotoIndex < 0 || sp.afterPhotoIndex >= len - 1) { warnings.push(`split index out of range in segment ${sp.segment}`); continue; }
    if (!splitBySeg.has(sp.segment)) splitBySeg.set(sp.segment, []);
    splitBySeg.get(sp.segment).push({ at: sp.afterPhotoIndex, reason: typeof sp.reason === 'string' ? sp.reason.slice(0, 120) : null });
  }

  const groups = [];
  let i = 0;
  while (i < n) {
    const g = owner[i];
    if (g !== null && named[g].segs.length > 1) {
      groups.push({ photos: named[g].segs.flatMap((x) => segments[x].photos), name: named[g].name, reason: null, segmentIndexes: named[g].segs });
      i = named[g].segs[named[g].segs.length - 1] + 1;
      continue;
    }
    const name = g !== null ? named[g].name : null;
    const cuts = (splitBySeg.get(i) || []).sort((a, b) => a.at - b.at);
    const photos = segments[i].photos;
    let from = 0;
    let reason = null;
    for (const c of cuts) {
      if (c.at < from) continue; // duplicate/overlapping cut
      groups.push({ photos: photos.slice(from, c.at + 1), name: from === 0 ? name : null, reason, segmentIndexes: [i] });
      from = c.at + 1;
      reason = c.reason;
    }
    groups.push({ photos: photos.slice(from), name: from === 0 ? name : null, reason, segmentIndexes: [i] });
    i += 1;
  }
  return { groups, warnings };
}

/**
 * refineDay({ day, segments, photosByRel, tagsFor, provider, signal }) -> { scenes, warnings, llm }
 * tagsFor(relPath) -> { setting, subject, light, caption } | null (already collected).
 */
async function refineDay({
  day, segments, photosByRel, tagsFor, provider, signal,
}) {
  const { sceneSystemPrompt, sceneSchema, sceneUserText } = require('./llm/scenePrompt');
  const withTags = segments.map((s, index) => ({
    ...s,
    index,
    photos: s.photos.map((r) => {
      const t = tagsFor(r);
      return { relPath: r, tags: t, caption: t && t.caption ? t.caption : '' };
    }),
  }));
  let reply;
  try {
    const res = await provider.completeText({
      systemPrompt: sceneSystemPrompt(), userText: sceneUserText(day, withTags), jsonSchema: sceneSchema(), signal,
    });
    reply = extractJson(res.text);
  } catch (err) {
    return { scenes: null, warnings: [`scene LLM step failed for ${day}: ${err.message}`], llm: 'failed' };
  }
  const { groups, warnings } = applySceneReply(segments, reply);
  const scenes = groups.map((g) => {
    const members = g.photos.map((r) => photosByRel[r]).filter(Boolean)
      .sort((a, b) => a.dateTaken.localeCompare(b.dateTaken) || a.relPath.localeCompare(b.relPath));
    const start = members[0].dateTaken;
    const end = members[members.length - 1].dateTaken;
    const base = { photos: members.map((m) => m.relPath), start, end };
    const captions = {};
    members.forEach((m) => { const t = tagsFor(m.relPath); if (t && t.caption) captions[m.relPath] = t.caption; });
    const firstSeg = segments[g.segmentIndexes[0]];
    return {
      id: sceneId(base.photos[0], start),
      name: g.name || segmentName(base),
      photos: base.photos,
      start,
      end,
      day: dayOf(start),
      source: g.name ? 'llm' : 'auto',
      startReason: g.reason || firstSeg.startReason,
      evMedian: firstSeg.evMedian,
      camera: firstSeg.camera,
      flash: g.segmentIndexes.some((x) => segments[x].flash),
      captions,
    };
  });
  return { scenes, warnings, llm: 'ok' };
}

module.exports = { applySceneReply, refineDay };
