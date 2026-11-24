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

const STRENGTHS = [
  { id: 'subtle', label: 'Subtle', hint: 'Half of every AI adjustment (x0.5).' },
  { id: 'normal', label: 'Normal', hint: 'The AI adjustments as proposed (x1).' },
  { id: 'punchy', label: 'Punchy', hint: 'One and a half times every AI adjustment (x1.5).' },
];

// Version 2 Phase 4: the AI toggle only shows when the server reports an enabled, reachable LLM.
export function aiAvailable(llm) {
  return Boolean(llm && llm.enabled && llm.status === 'reachable');
}

export default function RunPanel({
  projectName, onProjectNameChange, selectedPhotos, selectedPreset, onRun, canRun, runStarting,
  llm = null, aiCorrection = false, onAiCorrectionChange = () => {}, aiStrength = 'normal', onAiStrengthChange = () => {},
}) {
  const showAi = aiAvailable(llm);
  const aiOn = showAi && aiCorrection;
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
        {aiOn && (
          <p className="text-sm text-[var(--text-dim)]">
            AI correction: <span className="text-[var(--text)]">{aiStrength}</span> · files named <span className="timestamp">name_ai{selectedPreset && selectedPreset !== 'none' ? `_${selectedPreset}` : ''}.jpg</span>
          </p>
        )}
      </div>

      {llm && llm.enabled && !showAi && (
        <p className="text-xs text-[var(--amber)] mb-3">AI correction unavailable: {llm.detail}</p>
      )}
      {showAi && (
        <div className="panel px-3 py-2.5 mb-4 space-y-2" data-testid="ai-panel">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={aiCorrection} onChange={(e) => onAiCorrectionChange(e.target.checked)} />
            <Hint text={`A local vision model (${llm.model}) fine-tunes each photo's base correction - exposure, highlights, shadows, contrast, clarity, dehaze, saturation, white balance - before your preset is applied. Output files get "_ai" in their name. If the model is slow or fails, that photo renders normally.`}>
              AI-guided correction
            </Hint>
          </label>
          {aiCorrection && (
            <div className="flex gap-1.5" role="group" aria-label="AI strength">
              {STRENGTHS.map((st) => (
                <Hint key={st.id} text={st.hint}>
                  <button
                    type="button"
                    onClick={() => onAiStrengthChange(st.id)}
                    className={`btn-secondary text-xs px-2.5 py-1 ${aiStrength === st.id ? 'active' : ''}`}
                  >
                    {st.label}
                  </button>
                </Hint>
              ))}
            </div>
          )}
        </div>
      )}

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
