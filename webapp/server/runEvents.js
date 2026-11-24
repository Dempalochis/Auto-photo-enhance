// Version 2 Phase 1: structured progress from the PowerShell scripts.
//
// The scripts print `@@EVENT {json}` lines next to their human-readable lines (only when called
// with -EmitEvents, which the server always passes). Events are read first; the Version 1 regex
// parsing ("Enhancing X (", "Skipping X (", "FAILED: ", "Processed: ...") stays as the fallback
// for a script that doesn't emit events.
//
// Each human line is printed immediately BEFORE its event line, so a regex match is held back for
// one line: if the next line is an event, the held line is dropped and the handler switches to
// events for good; otherwise the held line is applied as in Version 1.

const EVENT_PREFIX = '@@EVENT ';

function parseEventLine(line) {
  if (typeof line !== 'string' || !line.startsWith(EVENT_PREFIX)) return null;
  try {
    const obj = JSON.parse(line.slice(EVENT_PREFIX.length));
    return obj && typeof obj.event === 'string' ? obj : null;
  } catch {
    return null;
  }
}

const SUMMARY_RE = /^Processed: (\d+)\s+Skipped: (\d+)\s+Failed: (\d+)\s+Quarantined: (\d+)/;

/**
 * Progress handler for a run job. `items` is job.progress.items, in -FilesJson order.
 * Returns { onLine(line), flush(), current(), summary(), mode() }.
 * opts.onEvent(evt, item) is called for every event (used for batching extras, AI notes, ...).
 */
function createRunProgressHandler(items, opts = {}) {
  let mode = 'unknown'; // 'events' | 'regex' | 'unknown'
  let held = null;
  let fileIndex = -1;
  let current = null;
  let summary = { processed: 0, skipped: 0, failed: 0, quarantined: 0 };

  function applyRegex(line) {
    let m;
    if (line.match(/^Enhancing (.+?) \(/) || line.match(/^Skipping (.+?) \(/)) {
      if (current && current.status === 'running') current.status = 'done';
      fileIndex += 1;
      current = items[fileIndex] || null;
      if (current) current.status = line.startsWith('Skipping') ? 'done' : 'running';
      if (line.startsWith('Skipping')) current = null;
    } else if (line.match(/^\s*FAILED: /)) {
      if (current) current.status = 'failed';
    } else if ((m = line.match(SUMMARY_RE))) {
      summary = { processed: +m[1], skipped: +m[2], failed: +m[3], quarantined: +m[4] };
    }
  }

  function isRegexLine(line) {
    return /^Enhancing (.+?) \(/.test(line) || /^Skipping (.+?) \(/.test(line) || /^\s*FAILED: /.test(line) || SUMMARY_RE.test(line);
  }

  function applyEvent(evt) {
    const item = Number.isInteger(evt.index) ? items[evt.index] || null : null;
    switch (evt.event) {
      case 'file_started':
        if (item) { item.status = 'running'; current = item; }
        break;
      case 'file_completed':
        if (item) item.status = 'done';
        if (current === item) current = null;
        break;
      case 'file_failed':
        if (item) { item.status = 'failed'; if (evt.note) item.note = evt.note; }
        if (current === item) current = null;
        break;
      case 'file_skipped':
        if (item) item.status = 'done';
        break;
      case 'summary':
        summary = {
          processed: evt.processed || 0, skipped: evt.skipped || 0, failed: evt.failed || 0, quarantined: evt.quarantined || 0,
        };
        break;
      default:
        break;
    }
    if (opts.onEvent) opts.onEvent(evt, item);
  }

  function onLine(line) {
    const evt = parseEventLine(line);
    if (evt) {
      held = null;
      mode = 'events';
      applyEvent(evt);
      return;
    }
    if (mode === 'events') return; // human lines are for the console/log only now
    if (held !== null) { applyRegex(held); held = null; mode = 'regex'; }
    if (isRegexLine(line)) held = line;
  }

  function flush() {
    if (held !== null && mode !== 'events') { applyRegex(held); held = null; }
  }

  return {
    onLine, flush, current: () => current, summary: () => summary, mode: () => mode,
  };
}

/** Preview tiles: events first, Version 1 regex as fallback (same hold-one-line scheme). */
function createPreviewProgressHandler(items, urlFor) {
  let mode = 'unknown';
  let held = null;
  const find = (label) => items.find((i) => i.label === label);
  function applyRegex(line) {
    let m;
    if ((m = line.match(/^Rendering (.+)\.\.\.$/))) {
      const item = find(m[1]);
      if (item) item.status = 'running';
    } else if ((m = line.match(/^Rendered (.+)$/))) {
      const item = find(m[1]);
      if (item) { item.status = 'done'; item.url = urlFor(m[1]); }
    } else if ((m = line.match(/^FAILED rendering (.+?) \(/))) {
      const item = find(m[1]);
      if (item) item.status = 'failed';
    }
  }
  function onLine(line) {
    const evt = parseEventLine(line);
    if (evt) {
      held = null;
      mode = 'events';
      const item = find(evt.label);
      if (item) {
        if (evt.event === 'tile_started') item.status = 'running';
        else if (evt.event === 'tile_completed') { item.status = 'done'; item.url = urlFor(evt.label); }
        else if (evt.event === 'tile_failed') item.status = 'failed';
      }
      return;
    }
    if (mode === 'events') return;
    if (held !== null) { applyRegex(held); held = null; }
    if (/^(Rendering .+\.\.\.|Rendered .+|FAILED rendering .+? \()/.test(line)) held = line;
  }
  function flush() { if (held !== null && mode !== 'events') { applyRegex(held); held = null; } }
  return { onLine, flush, mode: () => mode };
}

module.exports = {
  EVENT_PREFIX, parseEventLine, createRunProgressHandler, createPreviewProgressHandler,
};
