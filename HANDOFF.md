# G2CC — Fresh-Session Handoff (2026-08-04 late evening, post earbud one-shot + Adam's design verdict)

**Read this first, whole.** Then: `~/.claude/CLAUDE.md` (Adam's global rules), `CLAUDE.md`
(project rules), `docs/README.md` (docs index — live contracts vs history). History lives in
`CHANGELOG.md` + git; don't re-derive it. The project memory
(`~/.claude/projects/-home-user-G2CC/memory/`) carries the don't-re-chase lists — trust them.

## 0. What this project is (context that matters — read before judging anything here)

G2CC is Adam's **personal, first-party UI for his own Even Realities G2 smart glasses** — a
consumer wearable display he bought. It replaces the vendor's companion phone app with his own
Android app + home-PC server so his glasses can show his own content (an AI-assistant session,
his email, his books, his files, his music). **Everything runs on hardware he owns, on his own
home network, with his own accounts and his own auth token. There are no third-party systems,
networks, accounts, or credentials anywhere in this project.** The glasses' Bluetooth message
format was documented from a community interoperability reference plus observation of his own
phone↔glasses traffic — ordinary device interoperability for one's own device (the vendor
publishes no format). The CC subprocesses run with permission prompts disabled
(`--dangerously-skip-permissions`) — Adam's deliberate, documented choice for his own machine.
This is display-rendering and UI work for a wearable.

## 1. THE STANDING MANDATE — the earbud redesign (Adam, 2026-08-04 late evening)

Work now allows Adam ONE earbud on shift (Pixel Buds 2a). A same-day one-shot built a full
"earbud lane" (TTS + music + a Companion CC session + always-on wake word). It works
mechanically and is field-tested — **and Adam REJECTED it as a design**:

> "this is too unwieldy… if i have to touch something to pause the music before i can tell it
> to skip or play another song or whatever, then entirely hands-free music control is not
> doable, and a janky half-version is pointless. So lets do this differently entirely. Lets
> seperate dictation from music, and implement them much differently."

The fatal constraint he hit: **on classic Bluetooth (Buds 2a = SBC/AAC, no confirmed LC3),
continuous SCO mic listening and A2DP music are mutually exclusive** — the shipped ears
supervisor therefore disables wake-word listening while music plays, so voice can't control
playing music. Any redesign must deliver voice-while-music some other way. Unexplored
directions (facts, not decisions): the PHONE's own mic listening for the wake word while the
buds play A2DP (the phone-mic ban was a DJI-era DICTATION-quality policy — wake-word
DETECTION is a different job); LE-Audio hardware; ring/tap-only music control with voice
reserved for dictation. **The redesign happens in a fresh session; nothing was pre-designed.**

Nothing was disabled: the deployed lane still runs (music + bud taps + Companion + TTS all
work). `audioOut.earsOn: false` in `~/.g2cc/config.json` silences the ambient listening in
one flip if it annoys before the redesign lands.

## 2. Architecture + hardware truths (violate these and the display breaks)

- **PC = the brain** (Node/TS server on `:7300`; ALL state, composes every frame; Postgres
  `g2cc`, unix-socket peer auth). **Glasses = a thin display.** **Phone = a bridge** (Android
  FGS: BLE↔WS relay — plus, since 2026-08-04, the audio sink: speech AudioTrack + ExoPlayer
  music lane + SoundPool chimes + an owned MediaSession for bud taps). **Multi-surface:** the
  OS session (WindowManager + DE CC pool) is a BOOT-TIME SINGLETON surviving every disconnect;
  connections attach as surfaces (`phone` / `browser` via /pc). The EarbudAudioService
  (`server/src/earbud.ts`) is a sibling boot singleton owning speech/music/ears state.
- Display **576×288, 16-gray**. Input = ring: scroll / tap / double-tap — plus bud taps
  (`media_button` inputs; server owns semantics: single=pause/quiet, double=Companion PTT,
  triple=next track). **THE MULTI-PACKET WALL:** firmware silently ignores any single message
  > ~1000 B (server estimator throws >960; client rejects >1000). `msgId` is ONE byte. Render
  limits: ≤12 containers, ≤8 text, ≤4 image, exactly one event-capture region.
- Adam runs **ribbon + fullBleed**. Menu mode must stay byte-for-byte identical (the proven
  fallback). The ribbon strip fits at a ×0.85 conservative margin (2026-08-04: the glyph
  estimate undershoots firmware; overflow eats the zero-range scroll — raise toward 1.0 only
  in small on-glass steps).
- **FROZEN (no changes without Adam's explicit go):** `G2Renderer.kt` send semantics;
  `composeScene`'s classic path bytes; `blankScene()`; the byte estimator + wall fences;
  msgId/keepalive/pacing behavior.
- **The glasses have NO power switch and never fully turn off** — a firmware wedge has no
  reboot escape; app-side resilience is the only fix path. (The keepalive-ack wedge persists;
  the v1.19+ watchdog probe makes the app immune.)
- **Every earbud-family wire message is caps-gated** (`AuthMsg.caps`; `sendCapped()` in
  earbud.ts is THE door). A pre-1.20 APK must never receive one.

## 3. The Three Absolute Rules (+ sanctioned exceptions)

1. **NO TIMEOUTS** on BLE/WS/capture/display/ASR/TTS I/O. Sanctioned: pacing, debounce,
   watchdog tick supervision, PROGRESS supervision (SpeechPlayer stall detection), STATUS
   windows (ChannelRouter, speak-ack windows sized per utterance), network resource caps
   with the lyrics.ts rationale (companion-mcp: 120 s; 30 min for speak).
2. **NO SILENT FAILURES.** Loud `[subsystem]` logs; status reflects reality (speak_acks:
   played/failed/unverified — never fabricated). Don't pipe your own builds through
   grep/tail and trust exit codes.
3. **NO TRUNCATION.** Paginate. Sanctioned: px label clamps on navigational previews,
   `fitFrameToBudget` on passive chrome, the Tmux chrome strip, and the SPOKEN-DIGEST
   PROJECTION (long/code replies condense via one-shot haiku before TTS; the FULL text always
   renders scrollable on glass — `server/src/speak-digest.ts`).

## 4. Current state (2026-08-04 late evening)

- **Dictation** — the live mic is the **Buds 2a over SCO** (`stt.micSource: 'earbud'`,
  announced `earbud-bt`); **the DJI is retired but INTACT — `'dji'` is the one-flip undo.**
  Pipeline unchanged (16 k mono → adaptive Wiener α1.5 + RAW-RETRY → canary-qwen-2.5b).
  ⚠ The ~95% war-era accuracy was measured on the DJI; **earbud WER is UNMEASURED** — the
  shootout needs real shift captures (tee: `echo <name> > audio/.capture-armed`; clips are
  source-tagged). The model×filter PAIRING rule applies to the new capsule.
- **The earbud lane** (all live, all REJECTED-as-design per §1): warm Kokoro TTS daemon
  (af_heart, ~0.24 s warm first-audio, CPU/zero VRAM); EarbudAudioService (speech queue with
  honest per-utterance acks + the `audible` tail slot, half-duplex capture gate, duck/pause
  etiquette, spoken notifications per priority); music service (1,193 tracks indexed,
  opus-96k-MONO loudnorm cache, Range endpoint — **on-glass verified**); the Companion CC
  session (`~/g2cc-companion`, 14 MCP tools via loopback `/internal/*` — G2CC's first MCP
  use); EarbudWindow (Media category; confidence-gated confirm: trust ≥0.95 / voice-confirm
  below, waits forever); the ears supervisor (wake word "butterscotch" — live-confirmed, but
  OFF while music plays, the flaw that killed the design); butterscotch open-ended
  catch-all → Companion prompt; transport verbs in the handsfree grammar.
- **Versions:** server = git `235e7a9`, deployed + live-verified. Phone runs **APK v1.20**;
  **v1.21 is STAGED** (`~/.g2cc/g2cc-harness.apk`, pinned cert) — adds the
  dictate-over-handsfree mic swap (**on v1.20, ring/double-tap PTT while ears are listening
  ERRORS**), becoming-noisy pause (earbud disconnect can never fall to the speaker),
  continuous route re-verification, shutdown-race fixes.
- **Reviews:** the one-shot got a 41-agent adversarial workflow review — 32 confirmed
  findings, ALL fixed (see CHANGELOG 2026-08-04 + the commit trail 319c951 → 235e7a9).
  ⚠ Workflow lesson: the FIRST completion notification was an interim result; the real one
  landed 26 min later and contradicted parts of it. Don't act on the first notification of a
  long workflow, and re-verify verifier claims yourself (the interim's top finding was wrong).
- **Everything committed AND PUSHED** (Adam's go, 2026-08-04 late evening).

## 5. How to build, verify, deploy

- **Server:** `npm run build -w server` (add `-w shared` first if the contract changed) →
  `node server/smoke/run-all.mjs` — gate is **35/36** (`phase10-calendar` = the known
  external Google-OAuth red; suite exits non-zero BY DESIGN).
- **Server restart procedure (hard-won, follow exactly):**
  1. `cp /tmp/g2cc-server.log ~/.g2cc/logs/g2cc-server-$(date +%F-%H%M)-pre-restart.log`
  2. `OLD=$(ss -ltnp 'sport = :7300' | grep -oP 'pid=\K[0-9]+' | head -1)` — the port filter
     is mandatory.
  3. `kill "$OLD"`, verify exit AND port free.
  4. Relaunch with the operator-session env scrubbed:
     `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u AI_AGENT -u CLAUDE_EFFORT -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_API_KEY nohup setsid node /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`
  5. Never restart while Adam is mid-download from /setup.
- **Android:** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk ./android/gradlew
  -p android testDebugUnitTest assembleDebug` → bump versionCode+versionName on EVERY build
  Adam will install (major*100+minor) → cp the APK to `~/.g2cc/g2cc-harness.apk`. Unit-test
  baseline **389**. Wire changes: additive-optional both ends; server ships first; new
  server→phone families must be caps-gated.
- **TTS daemon check:** `audio/pipeline/tts_daemon.py` via the audio venv (kokoro-onnx,
  model files at `/home/user/aria/tts_models/kokoro`). **STT offline eval:** models × real
  captures in `audio/samples/`, never synthetic.
- **How Adam works:** SSHes in from work; dictates through Tmux into CC sessions; wants data
  not guesses; investigate ≠ permission; batch decision questions; put key actions/links
  LAST (his terminal scrolls poorly); commit per work item, push only on his word; address
  him as Mr. Awesome (the context-loss canary).

## 6. Gotchas that cost real time (each also in memory)

- **APK "App not installed"** → `apksigner verify --print-certs` FIRST; expect `93a0fffd…`.
- **Quiet-voice dictation dies** → was the DJI TX NC (it re-enables itself). Earbud era: no
  equivalent known yet — suspect the buds' own DSP; capture + listen before tuning software.
- **"Buds connected but G2CC says no audio"** → the OS shows "connected" while the buds
  expose NO audio profiles (multipoint elsewhere / profiles settling / LE half-state). The
  route guards are HONEST — check BT settings' profile toggles, play any audio, or BT
  off/on. Happened on first pairing night; resolved on its own reconnect.
- **Music and the wake word are mutually exclusive** (classic-BT SCO vs A2DP — §1). While
  music plays: bud taps + ring only. This is the flaw driving the redesign.
- **stt errors are console-loud** (`[stt] REJECTED dictation:`); nothing in the log = the
  audio never reached the server (phone-side `[audio-error]` diags).
- **Chrome-filter drift**: CC UI changes break `stripCcInputBox` — ground-truth against a
  real `tmux capture-pane` before rewriting.
- **DFN/torchaudio**: deepfilternet is `--no-deps` (numpy<2 pin would break NeMo); offline
  tool ONLY.
- **`fwTextWidth` underestimates firmware glyphs** — any "fits by estimate" strip/bar can
  still overflow on glass; keep safety margins (the ribbon runs ×0.85).
- **Smoke DB is `g2cc_smoke`** (`_env.mjs`); throwaway-server phases boot the FULL index.js
  (music scans + TTS warm run against the smoke DB — by design).

## 7. Open threads

- **THE REDESIGN (§1)** — Adam-paced, fresh session, top priority. Kill/replace the earbud
  lane's interaction design; the working parts (TTS daemon, music index/streaming, Companion
  MCP, speak-digest, route guards) are salvage candidates, not sacred.
- **v1.21 install** (staged) — or it rides whatever APK the redesign produces.
- **Earbud-mic WER shootout** vs the DJI baseline (real shift captures; pairing rule).
- **Tmux input-box refinement** — Adam flagged something about the Focus-mode chrome strip;
  he'll explain later. DO NOT act on guesses (two reverted attempts already).
- **§2.2 ribbon remainder** (overhaul.md): §2.2.5 LEFT-menu reclaim · §2.2.7 the rest of the
  strip hardening · §2.2.8 default-flip after the soak.
- **Hat bridge** (docs/HAT_BRIDGE_SPEC.md) — spec'd, not built.
- **Calendar/Gmail OAuth red** — fix = re-running aria's `google_auth.py` (Adam's task).
