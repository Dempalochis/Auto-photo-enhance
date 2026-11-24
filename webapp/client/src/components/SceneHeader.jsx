import { useMemo } from 'react';
import { thumbnailUrl } from '../api';
import { sceneTimeRange, UNGROUPED_KEY } from '../sceneUtils';
import Hint from './Hint';

// Auto-named scenes are already called "14:05–14:40 · 23 photos", so their subtitle says how they
// were made instead of repeating it.
function subtitle(group, range, isUngrouped) {
  const n = group.photos.length;
  const count = `${n} photo${n === 1 ? '' : 's'}`;
  if (isUngrouped) return `${count} · click Find scenes to group them`;
  const s = group.scene || {};
  const how = { auto: 'auto (time/EXIF)', llm: 'named by AI', edited: 'edited' }[s.source] || '';
  if (s.source === 'auto' || (group.label || '').startsWith(range)) return [how, s.camera].filter(Boolean).join(' · ');
  return [range, count, how].filter(Boolean).join(' · ');
}

// Version 2 Phase 3 (LLM plan §7.3): one scene in the picker's scene view - name, time range,
// count, a small strip of its first thumbnails, and Select scene / Deselect scene (the same
// all-selected logic as DayHeader). `actions` is an optional slot for the scene editor
// (Phase 5) and the per-scene preset dropdown (Phase 6).
export default function SceneHeader({
  group, selected, onSelectMany, onSceneSelected, actions,
}) {
  const ids = useMemo(() => group.photos.map((p) => p.relPath), [group]);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const isUngrouped = group.key === UNGROUPED_KEY;
  const range = isUngrouped ? '' : sceneTimeRange(group.scene);
  const select = () => {
    onSelectMany(ids, !allSelected);
    if (!allSelected && onSceneSelected && !isUngrouped) onSceneSelected(group.scene);
  };
  return (
    <div className="flex items-center justify-between gap-3 mb-2 ml-3 pl-3 border-l-2 border-[var(--amber-dim)]" data-testid="scene-header">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex gap-0.5 shrink-0" aria-hidden="true">
          {group.photos.slice(0, 4).map((p) => (
            <img key={p.relPath} src={thumbnailUrl(p.relPath)} alt="" loading="lazy" className="w-8 h-6 object-cover rounded-[2px] bg-[var(--panel-raised)]" />
          ))}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-[var(--text)] truncate" title={group.label}>{group.label}</p>
          <p className="timestamp text-[var(--text-dim)]">{subtitle(group, range, isUngrouped)}</p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {actions}
        <Hint text={`${allSelected ? 'Removes' : 'Adds'} all ${ids.length} photo${ids.length === 1 ? '' : 's'} of this ${isUngrouped ? 'bucket' : 'scene'} ${allSelected ? 'from' : 'to'} your selection.`}>
          <button type="button" className="btn-secondary text-[10px] py-0.5 px-2" onClick={select}>
            {allSelected ? 'Deselect scene' : 'Select scene'}
          </button>
        </Hint>
      </div>
    </div>
  );
}
