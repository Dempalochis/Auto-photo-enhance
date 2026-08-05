# Auto-photo-enhance

Automated batch enhancement of Sony `.ARW` raw photos to `.jpg`, using [RawTherapee](https://rawtherapee.com/)'s command-line renderer (`rawtherapee-cli`). Two ways to use it: a one-click `.bat` for a plain batch conversion, or the [web UI](#web-ui) for browsing/filtering photos by date, comparing all 30 presets on a photo before committing, and running named/dated project batches.

## Quick start (CLI)

Double-click [`auto_enhance_arw_to_jpg.bat`](auto_enhance_arw_to_jpg.bat). It converts every `.arw` file in the repo root into `edited_jpg/`, using the settings in [`config/config.json`](config/config.json).

## Layout

```
config/config.json     settings: RawTherapee path, output/log dirs, quality, profiles, auto-profile rules, preset
profiles/*.pp3          RawTherapee color-correction profiles (named, selectable, ISO-branched)
presets/*.pp3           RawTherapee "look" presets, stacked on top of a profile (see Presets below)
scripts/lib_common.ps1  shared config-loading / base-profile-resolution logic
scripts/auto_enhance.ps1   main pipeline: converts *.arw -> *.jpg, logs, handles failures
scripts/watch_folder.ps1   optional watch-folder wrapper around auto_enhance.ps1
scripts/preview_presets.ps1   renders one example photo through every preset for comparison
logs/*.csv              one run per file per run: status, exit code, duration, ISO, profile, preset used
edited_jpg/             output JPEGs
preview/                example photo rendered through every preset + an index.html gallery
webapp/server/          Node/Express backend for the web UI (wraps the same scripts above)
webapp/server/tests/    automated backend tests (node:test) - see Testing below
webapp/client/          React + Tailwind + Radix UI frontend
projects/<name>_<date>/ output of web-UI batch runs, one folder per named/dated project
docs/gpu_spike_findings.md   GPU-acceleration research spike: findings, real timing data, recommendation
```

## How it works

1. `auto_enhance.ps1` scans an input directory for `*.arw` files and, for each one not already converted, calls `rawtherapee-cli -p <profile> -o <out>.jpg -j<quality> -Y -c <file>`.
2. **Idempotent**: if `edited_jpg/<name>.jpg` already exists, the file is skipped. Safe to re-run or schedule repeatedly.
3. **Per-photo profile selection**: if `autoProfile.enabled` is `true` in the config and `exiftoolPath` points at a working [ExifTool](https://exiftool.org/) install, each file's ISO is read and used to pick between `lowIsoProfile` and `highIsoProfile` (threshold: `isoThreshold`). Pass `-Profile <name>` or `-ProfilePath <file.pp3>` explicitly to bypass this and force one profile for the whole run.
4. **Failure handling**: a failed file (bad exit code, or RawTherapee silently printing its help text instead of processing) is retried on the next run. After `quarantineAfterFailures` (default 2) consecutive failures, the file is moved to `<input dir>/failed/` so it stops being retried forever.
5. Every run writes a CSV to `logs/` with one row per file (status, exit code, duration, ISO read, profile used, any failure note) and prints a summary (`Processed / Skipped / Failed / Quarantined`). Exit code is non-zero if anything failed.

## Config (`config/config.json`)

```json
{
  "rtPath": "...\\rawtherapee-cli.exe",
  "outputDir": "edited_jpg",
  "logDir": "logs",
  "quality": 95,
  "defaultProfile": "default",
  "exiftoolPath": "...\\ExifTool.exe",
  "autoProfile": { "enabled": true, "isoThreshold": 800, "lowIsoProfile": "default", "highIsoProfile": "lowlight" },
  "quarantineAfterFailures": 2,
  "preset": null
}
```
`outputDir`/`logDir` are relative to the repo root unless given as absolute paths. Any setting can be overridden per-invocation with the matching `-Param` (e.g. `-Quality 90`, `-InputDir ...`). `preset` is the name of a `presets/*.pp3` to stack on every conversion (e.g. `"teal_orange"`); leave it `null` for plain color-corrected output, or override per-run with `-Preset <name>`.

## Presets ("looks")

A preset is a small, *partial* pp3 that only touches stylistic settings (tone curve/contrast, saturation, split-toning, vignette, B&W, a white-balance bias) — never exposure/WB/denoise/sharpening, which stay owned by the color-correction profile. RawTherapee natively supports stacking multiple `-p` profiles in one call, each layering on top of the last:

```
rawtherapee-cli -p profiles/default.pp3 -p presets/teal_orange.pp3 -o out.jpg -j95 -Y -c photo.ARW
```

`auto_enhance.ps1` does exactly this whenever a preset is selected (via config or `-Preset <name>`), applied *after* the same ISO-based profile selection as before. No preset selected = pipeline behaves exactly as it did before presets existed.

Split-tone/two-tone looks use RawTherapee's real `[ColorToning]` tool (`Method=Splitco`, verified against RawTherapee's own source code) — independent RGB pushes for shadows/mids/highlights, not a hand-rolled color-curve hack.

### The 30 presets (`presets/*.pp3`)

| Preset | Category | Look |
|---|---|---|
| `nature_earth` | Nature | Muted, de-saturated organic tones (2026 "organic grading" trend — less neon-green, more grounded) |
| `golden_hour` | Nature | Warm push, protected highlights, soft vignette |
| `forest_moody` | Nature | Deep, cool-shadowed greens, atmospheric |
| `dramatic_sky` | Nature | Punchy clarity/contrast for big-sky landscapes |
| `autumn_glow` | Nature | Boosted warm oranges/reds for foliage |
| `misty_morning` | Nature | Cool, soft, desaturated fog/mist look |
| `vibrant_bloom` | Nature | Punchy florals/greens, spring vibrance |
| `teal_orange` | Urban | Classic cinematic blockbuster split-tone, restrained |
| `urban_fade` | Urban | Washed-out, flatter contrast "urban nostalgia" |
| `street_mono` | Urban | High-contrast gritty documentary B&W |
| `concrete_cool` | Urban | Cool blue-grey minimalist architecture |
| `blue_hour` | Urban | Deep blue ambience against warm light sources |
| `industrial_grit` | Urban | Desaturated steel/concrete grunge, heavy contrast |
| `night_market_vibrant` | Urban | Warm, saturated bustling night-market energy |
| `neon_nights` | Night | Cyberpunk magenta/cyan push — shines on scenes with real colored lights |
| `astro_sky` | Night | High clarity/contrast + cool cast for starry skies |
| `moonlit_blue` | Night | Cool, desaturated, quiet nightscape |
| `citylight_glow` | Night | Warm, soft-contrast bokeh city-lights glow |
| `starlit_desert` | Night | Warm sand tones against a cool night sky |
| `warm_streetlamp` | Night | Quiet, warm sodium-vapor streetlight glow |
| `natural_skin` | Portrait | True-to-life, minimal, skin-protected (2026 trend: less filtering, not more) |
| `editorial_mono` | Portrait | Contrast B&W with a channel mix tuned for flattering skin luminance |
| `soft_glow` | Portrait | Airy, soft-contrast, creamy lifted highlights |
| `moody_warm` | Portrait | Restrained warm-shadow/cool-highlight depth (not crushed blacks) |
| `vintage_film_portrait` | Portrait | Warm, faded classic film portrait |
| `high_key_bright` | Portrait | Bright, airy, high-key studio look |
| `pastel_dream` | Mood | High-key, soft pastel palette |
| `punch_pop` | Mood | Bold modern high-clarity, high-contrast, saturated |
| `cinematic_drama` | Mood | Deep contrast, cool-shadowed cinematic drama |
| `vibrant_travel` | Mood | Bold, saturated, high-clarity adventure/travel look |

These were verified for correct RawTherapee syntax, checked for measurable difference from the base and from each other, and visually inspected — but the reference photo used during development was a daytime indoor car-show shot, so effects tuned for foliage/skin/neon-lit night scenes (`nature_earth`, `moody_warm`, `neon_nights`, etc.) will read more strongly on photos with that actual content. Run `preview_presets.ps1` against a real photo from the relevant scenario before trusting a look for a shoot.

**Choosing a preset for a shoot** — render one example photo through every preset to compare, before running the whole batch:
```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preview_presets.ps1 -SourceFile path\to\example.ARW
```
This writes `preview/00_base_only.jpg` (no preset, for reference) plus one JPEG per preset and a `preview/index.html` gallery — open it in a browser to compare side by side. Then set `"preset": "<name>"` in the config (or pass `-Preset <name>` to `auto_enhance.ps1`) for the actual batch run.

**Adding a new preset**: same idea as adding a profile — dial in a look in the RawTherapee GUI, but save only the tool sections you actually changed (right-click a tool → "reset to neutral" for anything you didn't touch before saving) so it stays a thin, stackable layer rather than clobbering the base profile's exposure/WB.

## Adding a new profile

There's no universal "best" profile — RawTherapee's own community consensus is to build a few situational profiles rather than one that tries to handle every lighting condition. To add one:

1. Open a representative raw photo in the RawTherapee GUI and adjust it to taste.
2. `Processing Profile Operations` → `Save Profile` → save into `profiles/<name>.pp3`.
3. Reference it via `-Profile <name>`, or wire it into `autoProfile` in the config for automatic per-ISO selection.

`profiles/default.pp3` and `profiles/lowlight.pp3` (softer sharpening, stronger denoise, for ISO ≥ threshold) are set up as a starting pair.

## Web UI

A browser-based front end over the same pipeline above — nothing in it reimplements RawTherapee invocation, it just shells out to `auto_enhance.ps1` / `preview_presets.ps1` and gives you a GUI for the three steps: pick photos, pick a look, run.

### Starting it up

First time only, install dependencies for both halves:
```
cd webapp/server && npm install
cd ../client && npm install
```

Every time you want to use it, start the backend and the frontend (two separate terminals — leave both running):
```
node webapp/server/server.js
```
```
cd webapp/client && npm run dev
```
Open the URL Vite prints (`http://localhost:5173`). The backend listens on `http://localhost:5175`; the frontend proxies API calls to it automatically. Close both terminal windows (or `Ctrl+C`) to stop everything.

### Using it

**Source folder** — shows the folder currently being scanned for photos (defaults to `photosDir` from the config, or wherever you last pointed it — this choice persists across server restarts). Paste an absolute path and click **Use this folder**, or click **Browse…** for a lightweight folder navigator, since a browser can't hand a real filesystem path to the page from any native picker. The navigator lists every attached drive with its real name (e.g. "LaCie (F:)", same as Windows Explorer) — internal, external/USB, whatever's plugged in — with a **Drives** shortcut always available to jump back to that list from anywhere. A **Recent** row lists your last 5 source folders (most recent first) for one-click switching back. Switching folders clears your current photo selection and any open preview (they'd point at photos that may no longer be relevant).

**1. Choose photos to process** — every `.arw` found in the source folder above (recursively, by default), auto-grouped by month then day using the photo's real EXIF capture date (not file-copy time), newest-first by default.
- Click a photo's checkbox to include it in the batch; **Select day** / **Select month** toggle the whole group at once; **Select all** / **Clear selection** work across whatever's currently visible.
- **Search filename**, and **From/To date** (day-level only, ignores time-of-day) narrow the grid down.
- **Compact/Comfortable** toggles thumbnail size; sort **Newest/Oldest first** flips the order. Both, plus your last project name and preset choice, are remembered in the browser between sessions.

**2. Pick a look** — click **Preview** on any one photo to render it through the color-correction profile alone plus all 30 presets, grouped into Nature/Urban/Night/Portrait/Mood sections. Click a tile to select that preset (or the "None" tile for color-correction only). Renders are cached per photo, so previewing the same photo again is instant; a fresh photo takes roughly 3 minutes to render all 30 looks — previews are deliberately rendered small and fast (`-f` + a forced resize, ~900px, plus rendering a few presets at once) rather than at full quality/resolution, since this view is for comparing looks, not judging fine detail. A preview also no longer waits behind a queued/running batch **Run** — the two use independent lanes, so both progress at the same time.

**3. Run** — type a project name; the output folder (`projects/<name>_<date>/`) updates live as you type. Click **Run** to queue a batch conversion of every selected photo with the chosen preset. Unlike earlier versions, **Run never blocks**: it queues the job and immediately clears your selection so you can pick a different set of photos (from the same folder or a different one) and click **Run** again to queue the next job, without waiting for the first to finish. If the output drive looks low on space for the batch you're about to queue, a warning appears (based on a rough per-file estimate) — it's advisory only and never blocks the run, since already-converted files are always safe either way.

**Job queue** — below Run, split into **Active** (currently running), **Up next** (queued batch runs — drag the ⠿ handle to reorder which one runs next), **Queued previews** (queued preset previews, shown plainly since there's rarely more than one), and **History** (everything finished), each with live progress, an estimated time remaining, and a **Cancel** button for anything not finished yet. The ETA is derived from how long recent jobs of the same kind actually took (and, once a job is running, from its own progress so far) — it reads "estimating…" until there's enough data to base a number on, rather than showing a guess. Cancelling a job that's actively running kills the underlying RawTherapee process and removes the one file it was mid-write on, so a partial JPEG never gets mistaken for a finished one on a later run; everything converted before the cancel stays on disk. Click **Notify: off** to switch it to **Notify: on** and get a desktop notification (plus a permission prompt the first time) whenever a job finishes — handy since jobs now run in the background instead of holding up the page.

**Pausing a queued job** — click **Pause** on anything in "Up next" to hold it: it stays right where it is (still draggable, still visible) but won't run until you click its **Re-queue** button. A paused job never resumes on its own — that's deliberate, so it stays out of the way for as long as you want without silently jumping back into the queue while you're not looking. Only a job that hasn't started yet can be paused; once a job is actually running there's no way to freeze a RawTherapee process mid-render, so an active job can only be **Cancel**led.

### Gotcha: one job of each kind runs at a time

The backend runs at most one **batch run** and, independently, at most one **preview render** at a time — two separate queues (by job type), not one global queue. Running several full-size `rawtherapee-cli` conversions in parallel was measured to give no real speedup (RawTherapee already saturates available CPU cores per full-res render), so extra **Run** requests still queue behind each other. Preview renders are a different story since V5: they're deliberately small/fast (see "Pick a look" above) and run a few at once internally, which is why giving them their own lane — instead of sharing one queue with full batch runs — doesn't reintroduce the contention problem that ruled out parallel full renders in the first place. Either way, queueing never blocks the UI: keep browsing/filtering/previewing and queue as many jobs as you like, and the Job queue panel shows you where each one stands.

## Watch-folder automation

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watch_folder.ps1 -WatchDir incoming -PollIntervalSec 30 -StableSeconds 10
```

(`-ExecutionPolicy Bypass` is required per-invocation because Windows blocks unsigned local scripts by default — the same reason `auto_enhance_arw_to_jpg.bat` calls PowerShell that way internally. It only affects this one process, not your system-wide policy.)

Polls `-WatchDir` every `PollIntervalSec` seconds. Before processing, it checks that every `.arw` currently in the folder has had an unchanged file size for `StableSeconds` — if anything is still being copied in, the whole cycle is skipped rather than risking a half-written file. Once stable, it invokes `auto_enhance.ps1` over the whole folder (idempotency means already-converted files are skipped automatically). Run it under Task Scheduler for hands-off operation, or as a long-running console session.

## Known RawTherapee CLI gotchas

- `-c <input>` **must be the last argument** — anything after it is treated as another input file/folder.
- `-w` (suppress console window) is **not supported** by this build's `rawtherapee-cli.exe` — passing it makes RawTherapee silently print its help text instead of processing anything, with a non-informative failure. `auto_enhance.ps1` guards against this class of problem by treating a `Usage:` string in stdout as a hard failure, not a success.
- Windows file matching is case-insensitive — a glob list like `*.arw *.ARW` matches the same files twice; use a single pattern.
- `System.Drawing`/GDI+ cannot read `.ARW` metadata directly (throws a generic "Out of memory" on `Image.FromFile`) — ISO/EXIF reads go through ExifTool instead.
- `-f` (fast-export: bypasses sharpening/denoise/defringe/wavelet, forces the fastest demosaic, and is supposed to downsize) was measured and **not worth using** — its resize step didn't apply here (matches a known upstream bug), so it gave no real speedup while still degrading quality. `-q` (quick-start) is used instead: a small (~3-5%), zero-quality-cost win from skipping cache loading.

## Testing

**Automated tests (web UI backend/frontend)** — `webapp/server` and `webapp/client` each have
their own automated test suite (`node:test` for the backend, Vitest + React Testing Library for
the frontend), covering the job manager (persistence, cancellation, crash recovery), path-safety
checks, source-folder history, and the queue/Run UI behavior:
```
cd webapp/server && npm test
cd webapp/client && npm test
```

**Manual/pipeline verification** — each capability below was verified against real sample `.ARW` files during development:
- Fresh run converts all input files; re-run skips everything (idempotency).
- Missing RawTherapee executable / missing profile fails fast with a clear message.
- A rejected CLI flag is caught (both via exit code and the `Usage:` banner check) instead of silently "succeeding".
- Two different profiles applied to the same photo produce different output (checksums differ).
- ISO-based auto-profile branching picks the correct profile per file; an explicit `-Profile` override bypasses it.
- No preset selected produces byte-identical pipeline behavior to before presets existed (verified after the shared-logic refactor).
- Each preset, stacked on the base profile, produces a distinct output (checksums differ from base-only and from each other); results were visually inspected, not just checksum-diffed.
- Watch-folder: a batch of files dropped at once is processed exactly once, never duplicated across poll cycles; a file still being written is correctly left alone until its size stabilizes.
- A corrupt/unreadable file fails without aborting the rest of the batch, and is quarantined to `failed/` after repeated failures instead of being retried forever.
- Web UI, driven end-to-end in a real browser (not just code review): date grouping/sorting, day/month/date-range selection, categorized preset preview with live progress, and a full run producing correct output on disk were all verified working together.
- Job queue (V4): two batch runs queued back-to-back against real photos without either blocking the UI; cancelling a large in-progress batch stopped it cleanly, left every already-converted file intact, and correctly reported the in-flight file as cancelled rather than falsely claiming it (and every not-yet-started file) as done; a server restart with a job mid-run recovered it as "interrupted" instead of losing or silently resuming it.

See [docs/gpu_spike_findings.md](docs/gpu_spike_findings.md) for the V4 GPU-acceleration research spike: real per-stage timing data gathered from this pipeline, and why no GPU work is recommended yet.
