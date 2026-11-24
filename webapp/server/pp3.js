// Minimal reader/writer for RawTherapee .pp3 profiles (INI style: [Section] then Key=Value).
// Used to read the *actual* base profile a photo is rendered with, so the AI overlay can write
// absolute values (base + change): a later -p replaces a key, it never adds to it.
const fs = require('fs');

function parsePp3(text) {
  const out = {};
  let section = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1];
      if (!out[section]) out[section] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (section && eq > 0) out[section][line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function readPp3File(file) {
  return parsePp3(fs.readFileSync(file, 'utf8'));
}

// sections: { 'Exposure': { Compensation: 0.55, ... }, ... } -> pp3 text, sections in insertion
// order. Numbers are written without float noise (at most 4 decimals).
function formatValue(v) {
  if (typeof v === 'number') return String(Math.round(v * 10000) / 10000);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function stringifyPp3(sections, headerComment) {
  const lines = [];
  if (headerComment) for (const c of String(headerComment).split('\n')) lines.push(`# ${c}`);
  for (const [name, keys] of Object.entries(sections)) {
    if (lines.length) lines.push('');
    lines.push(`[${name}]`);
    for (const [k, v] of Object.entries(keys)) lines.push(`${k}=${formatValue(v)}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

function getNumber(parsed, section, key, fallback) {
  const v = parsed && parsed[section] ? parseFloat(parsed[section][key]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

module.exports = {
  parsePp3, readPp3File, stringifyPp3, getNumber, formatValue,
};
