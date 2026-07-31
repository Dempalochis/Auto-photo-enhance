const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Extracts the embedded preview JPEG from a raw file via ExifTool (fast, no raw decode -
// good enough for a picker grid; the real look comes from the preset preview render).
function extractThumbnail(exiftoolPath, sourceFile, destFile) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const tryTag = (tag) => new Promise((res, rej) => {
      const out = fs.createWriteStream(destFile);
      const proc = spawn(exiftoolPath, ['-b', tag, sourceFile]);
      proc.stdout.pipe(out);
      let wrote = 0;
      proc.stdout.on('data', (d) => { wrote += d.length; });
      proc.on('error', rej);
      proc.on('close', () => {
        out.end();
        if (wrote > 0) res(); else rej(new Error(`no ${tag}`));
      });
    });

    tryTag('-PreviewImage')
      .catch(() => tryTag('-ThumbnailImage'))
      .then(resolve)
      .catch((err) => {
        fs.rm(destFile, { force: true }, () => {});
        reject(err);
      });
  });
}

module.exports = { extractThumbnail };
