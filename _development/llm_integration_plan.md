# LLM-guided editing — integration plan

Status: **plan, not implemented.** (Revision 2: the LLM never picks the preset.)

> **Phasing and a few decisions now live in `Version_2_development_plan.md`**, which overrides
> this file where they differ. Most notably: the LLM no longer adjusts `noiseReduction` /
> `sharpening` (code sets them from ISO), and the phase numbers in §9 below are replaced by the
> Version 2 phases. This file remains the detailed design reference.

**Goal.** An optional "AI-guided correction" mode. For each photo, a small vision LLM looks at the
picture and fine-tunes the **colour-correction / base-editing stage**: white balance, exposure,
highlight and shadow recovery, contrast, clarity, dehaze, saturation, noise and sharpening. The
aim is for every photo to start from a better, punchier base. RawTherapee still renders every
pixel.

**Out of scope for the LLM:** the look preset. That stays the user's choice, exactly as today. The
user's preset is applied on top of the AI-corrected base, so the look works on a better starting
point.

**Second feature: scene grouping (§7).** The LLM also groups photos of the same scene, e.g.
"Beach at sunset" or "Dinner indoors". In the photo picker, each scene can be selected in one
click, the same way a month or day can be today. You can then select a whole scene and run it
with one preset.

The current non-LLM workflow stays exactly as it is and remains the default. The LLM provider can
be swapped (local Ollama → OpenRouter → Claude API) by changing config only.

---

## 1. Core idea: the LLM picks correction steps, code writes the pp3

The pipeline today:

```
rawtherapee-cli -p <base profile (ISO-branched)> [-p <format overlay>] [-p <user preset>] ...
```

The base profile (`default.pp3` / `lowlight.pp3`) is one fixed set of corrections for every
photo: +0.25 EV, auto-ITC white balance, ShadowCompr 35, Dehaze 6, Local Contrast 0.08,
and so on. That is a good average, but it isn't tailored to any one photo. LLM mode adds **one
per-photo correction overlay**, stacked right after the base, **before** the user's preset:

```
-p <base profile> [-p <format overlay>] -p <AI correction overlay> [-p <user preset>]
└──── existing ──────────────────────┘  └─── new, LLM mode only ──┘  └ unchanged ┘
```

The LLM does **not** write `.pp3` text. A small model would invent keys and cause the
`"Usage:"` help-text failure `auto_enhance.ps1` already detects. Instead it returns a small,
fixed JSON **correction plan** of named adjustments in integer steps. Deterministic code clamps
the values and turns them into the overlay.

### Why the overlay won't conflict with your presets
A later `-p` **replaces** any key it sets. If the AI overlay touched the same keys as the presets,
either the preset would silently erase the AI's work or the AI would change your look. So the AI
overlay is limited to **keys no preset sets**. I counted the keys across all 32 `presets/*.pp3`
files. The presets only touch:

> `[Vibrance]`, `[Luminance Curve]` Contrast/LCurve, `[ColorToning]`, `[Exposure] Black`,
> `[PCVignette]`, `[EPD]`, `[Black & White]`

The AI's allowed set (§3) avoids all of these. In practice the stages divide cleanly:
**AI = technical correction and per-photo punch**, **preset = creative look**. Add a unit test
that parses every preset and fails if a preset ever starts setting a key the AI owns. That keeps
the split honest as presets change.

This also means the order is: correction first, then the look, which is how a human edits too.

---

## 2. What the LLM sees

### 2.1 The image: show it the *real* base render, not the camera JPEG
Two options, set by `config.llm.inputImage`:

| Option | What it is | Speed | Quality of judgement |
|---|---|---|---|
| `"baseRender"` (**recommended**) | A small, fast RawTherapee render of the photo through the **base profile only** (the same trick `preview_presets.ps1` already uses: `-f` + `profiles/preview_fast_resize.pp3` stacked last, ≈900×600) | +~6 s per photo | The LLM sees exactly what its corrections will be applied to. "Shadows look crushed" is then true of *our* render |
| `"embedded"` | The camera's embedded preview JPEG (what `thumbnails.js` already extracts) | Free | The camera's own processing (its WB, tone curve, picture style), so steps relative to *our* base are a guess |

The LLM's output is *relative* ("+1 exposure"), so it has to see the thing it is correcting.
That makes `baseRender` the right default when quality is the goal. `embedded` is the fast mode.

### 2.2 EXIF context (one batched ExifTool call, like `captureDates.js`)
ISO, shutter, aperture, focal length, lens, flash fired, capture time, camera model, and the
camera's own white-balance setting / colour temperature where the body records it (Sony does).
This helps small models a lot: "ISO 6400, 1/30 s, 23:40, tungsten WB" tells it far more about
noise and colour cast than pixels alone.

### 2.3 Optional pixel stats (phase 3)
Histogram summary of the base render: mean luminance, % clipped highlights and shadows, mean
saturation, average R/G/B of the brightest 5% (a hint for colour casts). Small models are bad at
judging clipping by eye, and these numbers fix that. Needs an image decoder in Node (`sharp`),
so leave it out of v1.

### 2.4 Prompt
- Role: "You are a photo retoucher doing the technical base correction. A separate creative look
  will be applied after you, so aim for a clean, well-exposed, vivid but natural photo, not a style."
- The meaning of every adjustment and its −2..+2 range, with short examples
  ("+1 shadows = lift shadow detail noticeably, not flat").
- Tell it explicitly: **0 is a valid and common answer.** Without this, small models tend to
  change everything.
- Optional: the name of the user's chosen preset, as **context only** (e.g. "the look applied
  afterwards is `dramatic_mono`, so don't bother fixing colour casts" or "`high_key_bright`
  follows, so don't add exposure"). This is a cheap way to avoid stacking corrections.
- 2–3 short few-shot examples (scene description → plan).
- Versioned with `PROMPT_VERSION` (part of the cache key, §8).
- Qwen3.x may emit a "thinking" phase: turn it off (Ollama `think: false`). It adds latency and
  doesn't help here.

---

## 3. The correction-plan schema (the contract between LLM and pipeline)

```jsonc
{
  "scene":    "landscape|portrait|street|architecture|night|astro|food|macro|event|other",
  "lighting": "golden_hour|blue_hour|daylight_harsh|overcast|indoor_tungsten|indoor_mixed|night|flash",
  "issues":   ["underexposed","blown_highlights","crushed_shadows","colour_cast_warm",
               "colour_cast_cool","colour_cast_green","colour_cast_magenta","hazy","flat",
               "noisy","soft"],              // 0..n, display + sanity check
  "adjustments": {                            // every value is an integer step -2..+2, 0 = leave as-is
    "exposure":      0,
    "highlights":    0,   // + = recover more highlight detail
    "shadows":       0,   // + = lift shadows
    "contrast":      0,
    "clarity":       0,   // local contrast / micro-contrast: the main "stand out" control
    "dehaze":        0,
    "saturation":    0,
    "warmth":        0,   // + = warmer
    "tint":          0,   // + = more magenta, - = more green
    "noiseReduction":0,
    "sharpening":    0
  },
  "notes": "1-2 sentences of reasoning, shown in the UI"
}
```

### Step → RawTherapee mapping (`correctionTable.js`, one tunable table)
The model decides *how much* ("a bit more clarity" = +1). Code decides *what that means* in
RawTherapee units. The table is tuned by eye in Phase 0 and lives in code, where you can test
and fix it. It never lives in the prompt. Every row only touches keys that no preset sets:

| Step | pp3 section → key | Base value (default.pp3) | Per step (starting guess) |
|---|---|---|---|
| exposure | `[Exposure] Compensation` | 0.25 | ±0.3 EV |
| highlights | `[Exposure] HighlightCompr` (+ `[Shadows & Highlights] Highlights` at ±2) | 12 | ±15 |
| shadows | `[Exposure] ShadowCompr` (+ `[Shadows & Highlights] Shadows` at ±2) | 35 | ±12 |
| contrast | `[Exposure] Contrast` | 0 | ±10 |
| clarity | `[Local Contrast] Amount` | 0.08 | ±0.06 |
| dehaze | `[Dehaze] Strength` | 6 | ±10 |
| saturation | `[Exposure] Saturation` | 0 | ±8 |
| warmth | `[White Balance] TemperatureBias` (keeps auto-ITC WB, nudges it) | 0 | ±0.1 |
| tint | `[White Balance] Green` → see note | auto | ±0.04 |
| noiseReduction | `[Directional Pyramid Denoising] Luma` / `Chroma` | 3 / … | ±5 / ±10 |
| sharpening | `[Sharpening] Amount` | 130 | ±25 |

Notes:
- **Values are absolute: base + delta.** A later `-p` replaces a key, it doesn't add to it, so
  `correctionToPp3.js` reads the *actual* base profile chosen for that file (default vs.
  lowlight, after ISO branching) with a small INI parser and writes `base + step × unit`.
- **White balance:** `TemperatureBias` keeps RawTherapee's auto-ITC white balance and only nudges
  it. That's safer than having the LLM set a Kelvin value, which it can't judge. `tint` may need
  a different approach (auto-ITC recomputes green) — verify in Phase 0 and drop it from v1 if it
  doesn't take effect.
- **High ISO:** for files where ISO branching chose `lowlight.pp3`, cap `sharpening` at 0 and
  `noiseReduction` at ≥0. A small model shouldn't be able to make noise worse.
- **Overall strength knob:** `config.llm.strength` (0.5 / 1.0 / 1.5) multiplies every delta. This
  is the user's "subtle ↔ punchy" dial in the UI, applied after the LLM. No new LLM call needed.

### Validation (`correctionPlan.js`)
Unknown enum → `other`. Non-integers rounded, values clamped to −2..+2, unknown keys dropped.
JSON that won't parse → one retry, then **all-zero plan** (= today's output). A schema failure
never fails the job.

---

## 4. Optional second pass: check the result (phase 3)

Being able to look at the *result* is the biggest quality jump available. After pass 1, render
the fast preview again **with** the AI overlay and ask the LLM: "here is before/after, refine?",
returning the same schema as small corrections (±1 max). Cap it at one refinement.
- Cost: one more ~6 s fast render plus one more LLM call per photo.
- Config: `config.llm.refinePass: false` by default, so you can measure whether it's worth it on
  your photos.

---

## 5. Provider abstraction (local now, cloud later)

All provider code lives in `webapp/server/llm/`. Callers only ever see one interface:

```js
// llm/provider.js
/**
 * analyzeImage({ images: [{ base64, mediaType }], systemPrompt, userText, jsonSchema, signal })
 *   -> Promise<{ text, usage: { inputTokens, outputTokens } | null, model }>
 */
```
(`images` is an array so the refine pass can send before + after.)

| Adapter | File | Endpoint | Structured output | Notes |
|---|---|---|---|---|
| Ollama (default) | `llm/ollamaProvider.js` | `POST {baseUrl}/api/chat` (default `http://localhost:11434`) | `format: <JSON schema>` | `images: [base64]` on the message; `keep_alive` so the model stays loaded for the batch; `think: false`; temperature ≈0.2 |
| OpenAI-compatible | `llm/openaiCompatProvider.js` | `POST {baseUrl}/chat/completions` | `response_format: { type: "json_schema", ... }` | Covers **OpenRouter** (`https://openrouter.ai/api/v1`), LM Studio, llama.cpp server, vLLM. Images as `image_url` data URIs |
| Anthropic | `llm/anthropicProvider.js` | official `@anthropic-ai/sdk`, `client.messages.create` | `output_config: { format: { type: "json_schema", schema } }` | Images as `{type:"image", source:{type:"base64",...}}`. Default model `claude-opus-5-5`; `claude-haiku-5-5` is the cheap/fast option for bulk batches (your choice in config). Check `stop_reason` (`refusal` → all-zero plan). `cache_control` on the system prompt, since it's identical for every photo in a batch |
| Mock | `llm/mockProvider.js` | — | — | Canned plans, for tests and for trying the UI with no LLM running |

- `llm/index.js` → `createProvider(cfg.llm)` picks the adapter by `cfg.llm.provider`.
- Plain `fetch` (Node 18+ has it built in) for Ollama and OpenAI-compatible: no new dependency.
  `@anthropic-ai/sdk` is loaded lazily, only when `provider: "anthropic"`.
- The JSON schema is defined **once** (`llm/correctionSchema.js`) and passed to every adapter.
  `correctionPlan.js` validation still runs afterwards, because local models don't always follow
  a schema strictly.

### Config (`config/config.json`, new optional block)
```jsonc
"llm": {
  "enabled": false,                 // master switch; the UI toggle only shows when true
  "provider": "ollama",             // ollama | openai-compat | anthropic | mock
  "model": "qwen3.5:9b",            // any vision-capable model tag
  "baseUrl": "http://localhost:11434",
  "apiKeyEnv": null,                // e.g. "OPENROUTER_API_KEY" / "ANTHROPIC_API_KEY"
  "inputImage": "baseRender",       // baseRender | embedded (§2.1)
  "refinePass": false,              // §4
  "strength": 1.0,                  // global multiplier on all deltas
  "timeoutMs": 60000,
  "concurrency": 1,                 // 1 for local GPU; 4-8 is fine for cloud
  "maxImagePx": 1024,
  "sendGpsToCloud": false
}
```
- **API keys are never stored in config.json.** Config names an environment variable and the
  server reads `process.env[...]`. config.json has already leaked a local path once (see
  `.gitignore`).
- Switching to cloud means editing three lines: `provider`, `model`, `baseUrl`/`apiKeyEnv`.
- Add the block to `config.example.json` with `enabled: false`. Extend `startupChecks.js` /
  `/api/health` with an `llm` status: disabled / reachable / model missing (for Ollama: check
  `GET /api/tags` and confirm the model is in the list).

### Model notes
- Qwen3.5's small models accept images natively. 4B–9B is the sweet spot. ~2B is likely too
  weak to judge subtle exposure and colour. Check the exact Ollama tag with `ollama list` / the
  Ollama library before setting `model`.
- Privacy: in cloud mode the downscaled renders and EXIF leave the machine. Strip GPS by default
  and show a one-line notice in the UI when the provider isn't local.

---

## 6. Where it plugs into the pipeline

The LLM step runs **in the Node server**, not in PowerShell. Node already has `fetch`, JSON, the
job queue, caching and progress reporting. PowerShell only gets one new, optional input.

### 6.1 `auto_enhance.ps1`: optional `-CorrectionsJson <file>`
```json
{ "C:\\photos\\a.ARW": "C:\\...\\.webapp_cache\\corrections\\<key>.pp3", ... }
```
- When a file has an entry, insert `-p <overlay>` **after the base/format overlay and before the
  preset**. The batch `-Preset` stays exactly as the user chose it.
- Passed as a **file path**, not inline JSON, to avoid the command-line length limit
  (`ENAMETOOLONG` has happened before).
- Output naming: `<name>_ai.jpg` / `<name>_ai_<preset>.jpg`, so AI-corrected renders never
  collide with or get skipped because of existing plain ones. The idempotency check keeps working.
- New CSV log columns: `AiCorrection` (compact, e.g. `exp+1 sh+1 cla+2`), `AiScene`.
  The `Enhancing ...` line format stays the same so `makeRunJobFn`'s progress parsing doesn't break.
- Without `-CorrectionsJson`, the script behaves exactly as it does today.
- Pester tests (next to `presetStacking.Tests.ps1`): `-p` order base → format → AI → preset,
  naming, files missing from the map get no overlay.

### 6.2 New `analyze` job lane
`jobQueue.js` already runs an independent FIFO lane per type (`preview`, `run`). Add `analyze`:
per file → fast base render (or embedded JPEG) → EXIF → cache lookup → provider call
(limited by `llm.concurrency`) → validate → write overlay. Progress items use the same shape the
UI already renders.

### 6.3 The preset preview grid gets better too
`preview_presets.ps1` can accept the same overlay, so the "pick a look" grid shows every preset
**on the AI-corrected base** next to the plain one (`00_base_only` vs `00_ai_base`). You then
choose a preset based on what you'll actually get. The preview cache key gains the overlay hash.

### 6.4 UI
- **RunPanel:** an "AI-guided correction" toggle (shown only when `health.llm` is available) plus
  the strength dial (Subtle / Normal / Punchy). The preset picker is untouched.
- **Review (phase 2):** an "Analyze" button → per-photo cards showing before/after thumbnails,
  detected issues, the adjustment chips (`Exposure +1`, `Clarity +2`, …) with ± buttons to edit
  any step, and "reset to 0". Your edits are saved as the plan, so the LLM proposes and you can
  overrule it. This is also the best way to judge whether the LLM is helping.

### API additions
- `POST /api/analyze { files, preset? }` → `{ jobId }` (preset passed only as context, §2.4)
- `GET  /api/corrections?path=...` → cached plan for one photo, or 404
- `PUT  /api/corrections?path=...` → save a user-edited plan
- `POST /api/run { files, preset, projectName, aiCorrection: true }`
- `GET  /api/health` → adds an `llm` field

---

## 7. Scene grouping

**Goal:** the app proposes groups like "Harbour, golden hour (23 photos)" or "Restaurant
interior (41)". In the picker each group gets a header with **Select scene**, exactly like the
existing `MonthHeader` / `DayHeader` "Select month / Select day" buttons. You select one or more
scenes, pick a preset and run. The preset is still entirely your choice. The groups just make it
quick to apply the same look to a whole scene.

### 7.1 How the groups are built: time and EXIF first, then the LLM
A small local model can't look at 500 photos at once and sort them. Even a cloud model would be
slow and costly that way. So grouping happens in three steps, and the LLM only does the parts
code can't:

**Step 1: candidate segments by code (instant, no LLM).**
Sort by `dateTaken` (already read by `captureDates.js`). Start a new segment when:
- the time gap to the previous photo exceeds `scenes.maxGapMinutes` (default 10), or
- the light changes sharply: the exposure value computed from ISO, shutter and aperture jumps by
  more than ~3 EV (indoors ↔ outdoors, day → night), or flash switches on or off,
- or the camera body changes (two shooters at one event), when `scenes.splitByCamera` is on.

This already gets most boundaries right: one burst is one scene, and walking from the beach into
a restaurant is a time gap plus an EV jump. The extra EXIF fields come from the same batched
ExifTool call, extended from `DateTimeOriginal` to also read ISO, ExposureTime, FNumber, Flash
and Model.

**Step 2: a short visual tag per photo (same LLM call as the correction analysis).**
The per-photo call already looks at the image, so the schema gets a few cheap extra fields:
```jsonc
"sceneTags": {
  "setting": "beach|street|indoor_restaurant|forest|...",   // fixed vocabulary
  "subject": "people|landscape|food|architecture|...",
  "light":   "golden_hour|overcast|tungsten|...",           // same enum as "lighting"
  "caption": "max 8 words, e.g. 'couple on pier at sunset'"
}
```
For grouping *without* running a correction analysis, there's a tags-only mode: the embedded
preview JPEG (no RawTherapee render), a much shorter prompt, ≈1–3 s per photo locally. That makes
grouping a whole folder practical.

**Step 3: the LLM merges or splits segments, and names them (text only, cheap).**
One text-only call per day (no images) gets the segment list: time range, EXIF summary, and the
tags and captions of each segment's photos. It returns:
```jsonc
{ "groups": [ { "segments": [0, 1], "name": "Harbour at golden hour" },
              { "segments": [2],    "name": "Seafood dinner" } ],
  "splits": [ { "segment": 3, "afterPhotoIndex": 12, "reason": "moved from market to temple" } ] }
```
- **Merge** neighbouring segments that are the same scene despite a gap (a coffee break at the same
  viewpoint).
- **Split** a segment where the tags change clearly with no time gap (walking from a market into a
  temple).
- Only **neighbouring** segments may merge. Groups always cover a continuous stretch of time.
  This keeps the job easy for a small model and keeps the result predictable.
- Optional boundary check (phase 3): for unclear boundaries, send the two thumbnails on either
  side and ask "same scene? yes/no". Small vision models answer two-image comparisons reliably.

Validation is the same as for corrections: the output is checked against the segment list, and
invalid indices are dropped. If the LLM fails, the **Step 1 segments are used as the groups**,
named by code (`"14:05–14:40 · 23 photos"`). Grouping always produces something usable.

### 7.2 Storage and editing
- Stored per source folder in `.webapp_cache/scenes/<folder-key>.json`:
  `{ id, name, photos: [relPath…], start, end, source: "auto"|"edited" }`, plus the file
  fingerprints (size + mtime) used, written with `atomicFile.js`.
- **Incremental:** when new photos appear in the folder, only the affected days are regrouped.
  Groups you edited (`source: "edited"`) are never overwritten automatically.
- **Editing in the UI:** rename a scene, merge it with the next one, split it at a chosen photo,
  or move selected photos to another scene. These are cheap operations on the JSON, with no new LLM
  call. The LLM proposes the groups, but you have the final say.

### 7.3 Picker UI
- New **"Group by: Date | Scene"** switch in `PhotoPicker.jsx`.
  - **Date** (default): exactly today's month → day → photos view.
  - **Scene**: day → scene → photos. Each scene header shows the name, time range, count and a
    small strip of its first thumbnails, and has a **Select scene / Deselect scene** button.
    It reuses `onSelectMany` and the same all-selected logic as `DayHeader`. The virtualized
    row list (`useVirtualRows`) gets a `scene` row type next to `month` / `day`.
- Photos with no group yet (not analysed) show under an "Ungrouped" header, so nothing
  disappears from the picker.
- **"Find scenes"** button: queues the grouping job for the current folder, or only the days in the
  current date filter on a large library. Shows progress like other jobs.
- The search box also matches scene names and captions ("sunset", "dinner").
- `groupByScene()` goes in a new `sceneUtils.js` next to `groupByDate()` in `dateUtils.js`, and is
  unit-tested the same way.

### 7.4 One preset per scene, several scenes in one go
- **Basic (v1):** select a scene, choose a preset, click Run. This works with the existing
  `/api/run` unchanged. Project naming can default to the scene name.
- **Per-scene presets (phase 3):** in scene view, a preset dropdown on each scene header, then
  **"Queue all scenes"**. This queues one normal `run` job per scene with its own preset, using
  the job queue as it exists today. No pipeline changes, and each scene's job can be cancelled,
  retried or reordered on its own.

### 7.5 Consistent corrections within a scene
When AI correction (§1–6) and scene groups are both on, scenes also fix a weakness of per-photo
correction: neighbouring shots of one scene can get slightly different white balance and look
inconsistent next to each other. The solution:
- **Scene-level values:** `warmth`, `tint` and `dehaze` are replaced by the scene's **median**
  value. A scene has one light source, so it should have one white balance.
- **Per-photo values:** `exposure`, `highlights`, `shadows` stay individual, since bracketing and
  framing really do vary from shot to shot. `clarity`, `saturation`, `contrast` are pulled halfway
  toward the scene median.
- Controlled by `scenes.harmonizeCorrections` (default on). This is pure code on top of the cached
  plans, so no extra LLM calls are needed.

### 7.6 API additions
- `POST /api/scenes/detect { days? }` → `{ jobId }` (new `scenes` job lane)
- `GET  /api/scenes` → groups for the active source folder
- `PATCH /api/scenes/:id { name }`, `POST /api/scenes/:id/split { afterRelPath }`,
  `POST /api/scenes/merge { ids }`, `POST /api/scenes/move { relPaths, toId }`

### 7.7 Config
```jsonc
"scenes": {
  "maxGapMinutes": 10,
  "evJumpThreshold": 3,
  "splitByCamera": true,
  "useLlm": true,            // false = time/EXIF segments only, no LLM at all
  "harmonizeCorrections": true
}
```
With `useLlm: false`, scene grouping works even with no LLM installed. It's a useful feature on
its own and a sensible first deliverable.

---

## 8. Caching, cost, failure handling

- **Cache key:** `sha1(path + size + mtime) + provider + model + PROMPT_VERSION + inputImage + base
  profile fingerprint`. Re-running a batch, or the same photos with a different preset, never
  calls the LLM again: the correction doesn't depend on the preset. (If the preset is passed as
  context, add its name to the key.) A user-edited plan is stored separately and always wins.
  Same idea as `previewCache.js`'s fingerprint; written with `atomicFile.js`.
- **The overlay is regenerated from the plan at render time**, not cached as pp3. Changing the
  step table or `strength` therefore applies without re-asking the LLM.
- **Never block the main workflow:** provider unreachable, timeout, bad JSON or refusal → that
  photo gets an all-zero plan (= today's output) and the note `"AI correction skipped: <reason>"`.
  The job only fails if RawTherapee fails, same as today.
- **Bursts (phase 3):** frames within ±2 s with identical exposure settings reuse the first
  frame's plan.
- **Speed:** local 4–9B vision model ≈2–10 s per photo, plus ~6 s for the fast base render.
  That's next to the ~22 s full render measured in `docs/gpu_spike_findings.md`. Analysis of photo
  N+1 can overlap with RawTherapee rendering photo N later; sequential is fine for v1.
- **Cloud cost:** log `usage` per call, and show a running total in the job result.

---

## 9. Phased implementation

**Phase 0 — prove it on your photos first (no app changes).**
1. Calibrate the step table by hand: render 5 photos with each single step at ±1/±2 and check by
   eye that "+1" is a sensible amount. Confirm `tint` actually takes effect with auto-ITC WB.
2. A ~100-line Node script: 30–50 of your photos → fast base render → Ollama → plan → full render
   with the overlay. Write a side-by-side HTML page (base vs AI-corrected) like the existing
   `preview/index.html`.
3. Decide: does it actually look better? Is `baseRender` worth the ~6 s over `embedded`? Which
   steps does the model use sensibly, and which should be dropped? Only build the UI once this
   holds up.
4. Scenes: run the Step 1 time/EXIF segmentation (§7.1) on 2–3 real shoots and compare it with how
   you'd group them by hand. This shows how much the LLM merge/split step actually needs to fix.

**Phase 1a — scene grouping without the LLM (useful on its own, small).**
Step 1 segmentation (`sceneSegmenter.js`, pure + unit-tested), the extended ExifTool read,
the scenes cache + edit endpoints, the "Group by: Date | Scene" picker view with
**Select scene** headers, and "Find scenes" with `scenes.useLlm: false`. You can already select
a scene and run it with a preset.

**Phase 1b — backend core + one-click AI correction.**
`llm/` (interface, Ollama + mock adapters, schema, prompt), `correctionPlan.js`,
`correctionTable.js`, `correctionToPp3.js` + pp3 reader, a "presets never set AI-owned keys"
test, the corrections cache, `-CorrectionsJson` in `auto_enhance.ps1` + Pester tests, `_ai`
naming (also update `outputFileFor()`, which cancel cleanup depends on), the `llm` config block +
health check, and the RunPanel toggle + strength dial. Unit tests (node:test) for every pure part.

**Phase 2 — LLM scenes + review and edit.**
`sceneTags` in the analysis schema + the tags-only mode, the per-day merge/split/naming call
(§7.1 Step 3), scene rename/merge/split/move UI, scene-name search. Analyze button, per-photo before/after cards with editable step chips, `PUT /api/corrections`,
AI-corrected base in the preset preview grid (§6.3).

**Phase 3 — quality.**
Refine pass (§4), histogram stats (§2.3), burst reuse, per-scene presets + "Queue all scenes"
(§7.4), harmonizing corrections within a scene (§7.5), two-thumbnail boundary check (§7.1).

**Phase 4 — cloud providers.**
OpenAI-compatible adapter (OpenRouter), Anthropic adapter, `apiKeyEnv`, GPS stripping + privacy
notice, token/cost display. Because the interface was fixed in Phase 1, this only adds adapter
files and config. No pipeline changes.

**Possible later work:** log (LLM plan → your edited plan) pairs from the review screen and use
the most informative ones as few-shot examples, so the LLM learns your taste over time.

---

## 10. New / changed files (summary)

```
webapp/server/llm/provider.js              NEW  interface + shared helpers (timeout, retry once)
webapp/server/llm/index.js                 NEW  createProvider(cfg.llm)
webapp/server/llm/ollamaProvider.js        NEW
webapp/server/llm/mockProvider.js          NEW
webapp/server/llm/openaiCompatProvider.js  NEW (phase 4)
webapp/server/llm/anthropicProvider.js     NEW (phase 4)
webapp/server/llm/correctionSchema.js      NEW  the single JSON schema
webapp/server/llm/prompt.js                NEW  prompt builder + PROMPT_VERSION
webapp/server/correctionPlan.js            NEW  validate / clamp / all-zero fallback
webapp/server/correctionTable.js           NEW  step -> pp3 key/unit table (tunable)
webapp/server/correctionToPp3.js           NEW  plan + base profile -> overlay (pure) + pp3 reader
webapp/server/correctionsCache.js          NEW
webapp/server/tests/presetKeyOwnership.test.js  NEW  presets must not touch AI-owned keys
webapp/server/config.js                    CHG  llm block
webapp/server/startupChecks.js             CHG  llm health
webapp/server/server.js                    CHG  /api/analyze, /api/corrections, aiCorrection in /api/run
scripts/auto_enhance.ps1                   CHG  optional -CorrectionsJson, overlay before preset
scripts/preview_presets.ps1                CHG  optional overlay -> 00_ai_base tile (phase 2)
scripts/tests/aiCorrection.Tests.ps1       NEW
config/config.example.json                 CHG  llm block, enabled:false
webapp/client/src/components/RunPanel.jsx  CHG  toggle + strength dial
webapp/client/src/components/CorrectionReview.jsx  NEW (phase 2)
webapp/client/src/api.js                   CHG  analyze / corrections / scenes endpoints
webapp/server/sceneSegmenter.js            NEW  time/EV/camera segmentation (pure)
webapp/server/sceneGrouper.js              NEW  LLM merge/split/naming + fallback naming
webapp/server/scenesStore.js               NEW  per-folder scenes cache + edit operations
webapp/server/llm/scenePrompt.js           NEW  text-only grouping prompt + schema
webapp/server/captureDates.js              CHG  also read ISO/ExposureTime/FNumber/Flash/Model
webapp/server/server.js                    CHG  /api/scenes/* endpoints, `scenes` job lane
webapp/client/src/sceneUtils.js            NEW  groupByScene() (+ tests)
webapp/client/src/components/PhotoPicker.jsx  CHG  Date|Scene switch, SceneHeader with Select scene
webapp/client/src/components/SceneEditor.jsx  NEW  rename / merge / split / move (phase 2)
```

## 11. Decisions on the former open questions (settled 2026-11-24: "use the suggestions")
- **Preset as LLM context:** not passed in v1. Corrections stay independent of the preset, so the
  cache works across presets. It may be tried later as an experiment.
- **"Pop" without `[Vibrance]`:** `[Exposure] Saturation` only in small steps. Clarity (local
  contrast) and dehaze carry the "stand out" effect. The step table is tuned at calibration.
- **Scenes across midnight:** allowed. Segmentation uses time gaps only, not calendar days, and a
  scene is shown under the day it started.
- **Scene view layout:** day → scene → photos. The day headers stay, so "Select day" still works.
- **AI toggle on by default:** no. It stays opt-in (off by default) in Version 2. Whether it
  becomes the default is decided after your manual test of Version 2.
