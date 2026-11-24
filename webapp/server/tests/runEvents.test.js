const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEventLine, createRunProgressHandler, createPreviewProgressHandler } = require('../runEvents');

const items = (n) => Array.from({ length: n }, (_, i) => ({ name: `f${i}.ARW`, status: 'pending' }));
const ev = (o) => `@@EVENT ${JSON.stringify(o)}`;

test('parseEventLine accepts only well-formed @@EVENT lines', () => {
  assert.deepEqual(parseEventLine(ev({ event: 'summary', processed: 1 })), { event: 'summary', processed: 1 });
  assert.equal(parseEventLine('@@EVENT {broken'), null);
  assert.equal(parseEventLine('@@EVENT {"no":"event"}'), null);
  assert.equal(parseEventLine('Enhancing x.ARW (ISO=100'), null);
});

test('events drive progress; the human lines next to them are ignored (no double counting)', () => {
  const it = items(3);
  const h = createRunProgressHandler(it);
  [
    'Skipping f0.ARW (output already exists)', ev({ event: 'file_skipped', index: 0, total: 3 }),
    'Enhancing f1.ARW (ISO=100, profile=default, preset=none)', ev({ event: 'file_started', index: 1, total: 3 }),
  ].forEach(h.onLine);
  assert.equal(h.mode(), 'events');
  assert.deepEqual(it.map((i) => i.status), ['done', 'running', 'pending']);
  assert.equal(h.current(), it[1]);
  [
    '  FAILED: rawtherapee-cli exited with code 1 (attempt 1 of 2 before quarantine)',
    ev({ event: 'file_failed', index: 1, total: 3, note: 'exit 1' }),
    'Enhancing f2.ARW (ISO=100, profile=default, preset=none)', ev({ event: 'file_started', index: 2, total: 3 }),
    ev({ event: 'file_completed', index: 2, total: 3 }),
    'Processed: 1  Skipped: 1  Failed: 1  Quarantined: 0',
    ev({ event: 'summary', processed: 1, skipped: 1, failed: 1, quarantined: 0 }),
  ].forEach(h.onLine);
  h.flush();
  assert.deepEqual(it.map((i) => i.status), ['done', 'failed', 'done']);
  assert.equal(it[1].note, 'exit 1');
  assert.equal(h.current(), null);
  assert.deepEqual(h.summary(), { processed: 1, skipped: 1, failed: 1, quarantined: 0 });
});

test('without events the Version 1 regex parsing still works (fallback)', () => {
  const it = items(3);
  const h = createRunProgressHandler(it);
  [
    'Skipping f0.ARW (output already exists)',
    'Enhancing f1.ARW (ISO=100, profile=default, preset=none)',
    '  FAILED: no output file was created (attempt 1 of 2 before quarantine)',
    'Enhancing f2.ARW (ISO=100, profile=default, preset=none)',
    '',
    '=====================================',
    'Processed: 1  Skipped: 1  Failed: 1  Quarantined: 0',
  ].forEach(h.onLine);
  h.flush();
  assert.equal(h.mode(), 'regex');
  assert.deepEqual(it.map((i) => i.status), ['done', 'failed', 'running']);
  assert.deepEqual(h.summary(), { processed: 1, skipped: 1, failed: 1, quarantined: 0 });
});

test('regex fallback: a held line is applied before the next one (current file tracks correctly)', () => {
  const it = items(2);
  const h = createRunProgressHandler(it);
  h.onLine('Enhancing f0.ARW (ISO=100, profile=default, preset=none)');
  h.onLine('some RawTherapee output');
  assert.equal(h.current(), it[0]);
  assert.equal(it[0].status, 'running');
});

test('onEvent sees every event with its item', () => {
  const it = items(1);
  const seen = [];
  const h = createRunProgressHandler(it, { onEvent: (e, item) => seen.push([e.event, item && item.name]) });
  h.onLine(ev({ event: 'file_started', index: 0 }));
  h.onLine(ev({ event: 'summary' }));
  assert.deepEqual(seen, [['file_started', 'f0.ARW'], ['summary', null]]);
});

test('preview tiles: events first, regex fallback', () => {
  const urlFor = (l) => `/u/${l}.jpg`;
  const a = [{ label: '00_base_only', status: 'pending' }, { label: 'teal', status: 'pending' }];
  const h = createPreviewProgressHandler(a, urlFor);
  ['Rendering 00_base_only...', ev({ event: 'tile_started', label: '00_base_only' }), 'Rendered 00_base_only',
    ev({ event: 'tile_completed', label: '00_base_only' }), 'FAILED rendering teal (no output file)', ev({ event: 'tile_failed', label: 'teal' })].forEach(h.onLine);
  h.flush();
  assert.deepEqual(a.map((i) => i.status), ['done', 'failed']);
  assert.equal(a[0].url, '/u/00_base_only.jpg');

  const b = [{ label: '00_base_only', status: 'pending' }, { label: 'teal', status: 'pending' }];
  const r = createPreviewProgressHandler(b, urlFor);
  ['Rendering 00_base_only...', 'Rendering teal...', 'Rendered teal', 'FAILED rendering 00_base_only (x)'].forEach(r.onLine);
  r.flush();
  assert.deepEqual(b.map((i) => i.status), ['failed', 'done']);
});

test('a file already marked cancelled stays cancelled when the dying script reports it failed', () => {
  const it = items(1);
  const h = createRunProgressHandler(it);
  h.onLine(ev({ event: 'file_started', index: 0 }));
  it[0].status = 'cancelled'; // what server.js onCancel does
  h.onLine(ev({ event: 'file_failed', index: 0, note: 'exit 143' }));
  assert.equal(it[0].status, 'cancelled');
});
