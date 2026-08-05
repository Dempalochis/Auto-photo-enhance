import { arrayMove } from '@dnd-kit/sortable';

// Given the current ordered list of ids and a drag-end event's active/over ids, returns the new
// order - or the *same array reference* unchanged if there's nothing to do (no drop target, or
// dropped back where it started - dnd-kit fires onDragEnd even for a no-op drag), so callers can
// cheaply check `newOrder === ids` to skip firing an unnecessary reorder request.
export function computeReorderedIds(ids, activeId, overId) {
  if (!overId || activeId === overId) return ids;
  const oldIndex = ids.indexOf(activeId);
  const newIndex = ids.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1) return ids;
  return arrayMove(ids, oldIndex, newIndex);
}
