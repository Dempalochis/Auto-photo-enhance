// Formats a byte count as a short human-readable string (bytes/KB/MB/GB) for the project
// browser's per-project size column. Mirrors formatDuration.js's shape: a small pure formatter,
// unit tested on its own, with an explicit fallback for "no number at all" rather than "0 B".
export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}
