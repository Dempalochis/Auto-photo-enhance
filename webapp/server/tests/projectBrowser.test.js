const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFolderName, summarizeProjectFolder, listProjects } = require('../projectBrowser');

function tempProjectsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ape-projects-test-'));
}

function makeProjectFolder(projectsDir, folderName, files = {}) {
  const dir = path.join(projectsDir, folderName);
  fs.mkdirSync(dir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('parseFolderName splits a well-formed "<name>_<date>" folder', () => {
  assert.deepEqual(parseFolderName('Summer Wedding_2026-08-05'), { projectName: 'Summer Wedding', date: '2026-08-05' });
});

test('parseFolderName handles a project name that itself contains underscores', () => {
  assert.deepEqual(parseFolderName('2026-07-KonKon_2026-08-03'), { projectName: '2026-07-KonKon', date: '2026-08-03' });
});

test('parseFolderName falls back to the raw name with a null date for a non-conforming folder', () => {
  assert.deepEqual(parseFolderName('random_folder'), { projectName: 'random_folder', date: null });
});

test('summarizeProjectFolder counts files and total bytes recursively, excluding _logs', () => {
  const projectsDir = tempProjectsDir();
  const dir = makeProjectFolder(projectsDir, 'A Project_2026-08-05', {
    'DSC001.jpg': 'aaaa',
    'sub/DSC002.jpg': 'bb',
    '_logs/run_1.csv': 'this should not be counted at all',
  });
  const result = summarizeProjectFolder(dir);
  assert.equal(result.fileCount, 2);
  assert.equal(result.totalBytes, 6);
});

test('summarizeProjectFolder returns zeros for a missing directory instead of throwing', () => {
  assert.deepEqual(summarizeProjectFolder('C:\\definitely\\does\\not\\exist'), { fileCount: 0, totalBytes: 0 });
});

test('listProjects returns [] for a projects directory that does not exist yet', () => {
  assert.deepEqual(listProjects('C:\\definitely\\does\\not\\exist'), []);
});

test('listProjects lists every project folder with name/date/counts, newest date first', () => {
  const projectsDir = tempProjectsDir();
  makeProjectFolder(projectsDir, 'Older Shoot_2026-01-01', { 'a.jpg': 'x' });
  makeProjectFolder(projectsDir, 'Newer Shoot_2026-06-15', { 'a.jpg': 'x', 'b.jpg': 'yy' });

  const projects = listProjects(projectsDir);
  assert.equal(projects.length, 2);
  assert.deepEqual(projects.map((p) => p.projectName), ['Newer Shoot', 'Older Shoot']);
  assert.equal(projects[0].date, '2026-06-15');
  assert.equal(projects[0].fileCount, 2);
  assert.equal(projects[0].totalBytes, 3);
});

test('listProjects ignores stray files directly under projectsDir, only folders count', () => {
  const projectsDir = tempProjectsDir();
  fs.writeFileSync(path.join(projectsDir, 'stray.txt'), 'not a project');
  makeProjectFolder(projectsDir, 'Real Project_2026-01-01', { 'a.jpg': 'x' });

  const projects = listProjects(projectsDir);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].projectName, 'Real Project');
});

test('listProjects still shows a non-conforming folder name, sorted by its own mtime rather than dropped', () => {
  const projectsDir = tempProjectsDir();
  makeProjectFolder(projectsDir, 'not_a_date_folder', { 'a.jpg': 'x' });

  const projects = listProjects(projectsDir);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].date, null);
  assert.equal(projects[0].projectName, 'not_a_date_folder');
});
