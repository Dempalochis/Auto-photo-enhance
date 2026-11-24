// Version 2 Phase 3: scene view for the photo picker (LLM plan §7.3). Day -> scene -> photos;
// a scene is shown under the day it started (scenes may cross midnight). Photos in no scene go
// to an "Ungrouped" bucket at the end, so nothing disappears from the picker.
import { dayKey, formatDay } from './dateUtils';

export const UNGROUPED_KEY = '__ungrouped__';

// relPath -> scene, for search and lookups.
export function sceneIndex(scenes) {
  const idx = new Map();
  for (const s of scenes || []) for (const r of s.photos) idx.set(r, s);
  return idx;
}

// Search in scene view: filename/subfolder (as in Date view) OR the scene's name OR any caption
// the LLM gave its photos (Phase 5).
export function matchesSceneSearch(photo, scene, search) {
  if (!search) return true;
  const q = search.toLowerCase();
  if (photo.relPath.toLowerCase().includes(q)) return true;
  if (scene && scene.name && scene.name.toLowerCase().includes(q)) return true;
  const cap = scene && scene.captions && scene.captions[photo.relPath];
  return Boolean(cap && cap.toLowerCase().includes(q));
}

export function filterPhotosForScenes(photos, scenes, { search, minDate, maxDate }) {
  const idx = sceneIndex(scenes);
  return photos.filter((p) => {
    const d = dayKey(p.dateTaken);
    if (minDate && d < minDate) return false;
    if (maxDate && d > maxDate) return false;
    return matchesSceneSearch(p, idx.get(p.relPath), search);
  });
}

function hhmm(dt) { return typeof dt === 'string' ? dt.slice(11, 16) : ''; }

export function sceneTimeRange(scene) {
  const a = hhmm(scene.start);
  const b = hhmm(scene.end);
  if (!a) return '';
  const sameDay = (scene.start || '').slice(0, 10) === (scene.end || '').slice(0, 10);
  if (a === b && sameDay) return a;
  return sameDay ? `${a}–${b}` : `${a}–${b} (+1 day)`;
}

/**
 * photos: already filtered photo objects; scenes: from GET /api/scenes.
 * Returns [{ key, label, photos (all photos of the day, for Select day), scenes: [{ key, scene,
 * label, photos }] }], newest or oldest first. The ungrouped bucket (if any) is the last entry,
 * key UNGROUPED_KEY, with one pseudo-scene.
 */
export function groupByScene(photos, scenes, sortOrder = 'newest') {
  const dir = sortOrder === 'newest' ? -1 : 1;
  const byRel = new Map(photos.map((p) => [p.relPath, p]));
  const days = new Map();
  const used = new Set();
  const ordered = [...(scenes || [])].sort((a, b) => dir * (a.start || '').localeCompare(b.start || ''));
  for (const scene of ordered) {
    const members = scene.photos.map((r) => byRel.get(r)).filter(Boolean);
    if (members.length === 0) continue;
    members.sort((a, b) => dir * a.dateTaken.localeCompare(b.dateTaken));
    members.forEach((p) => used.add(p.relPath));
    const dKey = (scene.start || members[0].dateTaken).slice(0, 10);
    if (!days.has(dKey)) days.set(dKey, { key: dKey, label: formatDay(dKey), photos: [], scenes: [] });
    const day = days.get(dKey);
    day.scenes.push({ key: scene.id, scene, label: scene.name, photos: members });
    day.photos.push(...members);
  }
  const result = [...days.values()].sort((a, b) => dir * a.key.localeCompare(b.key));
  const rest = photos.filter((p) => !used.has(p.relPath)).sort((a, b) => dir * a.dateTaken.localeCompare(b.dateTaken));
  if (rest.length > 0) {
    const pseudo = { id: UNGROUPED_KEY, name: 'Ungrouped', photos: rest.map((p) => p.relPath) };
    result.push({
      key: UNGROUPED_KEY, label: 'UNGROUPED', photos: rest, scenes: [{ key: UNGROUPED_KEY, scene: pseudo, label: 'Not in a scene yet', photos: rest }],
    });
  }
  return result;
}

// Days covered by a set of photos (for "Find scenes" limited to the current date filter).
export function daysOf(photos) {
  return [...new Set(photos.map((p) => dayKey(p.dateTaken)))].sort();
}
