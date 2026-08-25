import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import * as Checkbox from '@radix-ui/react-checkbox';
import { CheckIcon } from '@radix-ui/react-icons';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
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

function MonthHeader({ month, selected, onSelectMany }) {
  const monthIds = useMemo(() => month.days.flatMap((d) => d.photos.map((p) => p.relPath)), [month]);
  const monthAllSelected = monthIds.every((id) => selected.has(id));
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-xs font-semibold tracking-wide">{month.label}</h3>
      <Hint text={`${monthAllSelected ? 'Removes' : 'Adds'} all ${monthIds.length} photos from this month ${monthAllSelected ? 'from' : 'to'} your selection.`}>
        <button type="button" className="btn-secondary text-[10px] py-0.5 px-2" onClick={() => onSelectMany(monthIds, !monthAllSelected)}>
          {monthAllSelected ? 'Deselect month' : 'Select month'}
        </button>
      </Hint>
    </div>
  );
}

function DayHeader({ day, selected, onSelectMany }) {
  const ids = useMemo(() => day.photos.map((p) => p.relPath), [day]);
  const allSelected = ids.every((id) => selected.has(id));
  return (
    <div className="flex items-center justify-between mb-2 pl-3 border-l-2 border-[var(--border)]">
      <span className="eyebrow">{day.label} · {day.photos.length}</span>
      <Hint text={`${allSelected ? 'Removes' : 'Adds'} all ${day.photos.length} photo${day.photos.length === 1 ? '' : 's'} from this day ${allSelected ? 'from' : 'to'} your selection.`}>
        <button type="button" className="btn-secondary text-[10px] py-0.5 px-2" onClick={() => onSelectMany(ids, !allSelected)}>
          {allSelected ? 'Deselect day' : 'Select day'}
        </button>
      </Hint>
    </div>
  );
}

// One virtualized "row" - up to `columns` photos, laid out with the same grid classes the
// unvirtualized version used. A CSS grid still handles the actual column layout; this row is
// just one grid-worth of photos at a time, chunked in JS so the virtualizer can measure/skip
// whole rows instead of individual cards.
function PhotoRow({ photos, selected, onToggle, onPreview, previewPhoto, previewStarting, thumbSize }) {
  return (
    <div className={`grid gap-3 ${thumbSize === 'compact' ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4'}`}>
      {photos.map((photo) => (
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
  );
}

// Mirrors the grid-cols-* breakpoints the CSS used before virtualization (Tailwind's sm=640px/
// md=768px are viewport-width breakpoints, not container queries, so this JS port is exactly
// equivalent behavior, not an approximation) - the virtualizer needs to know how many photos
// fit per row in JS, since it chunks photos into rows itself instead of letting CSS wrap them.
function useColumnCount(thumbSize) {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (thumbSize === 'compact') {
    if (width >= 768) return 6;
    if (width >= 640) return 4;
    return 3;
  }
  if (width >= 768) return 4;
  if (width >= 640) return 3;
  return 2;
}

// Flattens months -> days -> photos into a single list of virtualizable rows (month header / day
// header / one grid-row of up to `columns` photos) - this is what actually fixes the V8 Phase 1
// scale finding (3s UI freeze at 3000 photos, from every photo mounting as a real unmemoized DOM
// node with zero windowing). Window-scroll virtualization (not a fixed-height inner panel) was
// chosen specifically so the page keeps scrolling naturally - PhotoPicker sits inline in a normal
// scrolling document (App.jsx's `min-h-screen` layout, not a full-screen dedicated tool), so a
// react-window-style fixed-viewport panel would have been a real UX regression (double
// scrollbars) rather than just a perf fix. Selection state itself was already O(1) (a Set) - the
// cost was purely DOM node count, which this addresses directly.
function useVirtualRows(months, columns) {
  return useMemo(() => {
    const rows = [];
    for (const month of months) {
      rows.push({ type: 'month', key: `month-${month.key}`, month });
      for (const day of month.days) {
        rows.push({ type: 'day', key: `day-${day.key}`, day });
        for (let i = 0; i < day.photos.length; i += columns) {
          rows.push({ type: 'photos', key: `${day.key}-row-${i}`, photos: day.photos.slice(i, i + columns) });
        }
      }
    }
    return rows;
  }, [months, columns]);
}

const THUMB_SIZE_KEY = 'ape.thumbSize';

export default function PhotoPicker({
  photos, loading, selected, onToggle, onSelectMany, onPreview, previewPhoto, previewStarting,
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

  const columns = useColumnCount(thumbSize);
  const rows = useVirtualRows(months, columns);

  const listRef = useRef(null);
  const listOffsetRef = useRef(0);
  useLayoutEffect(() => {
    listOffsetRef.current = listRef.current?.offsetTop ?? 0;
  });

  const rowHeight = thumbSize === 'compact' ? 150 : 250; // estimate only - measureElement corrects per-row
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (i) => (rows[i].type === 'photos' ? rowHeight : 40),
    overscan: 6,
    scrollMargin: listOffsetRef.current,
    getItemKey: (i) => rows[i].key,
  });

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

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-[var(--text-dim)]">
          <div
            role="status"
            aria-label="Loading photos"
            className="w-6 h-6 rounded-full border-2 border-[var(--border)] border-t-[var(--amber)] animate-spin"
          />
          <p className="text-xs">Loading photos and reading capture dates…</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-[var(--text-dim)]">No photos match the current filters.</p>
      ) : (
        <div ref={listRef} style={{ position: 'relative', width: '100%', height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                  paddingBottom: row.type === 'photos' ? '0.75rem' : undefined,
                }}
              >
                {row.type === 'month' && <MonthHeader month={row.month} selected={selected} onSelectMany={onSelectMany} />}
                {row.type === 'day' && <DayHeader day={row.day} selected={selected} onSelectMany={onSelectMany} />}
                {row.type === 'photos' && (
                  <PhotoRow
                    photos={row.photos}
                    selected={selected}
                    onToggle={onToggle}
                    onPreview={onPreview}
                    previewPhoto={previewPhoto}
                    previewStarting={previewStarting}
                    thumbSize={thumbSize}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
