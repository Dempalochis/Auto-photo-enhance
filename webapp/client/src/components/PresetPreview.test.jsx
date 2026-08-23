import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PresetPreview from './PresetPreview';
import { CATEGORIES } from '../presetCategories';

const ALL_PRESETS = CATEGORIES.flatMap((c) => c.presets);

describe('PresetPreview', () => {
  test('renders every known preset as a selectable tile even with no previewPhoto/job at all', () => {
    render(
      <PresetPreview
        previewPhoto={null}
        job={null}
        presetNames={ALL_PRESETS}
        selectedPreset="none"
        onSelectPreset={() => {}}
      />,
    );
    expect(screen.getByText('None (color correction only)')).toBeInTheDocument();
    ALL_PRESETS.forEach((name) => expect(screen.getByText(name)).toBeInTheDocument());
  });

  test('a tile can be selected before any preview has ever been rendered', async () => {
    const onSelectPreset = vi.fn();
    const user = userEvent.setup();
    render(
      <PresetPreview
        previewPhoto={null}
        job={null}
        presetNames={ALL_PRESETS}
        selectedPreset="none"
        onSelectPreset={onSelectPreset}
      />,
    );
    await user.click(screen.getByText('golden_hour'));
    expect(onSelectPreset).toHaveBeenCalledWith('golden_hour');
  });

  test('shows a rendered thumbnail for a preset the active job has finished', () => {
    const job = {
      progress: {
        items: [
          { label: '00_base_only', status: 'done', url: '/base.jpg' },
          { label: 'golden_hour', status: 'done', url: '/golden_hour.jpg' },
        ],
      },
    };
    render(
      <PresetPreview
        previewPhoto="DSC00001.ARW"
        job={job}
        presetNames={ALL_PRESETS}
        selectedPreset="none"
        onSelectPreset={() => {}}
      />,
    );
    expect(screen.getByAltText('golden_hour')).toHaveAttribute('src', '/golden_hour.jpg');
    // A preset the job hasn't gotten to yet still renders as a tile, just without an image.
    expect(screen.getByText('teal_orange')).toBeInTheDocument();
    expect(screen.queryByAltText('teal_orange')).not.toBeInTheDocument();
  });

  test('the grid stays populated (not blank) while a freshly-started job has no progress yet', () => {
    // useJob resets to `job: null` immediately when a new preview job id is set, before the first
    // poll resolves - the grid must fall back to placeholder tiles for every preset instead of
    // disappearing during that window.
    render(
      <PresetPreview
        previewPhoto="DSC00002.ARW"
        job={null}
        presetNames={ALL_PRESETS}
        selectedPreset="none"
        onSelectPreset={() => {}}
      />,
    );
    expect(screen.getByText('None (color correction only)')).toBeInTheDocument();
    expect(screen.getByText('golden_hour')).toBeInTheDocument();
  });
});
