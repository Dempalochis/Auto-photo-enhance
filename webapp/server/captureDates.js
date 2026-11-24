const path = require('path');
const { spawn } = require('child_process');

function parseExifDate(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

// Windows command lines top out around 32K chars; a single exiftool call listing every file
// in a large library (thousands of files) blows past that and crashes with ENAMETOOLONG - this
// happened for real against a 4544-file library. Split into batches that stay well under the
// limit regardless of how long individual paths are, instead of guessing a fixed file count.
const MAX_BATCH_CHARS = 6000;
const MAX_BATCH_FILES = 300;

function makeBatches(filePaths) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const p of filePaths) {
    if (current.length > 0 && (currentChars + p.length > MAX_BATCH_CHARS || current.length >= MAX_BATCH_FILES)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(p);
    currentChars += p.length + 1;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// Version 2 (Phase 3): the same batched call also reads the exposure fields scene segmentation
// needs. `-n` returns them as plain numbers (ExposureTime in seconds, Flash as the EXIF bitfield)
// and leaves DateTimeOriginal's text format unchanged, so date parsing is unaffected.
const METADATA_TAGS = ['-DateTimeOriginal', '-ISO', '-ExposureTime', '-FNumber', '-Flash', '-Model'];

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Pure: one exiftool -j -n entry -> the metadata shape the app uses. FNumber 0 (manual lens) and
// missing values become null rather than 0, so EV maths can tell "unknown" from "dark".
function parseExifEntry(entry) {
  const flashRaw = entry && entry.Flash;
  let flash = null;
  if (typeof flashRaw === 'number') flash = (flashRaw & 1) === 1;
  else if (typeof flashRaw === 'string' && flashRaw) flash = /fired/i.test(flashRaw) && !/did not fire|not fired/i.test(flashRaw);
  return {
    dateTaken: parseExifDate(entry && entry.DateTimeOriginal),
    iso: num(entry && entry.ISO),
    exposureTime: num(entry && entry.ExposureTime),
    fNumber: num(entry && entry.FNumber),
    flash,
    model: entry && entry.Model ? String(entry.Model).trim() : null,
  };
}

function getMetadataBatch(exiftoolPath, filePaths) {
  return new Promise((resolve) => {
    const proc = spawn(exiftoolPath, ['-j', '-n', ...METADATA_TAGS, ...filePaths]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve({}));
    proc.on('close', () => {
      try {
        const arr = JSON.parse(out);
        const map = {};
        for (const entry of arr) {
          map[path.resolve(entry.SourceFile)] = parseExifEntry(entry);
        }
        resolve(map);
      } catch {
        resolve({});
      }
    });
  });
}

// Runs batches with limited concurrency (metadata reads are cheap/fast, unlike full raw
// renders, so a little parallelism here genuinely helps on large libraries).
async function runWithConcurrency(batches, worker, limit) {
  const results = new Array(batches.length);
  let next = 0;
  async function runner() {
    while (next < batches.length) {
      const i = next;
      next += 1;
      results[i] = await worker(batches[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, batches.length) }, runner));
  return results;
}

// Falls back to filesystem mtime (passed in by the caller) when EXIF has no DateTimeOriginal.
// Keyed by resolved absolute path, not bare filename - subfolders can have same-named files.
// Returns { [absPath]: { dateTaken, iso, exposureTime, fNumber, flash, model } }.
async function getPhotoMetadata(exiftoolPath, filePaths) {
  if (!exiftoolPath || filePaths.length === 0) return {};
  const batches = makeBatches(filePaths);
  const batchResults = await runWithConcurrency(batches, (batch) => getMetadataBatch(exiftoolPath, batch), 4);
  return Object.assign({}, ...batchResults);
}

// Unchanged contract from Version 1: { [absPath]: 'YYYY-MM-DDTHH:MM:SS' | null }.
async function getCaptureDates(exiftoolPath, filePaths) {
  const meta = await getPhotoMetadata(exiftoolPath, filePaths);
  const out = {};
  for (const [k, v] of Object.entries(meta)) out[k] = v.dateTaken;
  return out;
}

module.exports = {
  getCaptureDates, getPhotoMetadata, parseExifEntry, parseExifDate, makeBatches,
};
