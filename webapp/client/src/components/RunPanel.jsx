import { useEffect, useState } from 'react';
import { getOutputStatus } from '../api';
import Hint from './Hint';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function sanitize(name) {
  const cleaned = (name || '').trim().replace(/[<>:"/\\|?*]/g, '_');
  return cleaned.length > 0 ? cleaned : 'project';
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

export default function RunPanel({
  projectName, onProjectNameChange, selectedPhotos, selectedPreset, onRun, canRun, runStarting,
}) {
  const folderName = `${sanitize(projectName)}_${todayStr()}`;
  const totalSize = selectedPhotos.reduce((sum, p) => sum + p.size, 0);

  const [outputStatus, setOutputStatus] = useState(null);
  const [justQueued, setJustQueued] = useState(false);
  const [spaceWarning, setSpaceWarning] = useState(null);
  useEffect(() => {
    const check = () => getOutputStatus(projectName).then(setOutputStatus).catch(() => setOutputStatus(null));
    const debounce = setTimeout(check, 400);
    // Runs now happen in the background (see JobQueuePanel), so this can't just re-check once
    // right after a run finishes the way it used to when RunPanel tracked a single job directly -
    // poll instead, so "this folder already has files" catches up once a background run lands.
    const interval = setInterval(check, 4000);
    return () => { clearTimeout(debounce); clearInterval(interval); };
  }, [projectName]);
  const outputHasFiles = outputStatus?.exists && outputStatus.fileCount > 0 && outputStatus.folderName === folderName;

  // Run always queues a new job instead of disabling while a previous one runs - progress and
  // history for every queued job live in the JobQueuePanel below, not here. This is just a
  // brief local confirmation that the click landed.
  const handleRun = async () => {
    try {
      const result = await onRun();
      setJustQueued(true);
      setSpaceWarning(result?.spaceWarning || null);
      setTimeout(() => setJustQueued(false), 3000);
    } catch {
      // App.jsx already surfaces the error via the top-level loadError banner.
    }
  };

  return (
    <div>
      <h2 className="text-sm font-semibold mb-3">3. Run</h2>

      <label className="field-label block mb-1">
        <Hint text="Today's date is appended automatically, so running the same project name again later creates a fresh, separate folder rather than overwriting.">Project name</Hint>
      </label>
      <input
        type="text"
        value={projectName}
        onChange={(e) => onProjectNameChange(e.target.value)}
        placeholder="e.g. Summer Wedding"
        className="w-full text-sm px-3 py-2 mb-1"
      />
      <div className="mb-4">
        <p className="timestamp">
          Output folder: <span className="text-[var(--text-dim)]">projects/{folderName}/</span>
        </p>
        {outputHasFiles && (
          <p className="text-xs text-[var(--amber)] mt-1">
            Heads up: this folder already has {outputStatus.fileCount} item{outputStatus.fileCount === 1 ? '' : 's'} in it from a previous run. Already-converted photos will be skipped, not overwritten.
          </p>
        )}
      </div>

      <div className="panel px-3 py-2.5 mb-4 space-y-1">
        <p className="text-sm">
          <span className="stat-number text-base">{selectedPhotos.length}</span>{' '}
          photo{selectedPhotos.length === 1 ? '' : 's'} selected
          {selectedPhotos.length > 0 && <span className="text-[var(--text-dim)]"> · {formatSize(totalSize)}</span>}
        </p>
        <p className="text-sm text-[var(--text-dim)]">
          Preset: <span className="text-[var(--text)]">{selectedPreset === 'none' ? 'none (color correction only)' : selectedPreset || '—'}</span>
        </p>
      </div>

      <button
        type="button"
        disabled={!canRun || runStarting}
        onClick={handleRun}
        className="btn-primary w-full py-2.5 text-sm"
      >
        {runStarting ? 'Queuing…' : 'Run'}
      </button>

      {justQueued && (
        <p className="text-xs text-[var(--cat-nature)] mt-2">
          Queued — see Job queue below for progress.
        </p>
      )}
      {justQueued && spaceWarning && (
        <p className="text-xs text-[var(--amber)] mt-2">{spaceWarning}</p>
      )}
    </div>
  );
}
