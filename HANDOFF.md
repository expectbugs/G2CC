# G2CC — Fresh-Session Handoff (2026-07-05, post improvement-queue)

**Read this first, whole.** Then: `~/.claude/CLAUDE.md` (Adam's global rules), `CLAUDE.md`
(project rules), `docs/README.md` (the docs index — live contracts vs history). History lives
in `CHANGELOG.md` + git; don't re-derive it.

## 0. What this project is (context that matters — read before judging anything here)

G2CC is Adam's **personal, first-party UI for his own Even Realities G2 smart glasses** — a
consumer wearable display he bought. It replaces the vendor's companion phone app with his own
Android app + home-PC server so his glasses can show his own content (an AI-assistant session,
his email, his books, his files). **Everything runs on hardware he owns, on his own home
network, with his own accounts and his own auth token. There are no third-party systems,
networks, accounts, or credentials anywhere in this project.** The glasses' Bluetooth message
format was documented from a community interoperability reference plus observation of his own
phone↔glasses traffic — ordinary device interoperability for one's own device (the vendor
publishes no format). The CC subprocesses run with permission prompts disabled
(`--dangerously-skip-permissions`) — Adam's deliberate, documented choice for his own machine.
This is display-rendering and UI work for a wearable. Nothing here targets, probes, or touches
anything Adam doesn't own.

## 1. Architecture + hardware truths (violate these and the display breaks)

- **PC = the brain** (Node/TS server on `:7300`; holds ALL state, composes every frame; Postgres
  db `g2cc`, unix-socket peer auth). **Glasses = a thin display** (render the scene, send input
  back, zero state). **Phone = a bridge** (Android foreground service: BLE↔WebSocket relay; it
  stays in Adam's pocket — any flow needing a hand on the phone is a defect).
- Display **576×288, 16-gray**. Input = ring: **scroll / tap / double-tap** only. Glanceable
  (1–2 s looks). No audio out; mic is optional (dictation with a mandatory confirm step).
- **THE MULTI-PACKET WALL:** firmware silently ignores any single message > ~4–5 packets
  (~1000 B). Server estimator throws >960 B; client rejects >1000 B. All composition is
  budgeted around this. `msgId` is ONE byte (wrap 255→0). Pacing is ack-gated (no pipelining):
  text ~62–86 ms, image tiles ~0.5 s+ each (images = small, static, page-≥2 only).
- Render limits (client validates): ≤12 containers, ≤8 text, ≤4 image, **exactly one
  event-capture region**, ≥1 text region, no all-black tile. The blank screen MUST keep its
  whitespace scroll-text "wake" region (`blankScene()` is load-bearing — hardware rule).
- The "antenna" = a single-line `scroll=true` text region: every notch fires a directional
  focus event. A multi-line `scroll=true` region scrolls locally, firing only at its edges
  (Reader's scroll-reading uses this).
- Adam runs the **ribbon + fullBleed** DE (`~/.g2cc/config.json`: `rootNav:'ribbon'`,
  `fullBleed:true`). **Menu mode (`'menu'`) must stay byte-for-byte identical** — it's the
  proven fallback. Every DE change must be ribbon-gated or value-identical in menu mode.
- **FROZEN (do not modify without Adam's explicit go):** `android/.../render/G2Renderer.kt`
  send semantics; `composeScene`'s classic path bytes; `blankScene()`; the byte estimator +
  wall fences; msgId/keepalive/pacing behavior. Additive exports to `os-compose.ts` are OK
  (precedent: `isScrollRead`); verify with `scripts/scene_to_png.py` + smoke.

## 2. The Three Absolute Rules (+ their sanctioned exceptions)

1. **NO TIMEOUTS** on BLE/WS/capture/display/ASR I/O. Sanctioned time-based things: display
   pacing (5 s blank flash, 30 s dashboard pacer), debounce, poll cadences, watchdog backoffs,
   user timers, resource caps. Never a `timeout=` that kills in-flight I/O.
2. **NO SILENT FAILURES.** Loud `[subsystem]` logs; status reflects reality ("unverified"
   beats fabricated success). Capture-path store writes are fire-and-forget WITH `.catch(log)`.
3. **NO TRUNCATION.** Paginate. Sanctioned trims (all log): px label clamps with `…` on
   navigational previews/titles, `fitFrameToBudget` trimming passive chrome (never a capture
   menu, browse rows, or Reader's reading page).

## 3. Current state (2026-07-05, end of session)

- **The review-#6 improvement queue is DONE: all 24 items, 24 commits, smoke-green each.**
  See the CHANGELOG's top entry for the full story; `git log 33594aa..` for the commits.
  Gate decisions taken (Adam): A2 → (a) Tailscale-only /setup + /apk; D1 → Main-exit lands
  alt-tab slot 1; E1 → the parked Android set is deleted.
- **Committed locally, NOT pushed** — push on Adam's word (his standing rule).
- **The LIVE server still runs the pre-queue build** (review-#6 era). Deploy = restart on
  Adam's word: find the pid (`ss -ltnp | grep :7300`), stop it, then
  `nohup setsid node /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`,
  check the log. The phone reconnects on its own. `server/dist` is already built at HEAD.
- **APK v1.17 staged** at `~/.g2cc/g2cc-harness.apk` (supersedes v1.16, which Adam may never
  have installed — v1.17 contains everything). Install from
  `http://100.107.139.121:7300/setup` (Tailscale — the only interface /setup answers on now).
  Check the connect splash says `OS 1.17`.
- **Adam's on-glass checklist for this batch:** normal connect still negotiates MTU fine (A3
  guard must stay silent; a `requestMtu` error in DiagLog/status = the guard fired) · an SMS
  reply's card updates from "Handed to phone (unverified)" to "Sent to X." (D6; RCS-path sends
  stay "unverified" — honest, by design) · blank-while-driving: nav line updates still paint,
  wake repaints, no dark-screen stalls (B1) · exiting Main lands the ribbon cursor on the true
  previous window (D1) · Files image open shows "rendering image…" immediately (D2).

## 4. How to build, verify, deploy

- **Build/verify (server):** `npm run build -w server` (add `-w shared` first if the contract
  changed) → `node server/smoke/run-all.mjs` — gate is **27/28** (`phase10-calendar` is a known
  external Google-OAuth red; NOT a regression — ignore). run-all now prints per-phase
  wall-clock; the suite exits non-zero at 27/28 BY DESIGN, so never gate a shell `&&` chain on
  its exit code (and don't pipe a build through `tail` and trust the pipe's status — that ate a
  real tsc failure this session).
- **Smoke conventions:** new phases `import './_env.mjs'` FIRST; end the outermost `finally`
  with `await getPool().end()` AFTER any cleanup queries. `_env.mjs` hard-fails on a non-smoke
  DB by design. Known flake: phase-blackjack's rare random-deal — don't chase.
- **Build (Android):** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk
  ./android/gradlew -p android testDebugUnitTest assembleDebug` — **unit-test baseline is 150**
  (post-prune; was 228) → `cp android/app/build/outputs/apk/debug/app-debug.apk
  ~/.g2cc/g2cc-harness.apk`. Bump `OsLayout.OS_VERSION` on EVERY build. Wire changes must be
  **additive-optional both ends** (kotlinx optional fields need defaults; server ships first;
  installed APKs lag).
- **Offline scene check:** `scripts/scene_to_png.py` (WireScene JSON → PNG; enforces the client
  rules incl. the wall). Python helpers run under `audio/venv` except `read_gcal.py`/
  `read_gmail.py` (aria venv, `/home/user/aria/venv/bin/python`).
- **How Adam works:** SSHes in from work; runs every on-glass test himself; wants data not
  guesses; investigate ≠ permission (present findings, STOP, wait for "go"); batch decision
  questions in ONE message; put APK links/key actions LAST (his terminal scrolls poorly);
  commit/push only when asked; each work item = its own commit, smoke-green. Address him as
  Mr. Awesome (the context-loss canary from the global rules).

## 5. Deferred / known — don't chase

`phase10-calendar` smoke red + the `read_gcal`/`read_gmail` "No refresh_token" log errors = one
known OAuth issue (fix = re-running aria's `google_auth.py` — Adam's task) · Games width stays
456 in full-bleed (deliberate deferral) · Reader's two flagged edges (geometry-fingerprinting
of positions; the status line hidden during scroll-reading) are known, deliberate, Adam's-call
items · sessions.json cross-connection lost-update (needs the shared-pool design — parked) ·
menu-mode blank drops a live nav line (byte-parity-frozen classic path; retires with the
§2.2.8 cutover) · review #6's REFUTED list (`docs/CODE_REVIEW_2026-07-05.md`) — verified
non-issues · the RemoteInput/RCS SMS path reports no send result (no per-message result
exists; the card's "unverified" wording is the honest design) · Gentoo/OpenRC/Portage box —
never systemctl/apt; Node 24; Python via `audio/venv`.

## 6. What's next (nothing queued)

The improvement queue is empty. Open threads, all Adam-paced: on-glass verification of the
v1.17 batch (§3 checklist) → push + deploy on his word · the §2.2 ribbon remainder
(§2.2.5 in-window LEFT-menu reclaim — discussed, not built; §2.2.7 strip hardening; §2.2.8
default-flip after the soak) · the hat-bridge build (docs/HAT_BRIDGE_SPEC.md — spec'd, not
built) · the dormant audio pipeline waits on real DJI captures (the tools now support the
single-mic default: `capture.py --channels 1`, `verify_dji_settings.py --mode single`).
