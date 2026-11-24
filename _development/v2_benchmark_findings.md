# Version 2 — Phase 0 benchmark and behaviour findings

> **⚠ Phase 0a: measured on LINUX, NOT WINDOWS.** Cloud dev container: Ubuntu 24.04, 4 logical
> CPUs, 15 GB RAM, no GPU, RawTherapee **5.10** (apt), ExifTool 12.76, PowerShell 7.4.6.
> Your machine runs Windows, RawTherapee 5.12 and Windows PowerShell 5.1, so **timings, pipe
> buffering and process start-up cost can all differ**. Every gate below is re-decided with
> your own numbers in Phase 0b (`scripts/bench_rt.ps1` on Windows, see
> `Version_2_test_guide.md` §2). Until then each gated feature ships **off** (plan §9.3).

Same style as `docs/gpu_spike_findings.md`. Raw results: `.webapp_cache/bench/linux_full/`,
`linux_C_clean/`, `linux_DE_clean/` (`results.json` + `results.md`, local only).

## Test set

8 CC0 samples from raw.pixls.us in `_samples/` (gitignored), low ISO only (50–400):

| File | Camera | Size | ISO |
|---|---|---|---|
| a6000_12c.ARW | Sony ILCE-6000 | 6048×4024 | 100 |
| a7m2_14u.ARW | Sony ILCE-7M2 | 6048×4024 | 100 |
| a7m3_14c.ARW | Sony ILCE-7M3 | 6048×4024 | 400 |
| a7r_14c.ARW | Sony ILCE-7R | 7392×4920 | 50 |
| a7s_1.ARW / a7s_2.ARW | Sony ILCE-7S (8 s apart) | 4288×2848 / 2816×1872 | 400 |
| d750_14l.NEF | Nikon D750 (flash fired) | 6032×4032 | 100 |
| xt2_14c.RAF | Fujifilm X-T2 | 6000×4000 | 400 |

No high-ISO sample, so the `lowlight.pp3` branch was only exercised by unit tests here.

## Timings (median of 3 runs, `bench_rt.ps1`)

| Case | What | Linux result |
|---|---|---|
| A | Production final, one process per file | **9.2 s** median (1.7 s for the 5 MP A7S … 13.7 s for the 36 MP A7R) |
| B1 | Start-up + profile/ICC load + immediate failure | **69 ms** |
| B2 | Smallest file, -f, 64 px resize | 0.73 s |
| C | 5 files, one `-c` call vs 5 calls (clean re-run) | 44.0–44.4 s vs 43.7–44.3 s → **≈0.2 % gain** |
| D | Current draft: `-f` + Scale 0.15 | **4.0 s** (clean re-run; 3.8 s in the first run) |
| E1 | D at Scale 0.25 | 3.9 s (−4 %, noise) |
| E2 | No `-f`, explicit fast demosaic / no denoise / Scale 0.15 | 4.1 s |
| F | 6 final renders at concurrency 1 / 2 / 3 | 7.7 / **8.8** / 8.6 files per minute |

Notes on measurement quality, stated plainly:
- The first full run's cases C and E overlapped with other CPU work in the container (an Ollama
  call and calibration renders). Its C result ("29.7 % gain, GO") was **wrong**: run 1 showed
  2 %, runs 2–3 were contaminated. Both C and D/E were re-run with nothing else running; only
  the clean numbers are used above. `bench_rt.ps1` itself cannot detect a busy machine. On
  Windows, close other heavy apps before running it.
- X-Trans (`.RAF`) output is **not bit-for-bit deterministic** in RawTherapee 5.10: the same
  command run three times gave three different checksums (PSNR 61.7 dB between two runs,
  invisible). Bayer files (`.ARW`) were byte-identical. Any "byte-identical" check has to allow for this.

## Gates (Linux verdicts; Windows decides)

| Gate | Rule | Linux verdict | Default shipped |
|---|---|---|---|
| **Batching** (Phase 2) | C saves ≥ 10 % per file | **NO-GO**: 0.2 %; start-up is 0.7 % of a final render (B1/A) | `batchRender: false` |
| **Draft profile** | a variant replaces D only if ≥ 10 % faster | **keep D** (`-f` + Scale 0.15); E1/E2 within ±5 % | `profiles/draft_override.pp3` = old `preview_fast_resize.pp3`, unchanged |
| **Render limiter** | best concurrency for final renders | 2 (+14 % throughput); 3 is no better | limiter default 1 while a run is active (Phase 4) |
| **Progress source** | per-file lines arrive live through a pipe? | **yes, live** on Linux (see timeline) | `progressSource: "outputFolder"` (safe on Windows either way) |
| **LLM input default** | draftRender vs embedded plans agree? | inconclusive: the 2B model disagrees with *itself* across inputs (below) | `inputImage: "auto"` |
| **AI correction** | before/after looks better | **not decidable here**: needs your eyes and a 4–9B model | `llm.enabled: false` |
| **Dropped steps** | steps that don't work | `warmth` via TemperatureBias had **no effect**: replaced with `Equal`. `tint` works (sign flipped). Nothing dropped. | table marked *uncalibrated* |

What the batching verdict means: on Linux a RawTherapee process starts in ~70 ms, and the
~9 s render is all real work, so batching can't save anything. Windows process creation,
antivirus scanning of the .exe and ICC/profile loading may cost more there. That's exactly what
case C on your machine decides. The feature is fully built and tested, but switched off.

## CLI behaviour (case X, Linux)

5-file batch `-o <dir> -c f1 … f5`, one file a 50 KB truncated copy of a real `.ARW`:

```
     69 ms  RawTherapee, version 5.10, command line.
     69 ms  Output is 8-bit integer.
     69 ms  Processing: …/a6000_12c.ARW
    324 ms    Merging procparams #0
   4127 ms  Output is 8-bit integer.
   4127 ms  Processing: …/a7m2_14u.ARW
   7633 ms  Processing: …/truncated_a7m2_14u.ARW        (→ "Error loading file: …" on stderr)
   7633 ms  Processing: …/a7m3_14c.ARW
  12828 ms  Processing: …/a7r_14c.ARW
  (exit at 18846 ms)
```

- **Per-file line:** `Processing: <full input path>` is printed when a file *starts*. The previous
  file is written by then. There is no "done" line.
- **Live vs burst:** through a pipe the lines arrived **live** (spread over the run, not in one
  burst at the end). RawTherapee 5.10 evidently flushes stdout. Windows may still behave
  differently (C runtime block buffering on pipes), so `outputFolder` stays the default.
- **Output naming with `-o <dir>`:** `<input stem>.jpg` (e.g. `a7m3_14c.jpg`). Two inputs with the
  same stem would overwrite each other, which is why batches hold at most one file per stem.
- **Corrupt file:** RawTherapee reports it, **continues with the rest of the batch**, and the batch
  exits **254** (also 254 for a single unreadable file). A *mildly* truncated file (first 2 MB of
  25 MB) instead rendered a garbage JPEG with exit 0. Fault isolation can only catch files that
  produce no output, the same limit Version 1 has.
- **Help-text fallback:** never triggered by any of the generated argument lists (`Usage:` checked
  in the contract tests).

## Step table checks (`scripts/dev/step_calibration.js`, a7M3, draft render, mean RGB)

| Overlay | mean R / G / B | Effect |
|---|---|---|
| base | 131 / 164 / 156 | — |
| exposure −2 … +2 | 103 → 117 → **131** → 145 → 159 (R) | clear, linear ✓ |
| TemperatureBias ±0.1, ±0.2 (plan's warmth) | 131 / 164 / 156 for all four | **no effect** under `Setting=autitcgreen` ✗ |
| `Setting=autold` + TemperatureBias 0.2 | 175 / 162 / 136 | works, but replaces the auto-ITC method, so rejected |
| `Equal` 0.9 / 1.1 / 1.2 | 113/165/162 · 149/163/150 · 165/161/145 | warmer above 1, cooler below, auto-ITC kept ✓ **→ new warmth key** |
| `Green` −0.04/−0.08 (tint +1/+2) | 127/165/153 · 123/165/150 | takes effect; **higher Green = greener**, so tint's sign was flipped ✓ |
| `Itcwb_green` 0.05 | unchanged | no effect |

`correctionTable.js` now maps warmth → `[White Balance] Equal` (±0.05/step) and tint →
`[White Balance] Green` (−0.04/step). Neither key is set by any preset
(`presetKeyOwnership.test.js`). The remaining steps are the plan's starting guesses, still
**uncalibrated**. Calibrating them by eye is Phase 0b.

## LLM experiment (`scripts/dev/llm_experiment.js`, Ollama 0.40.18, `qwen3.5:2b`, CPU)

3 photos × 3 input images (draft render, embedded camera JPEG, full-pipeline render at draft
size). The adapter and the schema work: every reply was valid JSON matching the schema, with no
retries. The quality is not usable:

| Photo | draftRender plan | embedded plan | fullSmall plan |
|---|---|---|---|
| a6000 (forest stream) | exp−1 hl−2 sh−1 con−1 cla−1 dhz−1 | exp−1 hl−1 sh−1 con−1 cla−1 dhz−1 | exp−1 hl−2 sh−1 con−1 cla−1 dhz−1 |
| a7M2 (frozen forest floor) | cla+1 | exp−1 hl−2 sh−1 con−1 cla−1 dhz−1 | exp−1 hl−2 sh−1 con−1 cla−1 dhz−1 |
| a7M3 (park / trees) | hl−1 dhz+1 | cla+1 | cla+1 |

- Mean step difference draftRender vs embedded **4.0**, vs fullSmall **3.7**.
- Signs contradict the notes ("recover highlights" → `hl−2`; "flat" → `con−1 cla−1`), and scene labels
  are wrong (forest = "astro", "food", "portrait"). Captions are good ("Rocky forest stream,
  autumn colors").
- Speed on 4 CPU cores: ~25–28 s per call on a ~900 px draft, 60–123 s on the 1616 px embedded
  JPEG (image tokens). On a GPU with a 4–9B model expect a few seconds.

**Conclusion:** the 2B model is too weak, as LLM plan §5 predicted ("~2B is likely too weak").
The AI gate and the input-image gate must be judged on Windows with `qwen3.5:4b`–`9b`.
The embedded JPEG costs far more LLM time on CPU because it's larger. `maxImagePx` downscaling
of the embedded JPEG is not implemented (no image library in Node), so the analyze lane prefers
the ~900 px draft render whenever a render slot is free.

## Scene segmentation (`scripts/dev/scene_report.js`)

Ran on `_samples/`: 8 unrelated photos → 7 segments (the two A7S frames 8 s apart group
together, everything else splits on huge time gaps). Correct, but meaningless as a check: real
shoots are needed. That comparison is Phase 0b (test guide §4).
