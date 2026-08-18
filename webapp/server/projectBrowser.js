const fs = require('fs');
const path = require('path');

// Reverses projectFolderName's `${sanitizeProjectName(name)}_${date}` convention (pathSafety.js)
// well enough to show a human a readable name + date, without needing to store that metadata
// separately anywhere - the date is always appended as the trailing `_YYYY-MM-DD`, so a
// trailing match is reliable regardless of what characters sanitizeProjectName left in the name.
const FOLDER_NAME_PATTERN = /^(.*)_(\d{4}-\d{2}-\d{2})$/;

function parseFolderName(folderName) {
  const m = folderName.match(FOLDER_NAME_PATTERN);
  if (!m) return { projectName: folderName, date: null };
  return { projectName: m[1], date: m[2] };
}

// Recursively sums file count/bytes under `dir`, skipping the run-log subfolder (_logs) - a
// project's "file count" should mean its actual converted photos, not the CSV logs alongside
// them (same exclusion server.js's own walkArwFiles applies to 'failed'). Missing/unreadable
// directories return zero counts rather than throwing, since a project folder could in principle
// be deleted or moved between being listed and this stat pass.
function summarizeProjectFolder(dir) {
  let fileCount = 0;
  let totalBytes = 0;

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === '_logs') continue;
        walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        fileCount += 1;
        try {
          totalBytes += fs.statSync(path.join(current, entry.name)).size;
        } catch {
          // vanished between readdir and stat - just skip its size, don't fail the whole listing
        }
      }
    }
  }

  walk(dir);
  return { fileCount, totalBytes };
}

// Lists every project folder directly under `projectsDir` (as created by projectFolderName, see
// pathSafety.js), newest first by the date parsed from its own folder name - falling back to the
// folder's own mtime for one that doesn't match the naming convention, so it still shows up
// rather than silently vanishing from the list. Returns [] for a missing projects directory
// rather than throwing - there may simply be no batches run yet.
function listProjects(projectsDir) {
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const folderPath = path.join(projectsDir, e.name);
      const { projectName, date } = parseFolderName(e.name);
      const { fileCount, totalBytes } = summarizeProjectFolder(folderPath);
      let mtimeMs = null;
      try { mtimeMs = fs.statSync(folderPath).mtimeMs; } catch { /* folder vanished mid-listing */ }
      return {
        folderName: e.name, projectName, date, fileCount, totalBytes, mtimeMs,
      };
    })
    .sort((a, b) => {
      const aKey = a.date || (a.mtimeMs != null ? new Date(a.mtimeMs).toISOString().slice(0, 10) : '');
      const bKey = b.date || (b.mtimeMs != null ? new Date(b.mtimeMs).toISOString().slice(0, 10) : '');
      if (aKey !== bKey) return bKey.localeCompare(aKey); // newest date first
      return (b.mtimeMs || 0) - (a.mtimeMs || 0); // tie-break: newest mtime first
    });
}

module.exports = { parseFolderName, summarizeProjectFolder, listProjects };
