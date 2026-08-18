import { useEffect, useRef, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  getPhotos, getPresets, getSourceFolder, setSourceFolder, startPreview, startRun,
} from './api';
import { useJob } from './useJob';
import SourceFolderPicker from './components/SourceFolderPicker';
import PhotoPicker from './components/PhotoPicker';
import PresetPreview from './components/PresetPreview';
import RunPanel from './components/RunPanel';
import JobQueuePanel from './components/JobQueuePanel';
import HealthIndicator from './components/HealthIndicator';
import ProjectBrowser from './components/ProjectBrowser';

const PROJECT_NAME_KEY = 'ape.lastProjectName';
const PRESET_KEY = 'ape.lastPreset';
const PREVIEW_PHOTO_KEY = 'ape.lastPreviewPhoto';

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
  }, []);

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
      const result = await startRun(Array.from(selected), selectedPreset, projectName);
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
              />
            </div>
            <PresetPreview
              previewPhoto={previewPhoto}
              job={previewJob}
              presetNames={presetNames}
              selectedPreset={selectedPreset}
              onSelectPreset={setSelectedPreset}
            />
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
