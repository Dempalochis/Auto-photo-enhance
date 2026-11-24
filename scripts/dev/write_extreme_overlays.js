#!/usr/bin/env node
// Writes one AI overlay per step at -2 and +2 for each strength (subtle/normal/punchy) into the
// given folder - used by the Integration contract test to prove RawTherapee accepts them all.
const fs = require('fs');
const path = require('path');
const { req, REPO } = require('./devlib');

const out = process.argv[2] || path.join(REPO, '.webapp_cache', 'extreme_overlays');
fs.mkdirSync(out, { recursive: true });
const { STEP_KEYS } = req('correctionTable');
const { validatePlan } = req('correctionPlan');
const { correctionToPp3 } = req('correctionToPp3');
const { readPp3File } = req('pp3');
const base = readPp3File(path.join(REPO, 'profiles', 'default.pp3'));
let n = 0;
for (const strength of ['subtle', 'normal', 'punchy']) {
  for (const v of [-2, 2]) {
    const all = Object.fromEntries(STEP_KEYS.map((k) => [k, v]));
    const { plan } = validatePlan({ adjustments: all });
    fs.writeFileSync(path.join(out, `all_${v}_${strength}.pp3`), correctionToPp3(plan, base, { strength }).text);
    n += 1;
  }
}
for (const step of STEP_KEYS) {
  const { plan } = validatePlan({ adjustments: { [step]: 2 } });
  fs.writeFileSync(path.join(out, `${step}_2_punchy.pp3`), correctionToPp3(plan, base, { strength: 'punchy' }).text);
  n += 1;
}
console.log(`${n} overlays in ${out}`);
