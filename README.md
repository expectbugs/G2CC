# G2CC — G2 Control Center

A personal, first-party UI for Adam's own Even Realities **G2** smart glasses — replacing the vendor
companion app with his own Android app + home-PC server. **The home PC is the OS/brain** (holds all
window/session state, composes every screen); **the glasses are a thin display** (render the scene they're
handed, send input back, hold zero state); **the phone is a BLE/WiFi bridge** that stays in Adam's pocket,
untouched (the "prime directive"). Everything runs on hardware Adam owns over his home network — there are
no third-party systems, accounts, or credentials anywhere. This is UI + display-rendering work for a
wearable.

Two joined initiatives (canonical spec: `g2_custom_app_spec.md`): **Part A** — the direct-BLE Android app
+ the home server that bridges WebSocket ↔ a Claude Code subprocess. **Part B** — the audio/STT upgrade
(DJI Mic 3 mono TX2 → learned-profile spectral subtraction → DeepFilterNet → NVIDIA Parakeet ASR; two-mic
NLMS retained as a fallback).

## Current state (2026-06-30)

**The window-manager DE is the project now.** The home server (`:7300`) runs a windowing system —
**15 windows** (Main, CC, Aria, Mail, Files, Reader, Timers, Calendar, Games, Notices, Search, Terminal,
Deliveries, Media, SMS), each a content provider; the compositor turns a window's `WinView` into a
`WireScene` the glasses render. The BLE wire format is fully decoded (`docs/G2_BLE_PROTOCOL.md`,
authoritative). Server smoke suite **26/27** green (the lone red, `phase10-calendar`, is a pre-existing
Google-OAuth `no refresh_token` environmental failure — not a regression). Android client APK v1.14.

- **Phase 1 — modularization (DONE, merged to master, on-glass verified):** the 15 windows were split out
  of the old 8,555-line `os-windows.ts` into `server/src/windows/` (one file each) behind the FROZEN
  `OsWindow`/`WmContext` contracts + a `registry.ts`; the host is `server/src/window-manager.ts`. Adding a
  window = a new `windows/<id>.ts` + ONE `registry.ts` line, no host edit. Contract doc: `docs/WINDOW_API.md`.

- **Phase 2 — the ribbon DE/WM (BUILT + LIVE behind a flag; Adam testing on glass):** a new root-nav.
  An MRU **recents ribbon** in the TOP bar — antenna-driven (a `scroll=true` strip is the sole
  event-capture; the server draws the cursor, which is what enables "lands on the previous window"
  alt-tab). Scroll = move cursor, tap = enter the window, double-tap = back/blank (reading windows go
  straight to the ribbon; browse windows navigate hierarchically). A categorized **`All>` drawer**,
  **comprehensive per-window previews** (a read-only `preview()` per window — in-memory + fast DB reads
  only, NEVER `view()`, which would spawn CC / ping the phone on hover), and **reclaimed chrome** (glasses
  battery beside the clock, no bottom status bar — content reclaims the row; CC/Aria show a thin phase bar
  only while active). Flag-gated: `config.de.rootNav: 'menu' | 'ribbon'` (default `'menu'` = the proven
  launcher + the instant one-line fallback). The 15 windows are reused UNCHANGED. Full plan + status:
  `overhaul.md`.

**On-glass-gated remainder** (needs the real glasses): §2.2.5 the in-window full-bleed reclaim of the left
menu (on-glass co-design of where the action menu lives once the pinned column is gone), §2.2.7 on-glass
hardening (antenna feel/latency), §2.2.8 cutover (flip the default to `'ribbon'` after the soak).

**Audio/STT (Part B):** the pipeline modules are in-tree (notch + spectral-subtract with a learned PSD +
DeepFilterNet polish + Parakeet; NLMS fallback). Default path is single-mic learned-profile (the May
phone-recording analysis showed textbook stationarity). Production tuning is gated on real DJI captures.
See `g2_custom_app_spec.md` Part B + `audio/pipeline/README.md`.

**For fresh Claude Code sessions:** read `HANDOFF.md` first (the fullest snapshot — what works, the hard-
learned lessons, build/deploy/restart), then `overhaul.md` (the ribbon plan + live status), then `CLAUDE.md`
(the rules). UI contract: `docs/DE_DESIGN.md` + `docs/GLASSES_OS.md`. Wire truth: `docs/G2_BLE_PROTOCOL.md`.

## Architecture

```
  Home PC (Node server = the brain)              Glasses (Android app = thin client)
  ┌──────────────────────────────────┐  render(scene)  ┌───────────────────────────┐
  │ window-manager.ts  (nav, state)  │ ──────────────► │ ConnectionManager (WS)    │
  │ windows/*.ts       (15 windows)  │                 │ Scene(JSON) → G2Renderer  │
  │ os-compose.ts      (→ WireScene) │ ◄────────────── │ → BLE → glasses           │
  │ ribbon.ts          (Phase 2 nav) │  input(event)   │ EventParser (ring/gesture)│
  │ CC-subprocess bridge / Postgres  │                 │ (no app logic, no state)  │
  └──────────────────────────────────┘                 └───────────────────────────┘
```

## Layout

```
G2CC/
  CLAUDE.md              project rules (loaded into every CC session here)
  HANDOFF.md             the fullest single snapshot — READ FIRST
  overhaul.md            the DE/WM overhaul (Phase 1 modularization → Phase 2 ribbon) + live status
  g2_custom_app_spec.md  the canonical build spec (Part A app + Part B audio/STT)
  CHANGELOG.md / upgrades.md / UPGRADE_PROGRESS.md   the WHY + the v1/v2 feature history
  config.example.json    the ~/.g2cc/config.json shape (de.rootNav flips the ribbon)
  shared/src/            the both-ends wire contract (protocol.ts, constants.ts)
  server/src/
    window-manager.ts    the host: WindowManager + Main + the notification overlay
    ribbon.ts            Phase 2: the RibbonShell (root-nav state machine + its WireScene)
    windows/             the 15 windows (one file each) + types.ts (contracts) / _browse / _util /
                         _image / _session / registry.ts
    os-compose.ts        WinView → WireScene (byte budgets, the multi-packet-wall fences, the estimator)
    os-content.ts        markdown → blocks, chart/image rendering, gray4 tiling
    os-{display,menu,notify}.ts · store.ts · ws-handler.ts · cc-session.ts · session-pool.ts ·
    blackjack.ts · paperclips.ts · games.ts · timers.ts · calendar.ts · stats.ts · ...
  server/smoke/          run-all.mjs — THE regression suite (the gate; run after every server change)
  android/               the Kotlin app (foreground service, G2Renderer, NLS mirror, BLE driver, ...)
  audio/                 the Python audio + STT pipeline (Part B), project venv
  scripts/               render_*.py, read_*.py, scene_to_png.py (offline compose check), ...
  docs/                  DE_DESIGN · GLASSES_OS · G2_BLE_PROTOCOL · WINDOW_API · CONTENT_API · SIM_TOOLING · ...
```

External: `/home/user/g2code/` + `/home/user/g2aria/` are **ARCHIVED** (2026-06-29 →
`/home/user/g2-old-backup-2026-06-24.tar.gz`; the live dirs were removed — the inherited code now lives in
G2CC's own `server/src`). The i-soxi protocol reference is at `/home/user/G2 Custom/even-g2-protocol/`.

## Build / run / restart

- **Server (most changes — no APK):** `npm run build -w server` (and `-w shared` first if the wire
  contract changed) → `node server/smoke/run-all.mjs` (the gate) → restart: `ss -ltnp | grep :7300` → kill
  the pid → `nohup setsid node server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`. The
  phone auto-reconnects.
- **Try the ribbon on glass:** set `"de": { "rootNav": "ribbon" }` in `~/.g2cc/config.json` + restart
  (revert to `"menu"` = instant fallback; the proven shell is untouched).
- **Android (only when the client changes):** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk
  ./android/gradlew -p android testDebugUnitTest assembleDebug` → bump `OsLayout.OS_VERSION` → copy the APK
  to `~/.g2cc/g2cc-harness.apk` → Adam installs from `http://<host>:7300/setup`.
- **Offline compose check:** `scripts/scene_to_png.py` (WireScene JSON on stdin → PNG + client-rule
  validation incl. the multi-packet wall).
- **Postgres:** DB `g2cc`, role `user`, unix-socket peer auth, OpenRC service `postgresql-17`. The smoke
  suite runs isolated against `g2cc_smoke` (never production).

## Non-negotiables (the Three Absolute Rules + verify-before-execute)

- **No timeouts** in BLE / WebSocket / capture / display / ASR paths (UI debounce / display-pacing cadences
  are the only sanctioned exception).
- **No silent failures** — loud and proud; every catch logs with a `[subsystem]` tag.
- **No truncation** — content scrolls/paginates; only documented bounded-UI previews/clamps trim, and they
  log.
- **Verify before execute** — read the source / schema / `--help`; never guess BLE UUIDs, NeMo signatures,
  or DJI settings. Reverse-engineered wire values cite their i-soxi lineage in source.
- **Permission discipline** — investigation ≠ permission; each phase begins on Adam's explicit "go."

See `CLAUDE.md` for the full rules.
