# Version 2 — progress log

Branch: `version_2_dev`. Plan: `Version_2_development_plan.md` (phases, gates, working rules §9).
One entry per phase: what was done, what was skipped and why, deviations from the plan, test status.

| Phase | Status |
|---|---|
| Planning | ✅ done — plan, Version 1 record, LLM design committed (2026-11-24) |
| 0a Measure tooling + Linux behaviour checks | ✅ done (2026-11-24) |
| 1 Pipeline foundations | ✅ done (2026-11-24) |
| 2 Batched rendering + fault isolation | ✅ built, **off by default** (Linux gate: NO-GO) |
| 3 Scene grouping (no LLM) | ✅ done (2026-11-24) |
| 4 LLM core + AI correction | ✅ built, **off by default** (`llm.enabled: false`) |
| 5 LLM scenes + review UI | ✅ done (needs `llm.enabled`) |
| 6 Quality | ✅ built; the AI-only features need `llm.enabled` |
| 7 Cloud providers | ⏸ on hold |

## Environment notes
- 2026-11-24 (planning session): the container had Node 22 only. No `pwsh`, RawTherapee, ExifTool
  or Ollama, and **no npm/apt/pip access**: the "Default" environment allows no package managers and
  no hosts. Created the personal environment **`auto-photo-enhance`**: package managers allowed, plus
  hosts `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
  `exiftool.org`, `raw.pixls.us`, `ollama.com`, `registry.ollama.ai`. The new hosts were reachable at
  once. The npm registry was still unreachable from the old machine, which keeps its earlier rules
  until it is replaced. Start dev sessions in that environment. The first dev session verifies what
  installs, and once that works, saves the install steps as the environment's setup script.

- 2026-11-24 (dev session 1): installed and verified in the new `auto-photo-enhance` environment:

  | Tool | Result |
  |---|---|
  | Node 22 + `npm install` | ✅ (root postinstall installs server + client) |
  | PowerShell 7.4.6 (`pwsh`) | ✅ from the GitHub release `.deb` |
  | Pester 5.7.1 | ✅ from **nuget.org** (`api.nuget.org/v3-flatcontainer/pester/…`). PowerShell Gallery is blocked (403), so `Install-Module` can't work |
  | RawTherapee CLI | ✅ **5.10** (Ubuntu apt). Windows has 5.12 |
  | ExifTool | ✅ 12.76 (apt) |
  | CC0 samples | ✅ 8 files in `_samples/` (6 ARW, 1 RAF, 1 NEF, all ISO ≤ 400) from raw.pixls.us |
  | Ollama | ✅ 0.40.18 (`ollama-linux-amd64.tar.zst`, not `.tgz` which is 404 now) + `qwen3.5:2b` (2.7 GB). 4B/9B not pulled: CPU only |
  | ImageMagick | was preinstalled; used only for dev-side colour measurements |

  **Baseline before any change:** Pester 24/24, client 105/105, server 159 pass / **2 fail** / 3
  skipped. The two failures were Linux-only: `pathSafety.test.js` uses Windows paths and Node's
  `path` follows POSIX rules on Linux. Fixed in production code without changing Windows behaviour
  (`isSafeRelPath` rejects both win32- and posix-absolute paths, and `resolvePhotoPath` treats `\` as a
  separator, which is a no-op on Windows). Now green.

  The install steps are saved as the environment's **setup script** (runs on fresh containers).
  It starts in the folder above the checkout: apt packages, pwsh, Pester, the Ollama binary,
  `npm install`, samples. It doesn't pull a model (needs `ollama serve` running). Run
  `ollama serve & ollama pull qwen3.5:2b` by hand. The script is proven step by step in this session,
  but not yet on a fresh container.
  pwsh sends telemetry to a blocked host. Set `POWERSHELL_TELEMETRY_OPTOUT=1` to keep the proxy log quiet.

---

## Phase 0a: measure tooling + Linux behaviour checks ✅

Done:
- `scripts/bench_rt.ps1`: cases A–F + X (behaviour), median of N runs, `results.json` + `results.md`,
  gate verdicts printed at the end. PS 5.1 compatible. `-Cases A,C` works through `-File`.
- `scripts/dev/` (Node, dev-only, no new dependencies): `step_calibration.js` (single-step grid
  per photo), `llm_experiment.js` (before/after HTML page + input-image agreement),
  `scene_report.js` (time/EXIF segments with thumbnails), `devlib.js`.
- Ran everything on Linux. Results and verdicts in **`_development/v2_benchmark_findings.md`**
  (labelled not-Windows). Summary: batching NO-GO (0.2 %), keep draft D, render-limiter best at 2,
  stdout live on Linux, `TemperatureBias` warmth has no effect (→ `Equal`), tint sign inverted,
  `qwen3.5:2b` too weak to judge anything.

Deviations:
- **The LLM core modules were built in 0a, not 4**, because the experiment script needs them:
  `pp3.js`, `correctionTable.js`, `correctionPlan.js`, `correctionToPp3.js`, `baseProfile.js`,
  `llm/` (schema, prompt, provider interface, Ollama + mock adapters), plus `sceneSegmenter.js` and
  the extended ExifTool read (`captureDates.js` `getPhotoMetadata`) for the scene report (Phase 3
  task 1–2). All unit-tested. Phases 3/4 wire them into the app.
- **Warmth step changed** from `[White Balance] TemperatureBias` (measured: no effect with auto-ITC)
  to `[White Balance] Equal`. **Tint sign flipped** (higher `Green` = greener). Measured, see findings.
- 30–50-photo LLM run and real-shoot scene comparison: **not possible here** (no photo library, CPU
  only). Moved to Phase 0b (test guide).

## Phase 1: pipeline foundations ✅

Done:
- `Build-RTArgs -Mode final|draft` in `lib_common.ps1` is now the only argument builder:
  `auto_enhance.ps1`, `preview_presets.ps1`, the batch path and the contract tests use it. Stack
  order base → format → AI → preset → (draft) draft override. Draft without an override file
  falls back to the plain stack (Version 1's graceful fallback).
- `profiles/preview_fast_resize.pp3` **renamed** (git mv, content unchanged) to
  `profiles/draft_override.pp3`. Phase 0a kept variant D.
- Composite preview-cache fingerprint (`previewCache.js` `previewFingerprint`): presets + all
  `profiles/*.pp3` + `defaultProfile`/`autoProfile`/exiftool-present + source size/mtime + (Phase 5)
  AI overlay hash. Manifest `{ version: 2, inputs }`. Old manifests count as stale. Fixes the
  Version 1 stale-tile bug. Checked live: HIT on repeat, MISS after touching `lowlight.pp3`.
- `Invoke-RawTherapee` streams stdout line by line (`-OnLine`), same return shape.
- `@@EVENT {...}` lines: `file_started/completed/failed/skipped`, `summary`
  (auto_enhance), `tile_started/completed/failed` (preview).
- Node: `runEvents.js` (events first, Version 1 regex fallback; a human line is held for one line
  so it is never double-counted), used by `/api/run` and `/api/preview`.
- `config.powershellPath` (default `powershell.exe` = Version 1). Lets the server run the scripts with
  `pwsh` (used here on Linux). Checked live end to end: a run and a 33-tile preview through the
  real server + pwsh + RawTherapee, progress driven by events.
- Tests: Pester `rtArgsBuilder.Tests.ps1`, `pipelineEvents.Tests.ps1`, `integration/rtContract.Tests.ps1`
  (tag `Integration`, skips without RawTherapee/samples, ran for real here). Node `runEvents.test.js`,
  `previewFingerprint.test.js`, `config.test.js`.
- Byte-identity spot check against the Version 1 scripts (`git show HEAD:`) on the same inputs:
  console output identical, ARW output byte-identical; the RAF differs only because RawTherapee's
  X-Trans output isn't deterministic (three identical calls → three checksums).

Deviations:
- **Events are printed only with `-EmitEvents`** (the server always passes it). The plan said
  "next to the existing lines". The switch keeps the `.bat` console output exactly as in
  Version 1 (§9.4 "byte-identical").
- Found while testing live: my `config.js` edit had dropped `repoRoot`, and the server's
  `uncaughtException` handler swallowed the boot error, so the test suite still passed. Fixed, and
  `config.test.js` now pins the core config paths.

## Phase 2: batched rendering + fault isolation ✅ (off by default)

Done (all in `auto_enhance.ps1` + `lib_common.ps1`, only when `config.batchRender: true` or
`-BatchRender true`):
- Skip check first, then signature = ordered `-p` list + output subfolder + mode (`Get-BatchSignature`).
- `Split-IntoBatches`: unique stems (case-insensitive), `maxBatchSize` (20), `maxCommandChars`
  (16000, measured on the real quoted argument string).
- One call per batch into `<out>/.rt_batch_<guid>/`, outputs moved to their final names as they finish.
  Progress from `progressSource`: `outputFolder` (default; 250 ms poll, size-stable + exclusive-open
  check) or `stdout` (`Processing:` lines). A final pass at exit picks up anything missed.
- Fault isolation: a file the batch didn't produce is retried **alone** through the Version 1 path
  (attempt markers, quarantine after `quarantineAfterFailures`). Each batch re-checks the skip
  rule at its start, so flattened same-name outputs behave as in Version 1.
- CSV: one row per file, in input order. New `batch_started` event carries the temp folder.
- Cancel (`server.js`): deletes the in-flight batch's temp folder + stdout/stderr files as well as
  the current output (`cancelCleanupPaths`, tested).
- Tests: Pester `batchRender.Tests.ps1` (grouping, duplicate stems, size + char budget,
  subfolders, AI overlay in signature, temp→final naming, CSV rows, retry alone + quarantine
  after 2, single-file batch, off by default, locked/growing file not reported early). The
  integration suite runs a real 4-file batch with a truncated file and checks events arrive
  during the batch. Real runs here in both progress modes: OK.

Deviations / notes:
- Default **`batchRender: false`** (plan §9.3). The Linux gate says NO-GO. Your Windows bench decides.
- `-BatchRender` is a **string** (`true`/`false`): `powershell -File` cannot pass a `[bool]`.
- The `-CorrectionsJson` parameter (Phase 4) went into `auto_enhance.ps1` in the same
  restructuring, because the AI overlay is part of the batch signature. Its tests land with Phase 4.
- The render limiter is Phase 4 (it limits the `analyze` lane's draft renders).
- Commits: Phase 0a is one commit. Phases 1 and 2 are a second commit, because they touch the same
  restructured loop in `auto_enhance.ps1` and couldn't be split cleanly.

Test status at the end of Phase 2: server 209/209 (3 skipped as before), client 105/105, Pester 55/55
(incl. 5 Integration tests against real RawTherapee 5.10).

## Phase 3: scene grouping without the LLM ✅

Done:
- `captureDates.js`: the same batched `exiftool -j -n` call reads ISO, ExposureTime, FNumber, Flash,
  Model (`getPhotoMetadata`); `getCaptureDates` keeps its Version 1 contract. `/api/photos` entries
  gain `iso/exposureTime/fNumber/flash/model` (extra fields only).
- `sceneSegmenter.js` (built in 0a): time gap, EV100 jump, flash on/off, camera change. Crosses midnight.
  Names like `14:05–14:40 · 23 photos`.
- `scenesStore.js`: `.webapp_cache/scenes/<folder>_<hash>.json`, written atomically. Incremental:
  only days with added/removed/replaced photos (size+mtime) are regrouped. All days are regrouped
  on first run, on changed options, or with `force`. Scenes with `source: "edited"` are never
  regrouped/renamed, only lose vanished photos. Deterministic scene ids. Pure edit ops: rename,
  merge (neighbours only), split after a photo, move photos.
- Endpoints: `GET /api/scenes`, `POST /api/scenes/detect {days?, force?}` (new `scenes` job lane),
  `PATCH /api/scenes/:id`, `POST /api/scenes/merge`, `POST /api/scenes/:id/split`, `POST /api/scenes/move`.
- Picker: **Group by: Date | Scene** switch (remembered). Scene view = day → scene → photos, the day
  headers keep "Select day". `SceneHeader`: thumbnail strip, name, how it was grouped, **Select scene**.
  "Ungrouped" bucket for photos in no scene. **Find scenes** button (only the filtered days when a date
  filter is set). Search matches scene names (and Phase 5 captions). Selecting a scene with an empty
  project name names the project after the scene. Job queue labels for `scenes`/`analyze` jobs.
- `config.example.json`: `scenes` block (`maxGapMinutes` 10, `evJumpThreshold` 3, `splitByCamera`
  true, `useLlm` true, `harmonizeCorrections` true).
- Tests: `scenesStore.test.js` (9), `sceneSegmenter.test.js` (12), `sceneUtils.test.js` (7), picker
  scene-view tests (4). Checked live: detect job, rename, merge refusal for non-neighbours, merge,
  screenshot of the scene view.

Deviations:
- The plan has "rename / merge / split / move" endpoints in Phase 3 but their UI in Phase 5. Built
  as planned: endpoints now, the editor UI in Phase 5.
- Scene view has no month level (plan: "day → scene → photos").

Test status: server 221/221, client 116/116, Pester 55/55.

## Phase 4: LLM core + per-photo AI correction ✅ (off by default)

Done:
- `llm/` provider interface, **Ollama** + **mock** adapters, one JSON schema, prompt + `PROMPT_VERSION`
  (built in 0a). `llm` config block (`enabled: false`) in `config.example.json`, read by `config.js`.
  `/api/health` gains `llm: { enabled, status: disabled|reachable|unreachable|model_missing, detail }`
  (Ollama: `GET /api/tags`, model must be pulled). An enabled-but-unusable LLM is a health **warning**.
  The server logs the LLM status at start-up.
- Correction plan: `correctionPlan.js` (validate/clamp/all-zero), `correctionTable.js` (**no
  noiseReduction/sharpening**, review note 3), `correctionToPp3.js` (absolute base + step x unit x
  strength, read from the photo's actual base profile + format overlay), `presetKeyOwnership.test.js`.
- `correctionsCache.js`: plans keyed by photo (path+size+mtime) + provider + model + prompt version +
  input kind + base-profile fingerprint. User edits are stored separately and always win.
  **Content-addressed overlays** `pp3/<sha1>.pp3`. Drafts. Per-run `-CorrectionsJson` files.
- `analyze` lane: `analyzer.js` (edit > cache > LLM; input image per `llm.inputImage`, draft renders
  through the new **`scripts/render_draft.ps1`** = `Build-RTArgs -Mode draft`, one at a time, draft failure
  → embedded fallback; `llm.concurrency` workers; one retry on a non-JSON reply).
  `auto` = embedded JPEG while a run is rendering, else draft render.
- Pipeline: `auto_enhance.ps1 -CorrectionsJson <file>` → overlay after base/format, before preset;
  AI runs named `<name>_ai[_<preset>].jpg` (also `outputFileFor(..., {ai})` for cancel cleanup); CSV
  columns `AiCorrection`, `AiScene` (only in AI runs); `-WaitForCorrections`.
- **Overlap** (task 6): `planBoard.js`. The run's AI analysis is queued in the `analyze` lane in render
  order. The script waits per photo and prints `waiting_for_plan`, and only then does Node start that photo's
  `llm.planWaitMs` timer. A failed analysis gives an all-zero entry at once. On timeout: all-zero +
  note. Cached/edited plans are on the board before rendering starts.
- UI: **AI-guided correction** toggle + **Subtle / Normal / Punchy** dial in `RunPanel` (only when
  `health.llm` is enabled and reachable; otherwise a one-line reason). Choice remembered. Job queue shows
  "· AI (strength)" and labels analyze jobs.
- Endpoints: `POST /api/analyze`, `GET/PUT/DELETE /api/corrections?path=`, `aiCorrection`/`aiStrength`
  in `/api/run` (and kept on retry).
- Tests: node `aiOverlap.test.js` (slow photo 3 doesn't time out 4–20; fast provider never waits; dead
  provider → all-zero immediately; timer starts at the photo; cache/edits; non-JSON retry),
  `correction.test.js` (+ integer keys); Pester `aiCorrection.Tests.ps1` (stack order, naming, CSV,
  null overlay, no-JSON = Version 1, wait + give-up); Integration: every step at ±2 x every strength renders.
- **Live checks** (real server + pwsh + RawTherapee): mock-provider AI run → `_ai_teal_orange.jpg` files;
  Ollama on a dead port → normal renders named `_ai`, note in job/CSV/health, never a failed job;
  **real Ollama `qwen3.5:2b`** AI run of 2 photos → 73–78 s per analysis on CPU (embedded input), photo 2's
  plan arrived while photo 1 rendered, both rendered with their overlays.

Bugs found and fixed while testing for real:
- **Fractional values for integer keys** (`HighlightCompr=34.5` at strength 1.5) made RawTherapee reject
  the whole overlay. Table rows now carry `integer: true`. Unit test + real-CLI integration test cover
  every step x strength.

Deviations:
- **Render limiter:** analyze-side draft renders are limited to one process, and `inputImage: auto` uses the
  embedded JPEG during a run (plan review note 11). Limiting the *preview* lane while a run is
  active would change Version 1 preview behaviour, so it is opt-in: `previewConcurrencyWhileRunning`
  (unset = Version 1's 3).
- **Batching + AI:** with `batchRender: true`, the script waits for **all** plans before grouping, instead
  of per batch. Overlap within a batched AI run is lost. Both features are off by default, and per-photo
  overlays rarely share a signature anyway (plan review note 3).
- The embedded JPEG is sent at its native size (Sony: 1616x1080). Node has no image library, so
  `maxImagePx` is not applied. On CPU that makes embedded analysis 2–4x slower than a draft render.
- Phase 5 groundwork in the same commit: `sceneGrouper.js`, `llm/scenePrompt.js`, `refineScenes` in
  `aiService.js` (+ `sceneGrouper.test.js`).

Test status: server 235/235, client 119/119, Pester 62/62 (incl. 6 Integration against RawTherapee 5.10).

## Phase 5: LLM scenes + review and edit UI ✅

Done:
- **Scene tags:** `sceneTags` (setting / subject / light / caption, fixed vocabularies, caption ≤ 8 words)
  in the analysis schema. Tags-only mode (`tagsOnlySchema`, short prompt, embedded JPEG), cached per
  photo + model + prompt version. Tags from an existing correction plan are reused for free. Only an
  even sample of each segment is tagged (`scenes.maxTagsPerSegment`, default 6, first + last always),
  which keeps "Find scenes" affordable on big folders.
- **Per-day text-only call** (`llm/scenePrompt.js`, `sceneGrouper.js`): merge neighbouring segments,
  split one after a photo index, name groups. Strict validation (`applySceneReply`): non-contiguous,
  overlapping or unknown groups are dropped, as are splits on merged segments or out of range. Segments
  missing from the reply stay alone. Any failure falls back to the Phase 3 segments for that day. Edited
  scenes are still never touched. `scenes.useLlm: true` is a no-op without an enabled, reachable LLM.
- **Correction review** (`CorrectionReview.jsx`, below the preset grid, only with a usable LLM):
  "Analyze N selected" / "Re-analyse" (up to 24 cards). Per photo: before (base draft) / after
  (base + AI overlay draft) images, scene/lighting/issues/caption/notes, chips with − / + per step,
  "All to 0", "Reset to AI". `PUT/DELETE /api/corrections`, `POST /api/corrections/render` (new
  `review` lane) re-renders only the new "after" (drafts are cached by overlay hash).
- **Scene editor** (`SceneActions.jsx` in each scene header): Rename (inline), Merge ↓ (with the next
  scene), Split (after the last selected photo of the scene), Move N here (selected photos from other
  scenes). Uses the Phase 3 endpoints. Search by captions works through `sceneUtils`.
- **Preview grid on the AI base:** `00_ai_base` tile (base + AI overlay, no preset) next to
  `00_base_only` when AI is enabled and the photo already has a plan (cached or edited, never a new LLM
  call). The overlay hash joins the composite fingerprint, so editing a plan re-renders that photo's grid only.
  `preview_presets.ps1 -AiOverlay`.
- Mock provider answers per schema (scene grouping / tags / plan) so every flow can be tried with
  `"provider": "mock"`.
- Tests: `sceneGrouper.test.js` (6), `correctionSteps.test.js`, `SceneActions.test.jsx`,
  `CorrectionReview.test.jsx`, PresetPreview AI-tile tests. **Live:** Find scenes with the LLM step (mock),
  analyze → before/after URLs → edit (+2 exposure) → re-render → `00_ai_base` tile in the preview job,
  plus screenshots of the review panel and the RunPanel toggle.

Deviations:
- The review shows the "after" image at `llm.strength` (config), not at the RunPanel dial.
- Split in the scene editor uses the photo selection ("after the last selected photo in this scene")
  instead of a separate pick mode. Move uses the selection too.

Test status: server 235/235, client 129/129, Pester 62/62.

## Phase 6: quality features ✅

Done (each behind its own switch):
- **Refine pass** (`llm.refinePass`, default **false**): after pass 1, a **real RawTherapee draft render**
  with the pass-1 overlay ("after") next to the base draft ("before") goes back to the model, which may
  change each step by at most ±1. One round; the result is clamped to ±2. No `sharp` approximation
  (decided). Any failure keeps the pass-1 plan. The plan cache key includes the refine flag.
- **Scene harmonization** (`scenes.harmonizeCorrections`, default true, acts only in AI runs): photos of
  one saved scene (≥ 2 in the run) are held until all have plans. warmth/tint/dehaze go to the scene median,
  clarity/saturation/contrast halfway toward it, exposure/highlights/shadows stay per photo. Your edited
  plans are never changed and don't count toward the median. The run result reports `aiHarmonizedScenes`.
- **Per-scene presets + Queue all scenes:** a preset dropdown in each scene header (remembered per
  browser) and **Queue all scenes (N)** in the scene-view toolbar. It queues one normal run job per scene
  that has a preset, named after the scene, with the RunPanel's AI setting.
- **Histogram stats** (`llm.histogramStats`, default **false**): mean luminance, % clipped highlights/shadows,
  mean saturation, RGB of the brightest 5 %, added to the prompt. Uses **`sharp` as an optional dependency**
  (`webapp/server` `optionalDependencies`). Without it the stats are simply skipped. When available, `sharp`
  also downscales the LLM input to `llm.maxImagePx` (1024), which fixes the slow embedded-JPEG input noted
  in Phase 4.
- **Burst reuse** (`llm.burstReuse`, default true, acts only in AI analyses): frames ≤ 2 s apart with the same
  ISO/shutter/aperture reuse the first frame's plan (the leader is the burst's first photo in render order,
  so a single worker can't deadlock).
- **Two-thumbnail boundary check** (`scenes.boundaryCheck`, default **false**): for a boundary caused only
  by a time gap ≤ 2x `maxGapMinutes`, the last/first photos either side go to the model ("same scene?").
  Yes = merged before naming.
- Tests: `phase6.test.js` (harmonize, bursts incl. leader order, stats, refine ±1 with two real-render jobs,
  refine off = one call), `scenePresets.test.js`. **Live:** refine pass with real draft renders, stats
  computed by sharp (36.8 % clipped sky), harmonization of the A7S scene in an AI run.

Not done / deviations:
- **"Each feature measured on your photos"** (the exit criterion) is not possible here: no photo library and only a
  2B CPU model. So the defaults follow the plan: refine, stats and boundary check **off**; harmonize and burst
  reuse **on**, but they only act when AI correction is switched on. Their real value is for your test (test guide §6).
- Scene preset assignments live in the browser (localStorage), not on the server.

Test status: server 242/242, client 130/130, Pester 62/62.
