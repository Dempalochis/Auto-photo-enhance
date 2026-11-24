const { spawn } = require('child_process');

// Kills a spawned PowerShell script AND the rawtherapee-cli it started. Killing only the direct
// child leaves the grandchild rendering (and writing its output after cleanup ran).
//  - Windows: taskkill /T /F on the pid (whole tree).
//  - elsewhere: runner.js starts scripts in their own process group -> signal the group.
// Best effort: an already-dead process is fine.
function killProcessTree(proc) {
  if (!proc) return;
  try { proc.kill(); } catch { /* already gone */ }
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      killer.on('error', () => {});
    } catch { /* best effort */ }
  } else {
    // SIGKILL, not SIGTERM: with SIGTERM rawtherapee-cli died first and the script still had time
    // to log the cancel as a failed attempt (.attempts marker -> quarantine after two cancels).
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* not a group leader / already gone */ }
  }
}

module.exports = { killProcessTree };
