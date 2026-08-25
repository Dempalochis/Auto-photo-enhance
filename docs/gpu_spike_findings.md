# GPU acceleration spike — findings

Status: **research spike, not implemented.** Per the V4 plan's review notes, this phase was
descoped from "install darktable and benchmark it" to "instrument the existing pipeline, gather
real numbers from this machine, and write a recommendation" — actually installing and benchmarking
third-party software on your machine isn't something to do without you directly asking for that
specific action, independent of what an earlier plan draft said.

## Can RawTherapee itself use a GPU?

No. RawTherapee is CPU-multithreaded by design and has no OpenCL/GPU acceleration path — the
upstream feature request ([Beep6581/RawTherapee#1678](https://github.com/Beep6581/RawTherapee/issues/1678))
has been open since 2015 with nothing shipped. This is consistent with what this repo's own
README already documented: `-f` (fast-export, which bypasses sharpening/denoise/defringe/wavelet
and forces the fastest demosaic) measured no real speedup here, because the bottleneck is the
demosaic/denoise math itself, not something a flag unlocks.

darktable does have real OpenCL GPU acceleration (commonly a 50-70% export-time cut on capable
hardware, per [darktable's own docs](https://docs.darktable.org/usermanual/3.8/en/special-topics/opencl/performance/)),
but it's a different engine end to end: XMP sidecars instead of `.pp3` profiles, a different
processing pipeline. Adopting it would mean rebuilding the 30-preset "look" system on a second
engine, not flipping a config flag — a rearchitecture, not this phase's scope.

## What this phase actually built

Per-stage timing, surfaced for free (derived from timestamps/measurements already available, no
new dependencies):

- **`GET /api/photos`** now returns a `timing: { fileCount, walkMs, captureDatesMs }` field —
  splits "list files on disk" from "read EXIF capture dates via exiftool" ([server.js](../webapp/server/server.js)'s `listPhotos()`).
- **Every job** (`GET /api/jobs`, `GET /api/jobs/:id`) now returns a
  `timing: { queueWaitMs, runDurationMs, totalMs }` field ([jobTiming.js](../webapp/server/jobTiming.js)) —
  splits "waiting in the FIFO queue behind another job" from "actually running."

Both are pure functions of data already collected, unit-tested in
[tests/jobTiming.test.js](../webapp/server/tests/jobTiming.test.js), no new runtime cost.

## Real numbers, gathered on this machine during this session

**Listing photos** (74 real `.ARW` files, real library):
```
{"fileCount":74,"walkMs":2,"captureDatesMs":2803}
```
The filesystem walk is negligible (2ms). Reading EXIF capture dates via `exiftool` takes ~2.8
seconds for 74 files — **this is the real bottleneck for browsing a library**, not RawTherapee,
and not GPU-related at all: it's exiftool process-spawn + parse overhead, already mitigated in
this same V4 cycle by [captureDates.js](../webapp/server/captureDates.js)'s batching fix (splits
into ≤300-file/≤6000-char batches run with concurrency 4, instead of the one-shot call that used
to crash with `ENAMETOOLONG` on a 4544-file library). On a much larger library this would still
be the first thing to profile again before assuming RawTherapee itself is the problem.

**Converting one photo** (single file, no preset — color correction only):
```
{"queueWaitMs":1,"runDurationMs":22072,"totalMs":22073}
```
`queueWaitMs` of 1ms confirms the queue itself adds no meaningful overhead when nothing else is
running - all ~22 seconds is genuinely "doing the work." That ~22s for one file is the ceiling on
what any GPU work could theoretically claw back for a *single* conversion, though it's worth
noting this includes PowerShell process startup and RawTherapee's own cache/profile loading
alongside the actual demosaic/render — this coarse, request-level instrumentation can't separate
those from each other. `auto_enhance.ps1` already writes a **per-file** CSV log (`logs/*.csv`,
per the main README) with its own duration column; that's the next level of granularity to look
at before concluding how much of the 22s is fixed startup cost vs. genuinely scaling with photo
count in a batch.

## Recommendation

1. **Don't pursue darktable or any GPU path yet.** The one real multi-file bottleneck actually
   measured this session (EXIF reads while listing a library) has nothing to do with rendering
   and was already fixed by the batching work earlier in this same V4 cycle.
2. **Before spending any engineering effort on GPU acceleration**, profile a real multi-photo
   batch run's per-file CSV durations (already logged, no new tooling needed) to see whether
   render time is dominated by fixed per-invocation overhead (process startup, cache loading —
   which a GPU can't help with) or by work that actually scales with pixel count (which a GPU
   engine plausibly could). The `timing.runDurationMs` field this phase added makes the
   *batch-level* number visible in the UI/API; the CSV has the *per-file* breakdown already.
3. **If** a future profiling pass on a real large batch shows render time (not startup, not
   EXIF, not disk I/O) genuinely dominates and scales with volume, the narrowest next step would
   be evaluating darktable as an **opt-in fast-preview renderer only** (the 30-preset preview
   grid is the most latency-sensitive interaction and doesn't need to match final-output fidelity
   exactly) rather than replacing the batch-run engine of record — bounding the blast radius to
   one feature instead of a full pipeline rewrite.

Sources: [RawTherapee GPU discussion, discuss.pixls.us](https://discuss.pixls.us/t/rawtherapee-and-gpu-acceleration-on-linux/15052) · [OpenCL feature request, GitHub](https://github.com/Beep6581/RawTherapee/issues/1678) · [darktable OpenCL performance docs](https://docs.darktable.org/usermanual/3.8/en/special-topics/opencl/performance/) · [RawTherapee vs Darktable comparison](https://pixelretouching.com/rawtherapee-vs-darktable)

---

## V6 update: real per-file CSV numbers, gathered across every log on this machine

Per this doc's own recommendation #2 above ("profile a real multi-photo batch run's per-file CSV
durations... before spending any engineering effort on GPU acceleration"), this V6 phase built
[timingReport.js](../webapp/server/timingReport.js) - a small, unit-tested (see
[tests/timingReport.test.js](../webapp/server/tests/timingReport.test.js)) script that parses
every `logs/*.csv` and `projects/*/_logs/*.csv` on disk and aggregates `Processed` rows'
`DurationSec`. Run via `node webapp/server/timingReport.js`. Still read-only, still nothing
installed - matches the same boundary as the original spike.

**Real result, this machine, every real batch run logged so far (19 CSV files, 342 file-rows):**
```
{
  "fileCount": 342,
  "counts": { "Processed": 270, "Skipped": 71, "Failed": 1, "other": 0 },
  "processedDurationSec": {
    "count": 270, "min": 14.12, "max": 66.55,
    "mean": 19.36, "median": 17.56, "stddev": 6.74, "totalSec": 5227.57
  }
}
```

**Reading it:**
- Per-file duration is **not** tightly clustered around a fixed floor - min 14.12s, max 66.55s,
  a ~4.7x spread, with a stddev (6.74s) at roughly 35% of the mean. If fixed per-invocation
  overhead (PowerShell/RawTherapee process startup, cache loading) dominated, every file would
  land close to the same number regardless of content - it doesn't. There is real, scene-dependent
  work-scaling happening per photo.
- That variance is **not** explained by the ISO-based profile branch (a cheap follow-up check,
  splitting the same 270 rows by `Profile`): `default` (n=240) means 19.42s, `lowlight` (n=30)
  means 18.90s - nearly identical, with both spanning a similarly wide min/max range on their own.
  So it isn't "lowlight's extra denoise work is the slow tail" - the spread is coming from
  somewhere else, most plausibly per-photo scene complexity (detail/edges/noise affecting
  demosaic and denoise iteration counts), which is exactly the kind of work a GPU-accelerated
  demosaic/denoise path (like darktable's OpenCL pipeline) is actually built to speed up.

**Does this change the recommendation? No - and here's the reasoning, stated precisely rather
than just repeating "don't pursue it":** the variance finding says *if* RawTherapee had a GPU
path, there'd plausibly be real time to claw back per photo. But recommendation #1 above is
unaffected by this data either way: **RawTherapee has no GPU path at all**, full stop, so this
variance is only actionable through darktable specifically, which is a different rendering engine
end to end (XMP sidecars, not `.pp3` profiles - see above). A mean of ~19s/file for a full-quality
batch conversion isn't the kind of "genuinely dominates and blocks real work" number
recommendation #3 set as the bar for even the *narrower* opt-in-fast-preview-only darktable
option - it's a real, measured, moderate cost, not a bottleneck. **Recommendation stands:
don't pursue GPU/darktable work now.** This update exists so that judgment is based on this
machine's actual accumulated numbers instead of the single manually-triggered sample the original
spike had room for.
