# G2CC

Direct-BLE G2 glasses + Claude Code dispatch + DJI single-mic learned-profile NR (+ NLMS fallback) + Parakeet ASR.

Replaces the Even Hub seven-tap relaunch dance with a Pixel 10a foreground service that talks BLE to the Even G2 glasses and WebSocket to a home server. The server bridges to a Claude Code subprocess (vanilla CC today; swarm Code/Engineering specialist later). Audio path goes server-side: DJI Mic 3 (mono TX2) → spectral subtraction with learned noise profile → DeepFilterNet polish → NVIDIA Parakeet TDT 0.6B v2. Two-mic NLMS retained in-tree as fallback for non-stationary noise scenarios.

## Layout

```
G2CC/
  CLAUDE.md                    project rules (loaded into every CC session here)
  g2_custom_app_spec.md        the canonical build spec (Part A app + Part B audio/STT)
  README.md                    this file
  package.json                 npm workspace root: shared/, server/
  tsconfig.base.json
  .gitignore
  scripts/                     dev runners (TBD)
  shared/                      TypeScript protocol + constants shared with server
    package.json
    tsconfig.json
    src/{protocol.ts,constants.ts,index.ts}
  server/                      Node + Fastify + WebSocket → Claude Code subprocess
    package.json
    tsconfig.json
    src/                       (populated in Phase 2A onward)
  audio/                       Python audio + STT pipeline
    venv/                      project-scoped Python 3.13 venv (do not commit)
    requirements.txt           sounddevice, soundfile, scipy, numpy, matplotlib (Phase 2B)
                               + padasip, deepfilternet (Phase 3B)
                               + nemo_toolkit[asr] (Phase 8)
    samples/                   captured DJI recordings (Phase 8 when at the machine)
    profiles/                  learned noise-PSD profiles (.npz; one per environment)
    tools/                     verify_dji_settings.py, capture.py, sanity_listen.py,
                               learn_noise_profile.py
    pipeline/                  notch_filter.py, spectral_subtract.py, nlms.py (fallback),
                               dfn_polish.py, parakeet_engine.py
  android/                     Kotlin Android app (Phase 4+)
  docs/
    INHERITANCE_MAP.md         which G2CC file inherits from which g2code/g2aria/aria source
    VERIFIED_ENVIRONMENT.md    Phase 0 verification capture
    FORBIDDEN_PATTERN_AUDIT.md line-by-line audit of pattern violations vs. the absolute rules
    PROTOCOL_NOTES.md          BLE protocol lineage from i-soxi/even-g2-protocol
    DISPATCH.md                Dispatcher interface contract; how to add swarm specialists later
    HOLDS.md                   deferred work catalog (hardware-gated + swarm-gated + polish)
```

External:
- `/home/user/G2 Custom/even-g2-protocol/` — i-soxi protocol clone (SHA `b227335` as of 2026-05-05).
- `/home/user/g2code/` — primary architectural baseline (DO NOT MODIFY).
- `/home/user/g2aria/` — robustness overlay source (DO NOT MODIFY).
- `/home/user/aria/whisper_engine.py` — lazy-load + threading.Lock pattern that Parakeet wrapper inherits.

## Phase status — all phases complete (code-only; hardware tests gated on Adam)

| Phase | Status | Notes |
|-------|--------|-------|
| 0 — Foundation & Verification | ✓ | Three docs in `docs/`. Re-verify env before Phase 8 NeMo install. |
| 1 — Skeleton + i-soxi clone + capture reading | ✓ | i-soxi clone @ SHA `b227335`; `PROTOCOL_NOTES.md` documents every UUID with lineage. |
| 2A — Server core (CC dispatch + WS) | ✓ | TS workspace builds; smoke test passes 6 expectations. |
| 2B — DJI capture infrastructure | ✓ | `verify_dji_settings.py` + `capture.py` + `sanity_listen.py`. Captures deferred to H5 (Adam at machine). |
| 3A — Server robustness polish | ✓ | Heartbeat, `/endpoints` refresh, multi-endpoint QR. |
| 3B — noise-reduction + DFN modules | ✓ | spectral_subtract + notch_filter (default) + nlms (fallback) + dfn_polish. Math sanity + real-data holdout validation passing on May phone recording (5-8 dB reduction with <0.6 dB speech impact at +18 dB SNR). Production tuning gated on H5 DJI captures. |
| 4 — Android shell + foreground service | ✓ | Sideloadable; gate H1 (8-hour pocket test) on Pixel 10a. |
| 5 — BLE driver against i-soxi | ✓ | 12 BLE files + 6 unit tests. Hardware test gate H2 (real glasses) before BLE bonding flow. |
| 6 — App↔Server WebSocket + 5-defence reconnect + HUD | ✓ | wsGen race-safe pattern, kotlinx.serialization protocol, Hud + MenuController. |
| 7 — confirm_on_hud primitive + Channel Router ack | ✓ | ConfirmationFlow.kt + server channel-router.ts. Hardware test gate H4. |
| 8 — Parakeet swap + DJI captures + tuning + speak/see/confirm | ✓ (code-only) | parakeet_engine.py + MicCapture.kt + AudioStreamer.kt. NeMo install + tuning gated on H5/H6. |
| 9 — Dispatch-target abstraction polish + holds doc | ✓ | DISPATCH.md + HOLDS.md; `SwarmCodeDispatcher` stub in dispatch.ts. |

**Total project:** ~70 source files of TypeScript + Kotlin + Python; ~15 Markdown docs (counts grow with each phase; numbers approximate, not load-bearing).

**What's left** is the hardware-gated test bucket (H1-H7) + swarm-gated wiring (S1-S4), all enumerated in `docs/HOLDS.md`. None of it blocks the primary speak/see/confirm flow once Adam has the glasses + DJI in hand.

## Cross-cutting non-negotiables

- **No timeouts** in BLE / WebSocket / capture / display / ASR paths.
- **No silent failures** — loud and proud.
- **No truncation** — HUD scrolls; never `…`.
- **Verify everything** — every BLE UUID, every NeMo function signature, every g2code/g2aria import. Lineage citations in source for reverse-engineered values.
- **Investigation ≠ permission.** Each phase begins after explicit "go."
- **Don't modify g2code or g2aria.** Working escape hatches.

See `CLAUDE.md` for the full rules.

## Plan file

The full implementation plan lives at `/home/user/.claude/plans/building-it-please-come-quizzical-parasol.md` (created 2026-05-05).
