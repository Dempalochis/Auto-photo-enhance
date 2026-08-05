const MAX_HISTORY = 5;

// Adds `newPath` to the front of `history`, removing any existing occurrence first (so
// re-selecting a recent folder moves it back to the top instead of appearing twice) and capping
// the length at MAX_HISTORY, oldest dropped first.
function addToHistory(history, newPath) {
  const deduped = (Array.isArray(history) ? history : []).filter((p) => p !== newPath);
  return [newPath, ...deduped].slice(0, MAX_HISTORY);
}

module.exports = { addToHistory, MAX_HISTORY };
