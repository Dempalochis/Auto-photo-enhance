// Version 2 Phase 6 (LLM plan §2.3): pixel statistics of the LLM's input image - small models are
// bad at judging clipping by eye, and these numbers help. Uses `sharp`, an OPTIONAL dependency:
// when it isn't installed every function returns null and nothing else changes.
//
// Also downscales the LLM input to llm.maxImagePx (the embedded camera JPEG is often 1600+ px,
// which costs far more image tokens than the ~900 px draft render).
let sharpMod;
function sharp() {
  if (sharpMod === undefined) {
    try { sharpMod = require('sharp'); } catch { sharpMod = null; }
  }
  return sharpMod;
}

function available() { return Boolean(sharp()); }

/**
 * Pure: stats from raw interleaved RGB bytes.
 * Returns { meanLuma, clippedHighlightsPct, clippedShadowsPct, meanSaturation, brightRgb: [r,g,b] }.
 */
function statsFromRgb(data, channels = 3) {
  const n = Math.floor(data.length / channels);
  if (n === 0) return null;
  const lumas = new Float64Array(n);
  let sumL = 0;
  let sumS = 0;
  let hi = 0;
  let lo = 0;
  for (let p = 0; p < n; p += 1) {
    const r = data[p * channels];
    const g = data[p * channels + 1];
    const b = data[p * channels + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumas[p] = l;
    sumL += l;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sumS += mx === 0 ? 0 : ((mx - mn) / mx) * 255;
    if (mx >= 250) hi += 1;
    if (mx <= 5) lo += 1;
  }
  // Average colour of the brightest 5% (a colour-cast hint).
  const sorted = Array.from(lumas).sort((a, b) => b - a);
  const cut = sorted[Math.max(0, Math.floor(n * 0.05) - 1)];
  let br = 0;
  let bg = 0;
  let bb = 0;
  let bn = 0;
  for (let p = 0; p < n; p += 1) {
    if (lumas[p] >= cut) { br += data[p * channels]; bg += data[p * channels + 1]; bb += data[p * channels + 2]; bn += 1; }
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    meanLuma: Math.round(sumL / n),
    clippedHighlightsPct: r1((100 * hi) / n),
    clippedShadowsPct: r1((100 * lo) / n),
    meanSaturation: Math.round(sumS / n),
    brightRgb: [Math.round(br / bn), Math.round(bg / bn), Math.round(bb / bn)],
  };
}

async function imageStats(file) {
  const s = sharp();
  if (!s) return null;
  try {
    const { data, info } = await s(file).resize(256, 256, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return statsFromRgb(data, info.channels);
  } catch {
    return null;
  }
}

// JPEG buffer no larger than maxPx on its long side, or null (caller then sends the file as is).
async function resizeForLlm(file, maxPx) {
  const s = sharp();
  if (!s || !(maxPx > 0)) return null;
  try {
    const meta = await s(file).metadata();
    if (Math.max(meta.width || 0, meta.height || 0) <= maxPx) return null;
    return await s(file).resize(maxPx, maxPx, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
  } catch {
    return null;
  }
}

module.exports = {
  available, statsFromRgb, imageStats, resizeForLlm,
};
