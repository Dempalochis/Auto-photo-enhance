const fs = require('fs');
const path = require('path');
const { llmConfig } = require('./llm/provider');

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
    // Version 2: the raw config.json object, for the PowerShell-side settings Node mirrors
    // (profile choice for the preview fingerprint and the AI overlay base values).
    raw,
    // Version 2: which PowerShell runs the scripts. Default = Version 1's "powershell.exe"
    // (Windows PowerShell 5.1); "pwsh" works too (PowerShell 7, also on Linux for development).
    powershellPath: raw.powershellPath || 'powershell.exe',
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
    // Vite's build output (V8 Phase 3) - only exists after `npm run build`; server.js checks
    // for it before serving from it, so dev mode (no dist/ yet) isn't affected.
    clientDistDir: path.join(REPO_ROOT, 'webapp', 'client', 'dist'),
    thumbCacheDir: path.join(REPO_ROOT, '.webapp_cache', 'thumbnails'),
    previewCacheDir: path.join(REPO_ROOT, '.webapp_cache', 'previews'),
    stateDir: path.join(REPO_ROOT, '.webapp_cache'),
    jobsStoreFile: path.join(REPO_ROOT, '.webapp_cache', 'jobs.json'),
    // Version 2 Phase 4: AI correction (off unless config.llm.enabled is true).
    llm: llmConfig(raw.llm),
    correctionsDir: path.join(REPO_ROOT, '.webapp_cache', 'corrections'),
  };
}

module.exports = { loadConfig };
