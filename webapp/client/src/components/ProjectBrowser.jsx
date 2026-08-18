import { useEffect, useState } from 'react';
import { getProjects } from '../api';
import { formatBytes } from '../formatBytes';
import Hint from './Hint';

// Read-only list of past projects/<name>_<date>/ output folders (V6 Phase 7) - batch output has
// always landed there, but until now there was no way to see past runs without leaving the page
// and opening the folder in a file browser. Fetched once on mount plus an explicit Refresh
// button, rather than polled like JobQueuePanel - this data only changes when a run finishes,
// not multiple times a second, so a live poll would just be wasted requests.
export default function ProjectBrowser() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getProjects();
      setProjects(data.projects);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">
          <Hint text="Every projects/<name>_<date>/ output folder from a past batch run, newest first.">
            Past projects
          </Hint>
        </h2>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="btn-secondary text-[11px] px-2 py-1"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-xs text-[var(--danger)] mb-2">{error}</p>}
      {!loading && !error && projects.length === 0 && (
        <p className="text-xs text-[var(--text-dim)]">No past projects yet - run a batch to see it here.</p>
      )}

      {projects.length > 0 && (
        <ul className="space-y-2 max-h-80 overflow-y-auto">
          {projects.map((p) => (
            <li key={p.folderName} className="border border-[var(--border)] rounded-[3px] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium truncate" title={p.folderName}>{p.projectName}</p>
                <span className="timestamp shrink-0">{p.date || '—'}</span>
              </div>
              <p className="timestamp mt-1">
                {`${p.fileCount} file${p.fileCount === 1 ? '' : 's'} · ${formatBytes(p.totalBytes)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
