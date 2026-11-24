const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig } = require('../config');

test('loadConfig always returns the core paths (repoRoot, stateDir, scriptsDir, ...)', () => {
  const cfg = loadConfig();
  const repo = path.resolve(__dirname, '..', '..', '..');
  assert.equal(cfg.repoRoot, repo);
  for (const k of ['configPath', 'presetsDir', 'profilesDir', 'scriptsDir', 'stateDir', 'jobsStoreFile', 'previewCacheDir', 'thumbCacheDir']) {
    assert.equal(typeof cfg[k], 'string', k);
  }
  assert.equal(typeof cfg.powershellPath, 'string');
  assert.equal(typeof cfg.raw, 'object');
});
