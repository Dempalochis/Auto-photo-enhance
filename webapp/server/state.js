const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicFile');

// Persists the user's chosen source folder across server restarts, so switching folders in
// the UI doesn't reset back to config.json's photosDir every time the backend is restarted.
function makeStateStore(stateDir) {
  const stateFile = path.join(stateDir, 'state.json');

  function read() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function write(partial) {
    const current = read();
    atomicWriteFileSync(stateFile, JSON.stringify({ ...current, ...partial }, null, 2));
  }

  return { read, write };
}

module.exports = { makeStateStore };
