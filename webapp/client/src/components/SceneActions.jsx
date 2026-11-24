import { useState } from 'react';
import {
  renameScene, mergeScenes, splitScene, moveToScene,
} from '../api';
import { UNGROUPED_KEY } from '../sceneUtils';

// Pure helpers (unit-tested): what the scene editor can do with the current selection.
// The scene shown BELOW this one: the next one in time when sorted oldest first, the previous one
// when sorted newest first (the picker's default) - so "Merge ↓" always means what it shows.
export function nextSceneId(scenes, id, sortOrder = 'oldest') {
  const ordered = [...(scenes || [])].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  if (sortOrder === 'newest') ordered.reverse();
  const i = ordered.findIndex((s) => s.id === id);
  return i >= 0 && i < ordered.length - 1 ? ordered[i + 1].id : null;
}

// Split point = the selected photo of this scene that comes LAST in time (photos are in time
// order in the scene); splitting after the scene's last photo isn't possible.
export function splitPointFor(scene, selected) {
  const inScene = scene.photos.filter((r) => selected.has(r));
  if (inScene.length === 0) return null;
  const last = inScene[inScene.length - 1];
  return last === scene.photos[scene.photos.length - 1] ? null : last;
}

export function movableInto(scene, selected) {
  return [...selected].filter((r) => !scene.photos.includes(r));
}

/**
 * Version 2 Phase 5 (LLM plan §7.2): edit a scene from its header. Every edit marks the scene
 * "edited", so Find scenes never regroups or renames it again.
 */
export default function SceneActions({
  group, scenes, selected, onChanged, onError, sortOrder = 'oldest',
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  if (group.key === UNGROUPED_KEY) return null;
  const { scene } = group;
  const nextId = nextSceneId(scenes, scene.id, sortOrder);
  const splitAt = splitPointFor(scene, selected);
  const movable = movableInto(scene, selected);
  const run = (p) => p.then(onChanged).catch((err) => onError && onError(err.message));

  if (renaming) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => { e.preventDefault(); setRenaming(false); if (name.trim()) run(renameScene(scene.id, name.trim())); }}
      >
        <input aria-label="Scene name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className="text-xs px-1.5 py-0.5 w-40" />
        <button type="submit" className="btn-secondary text-[10px] py-0.5 px-2">Save</button>
        <button type="button" className="btn-secondary text-[10px] py-0.5 px-2" onClick={() => setRenaming(false)}>Cancel</button>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label={`Edit scene ${scene.name}`}>
      <button type="button" className="btn-secondary text-[10px] py-0.5 px-1.5" onClick={() => { setName(scene.name || ''); setRenaming(true); }}>Rename</button>
      {/* Plain tooltips (title), not <Hint>: four "?" icons per scene header crowded the row. */}
      <button type="button" title="Merges this scene with the one shown right below it." disabled={!nextId} className="btn-secondary text-[10px] py-0.5 px-1.5" onClick={() => run(mergeScenes([scene.id, nextId]))}>Merge ↓</button>
      <button type="button" title="Select a photo in this scene, then click: the photos taken after it become a new scene." disabled={!splitAt} className="btn-secondary text-[10px] py-0.5 px-1.5" onClick={() => run(splitScene(scene.id, splitAt))}>Split</button>
      <button type="button" title="Moves the selected photos from other scenes into this one." disabled={movable.length === 0} className="btn-secondary text-[10px] py-0.5 px-1.5" onClick={() => run(moveToScene(movable, scene.id))}>
        Move {movable.length || ''} here
      </button>
    </div>
  );
}
