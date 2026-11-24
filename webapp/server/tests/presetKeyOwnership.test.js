// Version 2, Phase 4 task 3 (LLM plan §1): the AI overlay is stacked BEFORE the preset, and a
// later -p replaces any key it sets. If a preset ever starts setting a key the AI owns, it would
// silently erase the AI correction. This test fails as soon as that happens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsePp3 } = require('../pp3');
const { CORRECTION_TABLE } = require('../correctionTable');

const PRESETS = path.resolve(__dirname, '..', '..', '..', 'presets');

function aiOwnedKeys() {
  const owned = new Set();
  for (const row of Object.values(CORRECTION_TABLE)) {
    owned.add(`${row.section}/${row.key}`);
    if (row.atTwo && row.atTwo.positive) owned.add(`${row.atTwo.positive.section}/${row.atTwo.positive.key}`);
  }
  return owned;
}

test('no preset sets a key the AI correction owns', () => {
  const owned = aiOwnedKeys();
  const files = fs.readdirSync(PRESETS).filter((f) => f.toLowerCase().endsWith('.pp3'));
  assert.ok(files.length >= 30, 'expected the shipped presets');
  const conflicts = [];
  for (const f of files) {
    const parsed = parsePp3(fs.readFileSync(path.join(PRESETS, f), 'utf8'));
    for (const [section, keys] of Object.entries(parsed)) {
      for (const key of Object.keys(keys)) if (owned.has(`${section}/${key}`)) conflicts.push(`${f}: [${section}] ${key}`);
    }
  }
  assert.deepEqual(conflicts, []);
});
