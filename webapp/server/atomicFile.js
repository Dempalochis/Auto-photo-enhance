const fs = require('fs');
const path = require('path');

// Writes `data` (already a string) to `file` via write-to-temp-then-rename. `rename` on the
// same volume is atomic on both Windows and POSIX, so a reader (or a crash mid-write) never
// sees a truncated/half-written `file` - only the complete old content or the complete new
// content. Shared by state.js and jobQueue.js, the two things in this app that persist
// user-visible state across restarts.
function atomicWriteFileSync(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { atomicWriteFileSync };
