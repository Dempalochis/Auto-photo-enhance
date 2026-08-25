import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import PhotoPicker from './PhotoPicker';

function makePhoto(i, { day = '15', month = '08' } = {}) {
  return {
    relPath: `DSC${String(i).padStart(5, '0')}.ARW`,
    name: `DSC${String(i).padStart(5, '0')}.ARW`,
    dateTaken: `2026-${month}-${day}T10:00:00`,
    size: 47 * 1024 * 1024,
  };
}

function renderPicker(photos, overrides = {}) {
  const props = {
    photos,
    loading: false,
    selected: new Set(),
    onToggle: vi.fn(),
    onSelectMany: vi.fn(),
    onPreview: vi.fn(),
    previewPhoto: null,
    previewStarting: false,
    ...overrides,
  };
  // PhotoPicker's day/month headers and a few controls use Hint (a Radix Tooltip wrapper) which
  // needs a Tooltip.Provider ancestor - normally supplied once by App.jsx at the root.
  render(<Tooltip.Provider><PhotoPicker {...props} /></Tooltip.Provider>);
  return props;
}

describe('PhotoPicker', () => {
  test('shows a loading state and no photos while loading', () => {
    renderPicker([], { loading: true });
    expect(screen.getByRole('status', { name: 'Loading photos' })).toBeInTheDocument();
  });

  test('shows an empty-state message when nothing matches', () => {
    renderPicker([]);
    expect(screen.getByText('No photos match the current filters.')).toBeInTheDocument();
  });

  test('renders month/day headers and photo filenames for a small set', () => {
    const photos = [makePhoto(1), makePhoto(2)];
    renderPicker(photos);
    expect(screen.getByText('DSC00001.ARW')).toBeInTheDocument();
    expect(screen.getByText('DSC00002.ARW')).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument(); // month header
  });

  test('search narrows the visible photos by filename', async () => {
    const user = userEvent.setup();
    const photos = [makePhoto(1), makePhoto(2)];
    renderPicker(photos);
    // The "Search filename" <label> isn't id/htmlFor-associated with its <input> (pre-existing,
    // unrelated to this change) - querying by placeholder instead of label text.
    await user.type(screen.getByPlaceholderText('DSC00600…'), '00002');
    expect(screen.queryByText('DSC00001.ARW')).not.toBeInTheDocument();
    expect(screen.getByText('DSC00002.ARW')).toBeInTheDocument();
  });

  test('Select all calls onSelectMany with every currently-filtered photo', async () => {
    const user = userEvent.setup();
    const photos = [makePhoto(1), makePhoto(2), makePhoto(3)];
    const { onSelectMany } = renderPicker(photos);
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onSelectMany).toHaveBeenCalledWith(
      expect.arrayContaining(['DSC00001.ARW', 'DSC00002.ARW', 'DSC00003.ARW']),
      true,
    );
  });

  test('Clear selection appears only once something is selected, and clears exactly what is selected', async () => {
    const user = userEvent.setup();
    const photos = [makePhoto(1), makePhoto(2)];
    expect(renderPickerHasNoClearButton(photos)).toBe(true);

    const { onSelectMany } = renderPicker(photos, { selected: new Set(['DSC00001.ARW']) });
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onSelectMany).toHaveBeenCalledWith(['DSC00001.ARW'], false);
  });

  function renderPickerHasNoClearButton(photos) {
    renderPicker(photos);
    const hasClear = screen.queryByRole('button', { name: 'Clear selection' }) !== null;
    return !hasClear;
  }

  // The actual regression test for the V8 Phase 1 scale finding: before virtualization, every
  // photo mounted as a real DOM node (confirmed live: 3000 photos -> 3000 <img> tags, ~3s freeze
  // on any selection change). With virtualization, only a small window around the visible range
  // should ever be mounted, regardless of how many photos are passed in.
  test('does not mount every photo as a DOM node for a large photo set (virtualization)', { timeout: 15000 }, () => {
    // jsdom has no real layout engine (offsetTop/getBoundingClientRect always report 0) and
    // doesn't implement window.scrollTo (harmless "not implemented" console noise from the
    // virtualizer's internal scroll-restoration logic), so this is a smoke test bounded to a
    // moderate photo count to stay fast under jsdom - the real ~3s-freeze-to-instant fix at
    // actual scale (3000 real photos) was verified live in a real browser, see V8_PLAN.md.
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    try {
      const photos = Array.from({ length: 150 }, (_, i) => makePhoto(i, { day: String(1 + (i % 28)).padStart(2, '0') }));
      renderPicker(photos);
      const mountedImages = document.querySelectorAll('img').length;
      expect(mountedImages).toBeGreaterThan(0);
      expect(mountedImages).toBeLessThan(150); // proves windowing is active at all, not a tight bound
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });

  test('a per-day Select day button selects only that day\'s photos', async () => {
    const user = userEvent.setup();
    const photos = [makePhoto(1, { day: '10' }), makePhoto(2, { day: '20' })];
    const { onSelectMany } = renderPicker(photos);
    const dayButtons = screen.getAllByRole('button', { name: 'Select day' });
    await user.click(dayButtons[0]);
    expect(onSelectMany).toHaveBeenCalledWith(expect.arrayContaining([expect.any(String)]), true);
    expect(onSelectMany.mock.calls[0][0]).toHaveLength(1); // exactly one day's worth
  });
});
