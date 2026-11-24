import { useEffect, useRef, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  getPhotos, getPresets, getSourceFolder, setSourceFolder, startPreview, startRun, getScenes, detectScenes, getHealth,
} from './api';
import { useJob } from './useJob';
import SourceFolderPicker from './components/SourceFolderPicker';
import PhotoPicker from './components/PhotoPicker';
import PresetPreview from './components/PresetPreview';
import RunPanel from './components/RunPanel';
import JobQueuePanel from './components/JobQueuePanel';
import HealthIndicator from './components/HealthIndicator';
import ProjectBrowser from './components/ProjectBrowser';
import SceneActions from './components/SceneActions';
import CorrectionReview from './components/CorrectionReview';

const PROJECT_NAME_KEY = 'ape.lastProjectName';
const PRESET_KEY = 'ape.lastPreset';
const PREVIEW_PHOTO_KEY = 'ape.lastPreviewPhoto';
const AI_KEY = 'ape.aiCorrection';
const AI_STRENGTH_KEY = 'ape.aiStrength';

export default function App() {
  const [sourceFolder, setSourceFolderState] = useState('');
  const [folderHistory, setFolderHistory] = useState([]);
  const [folderError, setFolderError] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [photosLoading, setPhotosLoading] = useState(true);
  const [presetNames, setPresetNames] = useState([]);
  const [selected, setSelected] = useState(new Set());
  // Remembered across reloads so the preset grid's thumbnails ("2. Pick a look") are still there
  // when the page reopens, not just the preset choice itself - restored below once photos load,
  // by re-requesting a preview for it (the server's own on-disk cache means that's instant when
  // nothing has changed, not a re-render).
  const [previewPhoto, setPreviewPhoto] = useState(() => localStorage.getItem(PREVIEW_PHOTO_KEY) || null);
  const [previewJobId, setPreviewJobId] = useState(null);
  const restoredPreviewRef = useRef(false);
  const [selectedPreset, setSelectedPreset] = useState(() => localStorage.getItem(PRESET_KEY) || 'none');
  const [projectName, setProjectName] = useState(() => localStorage.getItem(PROJECT_NAME_KEY) || '');
  const [loadError, setLoadError] = useState(null);
  const [previewStarting, setPreviewStarting] = useState(false);
  const [runStarting, setRunStarting] = useState(false);

  const previewJob = useJob(previewJobId);
  // Version 2 Phase 4: LLM status (from /api/health) and the run's AI options.
  const [llm, setLlm] = useState(null);
  const [aiCorrection, setAiCorrection] = useState(() => localStorage.getItem(AI_KEY) === 'true');
  const [aiStrength, setAiStrength] = useState(() => localStorage.getItem(AI_STRENGTH_KEY) || 'normal');
  useEffect(() => { localStorage.setItem(AI_KEY, String(aiCorrection)); }, [aiCorrection]);
  useEffect(() => { localStorage.setItem(AI_STRENGTH_KEY, aiStrength); }, [aiStrength]);
  useEffect(() => {
    let cancelled = false;
    let timer;
    const poll = () => getHealth()
      .then((h) => { if (!cancelled) setLlm(h.llm || null); })
      .catch(() => {})
      .finally(() => { if (!cancelled) timer = setTimeout(poll, 15000); });
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  const aiUsable = Boolean(llm && llm.enabled && llm.status === 'reachable');
  // Version 2 Phase 3: scene groups for the active folder + the "Find scenes" job.
  const [scenes, setScenes] = useState([]);
  const [scenesJobId, setScenesJobId] = useState(null);
  const scenesJob = useJob(scenesJobId);
  const refreshScenes = () => getScenes().then((r) => setScenes(r.scenes || [])).catch(() => setScenes([]));
  // Run jobs are no longer tracked by a single client-side ID - the JobQueuePanel polls the
  // server's job list directly, which is what lets Run stay usable for queuing another batch
  // instead of waiting on the previous one (see JobQueuePanel.jsx).

  useEffect(() => {
    setPhotosLoading(true);
    Promise.all([getSourceFolder(), getPhotos(), getPresets()])
      .then(([sf, p, pr]) => {
        setSourceFolderState(sf.path);
        setFolderHistory(sf.history || []);
        setPhotos(p.photos);
        setPresetNames(pr.presets);
      })
      .catch((err) => setLoadError(err.message))
      .finally(() => setPhotosLoading(false));
    refreshScenes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload the scene list once a "Find scenes" job finishes.
  useEffect(() => {
    if (scenesJob && scenesJob.status === 'done') { refreshScenes(); setScenesJobId(null); }
    if (scenesJob && scenesJob.status === 'error') { setLoadError(`Find scenes failed: ${scenesJob.error}`); setScenesJobId(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenesJob && scenesJob.status]);

  const handleFindScenes = async (days) => {
    try {
      const { jobId } = await detectScenes(days);
      setScenesJobId(jobId);
    } catch (err) {
      setLoadError(err.message);
    }
  };

  // Selecting a whole scene with no project name typed yet names the project after the scene.
  const handleSceneSelected = (scene) => {
    if (!projectName.trim() && scene && scene.name) setProjectName(scene.name);
  };

  useEffect(() => { localStorage.setItem(PROJECT_NAME_KEY, projectName); }, [projectName]);
  useEffect(() => { localStorage.setItem(PRESET_KEY, selectedPreset); }, [selectedPreset]);
  useEffect(() => {
    if (previewPhoto) localStorage.setItem(PREVIEW_PHOTO_KEY, previewPhoto);
    else localStorage.removeItem(PREVIEW_PHOTO_KEY);
  }, [previewPhoto]);

  // Once, after the first photo list lands: re-request a preview for whatever photo was last
  // previewed (restored from localStorage above) so its thumbnails come back without the user
  // re-clicking Preview - the server's on-disk preview cache means this resolves instantly rather
  // than re-rendering, unless the presets or photo genuinely changed since last time. Skipped
  // (and the stale reference dropped) if that photo isn't in the current folder's list at all -
  // e.g. the folder was switched in another tab since the last visit.
  useEffect(() => {
    if (photosLoading || restoredPreviewRef.current) return;
    restoredPreviewRef.current = true;
    if (!previewPhoto) return;
    if (!photos.some((p) => p.relPath === previewPhoto)) {
      setPreviewPhoto(null);
      return;
    }
    handlePreview(previewPhoto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photosLoading, photos]);

  const handleChangeFolder = async (path) => {
    setFolderError(null);
    // Covers the whole switch, not just the photo re-fetch - the folder-switch request itself
    // (POST /api/source-folder) is the slow part (it's what actually reads EXIF capture dates
    // for every file), so the spinner needs to start here, not after it already resolved.
    setPhotosLoading(true);
    try {
      const result = await setSourceFolder(path);
      setSourceFolderState(result.path);
      setFolderHistory(result.history || []);
      // The response already includes the full photo list - reuse it instead of firing a
      // separate GET /api/photos that would redo the same EXIF scan a second time.
      setPhotos(result.photos || []);
      // Selections/preview reference photos from the old folder - stale once the folder changes.
      setSelected(new Set());
      setPreviewPhoto(null);
      setPreviewJobId(null);
      refreshScenes();
    } catch (err) {
      setFolderError(err.message);
    } finally {
      setPhotosLoading(false);
    }
  };

  const toggle = (name) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const selectMany = (names, select) => {
    setSelected((prev) => {
      const next = new Set(prev);
      names.forEach((n) => (select ? next.add(n) : next.delete(n)));
      return next;
    });
  };

  const handlePreview = async (name) => {
    if (previewStarting) return;
    setPreviewStarting(true);
    setPreviewPhoto(name);
    try {
      const { jobId } = await startPreview(name);
      setPreviewJobId(jobId);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setPreviewStarting(false);
    }
  };

  const handleRun = async () => {
    if (runStarting) return;
    setRunStarting(true);
    try {
      const result = await startRun(Array.from(selected), selectedPreset, projectName,
        aiUsable && aiCorrection ? { aiCorrection: true, aiStrength } : undefined);
      // Clear the selection once a batch is queued - the natural next step in this flow is
      // picking a *different* set of photos to queue as the next job, not re-running the same
      // selection. Preset/project-name choices are left as-is since those often stay the same
      // across consecutive batches for one shoot.
      setSelected(new Set());
      return result;
    } catch (err) {
      setLoadError(err.message);
      throw err; // let RunPanel know the queue attempt failed, so it skips the "Queued" toast
    } finally {
      setRunStarting(false);
    }
  };

  const selectedPhotos = photos.filter((p) => selected.has(p.relPath));

  return (
    <Tooltip.Provider delayDuration={200}>
      <div className="min-h-screen">
        <header className="border-b border-[var(--border)] px-6 py-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl">Auto Photo Enhance</h1>
            <p className="eyebrow mt-1">Raw color correction + preset looks · RawTherapee</p>
          </div>
          <HealthIndicator />
        </header>

        {loadError && (
          <div className="mx-6 mt-4 panel border-[var(--danger)] text-[var(--danger)] text-sm px-4 py-2">
            {loadError}
          </div>
        )}

        <main className="max-w-[1180px] mx-auto p-6 grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-8">
          <div className="space-y-10">
            <div>
              <SourceFolderPicker
                currentPath={sourceFolder}
                history={folderHistory}
                photoCount={photos.length}
                onChangeFolder={handleChangeFolder}
                error={folderError}
              />
              <PhotoPicker
                photos={photos}
                loading={photosLoading}
                selected={selected}
                onToggle={toggle}
                onSelectMany={selectMany}
                onPreview={handlePreview}
                previewPhoto={previewPhoto}
                previewStarting={previewStarting}
                scenes={scenes}
                onFindScenes={handleFindScenes}
                scenesStatus={scenesJobId ? 'running' : 'idle'}
                onSceneSelected={handleSceneSelected}
                sceneActions={(group) => (
                  <SceneActions
                    group={group}
                    scenes={scenes}
                    selected={selected}
                    onChanged={(r) => setScenes(r.scenes || [])}
                    onError={setLoadError}
                  />
                )}
              />
            </div>
            <PresetPreview
              previewPhoto={previewPhoto}
              job={previewJob}
              presetNames={presetNames}
              selectedPreset={selectedPreset}
              onSelectPreset={setSelectedPreset}
            />
            <CorrectionReview selectedPhotos={selectedPhotos} llm={llm} />
          </div>

          <div className="lg:sticky lg:top-6 self-start space-y-4">
            <div className="panel p-5">
              <RunPanel
                projectName={projectName}
                onProjectNameChange={setProjectName}
                selectedPhotos={selectedPhotos}
                selectedPreset={selectedPreset}
                onRun={handleRun}
                canRun={selected.size > 0}
                runStarting={runStarting}
                llm={llm}
                aiCorrection={aiCorrection}
                onAiCorrectionChange={setAiCorrection}
                aiStrength={aiStrength}
                onAiStrengthChange={setAiStrength}
              />
            </div>
            <JobQueuePanel />
            <ProjectBrowser />
          </div>
        </main>
      </div>
    </Tooltip.Provider>
  );
}
