# Version 2 — progress log

Branch: `version_2_dev`. Plan: `Version_2_development_plan.md` (phases, gates, working rules §9).
One entry per phase: what was done, what was skipped and why, deviations from the plan, test status.

| Phase | Status |
|---|---|
| Planning | ✅ done — plan, Version 1 record, LLM design committed (2026-11-24) |
| 0a Measure tooling + Linux behaviour checks | ⬜ not started |
| 1 Pipeline foundations | ⬜ not started |
| 2 Batched rendering + fault isolation | ⬜ not started |
| 3 Scene grouping (no LLM) | ⬜ not started |
| 4 LLM core + AI correction | ⬜ not started |
| 5 LLM scenes + review UI | ⬜ not started |
| 6 Quality | ⬜ not started |
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
