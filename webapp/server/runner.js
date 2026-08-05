const { spawn } = require('child_process');
const { appendLog } = require('./jobQueue');

// Runs one of the repo's PowerShell scripts, streaming stdout line-by-line into job.log
// and invoking onLine(line, job) for callers that want to parse progress out of it
// (e.g. "Rendering X..." / "Enhancing X..." lines).
function runPowerShellScript(scriptPath, args, job, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args,
    ]);
    // Exposed so jobQueue.cancelJob() can kill an active job's underlying process.
    job._proc = proc;

    let buffer = '';
    const handleChunk = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.length === 0) continue;
        appendLog(job, line);
        if (onLine) onLine(line, job);
      }
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);
    proc.on('error', (err) => { job._proc = null; reject(err); });
    proc.on('close', (exitCode) => {
      job._proc = null;
      if (buffer.length > 0) {
        appendLog(job, buffer);
        if (onLine) onLine(buffer, job);
      }
      resolve({ exitCode });
    });
  });
}

module.exports = { runPowerShellScript };
