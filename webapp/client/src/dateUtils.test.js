import { describe, expect, test } from 'vitest';
import {
  dayKey, monthKey, filterPhotos, groupByDate,
} from './dateUtils';

describe('dayKey / monthKey', () => {
  test('extract the date/month portion of an ISO timestamp', () => {
    expect(dayKey('2026-08-04T13:05:00')).toBe('2026-08-04');
    expect(monthKey('2026-08-04T13:05:00')).toBe('2026-08');
  });
});

describe('filterPhotos', () => {
  const photos = [
    { relPath: 'Ceremony/DSC001.ARW', dateTaken: '2026-08-01T10:00:00' },
    { relPath: 'Reception/DSC002.ARW', dateTaken: '2026-08-02T20:00:00' },
    { relPath: 'DSC003.ARW', dateTaken: '2026-08-05T09:00:00' },
  ];

  test('filters by filename/subfolder substring, case-insensitive', () => {
    expect(filterPhotos(photos, { search: 'ceremony' }).map((p) => p.relPath))
      .toEqual(['Ceremony/DSC001.ARW']);
  });

  test('filters by inclusive date range, ignoring time-of-day', () => {
    const result = filterPhotos(photos, { minDate: '2026-08-02', maxDate: '2026-08-02' });
    expect(result.map((p) => p.relPath)).toEqual(['Reception/DSC002.ARW']);
  });

  test('returns everything when no filters are given', () => {
    expect(filterPhotos(photos, {})).toHaveLength(3);
  });
});

describe('groupByDate', () => {
  const photos = [
    { relPath: 'a.arw', dateTaken: '2026-08-01T10:00:00' },
    { relPath: 'b.arw', dateTaken: '2026-08-01T15:00:00' },
    { relPath: 'c.arw', dateTaken: '2026-07-31T09:00:00' },
  ];

  test('groups into Month -> Day -> photos, newest first by default', () => {
    const months = groupByDate(photos, 'newest');
    expect(months).toHaveLength(2); // August, July
    expect(months[0].key).toBe('2026-08');
    expect(months[0].days).toHaveLength(1); // both August photos share a day
    expect(months[0].days[0].photos).toHaveLength(2);
    expect(months[1].key).toBe('2026-07');
  });

  test('honors oldest-first sort order', () => {
    const months = groupByDate(photos, 'oldest');
    expect(months[0].key).toBe('2026-07');
    expect(months[1].key).toBe('2026-08');
  });
});
