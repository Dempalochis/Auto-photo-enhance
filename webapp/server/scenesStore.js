// Version 2 Phase 3 (LLM plan §7.2): scene groups per source folder, cached in
// .webapp_cache/scenes/<folder-key>.json and written atomically.
//
//   { version: 1, folder, options, detectedAt, scenes: [Scene], fingerprints: { relPath: "size:mtime" } }
//   Scene = { id, name, photos: [relPath], start, end, day, source: 'auto'|'edited'|'llm',
//             startReason?, evMedian?, camera?, flash?, captions? }
//
// Incremental: only the days whose photos changed (added, removed, replaced) are regrouped. Scenes
// you edited (source 'edited') are never regrouped or renamed automatically. They only lose
// photos that no longer exist.
//
// The pure functions (planDetection, rename/merge/split/move) are unit-tested. The file I/O is
// a thin wrapper around them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFileSync } = require('./atomicFile');
const { segmentPhotos, segmentName, sceneOptions } = require('./sceneSegmenter');

const STORE_VERSION = 1;

function folderKey(folder) {
  const resolved = path.resolve(folder);
  const hash = crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 10);
  const base = path.basename(resolved).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root';
  return `${base}_${hash}`;
}

function storeFile(scenesDir, folder) {
  return path.join(scenesDir, `${folderKey(folder)}.json`);
}

function sceneId(firstRelPath, start) {
  return `s_${crypto.createHash('sha1').update(`${firstRelPath}|${start}`).digest('hex').slice(0, 12)}`;
}

function dayOf(dateTaken) { return typeof dateTaken === 'string' ? dateTaken.slice(0, 10) : null; }

function fingerprintOf(p) { return `${p.size ?? ''}:${p.mtime ?? ''}`; }

function emptyStore(folder) {
  return {
    version: STORE_VERSION, folder, options: null, detectedAt: null, scenes: [], fingerprints: {},
  };
}

function readStore(scenesDir, folder) {
  try {
    const s = JSON.parse(fs.readFileSync(storeFile(scenesDir, folder), 'utf8'));
    if (s && s.version === STORE_VERSION && Array.isArray(s.scenes)) return s;
  } catch { /* no store yet, or unreadable: start empty */ }
  return emptyStore(folder);
}

function writeStore(scenesDir, folder, store) {
  atomicWriteFileSync(storeFile(scenesDir, folder), JSON.stringify(store, null, 2));
}

// Recomputes start/end/day/name for a scene from its photos (keeps a user-given name).
function refreshScene(scene, byRel, { keepName = true } = {}) {
  const photos = scene.photos.filter((r) => byRel[r]);
  photos.sort((a, b) => (byRel[a].dateTaken || '').localeCompare(byRel[b].dateTaken || '') || a.localeCompare(b));
  const start = photos.length ? byRel[photos[0]].dateTaken : scene.start;
  const end = photos.length ? byRel[photos[photos.length - 1]].dateTaken : scene.end;
  const out = {
    ...scene, photos, start, end, day: dayOf(start),
  };
  if (!keepName || !scene.name) out.name = segmentName(out);
  return out;
}

function autoScenesFromSegments(segments) {
  return segments.map((s) => ({
    id: sceneId(s.photos[0], s.start),
    name: s.name,
    photos: s.photos,
    start: s.start,
    end: s.end,
    day: dayOf(s.start),
    source: 'auto',
    startReason: s.startReason,
    evMedian: s.evMedian,
    camera: s.camera,
    flash: s.flash,
  }));
}

/**
 * Pure. photos: current folder listing [{ relPath, dateTaken, size, mtime, iso, ... }].
 * opts.days: optional list of 'YYYY-MM-DD' to (re)detect even if unchanged ("Find scenes" for
 * the days in the current date filter). opts.force: regroup every non-edited day.
 * Returns { store, affectedDays, toGroup } - toGroup = segments for the affected days (the
 * caller may refine them with the LLM, Phase 5, before calling finalizeDetection).
 */
function planDetection(prevStore, photos, cfgScenes, opts = {}) {
  const options = sceneOptions(cfgScenes);
  const byRel = Object.fromEntries(photos.map((p) => [p.relPath, p]));
  const prevFp = prevStore.fingerprints || {};
  const optionsChanged = JSON.stringify(prevStore.options || null) !== JSON.stringify(options);

  // Days touched by a change: new or replaced photos (by their current day) and removed photos
  // (by the day of the scene they were in).
  const affected = new Set(opts.days || []);
  for (const p of photos) {
    if (prevFp[p.relPath] !== fingerprintOf(p)) affected.add(dayOf(p.dateTaken));
  }
  for (const scene of prevStore.scenes) {
    if (scene.photos.some((r) => !byRel[r])) affected.add(scene.day);
  }
  if (opts.force || optionsChanged || !prevStore.detectedAt) {
    for (const p of photos) affected.add(dayOf(p.dateTaken));
  }
  affected.delete(null);

  // Edited scenes survive as they are (minus vanished photos). Auto/LLM scenes survive only on
  // days that were not affected.
  const kept = [];
  const claimed = new Set();
  for (const scene of prevStore.scenes) {
    const isEdited = scene.source === 'edited';
    if (!isEdited && affected.has(scene.day)) continue;
    const refreshed = refreshScene(scene, byRel);
    if (refreshed.photos.length === 0) continue;
    // An unaffected auto scene whose photo moved to another (affected) day is regrouped instead.
    if (!isEdited && refreshed.photos.some((r) => affected.has(dayOf(byRel[r].dateTaken)))) continue;
    kept.push(refreshed);
    refreshed.photos.forEach((r) => claimed.add(r));
  }

  const toSegment = photos.filter((p) => !claimed.has(p.relPath) && affected.has(dayOf(p.dateTaken)));
  const { segments, ungrouped } = segmentPhotos(toSegment, options);
  return {
    kept, segments, ungrouped, affectedDays: [...affected].sort(), options, byRel,
  };
}

/** Pure. Combines kept scenes with the (possibly LLM-refined) new scenes into the next store. */
function finalizeDetection(plan, newScenes, photos, folder, now = Date.now()) {
  const scenes = [...plan.kept, ...newScenes]
    .sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.id.localeCompare(b.id));
  // Guarantee unique ids (an edited scene and a new auto scene could collide on first photo).
  const seen = new Set();
  for (const s of scenes) {
    while (seen.has(s.id)) s.id = `${s.id}x`;
    seen.add(s.id);
  }
  return {
    version: STORE_VERSION,
    folder,
    options: plan.options,
    detectedAt: now,
    scenes,
    fingerprints: Object.fromEntries(photos.map((p) => [p.relPath, fingerprintOf(p)])),
  };
}

// Photos that are in the folder but in no scene (new since the last detection, or no capture time).
function ungroupedPhotos(store, photos) {
  const inScene = new Set(store.scenes.flatMap((s) => s.photos));
  return photos.filter((p) => !inScene.has(p.relPath)).map((p) => p.relPath);
}

// ---- edit operations (pure; each returns { store } or { error }) ----

function findScene(store, id) {
  const idx = store.scenes.findIndex((s) => s.id === id);
  return idx === -1 ? null : { idx, scene: store.scenes[idx] };
}

function renameScene(store, id, name) {
  const f = findScene(store, id);
  if (!f) return { error: 'scene not found' };
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) return { error: 'name is required' };
  const scenes = store.scenes.slice();
  scenes[f.idx] = { ...f.scene, name: clean, source: 'edited' };
  return { store: { ...store, scenes } };
}

// Only neighbouring scenes (in time order) may merge, so a scene stays a continuous stretch.
function mergeScenes(store, ids, byRel) {
  if (!Array.isArray(ids) || ids.length < 2) return { error: 'at least two scene ids are required' };
  const idxs = ids.map((id) => store.scenes.findIndex((s) => s.id === id));
  if (idxs.some((i) => i === -1)) return { error: 'scene not found' };
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i] !== sorted[i - 1] + 1) return { error: 'only neighbouring scenes can be merged' };
  const first = store.scenes[sorted[0]];
  const members = sorted.map((i) => store.scenes[i]);
  const merged = refreshScene({
    ...first, photos: members.flatMap((s) => s.photos), source: 'edited',
  }, byRel);
  const scenes = store.scenes.filter((_, i) => !sorted.includes(i));
  scenes.splice(sorted[0], 0, merged);
  return { store: { ...store, scenes } };
}

// Split after `afterRelPath`: the photos from the next one on become a new scene.
function splitScene(store, id, afterRelPath, byRel) {
  const f = findScene(store, id);
  if (!f) return { error: 'scene not found' };
  const at = f.scene.photos.indexOf(afterRelPath);
  if (at === -1) return { error: 'photo is not in this scene' };
  if (at === f.scene.photos.length - 1) return { error: 'cannot split after the last photo' };
  const a = refreshScene({ ...f.scene, photos: f.scene.photos.slice(0, at + 1), source: 'edited' }, byRel);
  const rest = f.scene.photos.slice(at + 1);
  const bStart = byRel[rest[0]] ? byRel[rest[0]].dateTaken : f.scene.end;
  const b = refreshScene({
    id: sceneId(rest[0], bStart), name: null, photos: rest, source: 'edited',
  }, byRel, { keepName: false });
  const scenes = store.scenes.slice();
  scenes.splice(f.idx, 1, a, b);
  return { store: { ...store, scenes } };
}

function moveToScene(store, relPaths, toId, byRel) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) return { error: 'relPaths must be a non-empty array' };
  const target = findScene(store, toId);
  if (!target) return { error: 'scene not found' };
  const moving = new Set(relPaths);
  const scenes = [];
  for (const s of store.scenes) {
    if (s.id === toId) {
      scenes.push(refreshScene({ ...s, photos: [...s.photos.filter((r) => !moving.has(r)), ...relPaths], source: 'edited' }, byRel));
    } else if (s.photos.some((r) => moving.has(r))) {
      const left = s.photos.filter((r) => !moving.has(r));
      if (left.length) scenes.push(refreshScene({ ...s, photos: left, source: 'edited' }, byRel));
    } else scenes.push(s);
  }
  scenes.sort((x, y) => (x.start || '').localeCompare(y.start || ''));
  return { store: { ...store, scenes } };
}

module.exports = {
  STORE_VERSION, folderKey, storeFile, readStore, writeStore, emptyStore, sceneId, dayOf,
  planDetection, finalizeDetection, autoScenesFromSegments, ungroupedPhotos, refreshScene,
  renameScene, mergeScenes, splitScene, moveToScene,
};
