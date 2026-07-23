# G2CC — Fresh-Session Handoff (2026-07-22 evening, post dictation-war)

> Timestamp note: the war ran INSIDE ONE shift (~15:00–21:00 CDT, 2026-07-22). Commits and
> tool timestamps after ~19:00 CDT read "07-23" in UTC — one workday, not two.

**Read this first, whole.** Then: `~/.claude/CLAUDE.md` (Adam's global rules), `CLAUDE.md`
(project rules), `docs/README.md` (the docs index — live contracts vs history). History lives
in `CHANGELOG.md` + git; don't re-derive it. The project memory
(`~/.claude/projects/-home-user-G2CC/memory/`) carries the don't-re-chase lists — trust them.

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
  back, zero state). **Phone = a bridge** (Android FGS: BLE↔WebSocket relay). **Multi-surface
  (2026-07-13):** the OS session (WindowManager + DE CC pool) is a BOOT-TIME SINGLETON that
  survives every disconnect; connections attach as surfaces (`phone` / `browser` via `/pc`).
- Display **576×288, 16-gray**. Input = ring: scroll / tap / double-tap. **THE MULTI-PACKET
  WALL:** firmware silently ignores any single message > ~1000 B (server estimator throws >960;
  client rejects >1000). `msgId` is ONE byte. Pacing is ack-gated. Render limits: ≤12
  containers, ≤8 text, ≤4 image, exactly one event-capture region; `blankScene()`'s wake
  antenna is a hardware rule.
- Adam runs **ribbon + fullBleed** (`~/.g2cc/config.json`). Menu mode must stay byte-for-byte
  identical (the proven fallback).
- **FROZEN (no changes without Adam's explicit go):** `G2Renderer.kt` send semantics;
  `composeScene`'s classic path bytes; `blankScene()`; the byte estimator + wall fences;
  msgId/keepalive/pacing behavior.
- **The glasses have NO power switch and never fully turn off** (Adam 2026-07-22) — a firmware
  wedge has no reboot escape; app-side resilience is the only fix path.

## 2. The Three Absolute Rules (+ sanctioned exceptions)

1. **NO TIMEOUTS** on BLE/WS/capture/display/ASR I/O. Sanctioned: display pacing, debounce,
   poll cadences, watchdog tick-counting supervision, user timers, resource caps.
2. **NO SILENT FAILURES.** Loud `[subsystem]` logs; status reflects reality. This includes YOUR
   OWN tooling: don't pipe builds through grep/tail and trust exit codes; don't `> /dev/null`
   a script you need the error from (both bit this project on 2026-07-22).
3. **NO TRUNCATION.** Paginate. Sanctioned trims: px label clamps with `…` on navigational
   previews, `fitFrameToBudget` on passive chrome, the Tmux CC-chrome strip (chrome ≠ content;
   the token count is kept by Adam's spec).

## 3. Current state (2026-07-22 end-of-evening, post dictation-war)

- **Dictation WORKS at Adam's normal voice** (~95% by his verdict, 2026-07-22 evening). The stack that
  got it there, outside-in:
  - **DJI TX Two-Level NC: OFF** (it was silently ON and gating quiet speech to nothing — check
    it FIRST on any quiet-voice regression; it can re-enable on its own).
  - **APK v1.19**: SCO route verification (wrong-mic frames dropped, loud fail), platform
    AEC/NS/AGC asked off, post-stop tail drain, watchdog PROBE-before-recover (ends the
    keepalive-wedge churn loops) + recovery deferred during live dictations.
  - **Server**: adaptive Wiener α1.5 front-end + RAW-RETRY when the filter zeroes VAD-heard
    speech + VAD-gated hallucination denylist + per-clip `[stt] clip:` telemetry + the Mic LIVE
    cue (Terminal shows "connecting" until the first frame actually arrives).
  - **ASR engine: `nvidia/canary-qwen-2.5b`** (config.stt.parakeetModel → daemon env
    G2CC_ASR_MODEL; SALM branch in parakeet_engine). Shootout-verified 2026-07-22 evening: halved the
    field's WER on hard audio, filter-agnostic, clean hallucination probes. parakeet-tdt-0.6b-v2
    is one config flip back. Warm load ~24 s cached; +6-7 GB VRAM; seconds per clip (accuracy
    outranks latency by Adam's decree).
  - **Losers, evidence-closed (don't re-chase):** DeepFilterNet (offline tool only — lost twice
    on real captures), the learned NC-off profile (lost to adaptive; per-clip re-leveling),
    parakeet-v3 (collapses on filtered audio — always test the model×filter PAIRING).
- **APK v1.19 installed** (splash `OS 1.19`), signed with THE pinned key
  (`~/.g2cc/g2cc-debug.keystore`, explicit signingConfig — see §5 gotchas).
- **The keepalive-ack wedge PERSISTS on the glasses** (native SYSTEM_EXIT 2026-07-21 killed
  f1=12 acks; no power switch → no reboot escape). The v1.19 watchdog probe makes the app
  immune (0 reconnect churn since). If acks ever resume, nothing changes — probes simply stop
  firing.
- **Everything is committed AND PUSHED** (Adam's go, same evening).

## 4. How to build, verify, deploy

- **Server:** `npm run build -w server` (add `-w shared` first if the contract changed) →
  `node server/smoke/run-all.mjs` — gate is **34/35** (`phase10-calendar` = the known external
  Google-OAuth red; NOT a regression). The suite exits non-zero at 34/35 BY DESIGN.
- **Server restart procedure (hard-won, follow exactly):**
  1. `cp /tmp/g2cc-server.log ~/.g2cc/logs/g2cc-server-$(date +%F-%H%M)-pre-restart.log`
     (nohup TRUNCATES the log; pre-restart history is evidence).
  2. `OLD=$(ss -ltnp 'sport = :7300' | grep -oP 'pid=\K[0-9]+' | head -1)` — **the port filter
     is mandatory** (an unfiltered grab once targeted a random service).
  3. `kill "$OLD"`, verify it exited AND the port is free.
  4. Launch with the operator-session env scrubbed:
     `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u AI_AGENT -u CLAUDE_EFFORT -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_API_KEY nohup setsid node /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`
  5. Never restart while Adam is mid-download from /setup (it kills the transfer).
- **Android:** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk ./android/gradlew
  -p android testDebugUnitTest assembleDebug` → **bump versionCode+versionName in
  app/build.gradle.kts on EVERY build Adam will install** (versionCode = major*100+minor;
  OsLayout.OS_VERSION reads BuildConfig.VERSION_NAME) → `cp android/app/build/outputs/apk/debug/app-debug.apk
  ~/.g2cc/g2cc-harness.apk`. Unit-test baseline **189**. Wire changes: additive-optional both
  ends; server ships first.
- **STT offline eval:** the harness pattern lives in this session's scratch history + memory —
  models × real captures in `audio/samples/`, transcripts scored vs known truth (the June
  clips are pangram tests), NEVER on synthetic audio. `audio/tools/learn_noise_from_dictations.py`
  re-learns a noise profile from teed captures if the shop's noise ever changes.
- **The capture tee:** `echo <name> > audio/.capture-armed` → the NEXT dictation's raw WAV
  lands in `audio/samples/<name>-<ts>.wav` (one-shot, works on the live server).
- **How Adam works:** SSHes in from work; dictates through the Tmux window into CC sessions;
  wants data not guesses; investigate ≠ permission; batch decision questions; put key
  actions/links LAST (his terminal scrolls poorly); commit per work item, push only on his
  word; address him as Mr. Awesome (the context-loss canary).

## 5. Gotchas that cost real time (each is also in memory)

- **APK "App not installed"** → `apksigner verify --print-certs ~/.g2cc/g2cc-harness.apk`
  FIRST; expect cert `93a0fffd…` (the pinned Jun-1 key). Two ambient debug keystores exist on
  this box; the gradle signingConfig pin is what keeps builds installable — never remove it.
- **Quiet-voice dictation dies** → check the DJI TX's NC setting before touching software.
- **"No speech detected" on real speech** → look for the RAW-RETRY log lines; if the filter is
  eating speech the retry recovers it and says so.
- **stt errors are now console-loud** (`[stt] REJECTED dictation:`) — if the log shows nothing,
  the audio never reached the server (phone-side; check `[audio-error]` diags).
- **Chrome-filter drift**: Claude Code UI changes break `stripCcInputBox` matchers — ground-truth
  against a real `tmux capture-pane` before rewriting (fixtures in phase5-terminal).
- **DFN/torchaudio**: deepfilternet is installed `--no-deps` (its numpy<2 pin would break
  NeMo); `dfn_polish.py` documents the scoped torchaudio shim. Offline tool ONLY.

## 6. Open threads (all Adam-paced)

- **Tmux input-box refinement**: Adam flagged something about the Focus-mode chrome strip that
  I misunderstood; he'll explain later — DO NOT act on guesses (two reverted attempts already).
- The **§2.2 ribbon remainder** (overhaul.md): §2.2.5 in-window LEFT-menu reclaim (discussed,
  not built) · §2.2.7 strip hardening · §2.2.8 default-flip after the soak.
- **Hat bridge** (docs/HAT_BRIDGE_SPEC.md) — spec'd, not built.
- **Calendar/Gmail OAuth red** (34/35 smoke + read_gcal/read_gmail errors) — fix = re-running
  aria's `google_auth.py` (Adam's task).
- The **glasses keepalive-ack wedge** — firmware-side; app is immune; nothing to do unless the
  vendor app/firmware clears it someday.
