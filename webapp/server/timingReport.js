const fs = require('fs');
const path = require('path');

// Parses PowerShell's Export-Csv output (double-quoted fields, comma-separated, header row,
// "" as an escaped quote inside a field) - exactly the shape auto_enhance.ps1 writes to
// logs/*.csv and projects/*/_logs/*.csv (see the main README's "Testing" section), not a
// general-purpose CSV parser.
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') { inQuotes = false; } else { cur += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}

function mean(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Buckets a batch of parsed CSV rows (see parseCsv) into status counts and per-file duration
// stats for the 'Processed' rows specifically. Answers the exact question
// docs/gpu_spike_findings.md's recommendation named: is a batch dominated by fixed
// per-invocation overhead (low variance, similar duration regardless of scene) or by work that
// scales with something else (high variance)? Skipped rows do no real work (DurationSec is
// blank) and Failed rows' duration reflects an aborted/errored attempt, not a real render, so
// mixing either into "how long does a real conversion take" would distort the numbers.
function aggregateTiming(rows) {
  const counts = {
    Processed: 0, Skipped: 0, Failed: 0, other: 0,
  };
  const durations = [];
  for (const row of rows) {
    const status = row.Status;
    if (status === 'Processed' || status === 'Skipped' || status === 'Failed') counts[status] += 1;
    else counts.other += 1;
    if (status === 'Processed' && row.DurationSec !== '' && row.DurationSec != null) {
      const d = Number(row.DurationSec);
      if (Number.isFinite(d)) durations.push(d);
    }
  }
  durations.sort((a, b) => a - b);
  const avg = mean(durations);
  const variance = durations.length > 0
    ? mean(durations.map((d) => (d - avg) ** 2))
    : null;

  return {
    fileCount: rows.length,
    counts,
    processedDurationSec: {
      count: durations.length,
      min: durations.length > 0 ? durations[0] : null,
      max: durations.length > 0 ? durations[durations.length - 1] : null,
      mean: avg,
      median: median(durations),
      stddev: variance != null ? Math.sqrt(variance) : null,
      totalSec: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : null,
    },
  };
}

// Finds every *.csv under each of `roots`, recursively - covers both the CLI pipeline's
// top-level logs/ and the web UI's per-project projects/<name>/_logs/.
function findCsvFiles(roots) {
  const results = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root, { recursive: true });
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith('.csv')) results.push(path.join(root, entry));
    }
  }
  return results;
}

module.exports = {
  parseCsv, aggregateTiming, findCsvFiles,
};

// `node webapp/server/timingReport.js` - reads every real CSV log already on disk and prints an
// aggregate report. Read-only: gathers/prints data, installs nothing, matches the boundary the
// V4 GPU spike drew (see docs/gpu_spike_findings.md).
if (require.main === module) {
  const repoRoot = path.join(__dirname, '..', '..');
  const roots = [path.join(repoRoot, 'logs'), path.join(repoRoot, 'projects')];
  const files = findCsvFiles(roots);
  console.log(`Found ${files.length} CSV log file(s) under ${roots.join(', ')}`);
  let allRows = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    allRows = allRows.concat(parseCsv(text));
  }
  console.log(JSON.stringify(aggregateTiming(allRows), null, 2));
}
