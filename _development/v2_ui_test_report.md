# Version 2 — browser test report (Linux dev container, 2026-11-24)

> **Not Windows.** Ubuntu 24.04 container, 4 CPU cores, no GPU, RawTherapee 5.10, PowerShell 7.4
> (`powershellPath: "pwsh"`), Chromium driven by Playwright (the Chrome engine, headless). No real Chrome
> or Windows machine was attached. Timings are indicative only; your Windows test (`Version_2_test_guide.md`) decides.

## How the tool was started: `start_all.bat`

A `.bat` file cannot execute on Linux, so `start_all.bat` was checked line by line and its exact steps were
run by hand:

| `start_all.bat` step | Result |
|---|---|
| `if not exist webapp\server\node_modules` / `webapp\client\node_modules` → message + exit | both present: passes |
| `start … /D webapp\server cmd /k node server.js` | backend listening on **:5175 after 122 ms** |
| `start … /D webapp\client cmd /k npm run dev` | Vite dev server on **:5173 after 372 ms** (Vite itself: "ready in 193 ms") |
| `ping -n 6 127.0.0.1` (≈5 s wait) | ample: both were up after ~0.4 s |
| `start "" "http://localhost:5173"` | page 200, `/api` and `/webapp-cache` proxied to :5175 (checked) |

Static review of the `.bat` files: no labels or `goto` (so the LF line endings in the repo are harmless to
`cmd`). `start_all.bat` is the **dev** launcher (two windows, Vite on 5173). `start.bat` is the production
launcher (one port, 5175, needs `npm run build`). Both look correct for Windows. Not executed for real: needs Windows.

The Vite log showed a CSS warning at start-up, which turned out to be a real Version 1 bug (B1 below).

## Test data

- `_samples/`: 8 CC0 raws (6 ARW, 1 NEF, 1 RAF).
- `/home/user/ape_testlib/`: **240 photos** (3 subfolders × 8 samples × 10 hard links), for scale.
- Rounds: **1** = Version 1 features, LLM off. **2** = Version 2 features with `llm.provider: "mock"`
  (instant, deterministic answers; real RawTherapee renders). **3** = the real `qwen3.5:2b` via Ollama on CPU.

## Response times

### Version 1 features (round 1, LLM off)

| Action | Time | Notes |
|---|---|---|
| Page load → photo list (8 photos) | **1.0 s** | 3.2 s on the very first load (cold exiftool + Vite transform) |
| Search / date filter / sort / thumbnail size | 19 / 56 / 196 ms | |
| Thumbnails (cached) | 2–6 ms each | lazy-loaded, only on-screen cards load |
| Preview, cold, 5 MP A7S (33 tiles) | **39.6 s** | ≈ 1.2 s per tile at 3 in parallel; pwsh + RawTherapee start per tile |
| Preview, cold, 24 MP a6000 (33 tiles) | **134 s** | ≈ 4 s per tile, the draft render dominates |
| Preview again (cache hit) | **0.2–1.0 s** | composite fingerprint, no re-render |
| Run 2 photos (A7S, teal_orange) | **6.3 s** | click → job done |
| Re-run same project | 0.7 s | 1 skipped (idempotent) |
| "Folder already has files" warning | 80 ms | |
| Cancel click → job cancelled | **248 ms** | after fix B2 (it was **11 s** before) |
| Retry a cancelled job | 18 s | finished file skipped, rest rendered |
| Pause → Re-queue → both runs done | 6.6 s | |
| Browse… dialog | 0.6 s | |
| Switch folder to 240 photos (incl. EXIF read) | **2.6–3.0 s** | `/api/photos`: walk 4 ms, exiftool 3.2 s cold / 0.3 s warm |
| Select all 240 / Clear selection | 162 / 141 ms | 30 of 240 cards mounted (virtualization works) |
| API `health`, `presets`, `jobs`, `projects`, `source-folder` | 2–4 ms | |

### Version 2 features (round 2, mock LLM, real renders)

| Action | Time | Notes |
|---|---|---|
| AI toggle appears after load | 15 ms after the list | from `/api/health` |
| Find scenes, 240 photos | **2.5 s** job | most of it is the EXIF read; 7 scenes, LLM step named them |
| Find scenes again, nothing changed | 2.5 s | 0 days regrouped (incremental works) |
| Find scenes, 8 photos (forced) | 1.2 s | |
| Select scene → project name = scene name | 62 ms | |
| Rename / Merge ↓ / Split (scene editor) | 0.45 / 0.76 / 1.1 s | Merge after fix B4 |
| Find scenes keeps edited scenes | 0.8 s | ✓ |
| Queue all scenes (2 scenes with presets) | 1.1 s | 2 run jobs named after the scenes ✓ |
| AI run, 2 photos, Punchy, teal_orange | **7.1 s** | `_ai_teal_orange.jpg`, CSV `AiCorrection/AiScene`, harmonized 1 scene ✓ |
| Review: Analyze 2 photos | **6.6 s** | incl. 4 draft renders (before + after) |
| Review: edit a step → new After image shown | **2.8–2.9 s** | 1 pwsh start + 1 draft render |
| Review: Reset to AI | 0.3 s | |
| Preview with the AI base tile (34 tiles, cold) | 64 s | `00_ai_base` tile shown ✓ |
| Batch mode, 5 photos (`batchRender: true`) | 34.0 s vs **33.2 s** without | progress moved file by file during the single call; no gain (Linux NO-GO confirmed) |

### Real LLM (round 3, Ollama `qwen3.5:2b`, CPU only)

| Action | Time | Notes |
|---|---|---|
| Review analysis, 1 photo, draft-render input | **119.6 s** | LLM 110 s; plan `exp-1 hl-2 sh-1 con-1 cla-1 dhz-1`, notes "overexposed and underexposed" (2B is too weak) |
| AI run, 1 photo, embedded-JPEG input | 25.8 s analysis, **156 s total** | queued **118.9 s behind the review analysis** (see L2) |

## Bugs found

| # | Severity | Bug | Where | Status |
|---|---|---|---|---|
| B1 | low (Version 1) | Google Fonts `@import` came after `@import "tailwindcss"`. That expands inline, so the font import ended up mid-file and was **ignored by browsers**: the Oswald/Inter/JetBrains Mono fonts never loaded (Vite warned on every start). | `webapp/client/src/index.css` | **fixed** (lines swapped) |
| B2 | medium (Linux/macOS only) | Cancel killed only `pwsh`; its `rawtherapee-cli` child kept rendering, finished the "partial" file after cleanup (file survived), and the job took 11 s to show "cancelled". Windows uses `taskkill /T`. | `runner.js`, `jobQueue.js` | **fixed**: own process group + group kill on non-Windows (`procTree.js`) |
| B3 | **high** (found while fixing B2) | With a group SIGTERM, RawTherapee died first and PowerShell still logged the cancel as a **failed attempt** (`.attempts` marker). Cancelling the same photo twice would **quarantine** it. | `procTree.js` | **fixed**: SIGKILL. Also a late `file_failed` can no longer turn a "cancelled" item into "failed" (`runEvents.js`, test added) |
| B4 | medium (Windows too) | Cancelling an AI analysis killed only `powershell.exe`, not the draft render's `rawtherapee-cli` (`taskkill /T` was only used for run jobs). | `aiService.js`, `jobQueue.js` | **fixed**: one `killProcessTree()` used everywhere |
| B5 | medium (UX) | **Merge ↓** merged with the *next scene in time*. In the default newest-first view that's the scene **above**, and on the top scene the button was disabled although a scene was shown below. | `SceneActions.jsx` | **fixed**: follows the on-screen order (test added) |
| B6 | low | Every selected photo without a plan made the review panel's `GET /api/corrections` return **404**, logged as a red error in the browser console. | `server.js`, `CorrectionReview.jsx` | **fixed**: `200 { plan: null }` = "Not analysed yet" (test added) |
| B7 | low | "Find scenes" with nothing to regroup reported `llm: "off (llm disabled)"` although the LLM was on. | `aiService.js` | **fixed**: "not needed (nothing to regroup)" |
| B8 | low (UX) | Scene header crowded: three "?" hint icons on the edit buttons plus a wide preset dropdown made the subtitle wrap. | `SceneActions.jsx`, `App.jsx` | **fixed**: plain tooltips, narrower dropdown (see `ui_test/scene_header_after.jpg`) |

## Limitations and observations (not changed; for your decision)

| # | Observation |
|---|---|
| L1 | **→ decided: no folder switch while previews load (implemented, see below).** Version 1 race, cosmetic: switching folders while thumbnails of the old folder are still loading gives a few 404s for those thumbnails (36 in one run). The server has already switched folders; the old grid is about to be replaced anyway. |
| L2 | **→ decided: AI runs get priority (implemented, see below).** One analyze lane: an AI run's analysis waits behind any analysis already running (e.g. a review "Analyze"). The run's plan-wait timer starts when it reaches the photo, so with the default `planWaitMs` = `timeoutMs` (60 s) a run queued behind a long review would render that photo **without AI** (with a note). Possible improvement: give run analyses priority over review analyses. |
| L3 | **→ decided: keep as is; you'll review all presets later.** **`dramatic_mono` renders very dark** on these samples (mean grey 10–12/255 on the A7S sky shot, 41–44 on the forest shot), in the final render too. The channel mixer (blue −38, cyan −22) crushes skies and greens. A Version 1 preset, and RawTherapee 5.10 here vs 5.12 on Windows, so check it there before changing anything. |
| L4 | Cold preview grids are slow on 24 MP files (≈ 2 min for 33 tiles on 4 cores), the known Version 1 limit. The cache makes repeat views instant. |
| L5 | Run clears the photo selection (Version 1 behaviour), so the review panel empties after a Run. Fine, but worth knowing when using Analyze → Run → review again. |

## Not covered here

Windows PowerShell 5.1, `.bat` execution itself, RawTherapee 5.12, a GPU and 4–9B models, real Chrome on
your desktop, Windows file locking during batch progress. All are in `Version_2_test_guide.md`.

Screenshots: `_development/ui_test/` (preview grid, 240-photo library, scene view, review cards, AI tile,
real-LLM run, fixed scene header). Test scripts (Playwright) were kept in the session scratchpad, not the repo.

## Your decisions (2026-11-24) and what was done

| Decision | Implementation | Verified live |
|---|---|---|
| **AI runs get priority over review analyses** | An AI run's analysis has its own job lane (`analyze-run`, shown as "AI analysis for … (priority)"), so it never queues behind a review analysis. All LLM calls go through one priority gate (`llm/priorityGate.js`): when the model is free, a waiting run call goes before any waiting review / scene-naming call. A call already in progress is not interrupted. | Run started while a 6-photo review analysis was running: its analysis waited **1 ms** (was ~2 min), and the run finished in 14.6 s while the review kept going. Unit tests: ordering, no preemption, abort, and the mixed scenario. |
| **Presets: keep as is for now** | nothing changed | — |
| **No folder switch while previews load** | While a preset preview is queued/rendering (or photos are loading), the folder field, Enter, **Use this folder**, **Browse…** and the **Recent** buttons are disabled with the reason shown. The server enforces the same rule (`409`), and before switching it also waits (up to 10 s) for photo thumbnails still being served, which removes the stale-thumbnail 404s (L1). | During a cold preview: controls disabled + reason, API switch refused with 409. After the preview finished (164 s): controls enabled, switch accepted (285 ms). |

Tests after the decisions: server 249/249, client 132/132, Pester 62/62.
