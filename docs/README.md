# docs/ — what's live contract vs historical record

Added 2026-07-05 (the review-day polish pass). Nothing in this directory is dead weight — but
half of it is **live contract** (drifting from it breaks things) and half is **historical
evidence** (kept because this project's discipline is "every byte traces to a reference").
Read top-down when fresh; the per-file notes say which is which.

## Live contracts (the code must match these; they win over memory)

| Doc | What it is |
|---|---|
| `DE_DESIGN.md` | **THE UI contract** (FINALIZED 2026-06-10): geometry, interaction model, content modes, the window table. Where it and GLASSES_OS differ, this wins. |
| `G2_BLE_PROTOCOL.md` | **THE wire spec** (authoritative, decoded from Adam's own traffic): frames, ack-latency table, conn-interval ramp, ack-gated pacing, the multi-packet wall. |
| `WINDOW_API.md` | The `OsWindow`/`WmContext`/`WinView` contracts + the window-author checklist + smoke conventions. Synced to `windows/types.ts` 2026-07-05. |
| `CONTENT_API.md` | The content pipeline: markdown→blocks, ```chart spec (null = gap), image rendering, the page-≥2 rule. |
| `GLASSES_OS.md` | Architecture/vision + the render/input contract. Refined by DE_DESIGN (which wins). |
| `SIM_TOOLING.md` | The EvenHub-simulator design loop + measured firmware font metrics (incl. the `─`≈21 px finding). Layout guide only — validate feel on glass. |
| `SDK_CAPABILITY_MAP.md` | What the official SDK exposes vs what G2CC uses (the display+input-only scope decision). |
| `DISPATCH.md` | The dispatch-target architecture (vanilla CC now, swarm specialist later). |
| `HAT_BRIDGE_SPEC.md` | The ESP32 hat design + BOM (not built yet; the phone-replacement path). |

## Reviews (each is also the don't-re-chase list for its era)

| Doc | Scope |
|---|---|
| `CODE_REVIEW_2026-07-05.md` | **Review #6 — the whole-project pass** (72→65 fixed, refuted list, 96 catalogued improvements). The current don't-re-chase reference. |
| `CODE_REVIEW_2026-06-13.md` | Review #5 — the r19/r20 batch review. |
| `CODE_REVIEW_2026-06-11b.md` | Review #4 — incl. the open-questions batch. |
| `CODE_REVIEW_2026-06-11.md` | Review #3 — the build-out review. |
| `CODE_REVIEW_2026-06-06.md` | Review #2 — the harness-era multi-pass review (its deferred list still stands). |

## Historical records / evidence (kept deliberately; do not treat as current state)

| Doc | Why it's kept |
|---|---|
| `PROTOCOL_NOTES.md` | Protocol lineage + hardware-confirmed render constraints (feeds G2_BLE_PROTOCOL). |
| `EVENHUB_FINDING.md` | The EvenHub launch/keepalive discovery trail (references the probe evidence below). |
| `PROBE_V2_LOG_EXCERPT.txt`, `probe-screenshots/` | Raw probe evidence backing the wire spec. |
| `FORBIDDEN_PATTERN_AUDIT.md` | The line-by-line Three-Rules audit of the inherited g2code/g2aria source. |
| `INHERITANCE_MAP.md` | File-by-file inheritance from g2code/g2aria (both archived 2026-06-29 → `/home/user/g2-old-backup-2026-06-24.tar.gz`). |
| `VERIFIED_ENVIRONMENT.md` | Point-in-time environment verification snapshot. |
| `HOLDS.md` | The pre-upgrades deferral catalog — **superseded** by `upgrades.md` (itself now done) and `overhaul.md`. |

## Where the rest lives (repo root)

`HANDOFF.md` = the fullest current-state snapshot (read first) · `overhaul.md` = the LIVE plan
(DE/WM overhaul, Phases 1–3 + ledger) · `CHANGELOG.md` = the WHY of every change ·
`upgrades.md` + `UPGRADE_PROGRESS.md` = the (completed) v2 queue + its record ·
`g2_custom_app_spec.md` = the canonical build spec (wins over everything on conflict).
