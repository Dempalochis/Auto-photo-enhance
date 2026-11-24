async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const getHealth = () => jsonFetch('/api/health');
export const getProjects = () => jsonFetch('/api/projects');
export const getPhotos = () => jsonFetch('/api/photos');
export const getPresets = () => jsonFetch('/api/presets');

export const startPreview = (photo) => jsonFetch('/api/preview', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ photo }),
});

export const startRun = (files, preset, projectName) => jsonFetch('/api/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ files, preset, projectName }),
});

export const getJob = (id) => jsonFetch(`/api/jobs/${id}`);
export const listJobs = ({ type, status } = {}) => {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (status) params.set('status', status.join(','));
  const qs = params.toString();
  return jsonFetch(`/api/jobs${qs ? `?${qs}` : ''}`);
};
export const cancelJob = (id) => jsonFetch(`/api/jobs/${id}`, { method: 'DELETE' });
export const reorderJobs = (type, orderedIds) => jsonFetch('/api/jobs/reorder', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type, orderedIds }),
});
export const pauseJob = (id) => jsonFetch(`/api/jobs/${id}/pause`, { method: 'POST' });
export const requeueJob = (id) => jsonFetch(`/api/jobs/${id}/requeue`, { method: 'POST' });
export const retryJob = (id) => jsonFetch(`/api/jobs/${id}/retry`, { method: 'POST' });
export const getOutputStatus = (projectName) => jsonFetch(`/api/output-status?projectName=${encodeURIComponent(projectName)}`);
export const thumbnailUrl = (relPath) => `/api/photos/thumbnail?path=${encodeURIComponent(relPath)}`;

export const getSourceFolder = () => jsonFetch('/api/source-folder');
export const setSourceFolder = (path) => jsonFetch('/api/source-folder', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path }),
});
export const browseFolders = (path) => jsonFetch(`/api/browse-folders?path=${encodeURIComponent(path || '')}`);

// ---- Version 2 Phase 3: scenes ----
const jsonBody = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const getScenes = () => jsonFetch('/api/scenes');
export const detectScenes = (days) => jsonFetch('/api/scenes/detect', jsonBody('POST', days ? { days } : {}));
export const renameScene = (id, name) => jsonFetch(`/api/scenes/${encodeURIComponent(id)}`, jsonBody('PATCH', { name }));
export const mergeScenes = (ids) => jsonFetch('/api/scenes/merge', jsonBody('POST', { ids }));
export const splitScene = (id, afterRelPath) => jsonFetch(`/api/scenes/${encodeURIComponent(id)}/split`, jsonBody('POST', { afterRelPath }));
export const moveToScene = (relPaths, toId) => jsonFetch('/api/scenes/move', jsonBody('POST', { relPaths, toId }));
