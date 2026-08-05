# G2CC — Fresh-Session Handoff (2026-08-05, post music-redesign Phase A)

**Read this first, whole.** Then: `~/.claude/CLAUDE.md` (Adam's global rules), `CLAUDE.md`
(project rules), **`docs/MUSIC_SPEC.md` — the Part D build contract you are executing** —
and `docs/README.md` (docs index). History lives in `CHANGELOG.md` + git; don't re-derive
it. The project memory (`~/.claude/projects/-home-user-G2CC/memory/`) carries the
don't-re-chase lists and the fabrication-incident lessons — trust them.

## 0. What this project is (context that matters — read before judging anything here)

G2CC is Adam's **personal, first-party UI for his own Even Realities G2 smart glasses** — a
consumer wearable display he bought. It replaces the vendor's companion phone app with his
own Android app + home-PC server so his glasses can show his own content (an AI-assistant
session, his email, his books, his files, his music). **Everything runs on hardware he
owns, on his own home network, with his own accounts and his own auth token. There are no
third-party systems, networks, accounts, or credentials anywhere in this project.** The
glasses' Bluetooth message format was documented from a community interoperability
reference plus observation of his own phone↔glasses traffic — ordinary device
interoperability for one's own device. The CC subprocesses run with permission prompts
disabled (`--dangerously-skip-permissions`) — Adam's deliberate, documented choice for his
own machine. This is display-rendering and UI work for a wearable.

## 1. THE STANDING MANDATE — MUSIC_SPEC Phase B (gate passed 2026-08-05)

The earbud lane's redesign is DESIGNED and its Phase A (knowledge base) is BUILT, gated,
and remediated. **The fresh session executes `docs/MUSIC_SPEC.md` Phase B: the old-lane
removal (spec D2 map) + the player core (D5) + native bud taps (D6.2) + the popup channel
(D6.3) + `phase-earbud.mjs` → `phase-music.mjs`.** Server-only — no APK required (v1.20's
wire contract carries it; caps `media-lane`/`earbud-buttons` already announced). Phase C
(MusicWindow + resolver + radio) follows on Adam's pacing; D (yt-dlp) and E (v1.22
gapless + key-gated backfills) after.

Phase-B gates (spec D9): smokes green (35/36-equivalent with phase-music), on-glass native
tap transport, track-change popups at ribbon root + the one-line in-window intrusion.
Dictation is UNTOUCHED by Phase B (ring-driven, mic = buds over SCO — the pre-earbud flow);
TTS/Companion/wake-word stay dormant on disk per D2 for their own future session.

## 2. Architecture + hardware truths (violate these and the display breaks)

- **PC = the brain** (Node/TS server on `:7300`; ALL state; Postgres `g2cc`, unix-socket
  peer auth). **Glasses = a thin display** (576×288, 16-gray; ring: scroll/tap/double-tap).
  **Phone = a bridge** (Android FGS: BLE↔WS relay + the audio sink). **Multi-surface:** the
  OS session is a BOOT-TIME SINGLETON surviving every disconnect; connections attach as
  surfaces (`phone`/browser via /pc).
- **Phone runs APK v1.21 (INSTALLED, not staged).** The earbud lane (EarbudAudioService,
  ears supervisor, Companion, TTS, EarbudWindow, bud-tap remap) **still runs until Phase B
  removes it** — removal is the work, not a pre-existing state.
- **THE MULTI-PACKET WALL:** firmware silently ignores any single message > ~1000 B
  (server estimator throws >960; client rejects >1000). `msgId` is ONE byte. Render
  limits: ≤12 containers, ≤8 text, ≤4 image, exactly one event-capture region.
- Adam runs **ribbon + fullBleed**. Menu mode must stay byte-for-byte identical. The
  ribbon strip fits at ×0.85 margin (`fwTextWidth` undershoots firmware glyphs).
- **FROZEN (no changes without Adam's explicit go):** `G2Renderer.kt` send semantics;
  `composeScene`'s classic path bytes; `blankScene()`; the byte estimator + wall fences;
  msgId/keepalive/pacing behavior.
- **The glasses have NO power switch**; app-side resilience is the only wedge escape
  (v1.19+ watchdog probe).
- **Every earbud-family wire message is caps-gated** (`sendCapped()` is THE door). Wire
  changes: additive-optional both ends; server first; new server→phone FAMILIES get caps
  (unknown FIELDS on known messages are old-APK-safe — `ignoreUnknownKeys` confirmed).
- **⚠ The RUNNING server (pid on :7300) predates this session's changes.** Its first
  restart (during Phase B deploy) picks up three things at once: the `music-meta-1`
  migration (tables already exist — idempotent no-op), the **4-root**
  `music.libraryDirs` config, and the Ogg stream-tag probe fix. Its boot scan of the 3
  new roots will re-probe nothing destructive (deletion is scoped to scanned roots;
  vanished-row logic already hardened).

## 3. The Three Absolute Rules (+ sanctioned exceptions)

1. **NO TIMEOUTS** on BLE/WS/capture/display/ASR I/O. Sanctioned: pacing, debounce,
   watchdog tick supervision, PROGRESS supervision, STATUS windows, network resource caps
   with the lyrics.ts rationale.
2. **NO SILENT FAILURES.** Loud `[subsystem]` logs; status reflects reality. Don't pipe
   your own builds through grep/tail and trust exit codes.
3. **NO TRUNCATION.** Paginate. Sanctioned: px label clamps on navigational previews,
   `fitFrameToBudget` on passive chrome, explicit-marked excerpts in LLM dossiers.

## 4. Current state (2026-08-05)

- **The music knowledge base (Phase A, DONE + remediated):** 2,672 tracks across 4 roots
  (`/mnt/slug/Music`, `/mnt/slug/pandora2/Media/Music`, `/home/user/Music`, the Downloads
  FF-collection `_Games OST` — all in `~/.g2cc/config.json`), 100% profiled + embedded
  (Qdrant `g2cc_music`, bge-small-en-v1.5, point id = track id), 584 dupe clusters, full
  opus transcode cache (7.87 GB — every first play instant). `audio/enrich/` = the
  resumable per-track pass runner (pass_status jsonb is the spine; `--force/--limit/
  --track-id/--artistless/--ids` scoping). Reports + the 362-row remediation diff:
  `audio/enrich/reports/`.
- **KB integrity rules (from the fabrication incident — spec D3.2 amendments):**
  artistless files never get MB title-only searches; `sources.speech` (ASR
  vocal-presence, parakeet-tdt CPU ~0.2 s/track) is authoritative for `vocals`; profile
  prompt carries the evidence hierarchy; copy DONORS require profile-status ok;
  hand-curated ground truth (Bastion trilogy, CLASS.wav, flock.ogg, 315.ogg) must never
  be LLM-re-rolled — `sources.profile.curated` marks it.
- **Resolver facts for Phase C:** exclude genre `sound effects` (Wurm SFX ~90) from
  playlists; `spoken word` = REAL content (IT interludes, GTA radio) — exclude from
  shuffle, don't purge; dupe_cluster = one member per playlist.
- **Dictation** — unchanged all session: ring-driven, buds over SCO
  (`stt.micSource:'earbud'`, `'dji'` = the one-flip undo), adaptive Wiener α1.5 →
  canary-qwen. Earbud WER still unmeasured vs the DJI baseline (capture tee:
  `echo <name> > audio/.capture-armed`).
- **Everything committed AND PUSHED** through the docs pass (Adam's word, 2026-08-05).

## 5. How to build, verify, deploy

- **Server:** `npm run build -w server` (add `-w shared` first if the contract changed) →
  `node server/smoke/run-all.mjs` — gate **35/36** (`phase10-calendar` = the known
  external Google-OAuth red; suite exits non-zero BY DESIGN). Phase B renames
  phase-earbud → phase-music; keep the gate arithmetic honest in the docs when it changes.
- **Server restart procedure (hard-won, follow exactly):**
  1. `cp /tmp/g2cc-server.log ~/.g2cc/logs/g2cc-server-$(date +%F-%H%M)-pre-restart.log`
  2. `OLD=$(ss -ltnp 'sport = :7300' | grep -oP 'pid=\K[0-9]+' | head -1)` — the port
     filter is mandatory.
  3. `kill "$OLD"`, verify exit AND port free.
  4. Relaunch with the operator-session env scrubbed:
     `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u AI_AGENT -u CLAUDE_EFFORT -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_API_KEY nohup setsid node /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`
  5. Never restart while Adam is mid-download from /setup.
- **Android (Phase B needs none):** `JAVA_HOME=/opt/openjdk-bin-17
  ANDROID_HOME=/opt/android-sdk ./android/gradlew -p android testDebugUnitTest
  assembleDebug` → bump versionCode+versionName on EVERY build Adam installs
  (major*100+minor) → cp to `~/.g2cc/g2cc-harness.apk`. Unit baseline **389**. Pinned
  keystore (`apksigner verify --print-certs` → `93a0fffd…` on any install failure).
- **Enrichment runner:** `audio/venv/bin/python -m audio.enrich.run_enrichment <pass>`
  from repo root (new tracks: the ingest path runs tags→mb→lyrics→audio→speech→profile→
  embed→pretranscode incrementally; `all` orchestrates serially).
- **How Adam works:** SSHes in from work; dictates through Tmux into CC sessions; wants
  data not guesses; investigate ≠ permission; batch decision questions; **put the answer
  he asked for LAST** (his terminal scrolls poorly — a buried answer = an unread answer);
  commit per work item, push only on his word; address him as Mr. Awesome (the
  context-loss canary — if it drifts, SAY SO before he has to).

## 6. Gotchas that cost real time (each also in memory)

- **APK "App not installed"** → `apksigner verify --print-certs` FIRST; expect `93a0fffd…`.
- **"Buds connected but G2CC says no audio"** → OS shows connected while the buds expose
  NO audio profiles (multipoint/profiles settling). Route guards are HONEST — check BT
  settings, play any audio, or BT off/on.
- **Music and SCO listening are mutually exclusive on classic BT** — the physics that
  killed the old design. The music app never fights it: dictation pauses music, period.
- **stt errors are console-loud** (`[stt] REJECTED dictation:`); nothing in the log = the
  audio never reached the server.
- **Chrome-filter drift**: CC UI changes break `stripCcInputBox` — ground-truth against a
  real `tmux capture-pane` before rewriting.
- **`fwTextWidth` underestimates firmware glyphs** — keep the ×0.85 strip margin; raise
  only in small on-glass steps.
- **Smoke DB is `g2cc_smoke`** (`_env.mjs`); throwaway-server phases boot the FULL
  index.js (music scans + TTS warm against the smoke DB — by design).
- **`pgrep -f | head -1` matches YOUR OWN bash wrapper** — killing "the" PID can kill the
  wrong process while the target survives. Match precisely; verify what died.
- **Postgres jsonb precedence:** `a || b - 'key'` parses as `a || (b - 'key')` (`-` keeps
  arithmetic precedence). Parenthesize, then VERIFY the row changed.
- **Ogg tags are STREAM-level** — both indexers now probe format+stream (format wins);
  don't regress this in music.ts probe changes.
- **ffprobe/ffmpeg trust:** container duration can be wrong — a mid-file `-ss` can decode
  EMPTY with rc=0 (nearly deleted two healthy Floyd/Queen tracks). Decode-verify before
  calling a file corrupt, and before ANY file deletion.

## 7. Open threads

- **PHASE B (§1)** — the mandate. Then C (window/resolver/radio), D (yt-dlp), E (v1.22
  gapless + backfills), Adam-paced.
- **TTS/dictation revisit** — shelved WHOLE to its own session (Adam decides when).
  Dormant inventory in MUSIC_SPEC D2.
- **AcoustID key** (Adam, free, 2 min) — unlocks fingerprint identification of the ~200+
  honest-unknown tracks + dedupe hardening. **Last.fm: assessed redundant post-profiles
  (2026-08-05) — skip unless Adam says otherwise.**
- **Earbud-mic WER shootout** vs the DJI baseline (real shift captures; pairing rule).
- **Tmux input-box refinement** — Adam flagged something about the Focus-mode chrome
  strip; he'll explain later. DO NOT act on guesses (two reverted attempts already).
- **§2.2 ribbon remainder** (overhaul.md): §2.2.5 LEFT-menu reclaim · §2.2.7 strip
  hardening · §2.2.8 default-flip after the soak.
- **Hat bridge** (docs/HAT_BRIDGE_SPEC.md) — spec'd, not built.
- **Calendar/Gmail OAuth red** — fix = re-running aria's `google_auth.py` (Adam's task).
- **Adam's future personal projects (not now):** rip the vinyl collection (Rega P9);
  consolidate/rename/de-dupe/back up the whole music collection.
