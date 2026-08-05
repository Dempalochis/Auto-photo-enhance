const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TYPE_NAMES = {
  Fixed: 'Local Disk',
  Removable: 'Removable Disk',
  'CD-ROM': 'CD Drive',
  Network: 'Network Drive',
};

function friendlyName(letter, label, driveType) {
  const trimmedLabel = (label || '').trim();
  if (trimmedLabel) return `${trimmedLabel} (${letter}:)`;
  return `${TYPE_NAMES[driveType] || 'Drive'} (${letter}:)`;
}

// Falls back to bare drive letters if PowerShell/Get-Volume isn't available for any reason -
// browsing still works, it just won't have friendly names in that case.
function listDrivesFallback() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    if (fs.existsSync(`${letter}:\\`)) drives.push({ name: `${letter}:\\`, path: `${letter}:\\` });
  }
  return drives;
}

// Real volume labels/types (e.g. "LaCie (F:)", "Local Disk (C:)") so an external drive is
// identifiable at a glance, same as Windows Explorer - not just a bare, indistinguishable
// drive letter like "F:\".
function listDrives() {
  return new Promise((resolve) => {
    const psCommand = 'ConvertTo-Json -InputObject @(Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter, FileSystemLabel, DriveType) -Compress';
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(listDrivesFallback()));
    proc.on('close', () => {
      try {
        const volumes = JSON.parse(out);
        const drives = volumes
          .map((v) => ({
            name: friendlyName(v.DriveLetter, v.FileSystemLabel, v.DriveType),
            path: `${v.DriveLetter}:\\`,
          }))
          .sort((a, b) => a.path.localeCompare(b.path));
        resolve(drives.length > 0 ? drives : listDrivesFallback());
      } catch {
        resolve(listDrivesFallback());
      }
    });
  });
}

// Free space on the drive that hosts `targetPath` (which need not exist yet - only its drive
// letter matters), for the warn-only disk-space check before a batch run (see diskSpace.js).
// Returns null (rather than throwing) on any failure - a check that can't determine free space
// should fail open, not block or crash the request that asked for it.
function getFreeSpaceBytes(targetPath) {
  return new Promise((resolve) => {
    const driveLetter = path.parse(path.resolve(targetPath)).root.replace(/[\\:]/g, '');
    if (!driveLetter) return resolve(null);

    const psCommand = `(Get-Volume -DriveLetter ${driveLetter} -ErrorAction SilentlyContinue).SizeRemaining`;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const n = parseInt(out.trim(), 10);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

module.exports = { listDrives, getFreeSpaceBytes };
