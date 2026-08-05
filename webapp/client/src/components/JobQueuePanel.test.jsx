import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import JobQueuePanel from './JobQueuePanel';
import * as api from '../api';

vi.mock('../api', () => ({
  listJobs: vi.fn(),
  cancelJob: vi.fn(),
  reorderJobs: vi.fn(),
  pauseJob: vi.fn(),
  requeueJob: vi.fn(),
}));

// JobQueuePanel uses <Hint>, which renders a Radix Tooltip - needs a Provider ancestor.
function renderPanel(props) {
  return render(<Tooltip.Provider><JobQueuePanel {...props} /></Tooltip.Provider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JobQueuePanel', () => {
  test('shows "No jobs yet." when the queue is empty', async () => {
    api.listJobs.mockResolvedValue({ jobs: [] });
    renderPanel();
    expect(await screen.findByText('No jobs yet.')).toBeInTheDocument();
  });

  test('renders queued/running/done jobs with their status and a progress bar for the running one', async () => {
    api.listJobs.mockResolvedValue({
      jobs: [
        {
          id: 'run-2', type: 'run', status: 'queued', etaMs: 125000,
          meta: { projectName: 'Second Batch', photoCount: 4, preset: 'teal_orange' },
        },
        {
          id: 'run-1', type: 'run', status: 'running', etaMs: 30000,
          meta: { projectName: 'First Batch', photoCount: 10, preset: 'none' },
          progress: { items: [{ status: 'done' }, { status: 'done' }, { status: 'pending' }, { status: 'pending' }] },
        },
        {
          id: 'preview-1', type: 'preview', status: 'done',
          meta: { photo: 'DSC001.ARW' },
        },
      ],
    });

    renderPanel();

    expect(await screen.findByText('Second Batch')).toBeInTheDocument();
    expect(screen.getByText('First Batch')).toBeInTheDocument();
    expect(screen.getByText('Preview: DSC001.ARW')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('2 active')).toBeInTheDocument();
    expect(screen.getByText('~2m 5s remaining')).toBeInTheDocument(); // queued job's etaMs
    expect(screen.getByText('~30s remaining')).toBeInTheDocument(); // running job's etaMs
  });

  test('shows "estimating…" for a job with no eta yet, instead of a blank or wrong number', async () => {
    api.listJobs.mockResolvedValue({
      jobs: [{
        id: 'run-1', type: 'run', status: 'queued', etaMs: null, meta: { projectName: 'Brand New' },
      }],
    });
    renderPanel();
    expect(await screen.findByText('estimating…')).toBeInTheDocument();
  });

  test('Cancel calls the API for that job and refreshes the list', async () => {
    const user = userEvent.setup();
    api.listJobs
      .mockResolvedValueOnce({
        jobs: [{ id: 'run-1', type: 'run', status: 'queued', meta: { projectName: 'A Batch' } }],
      })
      .mockResolvedValue({ jobs: [] });
    api.cancelJob.mockResolvedValue({ ok: true });

    renderPanel();
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);

    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(screen.getByText('No jobs yet.')).toBeInTheDocument());
  });

  test('"Up next" lists queued batch runs sorted by queuePosition, not by list order', async () => {
    api.listJobs.mockResolvedValue({
      jobs: [
        {
          id: 'run-b', type: 'run', status: 'queued', queuePosition: 1, meta: { projectName: 'Second in line' },
        },
        {
          id: 'run-a', type: 'run', status: 'queued', queuePosition: 0, meta: { projectName: 'Next up' },
        },
      ],
    });
    renderPanel();

    expect(await screen.findByText('Up next')).toBeInTheDocument();
    const items = await screen.findAllByText(/Next up|Second in line/);
    expect(items.map((el) => el.textContent)).toEqual(['Next up', 'Second in line']);
  });

  test('queued preview jobs render under "Queued previews", separate from batch runs, without a drag handle', async () => {
    api.listJobs.mockResolvedValue({
      jobs: [{
        id: 'preview-1', type: 'preview', status: 'queued', queuePosition: 0, meta: { photo: 'DSC002.ARW' },
      }],
    });
    renderPanel();

    expect(await screen.findByText('Queued previews')).toBeInTheDocument();
    expect(screen.queryByText('Up next')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Drag to reorder')).not.toBeInTheDocument();
  });

  test('a queued job in "Up next" shows a Pause button, which calls the API and refreshes', async () => {
    const user = userEvent.setup();
    api.listJobs
      .mockResolvedValueOnce({
        jobs: [{
          id: 'run-1', type: 'run', status: 'queued', queuePosition: 0, meta: { projectName: 'A Batch' },
        }],
      })
      .mockResolvedValue({
        jobs: [{
          id: 'run-1', type: 'run', status: 'paused', queuePosition: 0, meta: { projectName: 'A Batch' },
        }],
      });
    api.pauseJob.mockResolvedValue({ ok: true });

    renderPanel();
    const pauseBtn = await screen.findByRole('button', { name: 'Pause' });
    await user.click(pauseBtn);

    await waitFor(() => expect(api.pauseJob).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Re-queue' })).toBeInTheDocument();
  });

  test('a paused job shows Re-queue instead of Pause, and stays visible in "Up next"', async () => {
    api.listJobs.mockResolvedValue({
      jobs: [{
        id: 'run-1', type: 'run', status: 'paused', queuePosition: 0, meta: { projectName: 'Held Batch' },
      }],
    });
    renderPanel();

    expect(await screen.findByText('Up next')).toBeInTheDocument();
    expect(await screen.findByText('Held Batch')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-queue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    // A paused job can still be cancelled outright, not just re-queued.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  test('clicking Re-queue calls the API and refreshes', async () => {
    const user = userEvent.setup();
    api.listJobs
      .mockResolvedValueOnce({
        jobs: [{
          id: 'run-1', type: 'run', status: 'paused', queuePosition: 0, meta: { projectName: 'Held Batch' },
        }],
      })
      .mockResolvedValue({
        jobs: [{
          id: 'run-1', type: 'run', status: 'queued', queuePosition: 0, meta: { projectName: 'Held Batch' },
        }],
      });
    api.requeueJob.mockResolvedValue({ ok: true });

    renderPanel();
    const requeueBtn = await screen.findByRole('button', { name: 'Re-queue' });
    await user.click(requeueBtn);

    await waitFor(() => expect(api.requeueJob).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  test('a terminal job with an error message shows it', async () => {
    api.listJobs.mockResolvedValue({
      jobs: [{
        id: 'run-1', type: 'run', status: 'error', error: 'RawTherapee exited with code 1', meta: {},
      }],
    });
    renderPanel();
    expect(await screen.findByText('RawTherapee exited with code 1')).toBeInTheDocument();
  });

  test('shows a toast when a job transitions from running to done between polls, but not on the very first poll', async () => {
    api.listJobs
      .mockResolvedValueOnce({
        jobs: [{
          id: 'run-1', type: 'run', status: 'running', meta: { projectName: 'Batch A' },
        }],
      })
      .mockResolvedValueOnce({
        jobs: [{
          id: 'run-1',
          type: 'run',
          status: 'done',
          meta: { projectName: 'Batch A' },
          result: { processed: 1, skipped: 0, failed: 0 },
        }],
      });

    renderPanel();
    await screen.findByText('Batch A');
    expect(screen.queryByText(/Batch A: Done/)).not.toBeInTheDocument();

    // Real wait for the panel's own poll interval (1500ms) to fire a second time, rather than
    // fake timers - JobQueuePanel's poll loop and RTL's async queries both rely on real
    // setTimeout, and mixing that with faked timers is fragile in practice.
    expect(await screen.findByText(/Batch A: Done/, {}, { timeout: 3000 })).toBeInTheDocument();
  }, 5000);
});
