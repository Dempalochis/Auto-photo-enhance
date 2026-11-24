# Version 2 — development plan

Status: **plan, not implemented.**
What already exists (Version 1, phases 1–9) is described in `Version_1.md`; its "Known limits"
section is the starting point for this plan.

This document combines two earlier plans into one sequence of development phases:
- the **RawTherapee performance & architecture plan** (benchmarking, draft renders, batching,
  structured progress, fault isolation, CPU/GPU overlap);
- the **LLM integration plan** (`_development/llm_integration_plan.md`): per-photo AI colour
  correction, scene grouping, swappable LLM providers.

`llm_integration_plan.md` remains the **detailed design reference** for the LLM parts: schemas,
the step → pp3 table, prompts and the provider adapters. This document says *what is built in
which order*, and refers to that file as "LLM §n" where the detail lives there.

---

## 1. Engine decision (settled)

**RawTherapee (`rawtherapee-cli`) stays the rendering engine.** No migration to PhotoCraft or
another GPU raster editor.

- **It fits what the app does:** raw in (`.arw/.nef/.dng/.raf`) → global colour and tone edits →
  flat JPEG out (`-j95`). Layers, masks, compositing and PSD export are not used, and none of
  the planned features need them.
- **The tuned presets are the main asset:** the 32 Sony-tuned presets and the base profiles were
  calibrated by eye. Porting them to another engine means re-grading every one, and taking on the
  risk of breaking changes in a young tool.
- **It suits the LLM design:** the LLM's output becomes a plain-text `.pp3` overlay. That keeps the
  Node layer stateless, easy to inspect and easy to test.
- **No GPU contention:** RawTherapee is CPU-only, which leaves the GPU and its memory free for a
  local Qwen vision model.

Speed is improved inside RawTherapee instead (Phases 1 and 2). The LLM design is mostly
engine-neutral: only `correctionTable.js` / `correctionToPp3.js` are RawTherapee-specific. A
future engine change stays possible but is not planned.

---

## 2. Engineering principles

1. **Measure before optimizing.** Every speed change has a go/no-go gate based on Phase 0 numbers.
2. **The non-LLM workflow never changes behaviour.** Without the new options, the outputs, names,
   logs and exit codes are identical to today. Every feature is opt-in.
3. **Profiles are stacked, never edited.** Everything new is another `-p` layer: AI correction
   before the preset, draft override last. Base profiles and presets are never modified at run
   time.
4. **One way to build arguments.** All `rawtherapee-cli` arguments come from one function per
   render mode, so final, draft, preview and AI renders can't drift apart.
5. **Failures stay per file.** One bad raw file or one failed LLM call never fails a batch. Files
   fall back to today's behaviour (all-zero correction, retry, quarantine).
6. **Contract tests guard the CLI.** Mocked Pester tests check arguments. A separate opt-in suite
   that runs the real RawTherapee checks real behaviour.

---

## 3. Review notes on the performance plan

I went through the performance plan against the current code. Most of it carries over unchanged.
These points changed, and the reason for each:

1. **`-q` is already in production.** `auto_enhance.ps1` and `preview_presets.ps1` both pass `-q`
   today. A "with/without `-q`" benchmark step isn't needed, so the baseline already includes it.
2. **A draft render already exists.** The preset preview grid uses `-f` + a resize override
   (`profiles/preview_fast_resize.pp3`, Scale 0.15) + `-q` and measured **~6 s per render**.
   `docs/gpu_spike_findings.md` explains why that's the floor so far: demosaicing runs at full
   sensor resolution *before* any `[Resize]`. `-f` already selects the fastest demosaic and skips
   noise reduction, sharpening, defringe and wavelets. So a `draft_override.pp3` with `Method=fast`,
   noise reduction off and Scale 0.25 mostly repeats what `-f` already does.
   - The **~1–2 s target is unlikely** from settings alone. Phase 0 measures it before we rely on it.
   - Instead of a new file, there is **one draft profile** that the preview grid and the LLM both
     use. Rename `preview_fast_resize.pp3` → `profiles/draft_override.pp3`, plus `-f`.
   - If draft renders stay ~6 s, the fallback for the refine loop is in Phase 6.
3. **Noise and sharpening can't be judged on a 25% image.** Noise is invisible at that scale. So
   instead of a "noise-enabled draft variant", the LLM **does not adjust noise reduction or
   sharpening at all**. Code sets them from ISO, which `lowlight.pp3` branching already partly
   does. This removes a task and a source of bad decisions.
4. **The draft/final switch belongs in the argument builder, not in `correctionToPp3.js`.** The AI
   overlay is the same in both modes. Only the rest of the `-p` stack and the flags differ.
5. **How much batching gains is unknown until measured.** The ~22 s per photo has never been split
   into "process start" and "actual rendering". If start-up is ~1 s, batching saves <5%. Batching
   is therefore gated on Phase 0 (start-up must be ≥10% of per-file time).
6. **AI mode batches poorly.** With per-photo AI corrections, almost every photo has a different
   `-p` stack (its own overlay), so "group by profile signature" produces groups of one. The
   ISO-branched base profile already varies per file too. Batching mainly speeds up the **non-AI**
   mode, plus AI photos whose plans happen to match. Scene harmonization (LLM §7.5) makes matches
   more common.
7. **Multi-file `-c` breaks the current output naming.** With `-o <dir>` and several inputs,
   RawTherapee names each output `<basename>.jpg`. The app needs `<name>_<preset>.jpg` /
   `<name>_ai…jpg`, and mirrored subfolders where two folders can hold the same filename. So each
   batch renders into a **temp folder, then each file is moved to its final name**. Groups are also
   keyed by output subfolder.
8. **Fault isolation has to ship with batching, not after it.** Today a corrupt file fails alone
   and is quarantined after 2 attempts. Batching without per-file recovery would make that
   worse. Both go in the same phase.
9. **Per-file progress needs streamed output.** `Invoke-RawTherapee` currently buffers all of
   RawTherapee's output (`| Out-String`). With one call for many files, it must read stdout line by
   line. RawTherapee's exact per-file output line (`Processing: …`?) has to be checked against the
   real CLI in Phase 0, not assumed.
10. **Progress lines should not replace the human-readable output.** The `.bat` CLI users read the
    console. JSON events are printed as an extra line with a prefix (`@@EVENT {...}`), while the
    existing `Enhancing …` / summary lines stay. Node switches to the events, and the old regex
    parsing stays as a fallback.
11. **Separate queues already exist.** `jobQueue.js` runs an independent FIFO lane per job type.
    The GPU/CPU split is a new `analyze` lane (and `scenes`) next to `run`. `p-limit` isn't needed.
    Two things to watch:
    - the LLM's "base render" input is a RawTherapee render, so `analyze` also uses the CPU;
    - the preview lane already runs up to 3 renders in parallel.

    A small shared **render limiter** across lanes decides how many RawTherapee processes may run at
    once (default 1 while a `run` job is active). Pass-1 analysis uses the embedded JPEG instead of
    the draft render when `config.llm.inputImage = "auto"` and a run is in progress.
12. **Contract tests against the real RawTherapee are a separate, opt-in suite.** The current Pester
    tests mock `Invoke-RawTherapee` and need nothing installed. The real-CLI tests (draft output
    size, no help-text fallback, batch events) are tagged `Integration` and skip when RawTherapee
    isn't installed. That keeps `npm test` and the default Pester run fast and runnable anywhere.

---

## 4. Phases

Each phase can ship on its own and leaves the app working. The order is: **measure → pipeline
foundations → batching → scenes without LLM → AI correction → review UI → quality → cloud.**
This order delivers the non-LLM wins first, and means every LLM feature is built on a measured,
tested pipeline.

### Phase 0 — Measure and validate (no production changes)

**Goal:** real numbers and visual checks that decide what gets built.

Tasks
1. **Test set:** 5–10 Sony `.ARW` + 1 `.RAF` + 1 `.NEF` (`_samples/` already holds format
   samples), covering low and high ISO.
2. **`scripts/bench_rt.ps1`** (stand-alone, `Measure-Command`), each case run 3× and the median
   recorded:
   - **A. Production final:** today's stack (`-q` already on), one process per file.
   - **B. Process start cost:** RawTherapee on a tiny DNG (or a profile that resizes to ~64 px),
     close to pure start-up and profile/ICC loading.
   - **C. Batch:** the same N files in one `-c f1 f2 …` call vs N calls. Per-file difference = the
     real batching gain.
   - **D. Current draft:** `-f` + `preview_fast_resize.pp3` (≈6 s reference).
   - **E. Draft variants:** D + Scale 0.25 vs 0.15. D without `-f` but with the explicit
     `draft_override.pp3` settings (fast demosaic, no denoise). Check whether any of them really
     beats D.
   - **F. Parallel:** 2 and 3 concurrent final renders on the 4-core machine (throughput, not
     latency). This informs the render limiter.
3. **Check the real CLI's behaviour** on a **5-file batch**:
   - what RawTherapee prints per file;
   - **whether that output arrives live or only in a burst at the end.** A non-console pipe usually
     makes C/C++ programs buffer stdout in blocks (~4 KB), so per-file lines may arrive late;
   - what it names outputs with `-o <dir>`;
   - the exit code when one file in the batch is corrupt (use a truncated `.ARW`).

   Record the result as `progressSource: stdout | outputFolder` for Phase 2.
4. **LLM experiment** (LLM §9, Phase 0):
   - calibrate the step table by eye on 5 photos;
   - check that `tint` takes effect with auto-ITC white balance;
   - run 30–50 photos through Ollama/Qwen and write a before/after HTML page;
   - compare plans made from a **draft render vs. a full render vs. the embedded JPEG** of the same
     photo. If the plans match, the cheap input is good enough.
5. **Scene experiment:** run the time/EXIF segmentation (LLM §7.1 step 1) on 2–3 real shoots and
   compare with your own manual grouping.
6. Write it all to `_development/v2_benchmark_findings.md` (same style as
   `docs/gpu_spike_findings.md`).

**Decision gates (written into the findings):**
- **Batching (Phase 2):** go if C saves ≥10% per file.
- **Draft profile:** which variant D/E becomes `draft_override.pp3`, and its real latency.
- **LLM input default:** `draftRender` vs `embedded`.
- **AI correction (Phases 4–6):** go only if the before/after page actually looks better to you.
- **Dropped steps:** which adjustment steps don't work (e.g. `tint`) and are removed.

Exit: findings doc written; each gate has a yes/no.

---

### Phase 1 — Pipeline foundations: render modes, streamed progress, contract tests

**Goal:** restructure the CLI layer so the later features (batching, AI overlay, draft renders)
plug in without changing behaviour today.

Tasks
1. **One argument builder** in `lib_common.ps1`:
   `Build-RTArgs -Mode final|draft -Base -FormatOverlay -AiOverlay -Preset -Inputs -Out`.
   - The `-p` order is always: base → format overlay → AI overlay → preset → (draft only)
     `draft_override.pp3`.
   - `draft` adds `-f` and the draft override.
   - `auto_enhance.ps1` and `preview_presets.ps1` both use it. `preview_presets.ps1`'s own builder
     (lines ~109–116) is removed.
2. **`profiles/draft_override.pp3`:** the variant chosen in Phase 0. Rename
   `preview_fast_resize.pp3` **directly**, with no compatibility copy: both scripts move to the new
   builder in this phase, and Pester covers them.
   - It stays last in the stack, so presets can't override it.
   - **Composite preview-cache fingerprint** (`previewCache.js`). Today the fingerprint covers
     **only the presets**, so editing any other input keeps serving stale tiles. This is already a
     bug in Version 1, and Phase 0 tuning of the draft profile would hit it constantly. The new
     fingerprint covers every input a tile is rendered from:
     - every preset (as now);
     - **all of `profiles/*.pp3`**: base profiles, format overlays (`raf.pp3`) and
       `draft_override.pp3`. The whole folder is cheaper and safer than working out in Node which
       base profile ISO branching will pick (that happens in PowerShell). Editing an unused
       profile costing a needless re-render is a fine trade;
     - the `config.json` fields that change which profile is chosen: `defaultProfile`,
       `autoProfile.*`, `exiftoolPath` present or not;
     - the source raw file's size and mtime (a re-exported or replaced file with the same name);
     - Phase 5 adds the photo's AI overlay content hash, for the `00_ai_base` tile.

     Each input stays mtime + size (as now, no reading of file contents). The manifest stores
     `{ version: 2, inputs: {...} }`. Old manifests count as stale, which is a one-time re-render,
     the same tolerance `isManifestFresh` already has for old formats.
   - Unit tests: changing each input on its own invalidates the cache, and an unchanged set
     doesn't.
3. **Streamed RawTherapee output:** `Invoke-RawTherapee` reads stdout line by line (an
   `-OnLine` script block), not `Out-String`. The return shape stays `{ Stdout, ExitCode }`, so
   the current mocks keep working.
   - With one file per call (Phases 1 and 4), this is only used for logging and the `Usage:` check.
     Live progress in batch mode comes from whichever source Phase 0 confirmed works (Phase 2,
     task 3).
4. **Structured events:** `auto_enhance.ps1` prints
   `@@EVENT {"event":"file_started|file_completed|file_failed|file_skipped","file":"…","index":n,"total":N,"note":"…"}`
   next to the existing lines, plus a final `@@EVENT {"event":"summary",…}`.
   - `runner.js` / `makeRunJobFn` read events first, with the regex parser kept as a fallback.
   - Same for `preview_presets.ps1` (`tile_started/tile_completed`).
5. **Pester:**
   - mocked tests for the builder (stack order per mode, draft flags) and for the event lines;
   - a new **`Integration`-tagged** suite `scripts/tests/integration/rtContract.Tests.ps1`, skipped
     when no RawTherapee is found. It checks: draft render exits 0, no `Usage:` help text, output ≈
     expected size; final render matches today's dimensions.
6. **Node tests** for event parsing and the fallback, in the style of `runProgress.test.js`.

Exit: all existing Pester + node tests pass unchanged; outputs are byte-identical to before for
the same input (spot-checked); UI progress driven by events.

---

### Phase 2 — Batched rendering with per-file fault isolation *(only if the Phase 0 gate passes)*

**Goal:** remove repeated RawTherapee start-up across files that share the same profile stack,
without losing per-file progress, naming, cancel or quarantine.

Tasks
1. **Profile signature, worked out in PowerShell** (it already resolves ISO branching and format
   overlays per file): `signature = ordered -p list + output subfolder + mode`. Files already done
   are removed first (today's idempotency check), then the rest are grouped by signature.
2. **Splitting a signature group into batches.** A batch is closed and a new one started for the
   same signature as soon as any limit is reached:
   - **Unique file stems:** at most one file per `[IO.Path]::GetFileNameWithoutExtension()` in a
     batch, compared case-insensitively. RawTherapee names temp outputs by stem, so `DSC001.ARW`
     from two source folders (possible when files outside `-PhotosRoot` flatten into the same
     output folder), or `DSC001.ARW` + `DSC001.RAF`, would overwrite each other in `<tempdir>`.
     A duplicate stem moves to the next batch of that signature.
   - **File count:** `config.maxBatchSize` (default 20).
   - **Command-line length:** the full argument string as `Build-RTArgs` will pass it, quoting
     included, must stay under `config.maxCommandChars` (default 16000). The Windows
     `CreateProcess` hard limit is 32,767, so this leaves a wide safety margin for long nested
     paths and 4–5 `-p` profiles.
3. **One call per batch:** `rawtherapee-cli -o <tempdir> -j95 -Y -q -p … -c f1 f2 …`, with one
   fresh temp folder per batch. Each output is then **moved** from the temp folder to its final
   name (`_preset` / `_ai` suffix, mirrored subfolder). Live progress comes from the source Phase 0
   confirmed:
   - `progressSource: stdout`: per-file lines from the streamed output.
   - `progressSource: outputFolder` (expected, because of pipe buffering): poll `<tempdir>` every
     250 ms (simpler and more reliable on Windows than `FileSystemWatcher`). A `.jpg` counts as
     finished when its size has stopped changing **and** it can be opened for exclusive access
     (the write lock is released). Only then is `file_completed` emitted and the file moved. The
     next file in input order becomes `file_started`.
   - Whatever is left in `<tempdir>` when the process exits is handled the same way, so no file is
     lost if polling misses something.
4. **Fault isolation (same phase, not later):** after a group finishes, a file whose output is
   missing or empty is retried **alone** through the per-file path. That path uses today's
   attempt markers and quarantine after `quarantineAfterFailures`, so one corrupt `.ARW` can never
   fail its group, and quarantine behaves exactly as now.
5. **Cancel:** `job.onCancel` kills the process (as now), then deletes the temp folder and any
   partial final output of the in-flight file. Finished files from the group stay (same rule as
   today: a finished file is fine).
6. **Opt-in, then default (decided):** `config.batchRender: false` for one release, then `true`
   once the integration suite and real use show no regressions.
7. **Tests:**
   - Pester (mocked): grouping by signature; duplicate stems split into separate batches;
     the character budget splits a batch of long paths; two subfolders with the same filename end
     up in different groups; temp → final naming; a single failed file retried alone and
     quarantined after 2 attempts; the CSV log keeps one row per file;
   - progress from the output folder (node or Pester with a fake writer): a file still being
     written or locked is not reported or moved early;
   - integration: a real 5-file batch with one truncated file, checking that progress events
     arrive *during* the batch and not only at the end.

Exit: with `batchRender: true`, the same outputs and log rows as Phase 1. Measured per-file
speed-up recorded in the findings doc.

---

### Phase 3 — Scene grouping without the LLM

**Goal:** select a whole scene in one click and render it with one preset. This is useful on its
own, needs no LLM, and builds the grouping infrastructure the LLM improves later.
Detail: LLM §7.1 step 1, §7.2–7.4, §7.7.

Tasks
1. Extend `captureDates.js`'s batched ExifTool read with ISO, ExposureTime, FNumber, Flash and
   Model (same batching, so no extra cost).
2. `sceneSegmenter.js` (pure, unit-tested): split on time gaps (`maxGapMinutes`), EV jumps
   (`evJumpThreshold`), flash on/off and camera change. Names made from the time range:
   `"14:05–14:40 · 23 photos"`.
3. `scenesStore.js`: per-folder `.webapp_cache/scenes/<folder>.json`, regrouping only affected
   days, edited scenes never overwritten.
4. Endpoints `GET /api/scenes`, `POST /api/scenes/detect` (new `scenes` lane), rename / merge /
   split / move.
5. Picker:
   - a **Group by: Date | Scene** switch (day → scene → photos);
   - `SceneHeader` with **Select scene**, reusing `onSelectMany` like `DayHeader`, and a `scene`
     row type in `useVirtualRows`;
   - an "Ungrouped" bucket, search by scene name, project name defaulting to the scene name.
6. Client tests for `groupByScene()` (`sceneUtils.test.js`); server tests for the segmenter and
   the store.

Exit: select a scene → pick a preset → Run works end to end with `scenes.useLlm: false`.

---

### Phase 4 — LLM core: providers + per-photo AI correction *(only if the Phase 0 gate passes)*

**Goal:** the "AI-guided correction" toggle. The LLM fine-tunes the base correction of each
photo; your preset is applied on top. Detail: LLM §1–3, §5, §6.1–6.2, §8.

Tasks
1. `webapp/server/llm/`: provider interface, **Ollama** and **mock** adapters, the single JSON
   schema, the prompt + `PROMPT_VERSION`. The `llm` config block (`enabled: false` in
   `config.example.json`), and the `llm` status in `/api/health` / `startupChecks.js`.
2. **Correction plan** without `noiseReduction`/`sharpening` (review note 3): `correctionPlan.js`
   (validate/clamp/all-zero fallback), `correctionTable.js` (calibrated in Phase 0),
   `correctionToPp3.js` (base value + change, with an INI reader for the actual base profile per
   file).
3. **`presetKeyOwnership.test.js`:** fails if any preset sets a key the AI owns.
4. **`analyze` lane** (= the "GPU queue"): input image per `config.llm.inputImage`
   (`draftRender` | `embedded` | `auto`, from the Phase 0 decision), using the Phase 1 draft render
   mode. Corrections cache (LLM §8). A **shared render limiter** across lanes (review note 11).
5. **Pipeline:** `-CorrectionsJson <file>` in `auto_enhance.ps1` → the AI overlay goes in the
   builder's slot before the preset. `_ai` output naming (+ `outputFileFor()` for cancel cleanup).
   CSV columns `AiCorrection`, `AiScene`.
   - Batching (Phase 2) works unchanged: the AI overlay is just part of the signature.
   - **Content-addressed overlays:** the overlay file is named by the hash of its contents
     (`.webapp_cache/corrections/pp3/<sha1>.pp3`). Two photos with the same base profile and the
     same final values share one file, and therefore one signature, which helps batching for free.
     Expect this to be uncommon before scene harmonization (Phase 6): with AI mode on, most photos
     still get a unique stack. That's an accepted trade-off for per-photo accuracy. If you mostly
     work with AI mode on, the Phase 0 batching gate decides on that basis whether Phase 2 is worth
     building at all.
6. **Overlap:** a run with the AI toggle on analyses photo N+1 while photo N renders. Analysis
   goes through the `analyze` lane, rendering through `run`.
   - The analyze lane works through the batch in render order and may run ahead freely.
   - **The run waits for a photo's plan only once it reaches that photo.** The timeout
     (`llm.planWaitMs`, default = `llm.timeoutMs`) **starts when the run starts waiting for that
     photo**, not when the job was queued. A long queue therefore never times out photos that
     simply haven't been reached yet.
   - The analyze lane has its own per-call timeout (`llm.timeoutMs`). A photo whose analysis
     failed or timed out is marked as such straight away, so the run doesn't wait for it at all.
   - On timeout or failure → all-zero plan for that photo, with a note in the log.
   - With batching on, a batch waits for the plans of all its photos before starting. The wait is
     timed from the moment that batch is next to run.
   - Tests (mock provider with configurable delays): a slow provider on photo 3 doesn't time out
     photos 4–20; a provider faster than rendering never causes waiting; a dead provider gives
     all-zero plans immediately once the analyze calls fail.
7. **UI:** the toggle in `RunPanel.jsx` (shown only when `health.llm` is available) and the
   strength dial (Subtle / Normal / Punchy).
8. **Tests:** node tests for every pure part, using the mock provider for the analyze → run
   integration; Pester for `-CorrectionsJson` stacking order and naming.

Exit: toggle off = identical to Phase 3. Toggle on = AI-corrected `_ai` renders; LLM down = normal
renders with a note, never a failed job.

---

### Phase 5 — LLM scenes + review and edit UI

**Goal:** better scene groups from the LLM, and full control over what it proposes.
Detail: LLM §7.1 steps 2–3, §6.3–6.4.

Tasks
1. `sceneTags` in the analysis schema, plus a tags-only mode (embedded JPEG, short prompt) for
   grouping whole folders cheaply.
2. A per-day, text-only merge/split/naming call (`sceneGrouper.js`, `llm/scenePrompt.js`). If it
   fails, the Phase 3 segments are used.
3. **Correction review:** an Analyze button, per-photo before/after cards (draft renders), editable
   step chips, `PUT /api/corrections` (your edits always override the LLM's).
4. **Scene editor UI:** rename / merge / split / move. Search by captions.
5. **Preview grid on the AI-corrected base:** `00_ai_base` tile next to `00_base_only`. The
   photo's AI overlay content hash joins the Phase 1 composite fingerprint (the same pattern, one
   more input). Editing a plan in the review UI therefore re-renders only that photo's grid.

Exit: you can run analysis, review and adjust per photo and per scene, then render.

---

### Phase 6 — Quality: refine loop, scene consistency, per-scene presets

**Goal:** the features that improve results beyond a single LLM pass.
Detail: LLM §4, §7.4–7.5, §2.3.

Tasks
1. **Refine pass** (`llm.refinePass`, off by default): draft render with the overlay → LLM sees
   before/after → at most ±1 corrections, one round.
   - The "after" image is always a **real RawTherapee draft render**. Latency is whatever Phase 0
     measured for it.
   - **Decided: no `sharp` approximation.** Adjusting an 8-bit sRGB JPEG behaves very differently
     from RawTherapee's 32-bit raw pipeline, especially in highlight recovery and white balance.
     The LLM would judge artefacts that don't exist in the real render (e.g. false highlight
     clipping) and send back wrong ±1 corrections.
   - If the draft render is too slow for the refine pass to be worth it, `refinePass` stays off
     and the correction remains a single pass.
2. **Scene harmonization** (`scenes.harmonizeCorrections`): warmth/tint/dehaze set to the scene
   median, clarity/saturation/contrast moved halfway toward it. This also makes more photos share
   a profile stack, so batching works better.
3. **Per-scene presets:** a preset dropdown per scene header plus **Queue all scenes**, which
   queues one normal `run` job per scene.
4. Histogram stats for the LLM prompt (`sharp`), burst reuse of plans, and the two-thumbnail
   boundary check for unclear scene splits.

Exit: each feature is measured on your photos, and only the ones that help stay on by default.

---

### Phase 7 — Cloud LLM providers — **ON HOLD**

> On hold by decision (2026-11-24): not part of the current Version 2 build. Phases 0–6 are
> built first. The provider interface from Phase 4 keeps Phase 7 a pure add-on for later.

**Goal:** switch from local Ollama to OpenRouter or the Claude API by editing config only.
Detail: LLM §5.

Tasks
1. **OpenAI-compatible adapter:** covers OpenRouter, LM Studio, llama.cpp server and vLLM.
2. **Anthropic adapter:** the official `@anthropic-ai/sdk`, loaded lazily; structured output via
   `output_config.format`; `stop_reason: "refusal"` → all-zero plan; `cache_control` on the
   system prompt. Default model `claude-opus-5-5`, or `claude-haiku-5-5` for cheap bulk use (your
   choice in config). Both are current Claude API model IDs.
   - **Model names are checked rather than assumed:** at start-up and in `/api/health`, each cloud
     adapter checks that the configured model exists. Anthropic: `client.models.retrieve(model)`.
     OpenRouter / OpenAI-compatible: `GET {baseUrl}/models` and look for the ID. Ollama:
     `GET /api/tags`, as in Phase 4. An unknown name shows as `llm: model not found` in the health
     indicator, instead of every analysis failing at run time.
3. `apiKeyEnv` (keys only from environment variables), GPS stripped unless `sendGpsToCloud`, a
   privacy notice in the UI, token/cost totals per job.
4. Higher `llm.concurrency` for cloud. Analysis is then no longer GPU-bound and can run several
   calls at once.

Exit: the same features work on all three providers, with no pipeline changes.

---

## 5. Phase overview

| Phase | Delivers | Needs LLM | Gate | Risk |
|---|---|---|---|---|
| 0 Measure & validate | Numbers, visual checks, decisions | experiment only | — | none |
| 1 Pipeline foundations | One argument builder, draft mode, structured progress, contract tests | no | — | low |
| 2 Batched rendering | Fewer RawTherapee start-ups, per-file fault isolation | no | ≥10% start-up share | low–medium |
| 3 Scenes (no LLM) | Group by scene, **Select scene**, scene → preset → Run | no | — | low |
| 4 AI correction | Toggle + strength dial, Ollama, analyze lane, CPU/GPU overlap | yes | before/after looks better | medium |
| 5 LLM scenes + review | Named scenes, editable corrections, AI base in preview grid | yes | — | medium |
| 6 Quality | Refine loop, scene consistency, per-scene presets | yes | measured per feature | medium |
| 7 Cloud providers | OpenRouter / Claude via config | yes | — | low |

Phases 1–3 are worthwhile even if the LLM work is dropped after Phase 0.

## 6. Expected impact (to be confirmed in Phase 0)

| Change | Bottleneck | Expected impact | Confidence |
|---|---|---|---|
| Shared draft profile + one argument builder | Duplicate stack logic; LLM input renders | Preview and LLM renders consistent; latency ≈ today's ~6 s unless Phase 0 finds a faster variant | high (consistency) / low (1–2 s target) |
| Profile-signature `-c` batching | Repeated start-up | Equal to the measured start-up share; mostly helps non-AI batches | unknown until Phase 0 |
| Structured progress events | Fragile regex parsing | Reliable per-photo progress, needed for batching | high |
| Fault isolation | One bad file in a batch | Same failure behaviour as today, with batching | high |
| `analyze` lane + render limiter | LLM and render running one after another | LLM time mostly hidden behind the ~22 s renders | high |
| Scene grouping | Selecting photos by hand | One-click scene selection, consistent look per scene | high |

## 7. Decisions

Settled in the plan review:
- **Batching default:** `batchRender: false` for one release behind the Phase 0 ≥10% gate, then
  switched to `true`.
- **Draft profile:** `preview_fast_resize.pp3` is renamed directly to `profiles/draft_override.pp3`
  in Phase 1, with no compatibility copy.
- **Refine loop:** no `sharp` approximation. Real RawTherapee draft renders only, or a single pass.

- **Phase 7 (cloud providers):** on hold, to be picked up later.
- **LLM plan open questions:** resolved with the suggested answers. See `llm_integration_plan.md`
  §11.
- **Development branch:** `version_2_dev` (all Version 2 work is committed and pushed there).

## 8. Review log

Plan review round 2: risks raised and how they were addressed.

| # | Risk | Resolution | Where |
|---|---|---|---|
| 1 | Same-stem files overwrite each other in one batch's temp folder | At most one file per stem per batch; duplicates move to the next batch | Phase 2 task 2 |
| 2 | Block-buffered stdout makes batch progress freeze, then jump | Tested in Phase 0; temp-folder polling with a size-stable + lock check as the progress source | Phase 0 task 3, Phase 2 task 3 |
| 3 | Per-photo AI overlays fragment batching | Accepted; content-addressed overlays recover identical stacks for free; Phase 0 gate decides whether Phase 2 is worth building | Phase 4 task 5 |
| 4 | Windows 32,767-character command-line limit | Batches are also limited by `maxCommandChars` (16000) | Phase 2 task 2 |
| 5 | Plan-wait timeout counted from queue time, so later photos time out | Timeout starts when the run reaches the photo; failed analyses are marked so the run doesn't wait | Phase 4 task 6 |
| 6 | Model IDs might be wrong | `claude-opus-5-5` / `claude-haiku-5-5` are current IDs, so no change. Added a model-exists check at start-up and in health | Phase 7 task 2 |
| — | Preview cache fingerprint covers only presets (found while applying #2): draft profile, base profiles, format overlays, profile config and source file changes all serve stale tiles; already a Version 1 bug | Composite fingerprint over every tile input; Phase 5 adds the AI overlay hash for `00_ai_base` | Phase 1 task 2 |

---

## 9. How the build is carried out (autonomous development, manual test at the end)

Version 2 is developed autonomously in cloud sessions on branch **`version_2_dev`**. The user
manually tests the finished Version 2 on their Windows machine at the end. Consequences:

### 9.1 Environment
- The cloud container is **Linux**, with no Windows, no GPU and no real photo library.
- Tools needed in the container, which the dev session installs and verifies at its start:
  - Node dependencies (`npm install`);
  - **PowerShell 7 (`pwsh`) + Pester 5**, to run the Pester suite;
  - **RawTherapee CLI** (Linux build) and **ExifTool**, for contract tests and behaviour checks;
  - a few CC0 raw samples (raw.pixls.us);
  - optionally **Ollama** with a small Qwen3.5 vision model on CPU, to test the Ollama adapter for
    real. It's slow, but works for a handful of images.
- If a tool can't be installed (network policy), the session says so, and the dependent tests
  stay `Integration`-tagged and skipped. Results are never faked.
- The PowerShell scripts must keep working on **Windows PowerShell 5.1** (what `.bat` users run)
  as well as `pwsh` 7. Avoid 7-only syntax (`??`, `?.`, ternary, `ForEach-Object -Parallel`).
  Linux paths in tests are fine. Production code keeps its Windows behaviour.

### 9.2 Phase 0 split: what can be done here vs. what needs your machine and your eyes
- **0a: done in the cloud session.**
  - Build the Phase 0 tooling: `scripts/bench_rt.ps1`, the LLM experiment script (before/after HTML
    page), the scene segmentation report script.
  - Run the **behaviour** checks on Linux RawTherapee: multi-file `-c` output naming, exit code with
    a corrupt file, whether stdout arrives live or buffered. Record them in
    `_development/v2_benchmark_findings.md`, clearly labelled "Linux, not Windows".
- **0b: done by you during the final manual test.** Real Windows timings (`bench_rt.ps1`), stdout
  buffering on Windows, the AI before/after visual verdict, step-table calibration by eye.

### 9.3 Gates become config switches with safe defaults
Because 0b happens at the end, no phase is skipped on an unmeasured gate. Instead, every gated
feature is built **behind a config switch** whose default keeps Version 1 behaviour:

| Gate | Built anyway? | Default in Version 2 | Decided at your manual test |
|---|---|---|---|
| Batching (Phase 2) | yes | `batchRender: false` | enable if `bench_rt.ps1` case C shows ≥10% |
| Batch progress source | both implemented | `progressSource: "outputFolder"` | keep, or switch to `stdout` if Windows streams live |
| Draft profile | yes | today's preview settings (`-f`, Scale 0.15) | change only if case E beats D |
| AI correction (Phases 4–6) | yes | `llm.enabled: false` | enable if the before/after page looks better |
| LLM input image | all three | `inputImage: "auto"` | `draftRender` vs `embedded` |
| Step table | yes | starting values from LLM §3, marked **uncalibrated** | calibrate by eye |
| Refine pass | yes | `refinePass: false` | — |
| Scene LLM step | yes | `scenes.useLlm: true` (no-op without an LLM) | — |

### 9.4 Working rules for the dev session
- Work phase by phase in the order 0a → 1 → 2 → 3 → 4 → 5 → 6. **Phase 7 is on hold.**
- At the end of each phase: all tests green (`npm test` and `pwsh` Pester), a checked-off progress
  entry in `_development/Version_2_progress.md` (what was done, what was skipped and why, any
  deviation from this plan), then commit and push to `version_2_dev`.
- Keep Version 1 behaviour byte-identical when no new option is enabled. Existing tests must pass
  unchanged unless the plan explicitly changes that behaviour.
- Planning docs in `_development/` are tracked by force-add (the folder is gitignored). Use
  `git add -f` for new files there.
- Deliverable at the end: `_development/Version_2_test_guide.md`, a step-by-step manual test
  checklist per feature for Windows. It includes: setup (Ollama + model, `llm` config block),
  running `bench_rt.ps1` and reading the gate results, the before/after review, and how to switch
  each gated feature on or off.
