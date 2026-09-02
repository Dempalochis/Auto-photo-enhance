const path = require('path');
const { spawn } = require('child_process');
const { appendLog } = require('./jobQueue');

// Runs one of the repo's PowerShell scripts, streaming stdout line-by-line into job.log
// and invoking onLine(line, job) for callers that want to parse progress out of it
// (e.g. "Rendering X..." / "Enhancing X..." lines).
//
// Every line the script prints is ALSO echoed to the server's own stdout, tagged with the
// script name and short job id (e.g. "[preview_presets.ps1 a1b2c3] ERROR: RawTherapee CLI not
// found: ..."). The job log is only reachable through the HTTP API and the UI doesn't surface
// it prominently, so when a job "just fails" with no visible reason - the classic case being a
// preset-preview grid where every tile shows "failed" - running the server in a terminal now
// shows the actual PowerShell error (bad rtPath, missing ExifTool, unreadable source file, ...)
// without needing to poke at /api/jobs/:id by hand. The spawn invocation and final exit code
// are logged too, so a copy-pasteable repro of exactly what was run is always in the console.
function runPowerShellScript(scriptPath, args, job, onLine) {
  return new Promise((resolve, reject) => {
    const tag = `${path.basename(scriptPath)} ${String(job.id).slice(0, 6)}`;
    const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args];
    console.log(`[${tag}] spawn: powershell.exe ${psArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

    const proc = spawn('powershell.exe', psArgs);
    // Exposed so jobQueue.cancelJob() can kill an active job's underlying process.
    job._proc = proc;

    let buffer = '';
    const handleChunk = (streamName) => (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.length === 0) continue;
        appendLog(job, line);
        console.log(`[${tag}${streamName === 'stderr' ? ' stderr' : ''}] ${line}`);
        if (onLine) onLine(line, job);
      }
    };

    proc.stdout.on('data', handleChunk('stdout'));
    proc.stderr.on('data', handleChunk('stderr'));
    proc.on('error', (err) => {
      job._proc = null;
      console.error(`[${tag}] failed to spawn powershell.exe: ${err.message}`);
      reject(err);
    });
    proc.on('close', (exitCode) => {
      job._proc = null;
      if (buffer.length > 0) {
        appendLog(job, buffer);
        console.log(`[${tag}] ${buffer}`);
        if (onLine) onLine(buffer, job);
      }
      console.log(`[${tag}] exit code ${exitCode}`);
      resolve({ exitCode });
    });
  });
}

module.exports = { runPowerShellScript };
