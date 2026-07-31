import { useEffect, useState } from 'react';
import * as Progress from '@radix-ui/react-progress';
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
  projectName, onProjectNameChange, selectedPhotos, selectedPreset, job, onRun, canRun,
}) {
  const folderName = `${sanitize(projectName)}_${todayStr()}`;
  const running = job && (job.status === 'queued' || job.status === 'running');
  const items = job?.progress?.items || [];
  const doneCount = items.filter((i) => i.status === 'done' || i.status === 'failed').length;
  const pct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;
  const totalSize = selectedPhotos.reduce((sum, p) => sum + p.size, 0);

  const [outputStatus, setOutputStatus] = useState(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      getOutputStatus(projectName).then(setOutputStatus).catch(() => setOutputStatus(null));
    }, 400);
    return () => clearTimeout(timer);
    // re-check right after a run finishes too, since it changes what's in the folder
  }, [projectName, job?.status]);
  const outputHasFiles = outputStatus?.exists && outputStatus.fileCount > 0 && outputStatus.folderName === folderName;

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
        disabled={!canRun || running}
        onClick={onRun}
        className="btn-primary w-full py-2.5 text-sm"
      >
        {running ? 'Running…' : 'Run'}
      </button>

      {job && (
        <div className="mt-4">
          {running && (
            <>
              <Progress.Root value={pct} className="h-2 rounded-[3px] bg-[var(--panel-raised)] overflow-hidden">
                <Progress.Indicator
                  className="h-full bg-[var(--amber)] transition-all"
                  style={{ width: `${pct}%` }}
                />
              </Progress.Root>
              <p className="timestamp mt-1">{doneCount}/{items.length} converted</p>
            </>
          )}

          {job.status === 'done' && job.result && (
            <div className="text-xs mt-2 space-y-1">
              <p className="text-[var(--cat-nature)] font-medium">Done.</p>
              <p className="text-[var(--text-dim)]">
                Processed: {job.result.processed} · Skipped: {job.result.skipped} · Failed: {job.result.failed} · Quarantined: {job.result.quarantined}
              </p>
              <p className="text-[var(--text-dim)] break-all">{job.result.outputDir}</p>
            </div>
          )}

          {job.status === 'error' && (
            <p className="text-xs text-[var(--danger)] mt-2">{job.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
