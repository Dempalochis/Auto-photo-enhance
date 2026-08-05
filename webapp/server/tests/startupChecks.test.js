const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkStartupConfig } = require('../startupChecks');

function realDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ape-startup-test-'));
}

function baseCfg(overrides = {}) {
  const dir = realDir();
  return {
    rtPath: path.join(dir, 'rawtherapee-cli.exe'), // does not exist unless a test creates it
    scriptsDir: dir,
    presetsDir: dir,
    profilesDir: dir,
    exiftoolPath: path.join(dir, 'exiftool.exe'),
    photosDir: dir,
    ...overrides,
  };
}

test('a fully valid config produces no errors or warnings', () => {
  const dir = realDir();
  const rtPath = path.join(dir, 'rawtherapee-cli.exe');
  const exiftoolPath = path.join(dir, 'exiftool.exe');
  fs.writeFileSync(rtPath, '');
  fs.writeFileSync(exiftoolPath, '');

  const { errors, warnings } = checkStartupConfig({
    rtPath, scriptsDir: dir, presetsDir: dir, exiftoolPath, photosDir: dir,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('a missing rawtherapee-cli path is an error, not a warning', () => {
  const { errors } = checkStartupConfig(baseCfg());
  assert.equal(errors.some((e) => e.includes('rawtherapee-cli')), true);
});

test('a missing scripts folder is an error', () => {
  const { errors } = checkStartupConfig(baseCfg({ scriptsDir: 'C:\\definitely\\does\\not\\exist\\anywhere' }));
  assert.equal(errors.some((e) => e.includes('scripts folder')), true);
});

test('a missing exiftool path is a warning, not an error (the app degrades gracefully without it)', () => {
  const { errors, warnings } = checkStartupConfig(baseCfg());
  assert.equal(errors.some((e) => e.includes('exiftool')), false);
  assert.equal(warnings.some((w) => w.includes('exiftool')), true);
});

test('a missing photosDir is a warning, not an error (the UI can point it elsewhere)', () => {
  const { errors, warnings } = checkStartupConfig(baseCfg({ photosDir: 'C:\\definitely\\does\\not\\exist\\anywhere' }));
  assert.equal(errors.some((e) => e.includes('photosDir')), false);
  assert.equal(warnings.some((w) => w.includes('photosDir')), true);
});

test('a missing presets folder is a warning', () => {
  const { warnings } = checkStartupConfig(baseCfg({ presetsDir: 'C:\\definitely\\does\\not\\exist\\anywhere' }));
  assert.equal(warnings.some((w) => w.includes('presets folder')), true);
});
