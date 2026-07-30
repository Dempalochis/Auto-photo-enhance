# Auto-photo-enhance

Automated batch enhancement of Sony `.ARW` raw photos to `.jpg`, using [RawTherapee](https://rawtherapee.com/)'s command-line renderer (`rawtherapee-cli`).

## Quick start

Double-click [`auto_enhance_arw_to_jpg.bat`](auto_enhance_arw_to_jpg.bat). It converts every `.arw` file in the repo root into `edited_jpg/`, using the settings in [`config/config.json`](config/config.json).

## Layout

```
config/config.json     settings: RawTherapee path, output/log dirs, quality, profiles, auto-profile rules
profiles/*.pp3          RawTherapee processing profiles (named, selectable)
scripts/auto_enhance.ps1   main pipeline: converts *.arw -> *.jpg, logs, handles failures
scripts/watch_folder.ps1   optional watch-folder wrapper around auto_enhance.ps1
logs/*.csv              one row per file per run: status, exit code, duration, ISO, profile used
edited_jpg/             output JPEGs
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
  "quarantineAfterFailures": 2
}
```
`outputDir`/`logDir` are relative to the repo root unless given as absolute paths. Any setting can be overridden per-invocation with the matching `-Param` (e.g. `-Quality 90`, `-InputDir ...`).

## Adding a new profile

There's no universal "best" profile — RawTherapee's own community consensus is to build a few situational profiles rather than one that tries to handle every lighting condition. To add one:

1. Open a representative raw photo in the RawTherapee GUI and adjust it to taste.
2. `Processing Profile Operations` → `Save Profile` → save into `profiles/<name>.pp3`.
3. Reference it via `-Profile <name>`, or wire it into `autoProfile` in the config for automatic per-ISO selection.

`profiles/default.pp3` and `profiles/lowlight.pp3` (softer sharpening, stronger denoise, for ISO ≥ threshold) are set up as a starting pair.

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

## Testing

Each capability below was verified against real sample `.ARW` files during development:
- Fresh run converts all input files; re-run skips everything (idempotency).
- Missing RawTherapee executable / missing profile fails fast with a clear message.
- A rejected CLI flag is caught (both via exit code and the `Usage:` banner check) instead of silently "succeeding".
- Two different profiles applied to the same photo produce different output (checksums differ).
- ISO-based auto-profile branching picks the correct profile per file; an explicit `-Profile` override bypasses it.
- Watch-folder: a batch of files dropped at once is processed exactly once, never duplicated across poll cycles; a file still being written is correctly left alone until its size stabilizes.
- A corrupt/unreadable file fails without aborting the rest of the batch, and is quarantined to `failed/` after repeated failures instead of being retried forever.
