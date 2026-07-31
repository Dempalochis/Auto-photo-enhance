import { useEffect, useMemo, useState } from 'react';
import * as Checkbox from '@radix-ui/react-checkbox';
import { CheckIcon } from '@radix-ui/react-icons';
import { filterPhotos, groupByDate } from '../dateUtils';
import { thumbnailUrl } from '../api';
import Hint from './Hint';

function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PhotoCard({ photo, isChecked, isPreviewing, previewStarting, onToggle, onPreview, thumbSize }) {
  return (
    <div
      className={`relative rounded-[4px] overflow-hidden border transition-colors card ${
        isPreviewing ? 'border-[var(--amber-dim)]' : ''
      }`}
    >
      <img
        src={thumbnailUrl(photo.relPath)}
        alt={photo.name}
        className={`w-full object-cover bg-[var(--panel-raised)] ${thumbSize === 'compact' ? 'aspect-square' : 'aspect-[3/2]'}`}
        loading="lazy"
      />
      <div className="absolute top-2 left-2">
        <Checkbox.Root
          checked={isChecked}
          onCheckedChange={() => onToggle(photo.relPath)}
          className="w-5 h-5 rounded-[3px] bg-black/60 border border-white/40 flex items-center justify-center data-[state=checked]:bg-[var(--amber)] data-[state=checked]:border-[var(--amber)]"
        >
          <Checkbox.Indicator>
            <CheckIcon className="text-[var(--bg)] w-4 h-4" />
          </Checkbox.Indicator>
        </Checkbox.Root>
      </div>
      {photo.dir && (
        <span className="absolute top-2 right-2 timestamp bg-black/60 text-[var(--text)] px-1.5 py-0.5 rounded-[3px]">
          {photo.dir}
        </span>
      )}
      {thumbSize !== 'compact' && (
        <div className="p-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-[var(--text)] truncate">{photo.name}</p>
            <p className="timestamp text-[var(--text-dim)]">{formatSize(photo.size)}</p>
          </div>
          <button
            type="button"
            disabled={previewStarting}
            onClick={() => onPreview(photo.relPath)}
            className={`btn-secondary shrink-0 text-[11px] px-2 py-1 ${isPreviewing ? 'active' : ''}`}
          >
            Preview
          </button>
        </div>
      )}
      {thumbSize === 'compact' && (
        <button
          type="button"
          disabled={previewStarting}
          onClick={() => onPreview(photo.relPath)}
          className={`absolute bottom-1 right-1 btn-secondary text-[10px] px-1.5 py-0.5 ${isPreviewing ? 'active' : ''}`}
        >
          Preview
        </button>
      )}
    </div>
  );
}

function DayGroup({ day, selected, onToggle, onPreview, previewPhoto, previewStarting, onSelectMany, thumbSize }) {
  const ids = day.photos.map((p) => p.relPath);
  const allSelected = ids.every((id) => selected.has(id));

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2 pl-3 border-l-2 border-[var(--border)]">
        <span className="eyebrow">{day.label} · {day.photos.length}</span>
        <Hint text={`${allSelected ? 'Removes' : 'Adds'} all ${day.photos.length} photo${day.photos.length === 1 ? '' : 's'} from this day ${allSelected ? 'from' : 'to'} your selection.`}>
          <button type="button" className="btn-secondary text-[10px] py-0.5 px-2" onClick={() => onSelectMany(ids, !allSelected)}>
            {allSelected ? 'Deselect day' : 'Select day'}
          </button>
        </Hint>
      </div>
      <div className={`grid gap-3 ${thumbSize === 'compact' ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4'}`}>
        {day.photos.map((photo) => (
          <PhotoCard
            key={photo.relPath}
            photo={photo}
            isChecked={selected.has(photo.relPath)}
            isPreviewing={previewPhoto === photo.relPath}
            previewStarting={previewStarting}
            onToggle={onToggle}
            onPreview={onPreview}
            thumbSize={thumbSize}
          />
        ))}
      </div>
    </div>
  );
}

const THUMB_SIZE_KEY = 'ape.thumbSize';

export default function PhotoPicker({
  photos, selected, onToggle, onSelectMany, onPreview, previewPhoto, previewStarting,
}) {
  const [search, setSearch] = useState('');
  const [minDate, setMinDate] = useState('');
  const [maxDate, setMaxDate] = useState('');
  const [sortOrder, setSortOrder] = useState('newest');
  const [thumbSize, setThumbSize] = useState(() => localStorage.getItem(THUMB_SIZE_KEY) || 'comfortable');

  useEffect(() => { localStorage.setItem(THUMB_SIZE_KEY, thumbSize); }, [thumbSize]);

  const filtered = useMemo(() => filterPhotos(photos, { search, minDate, maxDate }), [photos, search, minDate, maxDate]);
  const months = useMemo(() => groupByDate(filtered, sortOrder), [filtered, sortOrder]);
  const allVisibleSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.relPath));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">1. Choose photos to process</h2>
        <span className="eyebrow">{selected.size} selected</span>
      </div>

      <div className="panel p-3 mb-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[160px]">
          <label className="field-label block mb-1">Search filename</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="DSC00600…"
            className="w-full text-sm px-2.5 py-1.5"
          />
        </div>
        <div>
          <label className="field-label block mb-1">
            <Hint text="Filters by calendar day only - time of day is ignored. Leave blank for no lower limit.">From date</Hint>
          </label>
          <input type="date" value={minDate} onChange={(e) => setMinDate(e.target.value)} className="text-sm px-2 py-1.5" />
        </div>
        <div>
          <label className="field-label block mb-1">
            <Hint text="Inclusive - photos taken on this day are included. Leave blank for no upper limit.">To date</Hint>
          </label>
          <input type="date" value={maxDate} onChange={(e) => setMaxDate(e.target.value)} className="text-sm px-2 py-1.5" />
        </div>
        <button
          type="button"
          className="btn-secondary text-xs px-2.5 py-1.5"
          onClick={() => setSortOrder((s) => (s === 'newest' ? 'oldest' : 'newest'))}
        >
          {sortOrder === 'newest' ? '↓ Newest first' : '↑ Oldest first'}
        </button>
        <Hint text="Compact shows more photos per row with smaller thumbnails; Comfortable shows filename and size.">
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setThumbSize('compact')}
              className={`btn-secondary text-xs px-2.5 py-1.5 ${thumbSize === 'compact' ? 'active' : ''}`}
            >
              Compact
            </button>
            <button
              type="button"
              onClick={() => setThumbSize('comfortable')}
              className={`btn-secondary text-xs px-2.5 py-1.5 ${thumbSize === 'comfortable' ? 'active' : ''}`}
            >
              Comfortable
            </button>
          </div>
        </Hint>
        <button
          type="button"
          onClick={() => onSelectMany(filtered.map((p) => p.relPath), !allVisibleSelected)}
          className="btn-secondary text-xs px-2.5 py-1.5"
        >
          {allVisibleSelected ? 'Deselect all' : 'Select all'}
        </button>
        {selected.size > 0 && (
          <button type="button" onClick={() => onSelectMany(Array.from(selected), false)} className="btn-secondary text-xs px-2.5 py-1.5 text-[var(--danger)]">
            Clear selection
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-[var(--text-dim)]">No photos match the current filters.</p>
      ) : (
        months.map((month) => {
          const monthIds = month.days.flatMap((d) => d.photos.map((p) => p.relPath));
          const monthAllSelected = monthIds.every((id) => selected.has(id));
          return (
            <div key={month.key} className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold tracking-wide">{month.label}</h3>
                <Hint text={`${monthAllSelected ? 'Removes' : 'Adds'} all ${monthIds.length} photos from this month ${monthAllSelected ? 'from' : 'to'} your selection.`}>
                  <button type="button" className="btn-secondary text-[10px] py-0.5 px-2" onClick={() => onSelectMany(monthIds, !monthAllSelected)}>
                    {monthAllSelected ? 'Deselect month' : 'Select month'}
                  </button>
                </Hint>
              </div>
              {month.days.map((day) => (
                <DayGroup
                  key={day.key}
                  day={day}
                  selected={selected}
                  onToggle={onToggle}
                  onPreview={onPreview}
                  previewPhoto={previewPhoto}
                  previewStarting={previewStarting}
                  onSelectMany={onSelectMany}
                  thumbSize={thumbSize}
                />
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
