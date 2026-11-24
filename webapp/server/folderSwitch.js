// Decision after the browser test (2026-11-24): the source folder can't be switched while
// previews are loading.
//  - A preset-preview job queued or rendering -> refused (409) until it finishes or is cancelled.
//  - Photo thumbnails (the camera's embedded preview JPEGs) still being served -> the switch waits
//    for them to finish (they're quick), and is refused if they don't within the time limit.
//    Before this, a thumbnail requested for the old folder could arrive after the switch and 404.

function previewBusy(previewLaneJobs) {
  return (previewLaneJobs || []).some((j) => j && ['queued', 'running', 'paused'].includes(j.status));
}

// Resolves true once getCount() is 0, false if it's still > 0 after timeoutMs.
async function waitForIdle(getCount, { timeoutMs = 10000, pollMs = 50 } = {}) {
  const t0 = Date.now();
  while (getCount() > 0) {
    if (Date.now() - t0 >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

const MESSAGES = {
  preview: 'A preset preview is still rendering. Switch folders when it has finished, or cancel it in the Job queue.',
  thumbnails: 'Photo previews are still loading. Try again in a moment.',
};

module.exports = { previewBusy, waitForIdle, MESSAGES };
