import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { browseFolders } from '../api';
import Hint from './Hint';

function BrowseModal({ open, onOpenChange, onSelect, startPath }) {
  const [current, setCurrent] = useState(null);
  const [error, setError] = useState(null);

  const load = (path) => {
    setError(null);
    browseFolders(path).then(setCurrent).catch((err) => setError(err.message));
  };

  useEffect(() => {
    if (open) load(startPath || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] max-w-[90vw] max-h-[70vh] flex flex-col panel p-4 z-50">
          <Dialog.Title className="text-sm font-semibold mb-1">Browse for folder</Dialog.Title>
          <div className="flex items-center justify-between mb-3 gap-2">
            <p className="timestamp break-all">{current?.path || 'Drives'}</p>
            {current?.path && (
              <button
                type="button"
                onClick={() => load('')}
                className="btn-secondary shrink-0 text-[11px] px-2 py-1"
              >
                Drives
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 mb-3">
            {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
            {current?.parent !== null && current?.parent !== undefined && (
              <button
                type="button"
                onClick={() => load(current.parent)}
                className="btn-secondary w-full text-left text-xs px-2.5 py-1.5"
              >
                .. (up)
              </button>
            )}
            {current?.folders.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => load(f.path)}
                className="btn-secondary w-full text-left text-xs px-2.5 py-1.5 truncate"
              >
                {f.name}
              </button>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="btn-secondary text-xs px-3 py-1.5">Cancel</button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!current?.path}
              onClick={() => onSelect(current.path)}
              className="btn-primary text-xs px-3 py-1.5"
            >
              Use this folder
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function SourceFolderPicker({
  currentPath, history, photoCount, onChangeFolder, error,
}) {
  const [inputValue, setInputValue] = useState(currentPath || '');
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => { setInputValue(currentPath || ''); }, [currentPath]);

  const submitPath = (path) => {
    if (path && path !== currentPath) onChangeFolder(path);
  };

  // Recent folders other than the one currently active - re-picking the active one is a no-op
  // (submitPath already skips it), so there's nothing useful to show for it here.
  const recentOthers = (history || []).filter((p) => p !== currentPath);

  return (
    <div className="panel p-3 mb-4">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label className="field-label block mb-1">
            <Hint text="Absolute folder path on this machine. A browser can't show a native file picker with real paths, so paste one here or use Browse.">
              Source folder
            </Hint>
          </label>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitPath(inputValue.trim()); }}
            placeholder="C:\Users\you\Pictures\Shoot"
            className="w-full text-sm px-2.5 py-1.5"
          />
        </div>
        <button type="button" className="btn-secondary text-xs px-2.5 py-1.5" onClick={() => submitPath(inputValue.trim())}>
          Use this folder
        </button>
        <button type="button" className="btn-secondary text-xs px-2.5 py-1.5" onClick={() => setBrowseOpen(true)}>
          Browse…
        </button>
      </div>
      <p className="timestamp mt-2">
        {photoCount} photo{photoCount === 1 ? '' : 's'} found in <span className="text-[var(--text-dim)]">{currentPath}</span>
      </p>
      {error && <p className="text-xs text-[var(--danger)] mt-1">{error}</p>}

      {recentOthers.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          <span className="field-label">Recent:</span>
          {recentOthers.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => submitPath(p)}
              title={p}
              className="btn-secondary text-[11px] px-2 py-1 max-w-[220px] truncate"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <BrowseModal
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        startPath={currentPath}
        onSelect={(path) => { setBrowseOpen(false); submitPath(path); }}
      />
    </div>
  );
}
