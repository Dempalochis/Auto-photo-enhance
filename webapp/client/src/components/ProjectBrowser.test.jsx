import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import ProjectBrowser from './ProjectBrowser';
import * as api from '../api';

vi.mock('../api', () => ({
  getProjects: vi.fn(),
}));

function renderBrowser() {
  return render(<Tooltip.Provider><ProjectBrowser /></Tooltip.Provider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProjectBrowser', () => {
  test('shows an empty state when there are no past projects', async () => {
    api.getProjects.mockResolvedValue({ projects: [] });
    renderBrowser();
    expect(await screen.findByText('No past projects yet - run a batch to see it here.')).toBeInTheDocument();
  });

  test('lists each project with its name, date, file count, and size', async () => {
    api.getProjects.mockResolvedValue({
      projects: [
        {
          folderName: 'Summer Wedding_2026-08-05', projectName: 'Summer Wedding', date: '2026-08-05', fileCount: 42, totalBytes: 300 * 1024 * 1024,
        },
      ],
    });
    renderBrowser();

    expect(await screen.findByText('Summer Wedding')).toBeInTheDocument();
    expect(screen.getByText('2026-08-05')).toBeInTheDocument();
    expect(screen.getByText('42 files · 300.0 MB')).toBeInTheDocument();
  });

  test('a folder with no parseable date shows an em dash instead of "null"', async () => {
    api.getProjects.mockResolvedValue({
      projects: [{
        folderName: 'weird_folder', projectName: 'weird_folder', date: null, fileCount: 1, totalBytes: 1024,
      }],
    });
    renderBrowser();
    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  test('shows an API error instead of silently rendering nothing', async () => {
    api.getProjects.mockRejectedValue(new Error('cannot read projects directory'));
    renderBrowser();
    expect(await screen.findByText('cannot read projects directory')).toBeInTheDocument();
  });

  test('clicking Refresh re-fetches the project list', async () => {
    const user = userEvent.setup();
    api.getProjects
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({
        projects: [{
          folderName: 'New Shoot_2026-08-05', projectName: 'New Shoot', date: '2026-08-05', fileCount: 3, totalBytes: 1024,
        }],
      });

    renderBrowser();
    await screen.findByText('No past projects yet - run a batch to see it here.');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('New Shoot')).toBeInTheDocument();
    await waitFor(() => expect(api.getProjects).toHaveBeenCalledTimes(2));
  });
});
