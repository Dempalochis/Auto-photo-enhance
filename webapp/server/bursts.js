// Version 2 Phase 6 (LLM plan §8 "Bursts"): frames within +-2 s of each other with identical
// exposure settings (ISO, shutter, aperture) reuse the first frame's plan - one LLM call per burst.
// Pure. photos: [{ ..., exif: { dateTaken, iso, exposureTime, fNumber } }] in any order.
// Returns Map index -> leaderIndex for every follower (leaders are not in the map).
const { timeMs } = require('./sceneSegmenter');

const BURST_WINDOW_MS = 2000;

function sameExposure(a, b) {
  return a.iso != null && a.iso === b.iso && a.exposureTime != null && a.exposureTime === b.exposureTime
    && (a.fNumber || null) === (b.fNumber || null);
}

function findBursts(photos, windowMs = BURST_WINDOW_MS) {
  const idx = photos
    .map((p, i) => ({ i, t: timeMs(p.exif && p.exif.dateTaken), e: p.exif || {} }))
    .filter((x) => x.t !== null)
    .sort((a, b) => a.t - b.t || a.i - b.i);
  // Chain frames into bursts in time order...
  const groups = [];
  let prev = null;
  for (const x of idx) {
    if (prev && x.t - prev.t <= windowMs && sameExposure(prev.e, x.e)) groups[groups.length - 1].push(x.i);
    else groups.push([x.i]);
    prev = x;
  }
  // ...then the leader is the member that comes FIRST in the input (render) order, so a worker
  // walking the list in order always reaches a leader before its followers (no deadlock).
  const followers = new Map();
  for (const g of groups) {
    if (g.length < 2) continue;
    const leader = Math.min(...g);
    for (const i of g) if (i !== leader) followers.set(i, leader);
  }
  return followers;
}

module.exports = { findBursts, BURST_WINDOW_MS };
