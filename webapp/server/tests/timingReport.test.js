const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, aggregateTiming } = require('../timingReport');

const SAMPLE_CSV = [
  '"Timestamp","File","Status","ExitCode","DurationSec","ISO","Profile","Preset","OutputPath","Note"',
  '"2026-08-05T22:49:07.14+02:00","DSC001.ARW","Processed","0","19.81","100","default","golden_hour","C:\\out\\DSC001.jpg",""',
  '"2026-08-05T22:49:26.37+02:00","DSC002.ARW","Processed","0","18.58","100","default","golden_hour","C:\\out\\DSC002.jpg",""',
  '"2026-08-05T22:49:44.00+02:00","DSC003.ARW","Skipped","","","","","","C:\\out\\DSC003.jpg","output already exists"',
  '"2026-08-05T22:50:00.00+02:00","DSC004.ARW","Failed","1","3.2","400","default","golden_hour","C:\\out\\DSC004.jpg","rawtherapee-cli exited with code 1"',
].join('\r\n');

test('parseCsv splits a PowerShell Export-Csv file into row objects keyed by header', () => {
  const rows = parseCsv(SAMPLE_CSV);
  assert.equal(rows.length, 4);
  assert.deepEqual(Object.keys(rows[0]), [
    'Timestamp', 'File', 'Status', 'ExitCode', 'DurationSec', 'ISO', 'Profile', 'Preset', 'OutputPath', 'Note',
  ]);
  assert.equal(rows[0].File, 'DSC001.ARW');
  assert.equal(rows[0].DurationSec, '19.81');
  assert.equal(rows[2].Status, 'Skipped');
  assert.equal(rows[2].DurationSec, '');
});

test('parseCsv handles a "" escaped quote inside a quoted field', () => {
  const csv = '"Status","Note"\r\n"Failed","he said ""stop"" mid-render"';
  const rows = parseCsv(csv);
  assert.equal(rows[0].Note, 'he said "stop" mid-render');
});

test('parseCsv handles a comma embedded inside a quoted field without splitting it', () => {
  const csv = '"Status","Note"\r\n"Failed","reason one, reason two"';
  const rows = parseCsv(csv);
  assert.equal(rows[0].Note, 'reason one, reason two');
});

test('parseCsv returns an empty array for an empty/header-only file', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('"Timestamp","File","Status"'), []);
});

test('aggregateTiming counts each status and computes duration stats over Processed rows only', () => {
  const rows = parseCsv(SAMPLE_CSV);
  const report = aggregateTiming(rows);

  assert.equal(report.fileCount, 4);
  assert.deepEqual(report.counts, {
    Processed: 2, Skipped: 1, Failed: 1, other: 0,
  });
  assert.equal(report.processedDurationSec.count, 2, 'Skipped (no duration) and Failed (not a real render) are excluded');
  assert.equal(report.processedDurationSec.min, 18.58);
  assert.equal(report.processedDurationSec.max, 19.81);
  assert.equal(report.processedDurationSec.mean, (19.81 + 18.58) / 2);
  assert.equal(report.processedDurationSec.median, (19.81 + 18.58) / 2);
  assert.ok(report.processedDurationSec.totalSec > 38 && report.processedDurationSec.totalSec < 38.4);
});

test('aggregateTiming reports low stddev for consistent per-file durations - the "fixed overhead dominates" signal', () => {
  const rows = [10, 10.1, 9.9, 10.2, 9.8].map((d) => ({ Status: 'Processed', DurationSec: String(d) }));
  const report = aggregateTiming(rows);
  assert.ok(report.processedDurationSec.stddev < 0.5, `expected low stddev, got ${report.processedDurationSec.stddev}`);
});

test('aggregateTiming reports high stddev for wildly varying durations - the "scales with something" signal', () => {
  const rows = [2, 3, 45, 60, 90].map((d) => ({ Status: 'Processed', DurationSec: String(d) }));
  const report = aggregateTiming(rows);
  assert.ok(report.processedDurationSec.stddev > 20, `expected high stddev, got ${report.processedDurationSec.stddev}`);
});

test('aggregateTiming handles zero Processed rows without dividing by zero', () => {
  const rows = [{ Status: 'Skipped', DurationSec: '' }, { Status: 'Failed', DurationSec: '1.2' }];
  const report = aggregateTiming(rows);
  assert.deepEqual(report.processedDurationSec, {
    count: 0, min: null, max: null, mean: null, median: null, stddev: null, totalSec: null,
  });
});

test('aggregateTiming handles an empty input array', () => {
  const report = aggregateTiming([]);
  assert.equal(report.fileCount, 0);
  assert.equal(report.processedDurationSec.count, 0);
});

test('aggregateTiming ignores a non-numeric DurationSec rather than corrupting the average', () => {
  const rows = [
    { Status: 'Processed', DurationSec: '10' },
    { Status: 'Processed', DurationSec: 'not-a-number' },
  ];
  const report = aggregateTiming(rows);
  assert.equal(report.processedDurationSec.count, 1);
  assert.equal(report.processedDurationSec.mean, 10);
});

test('median handles both an odd and an even number of Processed rows', () => {
  const odd = aggregateTiming([1, 2, 3].map((d) => ({ Status: 'Processed', DurationSec: String(d) })));
  assert.equal(odd.processedDurationSec.median, 2);

  const even = aggregateTiming([1, 2, 3, 4].map((d) => ({ Status: 'Processed', DurationSec: String(d) })));
  assert.equal(even.processedDurationSec.median, 2.5);
});
