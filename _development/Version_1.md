# Version 1 — what is implemented

Status: **implemented and committed** (through commit `a8b1d69`, 2026-09-02).
Version 2 (planned, not implemented) is described in `Version_2_development_plan.md`.

**A note on naming.** During development, the iterations were called "V1" to "V9" (commit
messages, and the local-only `V4_PLAN.md` … `V9_PLAN.md`). From now on, **all of that together
is Version 1**, and the old iterations are its **phases 1–9**. The commit titled
"Version 2: 20 presets" is therefore Version 1, Phase 2, not the new Version 2.

Sources: git history, `README.md`, `docs/gpu_spike_findings.md` and the current code. The
original V4–V9 plan documents aren't in this checkout, so where a phase's exact scope is
unclear, this document describes what the commits actually contain.

---

## Summary: what Version 1 is

A Windows tool that batch-converts camera raw files to JPEG with RawTherapee's CLI. It has two
front ends over the same PowerShell pipeline:

- **CLI:** `auto_enhance_arw_to_jpg.bat` / `scripts/auto_enhance.ps1` (plus an optional watch
  folder).
- **Web UI:** React + Express. Pick photos → pick a look (32 presets, previewed) → run named,
  dated project batches through a persistent job queue.

| Area | State at the end of Version 1 |
|---|---|
| Input formats | `.arw`, `.nef`, `.dng`, `.raf` (tuned on Sony; one real sample verified per other format) |
| Output | JPEG, quality 95 by default, into `edited_jpg/` (CLI) or `projects/<name>_<date>/` (web UI) |
| Edits | Global only: base colour-correction profile (ISO-branched), per-format overlay, optional look preset |
| Profile stack | `-p <base: default/lowlight by ISO> [-p <profiles/<ext>.pp3>] [-p <preset>]` |
| Presets | 32 looks in 5 categories (Nature, Urban, Night, Portrait, Mood) |
| Engine | RawTherapee CLI, CPU only, ~22 s per full-resolution photo; one process per photo |
| Platform | Windows (PowerShell, `.bat` launchers, `winget`-based setup) |
| Tests | 155 server (`node --test`) + 104 client (`vitest`), as recorded in the README, plus a Pester suite for the PowerShell pipeline (24 `It` cases at the time of writing) |

---

## Phase 1 — CLI pipeline (`3ac1afd`, `3715dc7`, 2026-07-30)
- `auto_enhance_arw_to_jpg.bat` + `scripts/auto_enhance.ps1`: convert every `.ARW` in a folder
  to JPEG via `rawtherapee-cli`.
- `profiles/default.pp3` (originally `sony_a7ii_24-70f4_best.pp3`) and `profiles/lowlight.pp3`.
- `config/config.json`: RawTherapee/ExifTool paths, output/log folders, quality, default profile.
- **ISO-based profile branching** (`autoProfile`): ExifTool reads the ISO, and the low or high ISO
  profile is chosen per photo.
- **Idempotent:** existing outputs are skipped. **Failure handling:** detects RawTherapee printing
  its help text instead of rendering; retries failed files on the next run; quarantines a file to
  `failed/` after `quarantineAfterFailures` failures in a row.
- One CSV log per run (status, exit code, duration, ISO, profile, note) and a summary.
- `scripts/watch_folder.ps1`: polls a folder, waits until file sizes are stable, then converts.

## Phase 2 — Look presets (`6e1a9cd`, `a9954ad`, `ed9444c`, 2026-07-31)
- 30 `.pp3` look presets in `presets/`, stacked on top of the base profile (`-Preset`).
- Output naming `<name>_<preset>.jpg`, so different looks of one photo don't overwrite each other.
- `scripts/lib_common.ps1`: shared config loading and base-profile resolution.
- `scripts/preview_presets.ps1`: renders one example photo through every preset, with an
  `index.html` gallery.

## Phase 3 — Web UI (`6b1c58b`, `92d2dbe`, `01b105b`, 2026-07-31 → 08-05)
- `webapp/server` (Express) shells out to the existing PowerShell scripts; `webapp/client` (React +
  Vite + Tailwind + Radix).
- Photo picker grouped by **month → day** from EXIF capture date (`captureDates.js`), with
  **Select month / Select day**; thumbnails from the embedded JPEG (`thumbnails.js`).
- Preset preview grid and Run panel with project names → `projects/<name>_<date>/`.
- Source folder picker with a drive navigator (`drives.js`), persisted state (`state.js`), and a
  first job queue (`jobQueue.js`, `runner.js`); `start_all.bat`.

## Phase 4 — Job manager and safety (`0f0d2da`, `1407c09`, 2026-08-05)
- `JobQueuePanel.jsx`: active / queued / history view.
- Safety and robustness helpers: `pathSafety.js` (no path traversal), `atomicFile.js`,
  `diskSpace.js` (free-space warning), `startupChecks.js` (config sanity), `folderHistory.js` (last 5
  source folders), `runProgress.js`, `jobTiming.js`.

## Phase 5 — Queue features and test suites (`f9543e9`, 2026-08-05)
- Job **ETA** (`jobEta.js`), drag-to-reorder for queued runs (`dragReorder.js`), job state
  transitions, duration formatting.
- Separate lanes per job type in `jobQueue.js`, so a preview no longer waits behind a batch run.
- **Automated test suites introduced:** server (`node --test`, including a server integration test)
  and client (`vitest`).

## Phase 6 — Queue control and disk estimates (`df3d28e`, 2026-08-09)
- Pause / re-queue, a richer job queue panel (+ tests), and disk-space estimates that count every
  run already queued ahead.
- The commit notes "without Phases 8 and 9". Those two sub-phases of the old V6 plan were not
  done in this phase. Their contents aren't recorded in this checkout. Phase 7 below may have
  covered parts of them.

## Phase 7 — Presets always available, project browser, retry (`259635b` → `9e79518`, 2026-08-18 → 08-25)
- Preset grid always visible and selectable before any preview; **preview cache** with a per-preset
  fingerprint (`previewCache.js`), so editing a preset invalidates the cache.
- **Health indicator** (`/api/health`, polled every 15 s), **Project browser** (`projectBrowser.js`),
  **job retry** (`jobRetry.js`), history search + "Load more", desktop notifications, and a timing
  report (`timingReport.js`).
- Presets 31–32: `analog_fade`, `dramatic_mono` (32/32 tracked).
- Planning documents, `docs/` and `_development/` made local-only in `.gitignore`. README
  rewritten.

## Phase 8 — Testing, performance, packaging (`83e166e` → `34a4dd3`, 2026-08-25)
- Root launcher (`package.json`: `npm run dev` / `build` / `start` / `test`).
- **GPU spike:** `docs/gpu_spike_findings.md`, with per-stage timing (`timing` fields on
  `/api/photos` and jobs). Conclusion: RawTherapee has no GPU path, ~22 s per photo, and no GPU work
  recommended.
- **Pester tests** for the pipeline: idempotent skip, ISO branching, output naming, preset stacking,
  quarantine (`scripts/tests/`, with RawTherapee and ExifTool mocked).
- Retry also allowed for "done" jobs that had failed files. **Virtualized photo grid**
  (`@tanstack/react-virtual`): Select all on 3000+ photos went from 3071 ms → 97 ms.
- **Single-port production build:** Express serves `webapp/client/dist/`.
- **Windows packaging:** `setup.bat` / `scripts/setup.ps1` (checks Node, finds or installs
  RawTherapee and ExifTool via `winget`, creates `config.json`, npm install + build) and
  `start.bat`. `config.json` untracked, with `config.example.json` as the tracked template.
- README quick-start ("Just want to use it?").

## Phase 9 — Multi-format raw support (`3c5d5df` → `a8b1d69`, 2026-08-25 → 09-02)
- `.nef`, `.dng`, `.raf` accepted alongside `.arw` (`rawFormats.js` / `$SupportedRawExtensions`,
  kept in sync), each run end to end with a real sample. Disk-estimate calibration.
- **Per-format overlay profiles:** `profiles/<ext>.pp3` is stacked on files with that extension
  automatically. First one: `profiles/raf.pp3`, a Fujifilm X-Trans white-balance fix measured on a
  grey card.
- Debugging: PowerShell output echoed to the server console, tagged by script and job.
- Fix: RawTherapee arguments quoted in `preview_presets.ps1`, so photo paths with spaces work.

---

## Known limits at the end of Version 1 (starting point for Version 2)
- ~22 s per photo, CPU-bound, one `rawtherapee-cli` process per photo. Process start-up cost
  has never been measured separately.
- A preset preview render takes ~6 s each (`-f` + resize to ~900 px); a full grid of 32 takes a
  little over 3 minutes.
- One fixed base correction for every photo (apart from ISO branching and format overlays): no
  per-photo correction.
- Photos can only be grouped by date (month/day). There is no grouping by scene.
- Progress is parsed from free-text output lines (`Enhancing …`, `FAILED: …`).
- **Known bug:** the preview cache (`previewCache.js`) only fingerprints the preset files. Editing
  a base profile (`default.pp3`/`lowlight.pp3`), a format overlay (`raf.pp3`),
  `preview_fast_resize.pp3`, the profile settings in `config.json`, or replacing a source file
  under the same name keeps serving stale preview tiles until the cache is cleared by hand. The
  fix is planned in Version 2, Phase 1.
- Presets and profiles are tuned on Sony sensors only. `.CR3` is not supported.
