import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import SceneActions, { nextSceneId, splitPointFor, movableInto } from './SceneActions';
import * as api from '../api';

vi.mock('../api', () => ({
  renameScene: vi.fn().mockResolvedValue({ scenes: [] }),
  mergeScenes: vi.fn().mockResolvedValue({ scenes: [] }),
  splitScene: vi.fn().mockResolvedValue({ scenes: [] }),
  moveToScene: vi.fn().mockResolvedValue({ scenes: [] }),
}));

const scenes = [
  { id: 'b', name: 'B', photos: ['b1'], start: '2026-01-01T11:00:00' },
  { id: 'a', name: 'A', photos: ['a1', 'a2', 'a3'], start: '2026-01-01T10:00:00' },
];

test('pure helpers', () => {
  expect(nextSceneId(scenes, 'a')).toBe('b');
  expect(nextSceneId(scenes, 'b')).toBe(null);
  // newest first (picker default): the scene below is the previous one in time
  expect(nextSceneId(scenes, 'b', 'newest')).toBe('a');
  expect(nextSceneId(scenes, 'a', 'newest')).toBe(null);
  expect(splitPointFor(scenes[1], new Set(['a1', 'a2']))).toBe('a2');
  expect(splitPointFor(scenes[1], new Set(['a3']))).toBe(null);
  expect(splitPointFor(scenes[1], new Set(['x']))).toBe(null);
  expect(movableInto(scenes[1], new Set(['a1', 'b1']))).toEqual(['b1']);
});

describe('SceneActions', () => {
  const renderIt = (selected) => {
    const onChanged = vi.fn();
    render(<Tooltip.Provider><SceneActions group={{ key: 'a', scene: scenes[1] }} scenes={scenes} selected={selected} onChanged={onChanged} /></Tooltip.Provider>);
    return onChanged;
  };

  test('merge with the next scene, split after the selection, move the selection here', async () => {
    const user = userEvent.setup();
    renderIt(new Set(['a1', 'b1']));
    await user.click(screen.getByRole('button', { name: 'Merge ↓' }));
    expect(api.mergeScenes).toHaveBeenCalledWith(['a', 'b']);
    await user.click(screen.getByRole('button', { name: 'Split' }));
    expect(api.splitScene).toHaveBeenCalledWith('a', 'a1');
    await user.click(screen.getByRole('button', { name: 'Move 1 here' }));
    expect(api.moveToScene).toHaveBeenCalledWith(['b1'], 'a');
  });

  test('rename via the inline form', async () => {
    const user = userEvent.setup();
    renderIt(new Set());
    expect(screen.getByRole('button', { name: 'Split' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Scene name');
    await user.clear(input);
    await user.type(input, 'Harbour');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.renameScene).toHaveBeenCalledWith('a', 'Harbour');
  });
});
