# Version 2 — manual test guide (Windows)

Branch: `version_2_dev`. Everything new in Version 2 is **off or inert by default**. With the
`config.json` you have today, the app should behave exactly like Version 1. §1 checks that first,
then each section switches one feature on.

Built and tested in a Linux cloud container (RawTherapee 5.10, pwsh 7, a 2B model on CPU). What that
could and couldn't prove is in `Version_2_progress.md` → "Final summary". Gate numbers from Linux are
in `v2_benchmark_findings.md` (labelled not-Windows). This guide is where the real decisions get made.

Tick boxes as you go. Anything odd: note the step number and copy the server console lines (each
PowerShell line is echoed there as `[auto_enhance.ps1 abc123] …`).

---

## 0. Setup

- [ ] 0.1 `git fetch` and `git checkout version_2_dev`, then `git pull`.
- [ ] 0.2 Run `setup.bat` (or `npm install` in the repo root, then `npm run build`).
      `webapp/server` now has an **optional** dependency `sharp` (image statistics, §11.4). If its
      install fails, the app still works; only §11.4 is skipped.
- [ ] 0.3 Your `config/config.json` is not touched. New keys are listed in
      `config/config.example.json`; **missing keys use the Version 1-safe defaults**, so nothing has to
      be copied yet. Each section below says which block to add.
- [ ] 0.4 Optional, for the Pester suites: Windows PowerShell 5.1 ships Pester 3.4. Install Pester 5 once
      (admin PowerShell):
      ```powershell
      Install-Module Pester -MinimumVersion 5.5 -Force -SkipPublisherCheck
      ```
      Then from the repo root:
      ```powershell
      Invoke-Pester -Path scripts\tests -Output Detailed
      ```
      All 62 should pass on Windows too. The 6 `Integration` tests run against your real RawTherapee
      and need raws in `_samples\` (any of your own; the batch test needs at least 3). Without them
      they're reported as skipped. To run only those: `Invoke-Pester -Path scripts\tests -TagFilter Integration`.
- [ ] 0.5 `npm test` in the repo root: server and client suites green.

## 1. Version 1 behaviour is unchanged (nothing enabled)

- [ ] 1.1 `auto_enhance_arw_to_jpg.bat` on a small folder (3–5 raws): console lines look exactly as
      before (no `@@EVENT` lines), outputs are `name.jpg` / `name_<preset>.jpg`, and the CSV has the same columns.
- [ ] 1.1b `start_all.bat` (dev mode): two windows open (server on 5175, Vite on 5173), and the browser opens
      `http://localhost:5173` after ~5 s. On Linux the same steps had both servers up in under 0.5 s.
      The Vite window should no longer print an "@import must precede" warning (fixed).
- [ ] 1.2 Web UI (`start.bat`): pick photos → preset → **Run**. Progress per photo moves as before, the
      job finishes, and the files are in `projects\<name>_<date>\`.
- [ ] 1.3 Preview a photo: 33 tiles render, then preview it again → instant (cache hit).
- [ ] 1.4 The header pill is green. The Run panel has **no** AI toggle. The picker shows a new
      **Date | Scene** switch, on Date by default (the Version 1 view).
- [ ] 1.5 Cancel a run mid-way: the in-flight file is removed, finished files stay (as in Version 1).
- [ ] 1.5b **No folder switch while previews load:** click Preview on a photo, and while the tiles render try
      to switch folders. **Use this folder**, **Browse…** and **Recent** are disabled with
      "A preset preview is still rendering…". After the grid is done, switching works again.
- [ ] 1.6 Corrupt-file handling: copy one raw, truncate it (e.g. keep the first 50 KB), and run it. It fails,
      gets a `.attempts` marker, and on the 2nd run it's quarantined to `failed\`.

## 2. Phase 0b: benchmark on your machine (decides the gates)

Use 5–10 Sony `.ARW` (low **and** high ISO, e.g. ISO 100 and ISO 3200+) plus one `.RAF` and one `.NEF`
in one folder, e.g. `C:\bench`. Close other heavy apps (a busy machine makes the numbers worthless;
this happened once on Linux, see findings).

- [ ] 2.1 Run (takes roughly 15–30 min):
      ```powershell
      powershell -ExecutionPolicy Bypass -File scripts\bench_rt.ps1 -SamplesDir C:\bench
      ```
      Quick re-run of single cases: `-Cases C -Runs 3`, `-Cases D,E`, `-Cases X -Runs 1`.
- [ ] 2.2 Read the `GATE` lines at the end (also in `.webapp_cache\bench\<timestamp>\results.md`):

      | Gate line | What it decides | Action |
      |---|---|---|
      | `batching` | Is one `-c f1 f2 …` call ≥ 10 % faster per file than N calls (case C)? | GO → set `"batchRender": true` (§4) |
      | `startupShare` | Start-up cost as % of a final render (B1/A) | explains the batching result |
      | `draftProfile` | Is a draft variant ≥ 10 % faster than today's `-f` + Scale 0.15? | "keep D" = nothing to do; otherwise tell me which (E1 = Scale 0.25, E2 = no `-f`) |
      | `renderLimiter` | Throughput at 1/2/3 parallel final renders | if 1 is clearly best, set `"previewConcurrencyWhileRunning": 1` (§3.4) |
      | `progressSource` | Do `Processing:` lines arrive live through a pipe on Windows? | `True` = `"progressSource": "stdout"` is an option; `outputFolder` stays the safe default |

- [ ] 2.3 Copy the `results.md` table and the gates into `v2_benchmark_findings.md` under a new
      "Windows (Phase 0b)" heading.
- [ ] 2.4 Case X also records the exit code with a corrupt file and the output naming. Compare with the
      Linux values (254, `<stem>.jpg`).

## 3. Pipeline foundations (Phase 1), always on

- [ ] 3.1 **Preview cache now notices every input.** Preview a photo (cache filled). Then do each of these
      and preview again; each must re-render (watch the server console: `cache = MISS`):
      edit `profiles\default.pp3` (add a blank line) · edit `profiles\lowlight.pp3` ·
      edit `profiles\draft_override.pp3` · change `autoProfile.isoThreshold` in `config.json` (restart the
      server) · replace the raw file with a different one under the same name. With nothing changed: `HIT`.
- [ ] 3.2 `profiles\preview_fast_resize.pp3` is gone; `profiles\draft_override.pp3` is the same file
      renamed. Preview tiles are still ~900 px wide.
- [ ] 3.3 Run progress in the UI comes from structured events (the server log shows
      `@@EVENT {"event":"file_started",…}` lines). Photos with the **same filename in two subfolders** still
      show the right one as running/done.
- [ ] 3.4 Optional render limiter: `"previewConcurrencyWhileRunning": 1` in `config.json` → a preview
      started while a batch run is rendering uses 1 RawTherapee process instead of 3. Unset = Version 1.

## 4. Batched rendering (Phase 2), **off by default**

Turn on in `config.json`: `"batchRender": true` (optional: `"maxBatchSize": 20`,
`"maxCommandChars": 16000`, `"progressSource": "outputFolder"` or `"stdout"`). Restart the server.
For a single CLI run: `scripts\auto_enhance.ps1 … -BatchRender true`.

- [ ] 4.1 Run 10+ photos with one preset. The console shows `Batch 1 of N: k files in one RawTherapee call`,
      per-photo progress still moves **during** the batch (not all at the end), and outputs get their normal names.
- [ ] 4.2 Same CSV as without batching: one row per file, input order.
- [ ] 4.3 Put a truncated raw in the batch: the others finish, the bad one is retried **on its own**
      ("Batch produced no output for … retrying it on its own"), fails, and is quarantined on the 2nd run.
- [ ] 4.4 Cancel mid-batch: the job stops, finished files stay, and no `.rt_batch_*` folder is left in the output folder.
- [ ] 4.5 Two subfolders with the same filename (e.g. `A\DSC001.ARW`, `B\DSC001.ARW`): both render, in their own subfolders.
- [ ] 4.6 If 2.2 said `progressSource` live: try `"progressSource": "stdout"` and repeat 4.1.
- [ ] 4.7 **Decide:** keep `batchRender` on only if 2.2 said GO and 4.1–4.5 passed.

## 5. Scene grouping without the LLM (Phase 3)

- [ ] 5.1 Picker → **Scene** → "No scenes yet" → **Find scenes**. A "Find scenes" job runs, then
      the view shows day → scene → photos, with scenes named like `14:05–14:40 · 23 photos`.
- [ ] 5.2 **Select scene** selects exactly that scene. With an empty project name, the Run panel's
      project name becomes the scene name.
- [ ] 5.3 **Date filter + Find scenes** groups only the filtered days.
- [ ] 5.4 Search box: typing part of a scene name shows that scene.
- [ ] 5.5 Scene editor in the header: **Rename**, **Merge ↓** (with the next scene), **Split** (select a
      photo in the scene first; splits after it), **Move N here** (select photos from other scenes).
- [ ] 5.6 Click **Find scenes** again: your edited scenes keep their names and photos.
      Add a new raw to the folder → Find scenes → only that day is regrouped.
- [ ] 5.7 **Compare with your own grouping** on 2–3 real shoots (Phase 0 task 5):
      ```powershell
      node scripts\dev\scene_report.js D:\Photos\2026-08-Trip
      ```
      Open `.webapp_cache\scene_report\<folder>\index.html`. Note which segments you'd merge or split.
      Try `--gap 20` / `--ev 2`. If other values suit you better, set them in `config.json` → `"scenes"`.
- [ ] 5.8 Settings (defaults): `"scenes": { "maxGapMinutes": 10, "evJumpThreshold": 3, "splitByCamera": true, "useLlm": true }`.

## 6. Ollama + model setup (for §7–§11)

- [ ] 6.1 Install Ollama for Windows (ollama.com/download). It runs in the tray and listens on `http://localhost:11434`.
- [ ] 6.2 Pull a vision model. Qwen3.5 4B–9B is the sweet spot (2B was too weak in the Linux test, see findings).
      Check the exact tag on ollama.com/library/qwen3.5 first:
      ```powershell
      ollama pull qwen3.5:9b
      ```
      ```powershell
      ollama list
      ```
      If 9B is slow on your GPU, try `qwen3.5:4b`.
- [ ] 6.3 Add to `config\config.json` (keep `enabled: true` only while testing AI):
      ```json
      "llm": {
        "enabled": true,
        "provider": "ollama",
        "model": "qwen3.5:9b",
        "baseUrl": "http://localhost:11434",
        "inputImage": "auto",
        "strength": 1.0,
        "timeoutMs": 60000,
        "concurrency": 1,
        "maxImagePx": 1024,
        "refinePass": false,
        "histogramStats": false,
        "burstReuse": true
      }
      ```
      `"provider": "mock"` gives canned answers, which is handy to try the UI with Ollama stopped.
- [ ] 6.4 Restart the server. The console prints `[server] LLM: ollama qwen3.5:9b -> reachable`. The header pill
      stays green.
- [ ] 6.5 Negative checks: quit Ollama → within ~15 s the pill turns amber, its tooltip says
      "AI correction unavailable: cannot reach Ollama…", and the Run panel shows that reason instead of
      the toggle. Wrong model name → "model … not pulled … run: ollama pull …".

## 7. Is AI correction worth it? (the main gate)

- [ ] 7.1 **Before/after page** on 30–50 of your photos (mixed scenes, some high ISO):
      ```powershell
      node scripts\dev\llm_experiment.js D:\Photos\TestSet --max 40 --inputs draftRender,embedded
      ```
      Open `.webapp_cache\llm_experiment\index.html`. Each row shows before / after and the plans from
      each input image.
- [ ] 7.2 **Gate:** does "after" look better on most photos? **Yes** → AI correction can stay available.
      **No** → keep `llm.enabled: false`. Write the verdict in `v2_benchmark_findings.md`.
- [ ] 7.3 **Input image:** the page prints "Agreement between input images" (mean step difference; 0 =
      identical plans). If draftRender and embedded mostly agree (≲1), `"inputImage": "embedded"` is
      good enough and saves a render per photo. Otherwise keep `auto` or `draftRender`.
- [ ] 7.4 **Steps the model misuses:** the page lists how often each step was used. Note steps that
      are wrong in direction or size.
- [ ] 7.5 **Calibrate the step table by eye** on ~5 photos:
      ```powershell
      node scripts\dev\step_calibration.js D:\Photos\TestSet --max 5
      ```
      Open `.webapp_cache\step_calibration\index.html` (each row = one step at −2 … +2). If "+1" is too
      much or too little, change `perStep` in `webapp\server\correctionTable.js`. When done, change
      `TABLE_STATUS` to `'calibrated'`. `--mode fullSmall` shows the full-quality pipeline (slower).
      Check that **warmth** (now `[White Balance] Equal`) and **tint** (`Green`, sign flipped) look
      right on Windows RawTherapee 5.12. On Linux 5.10 they did.

## 8. AI-guided run (Phase 4)

- [ ] 8.1 The Run panel shows **AI-guided correction** + **Subtle / Normal / Punchy**. Turn it on, pick
      a preset, and Run 5–10 photos. The job queue shows the run "· AI (normal)" and an "AI analysis for …" job.
- [ ] 8.2 Outputs are named `name_ai_<preset>.jpg` (`name_ai.jpg` without a preset), next to any plain
      renders of the same photos (no collision, no false "already exists").
- [ ] 8.3 The CSV in `_logs\` has extra columns `AiCorrection` (e.g. `exp+1 sh+1 cla+2`) and `AiScene`.
- [ ] 8.4 Overlap: photo 2's analysis runs while photo 1 renders. A photo shows status "waiting" only if its
      plan isn't ready when the render reaches it.
- [ ] 8.5 **Quit Ollama mid-run:** the run completes, the remaining photos render without AI, and the
      Note column says "AI correction skipped: …". The job is **not** failed.
- [ ] 8.5b **Priority:** start **Analyze** on ~10 photos in the review panel, then immediately Run 2 other photos
      with AI on. The job queue shows "AI analysis for … (priority)". The run's photos get their plans right
      after the review call in progress, without waiting for the whole review (no "AI correction skipped" note).
- [ ] 8.6 Re-run the same photos with another preset: no new LLM calls (plans are cached; the
      analysis job finishes instantly or isn't created at all).
- [ ] 8.7 Compare Subtle vs Punchy on one photo (different project names).
- [ ] 8.8 `"llm": { "enabled": false }` → toggle gone, everything as in §1.

## 9. Review and edit (Phase 5)

- [ ] 9.1 Select up to 24 photos → **AI correction review** (below the preset grid) → **Analyze N selected**.
      Cards show Before (base profile) / After (AI correction) renders, scene, lighting, issues, caption and notes.
- [ ] 9.2 Click **+ / −** on a chip: the card says "your edit", and the After image re-renders within a few seconds.
- [ ] 9.3 **Reset to AI** returns to the model's plan. **All to 0** = no correction.
- [ ] 9.4 Run the edited photo with AI on: the output uses **your** edit (check the CSV `AiCorrection`).
- [ ] 9.5 Preview a photo that has a plan: a tile **AI-corrected base (compare)** appears next to
      "None". Edit that photo's plan → preview again → only that photo's grid re-renders.
- [ ] 9.6 **Find scenes** with the LLM on (`scenes.useLlm`, default true): scenes get real names
      ("Harbour at golden hour"), and the subtitle says "named by AI". The search box finds words from
      captions. Stop Ollama and run Find scenes again: you still get the time-based scenes.

## 10. Switches: what each gated feature is and how to turn it on or off

All in `config\config.json`. Restart the server after a change. "Default" = what you get when the key is missing.

| Feature | Key | Default | On | Off |
|---|---|---|---|---|
| Batched rendering | `batchRender` | `false` | `true` | `false` |
| Batch limits | `maxBatchSize` / `maxCommandChars` | `20` / `16000` | — | — |
| Batch progress source | `progressSource` | `"outputFolder"` | `"stdout"` | `"outputFolder"` |
| Preview limiter during runs | `previewConcurrencyWhileRunning` | unset (3) | `1` or `2` | remove the key |
| PowerShell used by the server | `powershellPath` | `"powershell.exe"` | `"pwsh"` | — |
| AI correction (everything LLM) | `llm.enabled` | `false` | `true` | `false` |
| LLM input image | `llm.inputImage` | `"auto"` | `"draftRender"` / `"embedded"` | — |
| AI strength (review / AI tile) | `llm.strength` | `1.0` | 0.5–1.5 | — |
| Plan wait per photo | `llm.planWaitMs` | = `timeoutMs` | ms | — |
| Refine pass (2nd LLM look) | `llm.refinePass` | `false` | `true` | `false` |
| Histogram stats in the prompt | `llm.histogramStats` | `false` | `true` (needs `sharp`) | `false` |
| Burst reuse | `llm.burstReuse` | `true` | `true` | `false` |
| LLM scene naming | `scenes.useLlm` | `true` (no-op without LLM) | `true` | `false` |
| Scene harmonization (AI runs) | `scenes.harmonizeCorrections` | `true` | `true` | `false` |
| Boundary check (2 thumbnails) | `scenes.boundaryCheck` | `false` | `true` | `false` |
| Photos tagged per segment | `scenes.maxTagsPerSegment` | `6` | — | — |
| Scene splitting | `scenes.maxGapMinutes` / `evJumpThreshold` / `splitByCamera` | `10` / `3` / `true` | — | — |

## 11. Quality features (Phase 6)

- [ ] 11.1 **Refine pass:** `"refinePass": true`. Analyze a few photos with **Re-analyse**: each takes about one extra
      draft render + one extra LLM call. Compare After images with refine off/on. Keep it only if it's better.
- [ ] 11.2 **Harmonization:** Find scenes, then an AI run over a whole scene (e.g. 10 photos of one sunset).
      Neighbouring shots should share white balance. The job result shows `aiHarmonizedScenes`. Compare
      with `"harmonizeCorrections": false` (new project name).
- [ ] 11.3 **Per-scene presets:** in Scene view, pick a preset in two or three scene headers → **Queue all
      scenes (N)** → one run per scene appears in the job queue, named after the scene.
- [ ] 11.4 **Histogram stats:** `"histogramStats": true` (needs `sharp`; check that
      `webapp\server\node_modules\sharp` exists). Re-analyse a backlit or overexposed photo. Its plan should be
      more sensible about highlights. With `sharp` installed, the LLM input is also downscaled to `maxImagePx`.
- [ ] 11.5 **Burst reuse:** analyze a burst (continuous shooting). The analysis job's counts show `burst: N`,
      and only the first frame calls the model.
- [ ] 11.6 **Boundary check:** `"boundaryCheck": true`, then Find scenes on a shoot where a short pause split one
      scene in two. The job notes say "boundary check merged …" when the model says same scene.
- [ ] 11.7 **Decide** for each of 11.1–11.6: keep on or off (Phase 6 exit criterion). Note it in the findings.

## 12. What to report back

- The Windows gate table (§2.3) and your AI verdict (§7.2).
- Which switches you'd set as defaults (§4.7, §7.3, §11.7).
- Anything that failed, with the step number and the server console lines.
