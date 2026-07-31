const path = require('path');
const { spawn } = require('child_process');

function parseExifDate(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

// One batched exiftool call for every file, instead of one process per file.
// Falls back to filesystem mtime (passed in by the caller) when EXIF has no DateTimeOriginal.
// Keyed by resolved absolute path, not bare filename - subfolders can have same-named files.
function getCaptureDates(exiftoolPath, filePaths) {
  return new Promise((resolve) => {
    if (!exiftoolPath || filePaths.length === 0) return resolve({});
    const proc = spawn(exiftoolPath, ['-j', '-DateTimeOriginal', ...filePaths]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve({}));
    proc.on('close', () => {
      try {
        const arr = JSON.parse(out);
        const map = {};
        for (const entry of arr) {
          map[path.resolve(entry.SourceFile)] = parseExifDate(entry.DateTimeOriginal);
        }
        resolve(map);
      } catch {
        resolve({});
      }
    });
  });
}

module.exports = { getCaptureDates };
