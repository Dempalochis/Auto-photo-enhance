async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

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
export const getOutputStatus = (projectName) => jsonFetch(`/api/output-status?projectName=${encodeURIComponent(projectName)}`);
export const thumbnailUrl = (relPath) => `/api/photos/thumbnail?path=${encodeURIComponent(relPath)}`;
