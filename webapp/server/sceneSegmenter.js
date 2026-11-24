// Version 2, Phase 3 (LLM plan §7.1 step 1): candidate scene segments from capture time and EXIF
// alone - instant, no LLM. Pure functions only, so the rules are unit tested directly.
//
// A new segment starts when, compared to the previous photo (sorted by capture time):
//   - the time gap exceeds maxGapMinutes, or
//   - the scene exposure value jumps by more than evJumpThreshold stops (indoors <-> outdoors,
//     day -> night), when both photos have usable ISO/shutter/aperture, or
//   - flash switches on/off (when both photos record it), or
//   - the camera body changes (when splitByCamera is on).
// Scenes may cross midnight (decision LLM §11): only gaps split, never calendar days.

const DEFAULTS = {
  maxGapMinutes: 10,
  evJumpThreshold: 3,
  splitByCamera: true,
  splitByFlash: true,
};

function sceneOptions(cfgScenes) {
  const o = { ...DEFAULTS };
  if (cfgScenes && typeof cfgScenes === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (cfgScenes[k] !== undefined && cfgScenes[k] !== null) o[k] = cfgScenes[k];
    }
  }
  return o;
}

// Scene exposure value normalised to ISO 100: EV100 = log2(N^2 / t) - log2(ISO / 100).
// Bright daylight is ~14-15, indoors ~5-7, night streets ~2-4. Null when any input is missing.
function exposureValue({ iso, exposureTime, fNumber } = {}) {
  if (!(iso > 0) || !(exposureTime > 0) || !(fNumber > 0)) return null;
  return Math.log2((fNumber * fNumber) / exposureTime) - Math.log2(iso / 100);
}

// dateTaken is a local wall-clock 'YYYY-MM-DDTHH:MM:SS' string (no zone). Parsed as UTC on
// purpose: only differences matter, and this sidesteps DST jumps in the server's own zone.
function timeMs(dateTaken) {
  if (typeof dateTaken !== 'string') return null;
  const m = dateTaken.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Why photo `cur` starts a new segment after `prev`, or null if it continues the segment.
function boundaryReason(prev, cur, opts) {
  const gapMin = (timeMs(cur.dateTaken) - timeMs(prev.dateTaken)) / 60000;
  if (gapMin > opts.maxGapMinutes) return `gap ${Math.round(gapMin)} min`;
  const evPrev = exposureValue(prev);
  const evCur = exposureValue(cur);
  if (evPrev !== null && evCur !== null && Math.abs(evCur - evPrev) > opts.evJumpThreshold) {
    return `EV jump ${(evCur - evPrev).toFixed(1)}`;
  }
  if (opts.splitByFlash && typeof prev.flash === 'boolean' && typeof cur.flash === 'boolean' && prev.flash !== cur.flash) {
    return cur.flash ? 'flash on' : 'flash off';
  }
  if (opts.splitByCamera && prev.model && cur.model && prev.model !== cur.model) return 'camera change';
  return null;
}

function hhmm(dateTaken) {
  return typeof dateTaken === 'string' ? dateTaken.slice(11, 16) : '??:??';
}

// "14:05–14:40 · 23 photos" (single-photo and same-minute scenes show one time).
function segmentName(seg) {
  const a = hhmm(seg.start);
  const b = hhmm(seg.end);
  const n = seg.photos.length;
  return `${a === b ? a : `${a}–${b}`} · ${n} photo${n === 1 ? '' : 's'}`;
}

/**
 * photos: [{ relPath, dateTaken, iso?, exposureTime?, fNumber?, flash?, model? }]
 * Returns { segments: [{ index, photos: [relPath], start, end, startReason, evMedian, camera,
 *           name }], ungrouped: [relPath] } - ungrouped = photos with no usable capture time.
 */
function segmentPhotos(photos, cfgScenes) {
  const opts = sceneOptions(cfgScenes);
  const dated = [];
  const ungrouped = [];
  for (const p of photos || []) {
    if (timeMs(p.dateTaken) === null) ungrouped.push(p.relPath);
    else dated.push(p);
  }
  dated.sort((a, b) => (timeMs(a.dateTaken) - timeMs(b.dateTaken)) || a.relPath.localeCompare(b.relPath));

  const segments = [];
  let cur = null;
  let prev = null;
  for (const p of dated) {
    const reason = prev ? boundaryReason(prev, p, opts) : 'first photo';
    if (!cur || reason) {
      cur = { index: segments.length, members: [], startReason: reason };
      segments.push(cur);
    }
    cur.members.push(p);
    prev = p;
  }

  return {
    segments: segments.map((s) => {
      const out = {
        index: s.index,
        photos: s.members.map((m) => m.relPath),
        start: s.members[0].dateTaken,
        end: s.members[s.members.length - 1].dateTaken,
        startReason: s.startReason,
        evMedian: (() => { const e = median(s.members.map(exposureValue)); return e === null ? null : Math.round(e * 10) / 10; })(),
        camera: s.members[0].model || null,
        flash: s.members.some((m) => m.flash === true),
      };
      out.name = segmentName(out);
      return out;
    }),
    ungrouped,
  };
}

module.exports = {
  DEFAULTS, sceneOptions, exposureValue, timeMs, median, boundaryReason, segmentName, segmentPhotos,
};
