# G2CC — Fresh-Session Handoff (2026-08-05, post the all-phases music night)

**Read this first, whole.** Then: `~/.claude/CLAUDE.md` (Adam's global rules), `CLAUDE.md`
(project rules), `docs/MUSIC_SPEC.md` (the Part D contract — **all five phases BUILT**,
statuses in its header/D9) and `docs/README.md`. History: `CHANGELOG.md` + git; don't
re-derive it. Project memory (`~/.claude/projects/-home-user-G2CC/memory/`) carries the
don't-re-chase lists — trust them.

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

## 1. THE STATE — the music app is BUILT (2026-08-05 overnight); on-glass gates are Adam's

The 2026-08-05 overnight session executed MUSIC_SPEC Phases **B, C, D and E** end-to-end,
each with its own multi-agent verify-then-fix review pass (fix-confirmed-then-commit), a
final whole-diff review, then deploy. Commits: 04335fb (B), 599b992 (C), then D/E/docs —
see git log. Deploy (the §4 restart) + seeding a ~25-track random-mix queue in
player_state are the LAST step of the night — after them **one bud tap plays music**
(idle-tap resume; boot never auto-plays). Verify post-deploy: the :7300 pid is newer
than dist, and `player_state` holds one row with ~25 queued.

**Adam's morning items (nothing else blocks):**
1. **Install APK v1.22** from /setup (staged at `~/.g2cc/g2cc-harness.apk`, pinned cert
   93a0fffd…). v1.21 keeps working seam-ful until then (the compatibility floor).
2. **On-glass gates:** B (bud taps native; track-change popups at ribbon root +
   in-window), C ("play some hard metal stuff" via Music → Ask; save/reopen a playlist;
   radio extending a dying queue), D (Browse → YouTube → grab a named song), E (after the
   install: the gapless boundary A/B; a mid-track server restart the ear shouldn't
   notice).
3. **AcoustID key** (free, 2 min, acoustid.org/new-application) → `music.acoustidKey` in
   `~/.g2cc/config.json` or env `ACOUSTID_API_KEY`, then
   `cd audio && ./venv/bin/python -m enrich.run_enrichment acoustid` (tmux — hours).
   The pass is EVIDENCE-ONLY (fabrication rules): it records fingerprint identities +
   mismatches for review, never rewrites tags.

## 2. Architecture + hardware truths (violate these and the display breaks)

- **PC = the brain** (Node/TS server on `:7300`; ALL state; Postgres `g2cc`, unix-socket
  peer auth). **Glasses = a thin display** (576×288, 16-gray; ring: scroll/tap/double-tap).
  **Phone = a bridge** (Android FGS: BLE↔WS relay + the audio sink). The OS session is a
  BOOT-TIME SINGLETON surviving every disconnect; connections attach as surfaces.
- **THE MULTI-PACKET WALL:** firmware silently ignores any single message > ~1000 B
  (server estimator throws >960; client rejects >1000). `msgId` is ONE byte. Render
  limits: ≤12 containers, ≤8 text, ≤4 image, exactly one event-capture region.
- Adam runs **ribbon + fullBleed**. Menu mode must stay byte-for-byte identical.
- **FROZEN (no changes without Adam's explicit go):** `G2Renderer.kt` send semantics;
  `composeScene`'s classic path bytes; `blankScene()`; the byte estimator + wall fences;
  msgId/keepalive/pacing behavior.
- **The glasses have NO power switch**; app-side resilience is the only wedge escape.
- **Every media-family wire message is caps-gated** (`sendCapped()` in music-player.ts is
  THE door; caps: `media-lane`, `earbud-buttons`, and v1.22's `media-prestage`). Wire
  changes: additive-optional both ends; server first; unknown FIELDS on known messages
  are old-APK-safe (`ignoreUnknownKeys`).
- **Music and SCO listening are mutually exclusive on classic BT** — the physics the
  design accepts: dictation pauses music (the capture gate), period. Dictation itself is
  UNCHANGED: ring-driven, mic = buds over SCO (`stt.micSource:'earbud'`, `'dji'` = the
  one-flip undo), adaptive Wiener α1.5 → canary-qwen.

## 3. The music app — the load-bearing map (2026-08-05)

- **`server/src/music-player.ts`** — MusicPlayerService (boot singleton; injected deps,
  no cycles): queue/transport, NATIVE bud taps (single=toggle w/ **idle-tap resume**,
  double=next, triple=prev w/ Spotify restart-≥3s), capture gate, play_history (80% skip
  rule), debounced player_state persistence + `loadPersisted` (NEVER auto-plays; the
  tap-arming ping `media_ctl(pause)` makes bud taps route while idle — the v1.21 app
  builds its MediaSession lazily), radio (Qdrant recommend, unembedded seeds filtered —
  one missing point id 404s a whole recommend; queue-GENERATION guard kills stale fills),
  v1.22 prestage (`sentNext` + `media_open.next` + `media_ctl preload` +
  `auto_advanced` adoption — all `media-prestage`-cap-gated).
- **`server/src/resolver.ts`** — D4 lanes: 1 deterministic (random/artist/album/playlist/
  vocab/search; LIKE-escaped, punctuation-tolerant), 2 Opus one-shot (live vocabulary
  incl. vocals in the prompt; strict-JSON plan → SQL; ANY failure falls through), 3
  embedding (`audio/enrich/embed_query.py` → Qdrant ranked) + blend w/ cross-set
  dupe-cluster dedupe. **D14 reality rule:** the exclusion terms are 'sound effect'
  (SINGULAR — the library's actual term, mostly in STYLES) + variants; 'spoken word'
  excluded from DISCOVERY lanes only (explicit artist/search/album asks keep it).
- **`server/src/windows/music.ts`** — MusicWindow (Media slot): fullBleed Now Playing =
  scrollContent (RING = VOLUME; double-tap = the FULL Actions list incl. Ask/Browse/
  Queue); classic = menus. Ask (dictate/typed → resolver → plays + honest lane line),
  Browse (Playlists/Artists/Albums/Moods&Genres/Search/YouTube), Queue (Cancel-first
  Clear; current row not removable), Playlists (transactional CRUD; dictated save-name
  REPEATS to replace an existing name; delete Cancel-first), karaoke Lyrics
  (track-change re-derive), YouTube (D7: search top-5 → grab → Play now/Append).
- **`server/src/youtube.ts`** — explicit-only yt-dlp: audio-only opus +
  `--embed-metadata` into `<libraryDirs[0]>/YouTube/`, incremental index,
  enrichment-on-ingest (speech FIRST per D14), minutes-class network caps (sanctioned).
- **`server/src/playlists.ts` / `music-browse.ts` / `store.ts::withTransaction`** —
  playlist CRUD is TRANSACTIONAL (pool-level BEGIN is a lie); remove/move take VISUAL
  indexes (gap-safe, dense renumber); albums group case-insensitively.
- **Popups (D6.3):** `WindowManager.musicPopup(line)` — ribbon strip text swap (antenna
  id/geometry untouched), in-window title intrusion (keeps `! flash` / `▲ nav` tails),
  blanked one-line flash; auto-revert `config.music.popupMs` (0=off); an explicit user
  blank kills a live popup. The player's `deps.popup` + public `popup()` reach it.
- **Android v1.22** (staged, NOT installed): rolling 2-item ExoPlayer playlist,
  mediaId-carrying items, `onMediaItemTransition(REASON_AUTO)` →
  `media_event{reason:'auto_advanced'}`, minutes-class LoadControl, caps +=
  `media-prestage`. Unit tests: **205** (the docs' old "389" never reproduced on any
  variant — 200/variant was measured before any change; delta unexplained, don't chase
  without Adam).

## 4. How to build, verify, deploy

- **Server:** `npm run build -w shared` (if protocol changed) → `npm run build -w server`
  → `node server/smoke/run-all.mjs` — gate **36/37** (`phase10-calendar` = the known
  external Google-OAuth red; exits non-zero BY DESIGN). Clean rebuild needs
  `rm -f server/tsconfig.tsbuildinfo && rm -rf server/dist` (the tsbuildinfo lives
  OUTSIDE dist and skips emits after a bare dist wipe).
- **Server restart procedure (hard-won, follow exactly):**
  1. `cp /tmp/g2cc-server.log ~/.g2cc/logs/g2cc-server-$(date +%F-%H%M)-pre-restart.log`
  2. `OLD=$(ss -ltnp 'sport = :7300' | grep -oP 'pid=\K[0-9]+' | head -1)` — the port
     filter is mandatory.
  3. `kill "$OLD"`, verify exit AND port free.
  4. Relaunch with the operator-session env scrubbed:
     `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u AI_AGENT -u CLAUDE_EFFORT -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_API_KEY nohup setsid node /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`
  5. Never restart while Adam is mid-download from /setup.
- **Android:** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk
  ./android/gradlew -p android testDebugUnitTest assembleDebug` → bump
  versionCode+versionName on EVERY build Adam installs (major*100+minor; NOW 122/1.22) →
  cp to `~/.g2cc/g2cc-harness.apk`. Unit baseline **205**. Pinned keystore
  (`apksigner verify --print-certs` → `93a0fffd…` on any install failure).
- **Enrichment runner:** `cd audio && ./venv/bin/python -m enrich.run_enrichment <pass>`;
  `speech` + `acoustid` are NOT in `all` (scope with `--ids`/`--track-id`/`--artistless`).
- **How Adam works:** SSHes in from work; dictates through Tmux into CC sessions; wants
  data not guesses; investigate ≠ permission; batch decision questions; **put the answer
  he asked for LAST** (his terminal scrolls poorly); commit per work item, push only on
  his word; address him as Mr. Awesome (the context-loss canary — if it drifts, SAY SO).

## 5. Gotchas that cost real time (each also in memory)

- **Fixture-from-production rule (NEW, the night's lesson):** a vocabulary-dependent test
  whose fixture plants the CODE's expected string proves nothing — the 'sound effects'
  exclusion was green while matching zero real rows ('sound effect', singular, in
  STYLES). Mirror production data in fixtures; verify terms against the DB first.
- **Qdrant recommend 404s the WHOLE call on one missing point id** — filter seeds
  through a retrieve first (radioNeighbors does).
- **A 'playing' report clears pausedBy** — phone-side auto-pause/resume (focus loss)
  must never latch a server-side pause (it silently killed queues at boundaries).
- **APK "App not installed"** → `apksigner verify --print-certs` FIRST; expect `93a0fffd…`.
- **"Buds connected but G2CC says no audio"** → profiles still settling; check BT
  settings, play any audio, or BT off/on.
- **stt errors are console-loud** (`[stt] REJECTED dictation:`); nothing in the log = the
  audio never reached the server.
- **`fwTextWidth` underestimates firmware glyphs** — keep the ×0.85 strip margin (popup
  strip override uses the SAME reserves as stripText's proven budget).
- **Smoke DB is `g2cc_smoke`** (`_env.mjs`); loadConfig's retired-key strip writes the
  real config from PRODUCTION boots only (G2CC_PG_DATABASE marks the smoke env).
- **Ogg tags are STREAM-level**; **ffprobe duration lies** (decode-verify before calling
  a file corrupt / deleting anything).
- **Postgres jsonb precedence:** `a || b - 'key'` parses as `a || (b - 'key')`.
- **pg pool ≠ transactions:** `query('BEGIN')` statements ride DIFFERENT connections —
  use `store.ts::withTransaction`.

## 6. Open threads

- **On-glass verification of B/C/D/E** (§1 — Adam's morning) + field tuning from use.
- **AcoustID key** (§1) → the backfill run + the mismatch report review.
- **TTS/dictation revisit** — shelved WHOLE (tts.ts, speak-digest.ts, companion-mcp.ts,
  `~/g2cc-companion/`, config.tts/companion/audioOut dormant on disk; the ears/voice
  grammar has no always-on feed). Its own future session, Adam decides when.
- **Earbud-mic WER shootout** vs the DJI baseline (capture tee: `audio/.capture-armed`).
- **Tmux input-box refinement** — Adam will explain; DO NOT act on guesses (two reverts).
- **§2.2 ribbon remainder** (overhaul.md): §2.2.5 LEFT-menu reclaim · §2.2.7 strip
  hardening · §2.2.8 default-flip after the soak.
- **Hat bridge** (docs/HAT_BRIDGE_SPEC.md) — spec'd, not built.
- **Calendar/Gmail OAuth red** — fix = re-running aria's `google_auth.py` (Adam's task).
- **The "389" Android-test figure** in older docs — never reproduced (200/variant
  measured pre-change); archaeology only with Adam's interest.
- **Adam's future personal projects (not now):** rip the vinyl collection (Rega P9);
  consolidate/rename/de-dupe/back up the whole music collection.
