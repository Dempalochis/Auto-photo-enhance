const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'config.json');

function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  const resolveRepoPath = (p, fallback) => {
    if (!p) return fallback;
    return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
  };
  return {
    repoRoot: REPO_ROOT,
    configPath: CONFIG_PATH,
    rtPath: raw.rtPath || 'C:\\Program Files\\RawTherapee\\5.12\\rawtherapee-cli.exe',
    exiftoolPath: raw.exiftoolPath || null,
    photosDir: resolveRepoPath(raw.photosDir, REPO_ROOT),
    scanSubfolders: raw.scanSubfolders !== false,
    projectsDir: resolveRepoPath(raw.projectsDir, path.join(REPO_ROOT, 'projects')),
    presetsDir: path.join(REPO_ROOT, 'presets'),
    profilesDir: path.join(REPO_ROOT, 'profiles'),
    scriptsDir: path.join(REPO_ROOT, 'scripts'),
    thumbCacheDir: path.join(REPO_ROOT, '.webapp_cache', 'thumbnails'),
    previewCacheDir: path.join(REPO_ROOT, '.webapp_cache', 'previews'),
    stateDir: path.join(REPO_ROOT, '.webapp_cache'),
    jobsStoreFile: path.join(REPO_ROOT, '.webapp_cache', 'jobs.json'),
  };
}

module.exports = { loadConfig };
