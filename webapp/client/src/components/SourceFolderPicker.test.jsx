import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import SourceFolderPicker from './SourceFolderPicker';

vi.mock('../api', () => ({
  browseFolders: vi.fn().mockResolvedValue({ path: '', parent: null, folders: [] }),
}));

function renderPicker(props) {
  return render(<Tooltip.Provider><SourceFolderPicker {...props} /></Tooltip.Provider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SourceFolderPicker recent-folder history', () => {
  test('shows no "Recent" row when there is no history', () => {
    renderPicker({
      currentPath: 'C:\\Photos\\Current', history: [], photoCount: 0, onChangeFolder: vi.fn(),
    });
    expect(screen.queryByText('Recent:')).not.toBeInTheDocument();
  });

  test('lists recent folders other than the current one', () => {
    renderPicker({
      currentPath: 'C:\\Photos\\Current',
      history: ['C:\\Photos\\Current', 'C:\\Photos\\Old1', 'C:\\Photos\\Old2'],
      photoCount: 0,
      onChangeFolder: vi.fn(),
    });
    expect(screen.getByText('Recent:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'C:\\Photos\\Old1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'C:\\Photos\\Old2' })).toBeInTheDocument();
    // The current folder isn't useful to re-select, so it's excluded from the recent list.
    expect(screen.queryByRole('button', { name: 'C:\\Photos\\Current' })).not.toBeInTheDocument();
  });

  test('clicking a recent folder calls onChangeFolder with that path', async () => {
    const user = userEvent.setup();
    const onChangeFolder = vi.fn();
    renderPicker({
      currentPath: 'C:\\Photos\\Current',
      history: ['C:\\Photos\\Current', 'C:\\Photos\\Old1'],
      photoCount: 0,
      onChangeFolder,
    });

    await user.click(screen.getByRole('button', { name: 'C:\\Photos\\Old1' }));
    expect(onChangeFolder).toHaveBeenCalledWith('C:\\Photos\\Old1');
  });
});
