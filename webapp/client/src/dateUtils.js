const MONTH_FMT = { year: 'numeric', month: 'long' };
const DAY_FMT = { weekday: 'short', month: 'short', day: 'numeric' };

export function dayKey(dateTaken) {
  return dateTaken.slice(0, 10);
}

export function monthKey(dateTaken) {
  return dateTaken.slice(0, 7);
}

export function formatMonth(key) {
  return new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, MONTH_FMT).toUpperCase();
}

export function formatDay(key) {
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, DAY_FMT).toUpperCase();
}

// Filters by date only (inclusive), ignoring time-of-day, and by filename/subfolder substring.
export function filterPhotos(photos, { search, minDate, maxDate }) {
  return photos.filter((p) => {
    if (search && !p.relPath.toLowerCase().includes(search.toLowerCase())) return false;
    const d = dayKey(p.dateTaken);
    if (minDate && d < minDate) return false;
    if (maxDate && d > maxDate) return false;
    return true;
  });
}

// Groups already-filtered photos into Month -> Day -> [photos], honoring sort order.
export function groupByDate(photos, sortOrder = 'newest') {
  const sorted = [...photos].sort((a, b) => {
    const cmp = a.dateTaken.localeCompare(b.dateTaken);
    return sortOrder === 'newest' ? -cmp : cmp;
  });

  const months = [];
  let curMonth = null;
  let curDay = null;

  for (const p of sorted) {
    const mKey = monthKey(p.dateTaken);
    const dKey = dayKey(p.dateTaken);

    if (!curMonth || curMonth.key !== mKey) {
      curMonth = { key: mKey, label: formatMonth(mKey), days: [] };
      months.push(curMonth);
      curDay = null;
    }
    if (!curDay || curDay.key !== dKey) {
      curDay = { key: dKey, label: formatDay(dKey), photos: [] };
      curMonth.days.push(curDay);
    }
    curDay.photos.push(p);
  }

  return months;
}
