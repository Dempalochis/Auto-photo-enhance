// Version 2 Phase 6 (LLM plan §7.4): a preset per scene + "Queue all scenes". Assignments are a
// per-browser convenience (localStorage), keyed by scene id; a scene id stays stable until the
// scene is regrouped.
const KEY = 'ape.scenePresets';

export function loadScenePresets() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

export function saveScenePresets(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* storage unavailable */ }
}

// One run per scene that has a preset assigned ('none' = colour correction only counts as
// assigned), in time order, using only photos that are still in the folder. Pure.
export function planSceneRuns(scenes, assignments, existingRelPaths) {
  const exists = new Set(existingRelPaths);
  return [...(scenes || [])]
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
    .filter((s) => assignments[s.id])
    .map((s) => ({
      sceneId: s.id, name: s.name, preset: assignments[s.id], files: s.photos.filter((r) => exists.has(r)),
    }))
    .filter((r) => r.files.length > 0);
}
