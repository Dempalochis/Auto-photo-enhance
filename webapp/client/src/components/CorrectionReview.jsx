import { useCallback, useEffect, useState } from 'react';
import {
  getCorrection, saveCorrection, resetCorrection, renderCorrections, startAnalyze,
} from '../api';
import { useJob } from '../useJob';
import { STEPS, bumpStep, formatStep } from '../correctionSteps';
import Hint from './Hint';

const MAX_CARDS = 24;

// One photo: before/after draft renders, what the AI saw, and the editable step chips.
function ReviewCard({
  relPath, data, onEdit, onReset, busy,
}) {
  if (!data) {
    return (
      <div className="panel p-3 text-xs text-[var(--text-dim)]" data-testid="review-card">
        <p className="text-[var(--text)] truncate mb-1">{relPath}</p>
        Not analysed yet.
      </div>
    );
  }
  const { plan } = data;
  return (
    <div className="panel p-3 space-y-2" data-testid="review-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--text)] truncate">{relPath}</p>
        <span className="timestamp text-[var(--text-dim)] shrink-0">{data.source === 'edit' ? 'your edit' : 'AI plan'}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {['before', 'after'].map((which) => {
          const url = which === 'before' ? data.beforeUrl : data.afterUrl;
          return (
            <figure key={which} className="m-0">
              <div className="aspect-[3/2] bg-[var(--panel-raised)] rounded-[3px] overflow-hidden flex items-center justify-center">
                {url ? <img src={url} alt={`${which} ${relPath}`} className="w-full h-full object-cover" />
                  : <span className="text-[10px] text-[var(--text-dim)]">{which === 'after' && data.summary === 'none' ? 'no change' : 'rendering…'}</span>}
              </div>
              <figcaption className="timestamp text-[var(--text-dim)] mt-0.5">{which === 'before' ? 'Before (base profile)' : 'After (AI correction)'}</figcaption>
            </figure>
          );
        })}
      </div>
      <p className="text-[11px] text-[var(--text-dim)]">
        {plan.scene} · {plan.lighting}{plan.issues && plan.issues.length ? ` · ${plan.issues.join(', ')}` : ''}
        {plan.sceneTags && plan.sceneTags.caption ? ` · "${plan.sceneTags.caption}"` : ''}
      </p>
      {plan.notes && <p className="text-[11px] italic text-[var(--text-dim)]">{plan.notes}</p>}
      <div className="flex flex-wrap gap-1" role="group" aria-label={`Adjustments for ${relPath}`}>
        {STEPS.map((s) => {
          const v = plan.adjustments[s.key] || 0;
          return (
            <span key={s.key} className={`inline-flex items-center gap-0.5 rounded-[3px] border px-1 text-[11px] ${v ? 'border-[var(--amber-dim)] text-[var(--text)]' : 'border-[var(--border)] text-[var(--text-dim)]'}`}>
              <button type="button" disabled={busy || v <= -2} aria-label={`${s.label} minus`} className="px-0.5" onClick={() => onEdit(relPath, bumpStep(plan.adjustments, s.key, -1))}>−</button>
              <span>{s.label} {formatStep(v)}</span>
              <button type="button" disabled={busy || v >= 2} aria-label={`${s.label} plus`} className="px-0.5" onClick={() => onEdit(relPath, bumpStep(plan.adjustments, s.key, 1))}>+</button>
            </span>
          );
        })}
      </div>
      <div className="flex gap-1.5">
        <button type="button" disabled={busy} className="btn-secondary text-[10px] px-2 py-0.5" onClick={() => onEdit(relPath, Object.fromEntries(STEPS.map((s) => [s.key, 0])))}>
          All to 0
        </button>
        {data.source === 'edit' && (
          <Hint text="Drops your edit and goes back to what the AI proposed.">
            <button type="button" disabled={busy} className="btn-secondary text-[10px] px-2 py-0.5" onClick={() => onReset(relPath)}>Reset to AI</button>
          </Hint>
        )}
      </div>
    </div>
  );
}

/**
 * Version 2 Phase 5 (LLM plan §6.4): "Analyze" the selected photos, then review every photo's
 * AI plan as before/after draft renders with editable steps. Your edits are saved per photo and
 * always override the AI (also in runs and in the preview grid's AI tile).
 */
export default function CorrectionReview({ selectedPhotos, llm }) {
  const [data, setData] = useState({});
  const [analyzeJobId, setAnalyzeJobId] = useState(null);
  const [renderJobId, setRenderJobId] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const analyzeJob = useJob(analyzeJobId);
  const renderJob = useJob(renderJobId);
  const shown = selectedPhotos.slice(0, MAX_CARDS);
  const shownKey = shown.map((p) => p.relPath).join('|');

  const refresh = useCallback(async (paths) => {
    const entries = await Promise.all(paths.map((p) => getCorrection(p).then((d) => [p, d]).catch(() => [p, null])));
    setData((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
  }, []);

  // Load whatever plans already exist for the current selection (cheap: no LLM call).
  useEffect(() => {
    if (shown.length) refresh(shown.map((p) => p.relPath));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  useEffect(() => {
    if (analyzeJob && (analyzeJob.status === 'done' || analyzeJob.status === 'error' || analyzeJob.status === 'cancelled')) {
      if (analyzeJob.status === 'error') setError(analyzeJob.error);
      refresh(shown.map((p) => p.relPath));
      setAnalyzeJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzeJob && analyzeJob.status]);

  useEffect(() => {
    if (renderJob && renderJob.status !== 'queued' && renderJob.status !== 'running') {
      refresh(renderJob.meta?.files || shown.map((p) => p.relPath));
      setRenderJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderJob && renderJob.status]);

  if (!llm || !llm.enabled || llm.status !== 'reachable') return null;

  const analyze = async (force) => {
    setError(null);
    try {
      const { jobId } = await startAnalyze(shown.map((p) => p.relPath), force ? { force: true } : {});
      setAnalyzeJobId(jobId);
    } catch (err) { setError(err.message); }
  };

  const afterChange = async (relPath) => {
    await refresh([relPath]);
    const { jobId } = await renderCorrections([relPath]);
    setRenderJobId(jobId);
  };

  const onEdit = async (relPath, adjustments) => {
    setBusy(true);
    try {
      const saved = await saveCorrection(relPath, adjustments);
      setData((prev) => ({ ...prev, [relPath]: { ...(prev[relPath] || {}), ...saved, afterUrl: null } }));
      await afterChange(relPath);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const onReset = async (relPath) => {
    setBusy(true);
    try { await resetCorrection(relPath); await afterChange(relPath); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const progress = analyzeJob?.progress?.items || [];
  const doneCount = progress.filter((i) => i.status === 'done' || i.status === 'failed').length;

  return (
    <div data-testid="correction-review">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-sm font-semibold">AI correction review</h2>
        <div className="flex items-center gap-2">
          {analyzeJobId && <span className="eyebrow">analysing {doneCount}/{progress.length || shown.length}…</span>}
          {renderJobId && <span className="eyebrow">rendering…</span>}
          <Hint text={`Asks ${llm.model} for a correction plan for each selected photo (up to ${MAX_CARDS}), then renders before/after drafts. Plans are cached: photos already analysed aren't sent again unless you click Re-analyse.`}>
            <button type="button" className="btn-secondary text-xs px-2.5 py-1.5" disabled={!shown.length || Boolean(analyzeJobId)} onClick={() => analyze(false)}>
              Analyze {shown.length || ''} selected
            </button>
          </Hint>
          <button type="button" className="btn-secondary text-xs px-2.5 py-1.5" disabled={!shown.length || Boolean(analyzeJobId)} onClick={() => analyze(true)}>
            Re-analyse
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-[var(--danger)] mb-2">{error}</p>}
      {shown.length === 0 ? (
        <p className="text-sm text-[var(--text-dim)]">Select photos above, then click Analyze to see what the AI would change.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {shown.map((p) => (
            <ReviewCard key={p.relPath} relPath={p.relPath} data={data[p.relPath]} onEdit={onEdit} onReset={onReset} busy={busy} />
          ))}
        </div>
      )}
      {selectedPhotos.length > MAX_CARDS && (
        <p className="text-xs text-[var(--text-dim)] mt-2">Showing the first {MAX_CARDS} of {selectedPhotos.length} selected photos.</p>
      )}
    </div>
  );
}
