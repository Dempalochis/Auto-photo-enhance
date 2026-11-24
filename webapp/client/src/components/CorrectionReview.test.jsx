import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import CorrectionReview from './CorrectionReview';
import * as api from '../api';

const plan = {
  scene: 'landscape', lighting: 'overcast', issues: ['flat'], notes: 'a bit flat',
  adjustments: { exposure: 0, highlights: 0, shadows: 1, contrast: 0, clarity: 1, dehaze: 0, saturation: 0, warmth: 0, tint: 0 },
};

vi.mock('../api', () => ({
  getCorrection: vi.fn(),
  saveCorrection: vi.fn(),
  resetCorrection: vi.fn().mockResolvedValue({ ok: true }),
  renderCorrections: vi.fn().mockResolvedValue({ jobId: 'r1' }),
  startAnalyze: vi.fn().mockResolvedValue({ jobId: 'j1' }),
  getJob: vi.fn().mockResolvedValue({ status: 'running', progress: { items: [] } }),
}));

const llm = { enabled: true, status: 'reachable', model: 'qwen3.5:9b' };
const renderIt = (props) => render(<Tooltip.Provider><CorrectionReview {...props} /></Tooltip.Provider>);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCorrection.mockImplementation(async (p) => ({
    path: p, plan, summary: 'sh+1 cla+1', source: 'cache', beforeUrl: '/b.jpg', afterUrl: '/a.jpg',
  }));
  api.saveCorrection.mockImplementation(async (p, adjustments) => ({ path: p, plan: { ...plan, adjustments }, source: 'edit' }));
});

describe('CorrectionReview', () => {
  test('renders nothing without a usable LLM', () => {
    const { container } = renderIt({ selectedPhotos: [{ relPath: 'a.ARW' }], llm: { enabled: false } });
    expect(container).toBeEmptyDOMElement();
  });

  test('shows existing plans with before/after images and analyses the selection', async () => {
    const user = userEvent.setup();
    renderIt({ selectedPhotos: [{ relPath: 'a.ARW' }], llm });
    expect(await screen.findByAltText('after a.ARW')).toHaveAttribute('src', '/a.jpg');
    expect(screen.getByText('Shadows +1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Analyze 1 selected/ }));
    expect(api.startAnalyze).toHaveBeenCalledWith(['a.ARW'], {});
  });

  test('a photo without a plan shows "Not analysed yet"', async () => {
    api.getCorrection.mockResolvedValueOnce({ path: 'n.ARW', plan: null, source: null });
    renderIt({ selectedPhotos: [{ relPath: 'n.ARW' }], llm });
    expect(await screen.findByText('Not analysed yet.')).toBeInTheDocument();
  });

  test('a + click saves the edited plan and re-renders the after image', async () => {
    const user = userEvent.setup();
    renderIt({ selectedPhotos: [{ relPath: 'a.ARW' }], llm });
    await screen.findByText('Clarity +1');
    await user.click(screen.getByRole('button', { name: 'Exposure plus' }));
    await waitFor(() => expect(api.saveCorrection).toHaveBeenCalledWith('a.ARW', expect.objectContaining({ exposure: 1, clarity: 1, shadows: 1 })));
    await waitFor(() => expect(api.renderCorrections).toHaveBeenCalledWith(['a.ARW']));
  });
});
