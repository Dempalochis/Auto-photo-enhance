import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import RunPanel from './RunPanel';

vi.mock('../api', () => ({
  getOutputStatus: vi.fn().mockResolvedValue({ exists: false, fileCount: 0, folderName: '' }),
}));

// RunPanel uses <Hint>, which renders a Radix Tooltip - needs a Provider ancestor.
function renderRunPanel(props) {
  return render(<Tooltip.Provider><RunPanel {...props} /></Tooltip.Provider>);
}

const baseProps = {
  projectName: 'Test Project',
  onProjectNameChange: () => {},
  selectedPhotos: [{ relPath: 'a.arw', size: 1000 }],
  selectedPreset: 'none',
  canRun: true,
  runStarting: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RunPanel', () => {
  test('Run is enabled whenever canRun is true and no request is in flight - there is no "previous job still running" gate anymore', () => {
    renderRunPanel({ ...baseProps, onRun: vi.fn() });
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  test('Run is disabled when nothing is selected', () => {
    renderRunPanel({
      ...baseProps, canRun: false, onRun: vi.fn(),
    });
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  test('Run is disabled only while its own enqueue request is in flight', () => {
    renderRunPanel({
      ...baseProps, runStarting: true, onRun: vi.fn(),
    });
    expect(screen.getByRole('button', { name: 'Queuing…' })).toBeDisabled();
  });

  test('clicking Run calls onRun and shows a brief queued confirmation', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockResolvedValue(undefined);
    renderRunPanel({ ...baseProps, onRun });

    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Queued/)).toBeInTheDocument();
  });

  test('Run can be clicked again right after a previous queue succeeded - queuing a second batch is not blocked', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockResolvedValue(undefined);
    renderRunPanel({ ...baseProps, onRun });

    const button = screen.getByRole('button', { name: 'Run' });
    await user.click(button);
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(button).toBeEnabled();

    await user.click(button);
    expect(onRun).toHaveBeenCalledTimes(2);
  });

  test('shows a disk-space warning returned by onRun alongside the queued confirmation', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockResolvedValue({ spaceWarning: 'Low disk space: about 2.0 GB free.' });
    renderRunPanel({ ...baseProps, onRun });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/Low disk space/)).toBeInTheDocument();
  });

  test('shows no disk-space warning when onRun does not return one', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockResolvedValue({});
    renderRunPanel({ ...baseProps, onRun });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByText(/Queued/);
    expect(screen.queryByText(/disk space/i)).not.toBeInTheDocument();
  });

  test('a failed enqueue does not show the queued confirmation', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockRejectedValue(new Error('boom'));
    renderRunPanel({ ...baseProps, onRun });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Queued/)).not.toBeInTheDocument();
  });
});

describe('RunPanel - Version 2 AI correction', () => {
  const llmOk = { enabled: true, status: 'reachable', model: 'qwen3.5:9b', detail: 'ok' };

  test('no AI controls without an enabled, reachable LLM (Version 1 panel)', () => {
    renderRunPanel({ ...baseProps, onRun: vi.fn() });
    expect(screen.queryByText('AI-guided correction')).not.toBeInTheDocument();
    renderRunPanel({ ...baseProps, onRun: vi.fn(), llm: { enabled: false, status: 'disabled' } });
    expect(screen.queryByText('AI-guided correction')).not.toBeInTheDocument();
  });

  test('an enabled but unreachable LLM shows why, without the toggle', () => {
    renderRunPanel({ ...baseProps, onRun: vi.fn(), llm: { enabled: true, status: 'unreachable', detail: 'cannot reach Ollama' } });
    expect(screen.getByText(/AI correction unavailable: cannot reach Ollama/)).toBeInTheDocument();
    expect(screen.queryByText('AI-guided correction')).not.toBeInTheDocument();
  });

  test('toggle and strength dial call back; the dial only shows when the toggle is on', async () => {
    const user = userEvent.setup();
    const onAiCorrectionChange = vi.fn();
    const onAiStrengthChange = vi.fn();
    const { rerender } = renderRunPanel({
      ...baseProps, onRun: vi.fn(), llm: llmOk, aiCorrection: false, onAiCorrectionChange, onAiStrengthChange,
    });
    expect(screen.queryByRole('group', { name: 'AI strength' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    expect(onAiCorrectionChange).toHaveBeenCalledWith(true);
    rerender(<Tooltip.Provider><RunPanel {...baseProps} onRun={vi.fn()} llm={llmOk} aiCorrection aiStrength="normal" onAiCorrectionChange={onAiCorrectionChange} onAiStrengthChange={onAiStrengthChange} /></Tooltip.Provider>);
    await user.click(screen.getByRole('button', { name: 'Punchy' }));
    expect(onAiStrengthChange).toHaveBeenCalledWith('punchy');
    expect(screen.getByText(/name_ai\.jpg/)).toBeInTheDocument();
  });
});
