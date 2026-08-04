# Earbud Audio — Full Spec (Part C)

**Status: BUILT + DEPLOYED + FIELD-TESTED 2026-08-04 — then REJECTED BY ADAM as a design
the same evening. A ground-up redesign is mandated (fresh session; HANDOFF §1).** This
document remains the accurate reference for WHAT EXISTS (the code still runs until the
redesign replaces it) and the post-mortem below is the redesign's required reading.

### Post-mortem — why the design died (2026-08-04 late evening)

The build was mechanically sound (music verified on-glass; TTS, Companion, wake word all
live). The DESIGN failed on one physical constraint discovered end-to-end: **on classic
Bluetooth (Buds 2a = SBC/AAC, no confirmed LC3), a continuous SCO mic capture and A2DP
music playback are mutually exclusive on the same earbud.** The shipped arbitration
(music wins; wake-word listening auto-suspends during playback) meant voice could not
control PLAYING music — Adam: "if i have to touch something to pause the music before i
can tell it to skip or play another song or whatever, then entirely hands-free music
control is not doable, and a janky half-version is pointless."

Constraints any redesign must honor (facts, not decisions):
- Voice control DURING music requires a listening path that does NOT own the buds' radio.
  Candidates seen but NOT designed: the PHONE's own mic for wake-word detection while the
  buds play A2DP (the phone-mic ban was a DICTATION-quality policy from the DJI era —
  detection is a different job with different quality needs); LE-Audio-capable hardware;
  or abandoning voice-during-music for ring/tap-driven transport.
- Adam's direction: "separate dictation from music, and implement them much differently."
- The salvageable machinery (working, reviewed, live): the Kokoro TTS daemon pair, the
  music index/transcode/Range streaming, the Companion session + MCP tool surface, the
  spoken-digest projection, the route guards + caps-gating discipline, the earcons.

What shipped vs. deferred: CHANGELOG 2026-08-04 (both entries). Mid-build additions by
Adam: the wake-word ringless path (§Decision Record) and SPOKEN DIGESTS — long/code
replies condense through a one-shot model pass before TTS (server/src/speak-digest.ts);
the full text always renders scrollable on glass; code is never read aloud.
Written after the work-policy change allowing a single earbud during shift. Companion to
`g2_custom_app_spec.md` Parts A/B; if this conflicts with the Three Absolute Rules or the wire
discipline there, those win.

### Decision Record (Adam, 2026-08-04)

- **Earbud: Google Pixel Buds 2a.** Tensor A1, BT 5.4, **SBC/AAC classic profiles** (LC3/LE
  Audio unconfirmed — possibly via future update; `TYPE_BLE_HEADSET` handling kept as
  future-proofing). Gestures on either bud (customizable, arrive as media buttons); native
  mono/volume-balance setting exists — enable it in the one-time setup checklist.
- **Topology: T2 — the earbud replaces the DJI entirely** (fewer BT links). Capture over
  SCO/HFP (music auto-suspends during dictation = the pause-to-record policy by physics),
  output over A2DP. **The DJI path is DISABLED, NOT DELETED**: `config.stt.micSource:
  'earbud' | 'dji'` (default `earbud`); every DJI code path stays intact and one config flip
  restores it. The T1/T3 rows in §C3 are retained as the undo/fallback map.
- **STT re-validation debt (accepted):** the model×filter pairing was validated on DJI
  captures. Earbud capture ships on the same warm path (16 k mono int16 → adaptive Wiener
  α1.5 → canary-qwen) with the RAW-RETRY net; source is honestly announced `earbud-bt` and
  per-clip telemetry is tagged, so shift captures via the existing tee
  (`audio/.capture-armed`) can score the pairing on real data (§C11 P4 remains).
- **Music: server library only** for now; Spotify-class app control deferred to a future
  session (MediaBridge foundation stays).
- **Voice: `af_heart`** (same as ARIA, by preference).
- **Confirm policy: trust-the-transcript at confidence ≥ 0.95; below that, VOICE
  confirmation** ("say send or cancel" — waits forever, no auto-anything). Gloves-driven:
  taps may be unavailable.
- **Ringless control: wake word `butterscotch`** (already the handsfree wake word in
  `voice.ts`). Ring/earbud-tap PTT bypasses the wake word; saying "butterscotch …" works at
  any time — gloves or not — for transport verbs and open-ended Companion prompts.

**Mission:** give G2CC an audio output channel. A dedicated, open-ended Claude Code session
("the Companion") reachable by voice, ring, or earbud button; its output rendered as
text-on-glasses when its window is active, spoken via TTS into the earbud when it isn't. Plus
on-demand music/anything playback to the earbud — mono, one bud — that elegantly ducks or
pauses around speech and dictation. The phone stays in the pocket (the work rule: earbud OK,
phone-fiddling not).

Everything here is Adam's own hardware: his earbud, his phone, his PC, his music files, his
glasses. Same first-party posture as the rest of G2CC.

---

## C1. Constraints (work rule + house rules)

- **One earbud, mono always.** Nothing may assume stereo reaches the ear.
- **Hands-free or eyes-free at all times.** Every control reachable via ring, earbud button,
  or voice. Phone UI (ControlActivity) is a test surface, not the daily driver.
- **NEVER the phone speaker.** A TTS blast from a pocket speaker on the floor is a policy
  violation. Hard route guard: no suitable BT output device → do not play, report
  `unverified` loudly, render to glasses instead. (`audioOut.allowSpeaker` config for home
  bench only, default false.)
- **No auto-confirm, no timeouts, no truncation, no silent failures** — the Three Absolute
  Rules apply to every new path (speech queue, playback, SCO orchestration). Spoken output is
  a **projection** of text that always lands in scrollback in full; interrupting speech mid-
  sentence (barge-in) is a user action, not truncation.
- **Half-duplex on the earbud.** Platform AEC is deliberately disabled in `MicCapture`
  (`disablePlatformVoiceDsp`). Earbud-mic capture while the same earbud plays audio = echo
  with no suppressor. Rule: capture state gates the speech queue and pauses media; never
  speak and record simultaneously.
- **Accuracy > latency** (Adam's standing decree from the STT war). Sub-second speech is the
  target, but never at the cost of wrong routing or fabricated status.

---

## C2. Decisions already closed (evidence in hand — don't re-litigate)

| Decision | Basis |
|---|---|
| **TTS engine = Kokoro v1.0 ONNX, reused from ARIA** | `/home/user/aria/tts_models/kokoro/` (310 MB model + 50-voice pack), `kokoro_onnx` 0.5.0 + CPU `onnxruntime` 1.24.3 already proven in `aria/tts.py`. **Zero VRAM** — coexists freely with canary-qwen's ~7 GB. 24 kHz mono output. No engine bake-off needed. |
| **Port ARIA's `_prepare_for_speech`** | Battle-tested markdown→speakable pass: strips bold/code/links, paren-artifact fix, newline→comma split points, and the 509-phoneme silent-truncation guard (`MAX_PHONEME_LENGTH = 509` off-by-one fix). This is exactly the "make CC output speakable" layer. |
| **TTS runs as a warm Python daemon mirroring `parakeet_daemon.py`** | Same sentinel-framed stdio protocol, same `G2CC_*` env config threading, same serialized-queue/respawn manager pattern in TS (`stt.ts::ParakeetDaemon` is the template). |
| **Playback/speech state lives at OsSession level, not in a window** | Audio must survive `onDeactivate`, screen blanking, ribbon parking, and surface disconnects. Windows are UI shells over session-lifetime services (the multi-surface principle, 2026-07-13). |
| **Phone = reflexes, PC = brain** | Duck ramps, chimes, SCO/A2DP transitions, route verification are phone-local (latency + radio ownership). What to say, what to play, queue, and policy are server-side. |
| **Third-party player control already exists** | `MediaBridge.kt` (NotificationListener-authorized `getActiveSessions`) + `media_cmd`/`media_state` wire lane + `windows/media.ts`. Ducking/pausing Spotify-class apps builds on this, not from scratch. |
| **Speech delivery gets real verification** | `ChannelRouter.awaitAck()` + the `confirmOnHudWithDelivery()` composite shape: `verified`/`unverified` with reason, promise never rejects, waiter registered before send. |

---

## C3. Hardware & Bluetooth topology — THE open technical risk

The phone radio may carry up to three links at once: **BLE (glasses) + A2DP (earbud out) +
SCO/HFP (DJI mic in)**. Classic Bluetooth does not promise SCO-to-device-A concurrent with
A2DP-to-device-B; profile switches suspend A2DP. The `ConnectionService` watchdog already
defers BLE recovery during live dictation *because* the DJI SCO shares the radio — this
subsystem adds a third tenant.

### Candidate topologies

| | Mic | Earbud role | Simultaneous mic+music? | Notes |
|---|---|---|---|---|
| **T1 (default)** | DJI TX2 over BT SCO (today's proven ~95% path) | A2DP output only | No — music **pauses** during dictation (desired behavior anyway); TTS-over-music fine (output-only) | Zero STT re-validation. Needs bench proof that SCO(DJI)+A2DP(earbud) time-slice cleanly and A2DP resumes. |
| **T2** | Earbud mic (HFP or LE Audio) | Everything | Classic: no (HFP mode = music suspends). LE Audio: possibly yes | Drops the collar mic entirely. Requires a full STT shootout on earbud captures (§C11 P4) — the model×filter **pairing rule** applies. Echo constraint (half-duplex) is absolute here. |
| **T3** | DJI receiver on USB-C (48 kHz float, the `dji-usb` path — already implemented) | A2DP output | Yes — USB in + BT out is fully concurrent | Best audio + true concurrency; physical hassle (receiver in pocket, USB-C occupied). The escape hatch if T1 benches badly. |

**DECIDED 2026-08-04: T2.** (Superseded recommendation kept for the record: build-for-T1 was
the pre-decision default.) All three share the same server design; only phone route
orchestration differs — which is why T1 remains one config flip away.

### Phase 0 bench matrix (now a hardware checklist + runtime self-checks)

Adam approved the build without a bench window, so these become (a) facts pinned from
published specs (Buds 2a: BT 5.4, SBC/AAC, either-bud gestures, mono setting), (b) runtime
verifications that fail LOUD (route guard, routedDevice checks, speak_ack status), and (c) a
ControlActivity bench screen for the remaining physical checks when he's back. Original
matrix, still worth running by hand:

1. Earbud facts: exact model, LE Audio (LC3) support, button/gesture events it emits,
   single-bud auto-downmix behavior, multipoint behavior.
2. With earbud connected (A2DP active): does `setCommunicationDevice(DJI SCO)` still land on
   the DJI? Does `routedDevice` verification pass? (The `MicCapture` device-pick currently
   falls back to `comms.firstOrNull()` — **an earbud would be silently captured and
   mislabeled `dji-bt`**. Fix regardless of bench outcome: §C7.)
3. A2DP suspend/resume around a dictation cycle: gap length, glitch behavior, does music
   auto-resume or need a nudge.
4. Media button events from the earbud: do they arrive without an owned MediaSession? With a
   placeholder session? Which gestures (single/double/triple/hold) are distinguishable?
5. AudioFocus `TRANSIENT_MAY_DUCK` from our future speech lane: does the earbud's source app
   (Spotify etc.) duck and recover?
6. Route guard: with no BT output present, confirm nothing reaches the speaker.
7. Android Accessibility **mono audio** toggle: verify it downmixes third-party stereo; note
   it in the one-time setup checklist.
8. BLE glasses link health while A2DP streams (body-block interaction) — a workday soak.
9. `MODIFY_AUDIO_SETTINGS` undeclared today despite `setMode`/`setCommunicationDevice` usage
   (latent finding) — declare it and re-verify SCO behavior is unchanged.

Deliverable: a **Topology Decision Record** appended to this file with the matrix results.

### Future note — hat bridge

If the ESP32-C5 hat (docs/HAT_BRIDGE_SPEC.md) ever replaces the phone as the BLE bridge, the
earbud almost certainly stays paired to the phone (ESP32 as A2DP source to a modern earbud is
not a bet to make). The audio lane's phone-side design stands regardless; revisit at hat time.

---

## C4. Architecture

```
                        ┌────────────────────────── PC (server, :7300) ──────────────────────────┐
                        │                                                                        │
  /mnt/slug/Music ──▶ music.ts (index/Postgres, search, queue)      tts.ts ── TtsDaemon ──▶ pipeline/tts_daemon.py
                        │        │                                    ▲            (kokoro-onnx, CPU, 24k mono)
                        │        ▼                                    │                          │
                        │  GET /media/track/:id (range, token,     earbud.ts  ◀── notifyHub (timers, sms, email)
                        │   opus-mono transcode + cache)           (EarbudAudioService: speech queue,
                        │        │                                  output policy, playback state,
                        │        │                                  ChannelRouter speak-acks)
                        │        │                                    │            ▲
                        │        │                              OsSession.toPhone  │ companion-mcp.js (stdio MCP)
                        │        │                                    │            │   ↑ loopback HTTP /internal/*
                        │        │                                    │       session-pool: "Companion" CC
                        │        │                                    │       (cwd ~/g2cc-companion, --mcp-config)
                        └────────┼────────────────────────────────────┼──────────────────────────┘
                                 │  HTTP (range audio)                │  WS: speak_start/chunks/speak_end,
                                 │                                    │      media_open/media_ctl, chime, caps-gated
                        ┌────────▼────────────────────────────────────▼─────────────────────────┐
                        │ Pixel 10a — G2CC app (ConnectionService FGS + mediaPlayback type)      │
                        │  AudioRouteArbiter (single owner of AudioManager.mode + comm device)   │
                        │  ├─ MicCapture (existing; DJI SCO / USB, role-pinned)                  │
                        │  └─ AudioOutController (NEW)                                           │
                        │      ├─ speech lane: AudioTrack 24k mono (WS binary 0x11 frames)       │
                        │      ├─ media lane: media3 ExoPlayer (server range URL, mono)          │
                        │      ├─ chimes: SoundPool (local assets, instant)                      │
                        │      ├─ ducker: own-lane gain + MediaBridge/AudioFocus for 3rd-party   │
                        │      ├─ MediaSession → earbud buttons → sendControlInput()             │
                        │      └─ route guard: BT-out or nothing (routedDevice verified → ack)   │
                        └───────────────┬────────────────────────────┬───────────────────────────┘
                                   BLE (glasses)                A2DP/SCO (earbud, DJI)
                                        │                            │
                                  G2 glasses HUD                one earbud (mono)
                              (EarbudWindow: text mode)         (TTS + music + chimes)
```

The earbud is effectively a **third surface** — an audio surface — attached to the same
boot-time OsSession as the phone and browser surfaces. When the glasses are wedged, asleep,
or in the case, the Companion remains fully usable by ear alone. That is a resilience win,
not just a feature.

---

## C5. Wire contract additions (`shared/src/protocol.ts`)

All additive-optional; server ships first; **capability-gated** so pre-1.20 APKs never see a
new type (they log a decode failure per unknown message — documented at `protocol.ts:790`).

- `AuthMsg` gains optional `caps?: string[]`. APK v1.20+ sends
  `['audio-out', 'media-lane', 'earbud-buttons']`. Server sends nothing below without the cap.

**Server → client (JSON):**
- `speak_start { id, policy: { music: 'duck'|'pause', duckDb?: number }, priority }`
- `speak_end { id, chunks }` — total binary chunk count (hole detection, mirroring mic-side)
- `chime { name }` — `rec_start|rec_stop|done|error|timer|notify` (APK-local assets, instant)
- `media_open { id, url, title, artist?, album?, durMs?, startMs? }` — ExoPlayer source
- `media_ctl { cmd: 'play'|'pause'|'stop'|'seek'|'volume', value? }`

**Server → client (binary):** new downstream tag scheme on the existing WS, mirroring the
upstream mic framing: `[0x11][u32 speakId][u32 seq][PCM16LE @ 24 kHz mono]`, chunks ≤ 32 KiB.
A binary frame outside an open `speak_start` window is a loud client-side warn + drop
(mirror of the server's `collectingAudio` guard).

**Client → server (JSON):**
- `speak_ack { id, status: 'played'|'unverified'|'failed', reason?, route }` — resolved via
  `ChannelRouter`; `route` is the actual `routedDevice` type/name (the v1.19 SCO-verification
  discipline applied to output).
- `media_event { id, state: 'playing'|'paused'|'ended'|'error', posMs, reason? }`
- `input` gains earbud button events — reuse the existing seam
  `ConnectionService.sendControlInput()` with `event: 'media_button', code: 'single'|'double'|'triple'|'hold'`
  (exact vocabulary from P0 bench).
- `audio_start.source` gains `'earbud-bt'` — earbud-mic capture is announced honestly, never
  mislabeled `dji-bt` (the pairing rule needs true capsule provenance).

---

## C6. Server subsystem

### C6.1 `tts.ts` + `audio/pipeline/tts_daemon.py`

Faithful mirror of the ASR daemon pair:

- Python: `kokoro_onnx` + CPU `onnxruntime` in the existing `audio/venv`; model files
  referenced from ARIA's path (or copied to `audio/tts_models/` — decide at build; reference
  first, copy if coupling annoys). Env: `G2CC_TTS_MODEL`, `G2CC_TTS_VOICES`, `G2CC_TTS_VOICE`.
  Port `_prepare_for_speech` + `_ensure_tts_splits` from `aria/tts.py` (drop ARIA's
  ACTION-block/push_image branch; G2CC's loud-fail is a `[tts]` console line + glasses error).
  Job protocol: JSON line in → sentinel-framed result out, **per-sentence**: input text is
  sentence-split, each sentence synthesized and emitted as base64 PCM in its own result frame
  so the server streams chunks while later sentences still render. Warmed at boot alongside
  `warmParakeet` with a one-word synthesis.
- TS: `TtsDaemon` class cloned from `ParakeetDaemon` (serialized queue, identity-gated
  respawn, buffer cap, sentinel parse, NO timeouts). Config-selected engine string
  (`config.tts.engine`, default `'kokoro'`) mirrors `config.stt.parakeetModel` so a future
  engine swap is a config flip.

### C6.2 `earbud.ts` — `EarbudAudioService` (OsSession-owned)

The brain. Constructed at boot next to the WindowManager; survives everything.

- **Speech queue.** `speak(text, {priority, policy})` → speakable-render → daemon →
  chunk-stream via `toPhone` + binary frames → `ChannelRouter.awaitAck` →
  `{status, reason}`. Priorities: `now` (flush queue: calls, errors), `next` (timers),
  `queue` (Companion replies, notification digests). Full text ALWAYS appended to the
  Companion scrollback first — speech is a projection.
- **Output policy** (the rule Adam specified):
  `speakDecision()` — if `hasDisplay()` **and** active window is `earbud` **and** not
  blanked/ribbon-parked → glasses text only; otherwise → TTS (text still lands in
  scrollback). `config.audioOut.speakMode: 'auto' | 'always' | 'never'` where `always` =
  both channels. Requires two new WM accessors: `activeWindowId(): string` and
  `isScreenIdle(): boolean` (blanked ∨ atRibbon) — today `active`/`blanked` are private.
- **Half-duplex + duck state machine.** States `IDLE / SPEAKING / CAPTURING / MEDIA`.
  Entering CAPTURING (any `audio_request start`): flush speech, pause own media lane, and
  (policy) pause third-party via `MediaBridge`. SPEAKING over media: own lane ducks by
  `duckDb` (default −12 dB, 150 ms ramps, phone-side); third-party ducks via AudioFocus
  transient. Exiting: restore. Barge-in = PTT during SPEAKING kills speech instantly.
  The `os-session.ts` `audio()` recursion warning applies: synthesize failures for
  start-class actions only, never stop-class.
- **Notification speech.** Subscribes `notifyHub`. Default work policy:
  `call` → speak now · `timer` → chime + speak · `sms` → chime + **sender name only**
  (privacy on the floor; body on request) · `email`/`info` → silent, on-demand digest.
  Config map per priority; `"what did I miss"` → digest of `listNotifications` unseen +
  `markAllSeen`. Profiles (work/home) are a P4 refinement, single policy map first.
- **Playback state**: current track, queue, position (extrapolated between `media_event`s,
  same `posMs()` trick as `windows/media.ts`), volume. All in-memory + Postgres-persisted
  queue so a server restart can offer "resume?".

### C6.3 `music.ts` — library + streaming

- Indexer: walk `config.music.libraryDirs` (default `['/mnt/slug/Music']` — 23 GB, ~1,200
  tracks today), `ffprobe` metadata → Postgres `tracks` table (artist/album/title/durMs/
  path/mtime), re-scan on demand (window menu row + Companion tool). Search = token match
  across artist/album/title/filename.
- Streaming: `GET /media/track/:id?token=…` — token-gated like `/endpoints` (interface-
  agnostic — the phone may be on cellular+Tailscale). Two modes:
  - `?fmt=opus` (default): ffmpeg transcode to **Opus 96k MONO** with `loudnorm`, cached at
    `~/.g2cc/media-cache/` keyed by path+mtime. Mono enforcement and loudness normalization
    at the source; kind to cellular. ExoPlayer plays Ogg/Opus natively.
  - `?fmt=raw`: range-served original (FLAC/MP3) for LAN/Wi-Fi listening.
  - **Range support is new machinery** — `@fastify/static` is not a dep and every current
    static reply is a sync whole-file buffer. Add a `Range` handler with
    `createReadStream(start, end)` + 206; heed the documented `/apk` async-stream trap
    (`index.ts:188` — use `return reply.send(stream)` semantics and test with ExoPlayer
    specifically).
- "Anything else": a `fetch_audio(url)` Companion tool (yt-dlp if installed — verify at
  build — else ffmpeg for direct URLs) downloading into a scratch library dir, then queued
  like any track. Podcasts/RSS ride this in P5.

### C6.4 The Companion session

- Pool entry via `getOrCreateByDirectory('/home/user/g2cc-companion')` — a real directory
  whose `CLAUDE.md` is the persona: terse spoken-first replies, no markdown/code in prose,
  "long answer → tell him it's on the glasses", context lines (now-playing, pending timers)
  provided per-prompt. Persistence/resume for free via `sessions.json`.
- Spawn additions (companion only): `--mcp-config ~/.g2cc/companion-mcp.json
  --strict-mcp-config` — **the first MCP use in G2CC** (flags verified present on CLI
  2.1.221 on 2026-08-04; re-verify at wiring per house rule). Existing `systemPrompt` →
  `--append-system-prompt` support carries the persona addendum.
- `server/src/companion-mcp.ts` → `dist/companion-mcp.js`, stdio MCP server whose tools call
  **loopback-only** HTTP endpoints (`/internal/*`, the `/scout/live` gate pattern + Bearer):
  `speak(text, priority?)` · `play(query | trackIds, mode?)` · `pause()` / `resume()` /
  `skip()` · `volume(delta|pct)` · `now_playing()` · `queue(query, position?)` ·
  `set_timer(duration, label)` / `list_timers()` · `save_note(text)` ·
  `unseen_notifications(markSeen?)` · `external_media(cmd)` (MediaBridge passthrough) ·
  `fetch_audio(url)` · `glasses_status()`.
  The session is open-ended by construction: new capability = new tool, no app change.
- `MAX_CONCURRENT_SESSIONS = 5` → 6 (the Companion is long-lived and must not evict work
  sessions).
- **Voice input routing.** Unchanged for existing flows: dictate mode still targets the
  active window (`onStt`), Tmux dictation untouched. New paths to the Companion:
  1. EarbudWindow active → its `onStt` (it's a `SessionLevel` shell like `windows/cc.ts`,
     pointed at the companion pool entry).
  2. **Earbud button double-tap = Companion PTT from anywhere** — chime, capture, transcript
     to Companion regardless of active window. This is the "dedicated session" promise.
  3. Handsfree wake word (`butterscotch`) grammar gains transport verbs (`pause`, `play`,
     `skip`, `volume up/down`, `what's playing`, `quiet`) — deterministic in
     `parseVoiceCommand`, no CC round-trip; everything else falls through to the Companion.
- **Confirmation without auto-confirm.** Glasses visible → the existing confirm card.
  Audio-only → spoken echo ("You said: … — tap to send, double-tap to cancel") that **waits
  indefinitely** for earbud tap / double-tap / voice "send it"/"cancel". No timer ever
  confirms or discards. `config.companion.confirm: 'card'|'voice'|'off'` (off = Enter-style
  trust, same rationale as typed input's no-card rule).

### C6.5 Existing modules that light up

- `timers.ts` — `fire()` already posts `priority:'timer'` to notifyHub → now chimes + speaks.
- `memo.ts` — voice memos gain a spoken "saved" ack.
- `lyrics.ts` — synced LRC on glasses while the media lane plays (P5 delight; cache is
  already Postgres-permanent).
- `reader.ts` — **read-aloud** (P5 flagship): chapter text → sentence-wise speech queue in
  `music:'pause'` mode, spoken-position persisted separately from the visual page, resume +
  barge-in safe. Audiobooks from the epub shelf without an audiobook.
- `intents.ts` — unchanged initially; media verbs live in the handsfree grammar + Companion
  tools (adding `play:` intents to confirm-accept dictation is a later option, noted only).

---

## C7. Phone subsystem (APK v1.20)

- **Manifest:** add `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permission + `mediaPlayback` in the
  FGS type mask — **in the initial `startForeground` mask** (it cannot be upgraded
  mid-flight; extend the existing nested-catch degradation). Declare the missing
  `MODIFY_AUDIO_SETTINGS` (latent finding — `MicCapture` already calls `setMode`/
  `setCommunicationDevice`).
- **`AudioRouteArbiter` (new, small, critical):** the single owner of `AudioManager.mode` +
  communication-device routing. `MicCapture`'s `savedAudioMode`/`commsRouted` bookkeeping
  moves here; the output lanes consult it. Fixes the unilateral seizure before it becomes a
  three-way fight.
- **Mic device-role pinning:** replace the `comms.firstOrNull()` fallback — DJI selected by
  product-name match (as today) or an explicitly configured address; an earbud is chosen
  only when the server explicitly requests `source:'earbud-bt'`. No silent capsule swaps,
  no mislabeled wire announcements.
- **`AudioOutController` (new, sibling of `MicCapture`):**
  - Speech lane: streaming `AudioTrack` (24 kHz mono PCM16, `USAGE_MEDIA` +
    `CONTENT_TYPE_SPEECH`), fed by the 0x11 binary frames; focus
    `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` so third-party players duck for free.
  - Media lane: **media3 ExoPlayer** (new dependency) with `DefaultHttpDataSource` carrying
    the Bearer token; `ChannelMixingAudioProcessor` mono-sum as belt-and-suspenders (server
    already sends mono opus).
  - Chimes: `SoundPool` over APK raw assets — instant, no round-trip; `rec_start`/`rec_stop`
    bound directly to `audio_request` handling so dictation feedback is glanceless.
  - Ducker: own-media gain automation (−12 dB default, 150 ms ramps) under speech; pause
    semantics per `speak_start.policy`.
  - **Route guard:** before any playback, verify an A2DP/BLE-headset output device is
    present AND `AudioTrack.getRoutedDevice()` confirms it (the v1.19 verification
    discipline, output edition). Otherwise: no sound, `speak_ack {status:'unverified',
    reason:'no earbud route'}`, loud diag. Speaker only if `allowSpeaker` config.
  - `speak_ack` sent on completion with actual route; `media_event` on player state changes.
- **`MediaSession` (owned, new):** placeholder session so earbud buttons arrive; callbacks →
  `ConnectionService.sendControlInput(Input(event:'media_button', code:…))` — the proven
  phone-side input seam (works in control mode, no `_serverMode` gate). Server owns gesture
  semantics: single = pause/resume all (the **panic/courtesy tap**), double = Companion PTT,
  triple = skip, hold = TBD from bench.
- **Tasker/intents:** new `com.g2cc.intent.action.MEDIA` forwarder (house pattern: companion
  object → `@Volatile instance`), documented in INTENTS.md.
- **ControlActivity:** a transport row (play/pause/skip/vol) + "speak test" + P0 bench
  screen (device dump, route probe, focus probe). Test hooks only.

---

## C8. Glasses UI — `windows/earbud.ts`

- `EarbudWindow` — id `earbud`, label `Earbud`, **category `Media`** (5-category rule: no
  new categories; `AI` stays dead). One line in `windows/registry.ts`.
- A `SessionLevel` shell over the Companion pool entry (the `windows/cc.ts` pattern) plus a
  menu: `Talk · Music · Queue · Volume · Speak: auto/always/off · What did I miss`.
- Music level: browse artists/albums/search-by-dictation; now-playing view with transport on
  tap/scroll; Volume row = ring scroll.
- `preview()` (ribbon hover, side-effect-free, in-memory only): now-playing line + speak-mode
  glyph + queue depth, e.g. `♪ Dogs — Pink Floyd 3:12 · 🔊auto · q4`.
- `statusLine()` mirrors it while active. All rendering through the standard compose path
  (multi-packet wall etc. already enforced there).
- Active-window state feeds the output policy via the new WM accessors (§C6.2).

---

## C9. Config additions (`config.ts` — remember the section-merge list gotcha)

```jsonc
"tts":      { "engine": "kokoro", "voice": "af_heart", "speed": 1.0,
              "modelPath": "/home/user/aria/tts_models/kokoro" },
"audioOut": { "speakMode": "auto",              // auto | always | never
              "duckDb": -12, "chimes": true, "allowSpeaker": false,
              "notify": { "call": "speak", "timer": "speak",
                          "sms": "chime+name", "email": "silent", "info": "silent" } },
"music":    { "libraryDirs": ["/mnt/slug/Music"], "format": "opus",
              "cacheDir": "~/.g2cc/media-cache" },
"companion":{ "dir": "/home/user/g2cc-companion", "model": "opus", "effort": "max",
              "confirm": "voice" }
```

Validators follow the house pattern: log loudly, fall back to defaults, never throw. Voice
note: `af_heart` is ARIA's voice — consider giving the Companion a **distinct** voice from
the 50-voice pack so the two assistants are tellable apart by ear.

---

## C10. Deploy discipline (unchanged, restated)

Server ships first; all wire changes additive-optional and **caps-gated**; smoke gate stays
34/35 + new phases; Android unit baseline 189 + new tests; versionCode bump per install;
pinned keystore; no pushes without Adam's word. Audio tests NEVER push sound to the phone —
mock the WS sink or write WAVs to disk (standing rule).

---

## C11. Phases

**P0 — Bench & facts** (earbud + phone + glasses in hand; ControlActivity bench screen).
The §C3 matrix. *Gate:* Topology Decision Record written; T1 confirmed or fallback chosen.

**P1 — Speech lane.** `tts_daemon.py` + `TtsDaemon` + `EarbudAudioService.speak()` + wire
msgs + caps + phone speech lane + chimes + route guard + third-party duck + timer/notify
hookup. APK v1.20. *Accept:* timer → chime+speech in ear over ducked Spotify, restored
after; zero speaker leak with earbud absent (unverified ack + glasses text fallback);
first-audio < ~1.5 s from `speak()`.

**P2 — Companion + voice loop.** Companion dir/persona + MCP server + tools + EarbudWindow +
WM accessors + output policy + spoken/tap confirm + barge-in + earbud button map + handsfree
transport verbs. *Accept:* eyes-free round trip on the floor: double-tap → chime → speak →
tap-to-send → answer spoken; same exchange with EarbudWindow active renders silently on
glass; Tmux dictation flow byte-identical to today.

**P3 — Music.** `music.ts` index + range/transcode endpoint + ExoPlayer lane + queue/state +
window Music UI + Companion play tools. *Accept:* "butterscotch, play Pink Floyd" → mono
audio in ear; ring volume; dictation pauses+resumes cleanly; battery drain over a full shift
measured and recorded.

**P4 — Earbud-mic shootout + polish.** Capture-tee real shift captures with `earbud-bt`
source → WER vs DJI baseline, canary × {raw, adaptive} pairings (the pairing rule). Decide
mic roles. Notification policy full build-out + "what did I miss" + work/home profiles +
panic-tap soak. *Accept:* decision recorded with data; DJI remains default unless earbud
WER is within Adam's tolerance.

**P5 — Long-form + delight.** Reader read-aloud (position-persistent, resumable), podcast /
`fetch_audio(url)`, memo speak-backs, lyrics-on-glass while playing. *Accept:* a chapter of
the current book read to the ear, resumable next shift.

---

## C12. Risks

| Risk | Standing |
|---|---|
| **BT radio triangle** (BLE + A2DP + SCO) congestion, body-block amplified | The core bet; P0/P3 soaks measure it. Watchdog already defers recovery during dictation — extend the same courtesy to A2DP glitches. Worst case: T3 (USB mic) or, long-term, the hat bridge. |
| A2DP suspend/resume gap around dictation feels bad | Bench in P0; chimes mask the seam; policy is pause-not-duck for capture anyway. |
| Earbud mic WER worse than DJI (ear position, HFP codec) | Expected; that's why T1 is default and P4 is data-gated. |
| Echo on single-earbud full-duplex (AEC off by design) | Half-duplex rule is absolute; continuous handsfree listening while music plays is explicitly unsupported on T2. |
| Battery (A2DP + WS + BLE all shift) | Opus 96k mono keeps radio duty low; P3 measures; FGS/wake-lock already sized for all-day. |
| Kokoro long-text edge cases | ARIA's split/truncation fixes ported; sentence-streamed so failures are per-sentence, loud, and skippable. |
| Config-section merge omission silently dropping user overrides | Known gotcha; called out in §C9. |
| New protocol types vs old APKs | Caps-gating in §C5; server never emits ungated. |

---

## C13. Open questions for Adam (batched)

1. **Which earbud?** Model in hand (or to buy)? LE Audio support and its button gesture set
   drive P0 and the T2 branch.
2. **Music source at work:** server library only, or also third-party apps (Spotify etc.)
   under duck/pause control? Both are supported — this only sets P3 priorities.
3. **Mic prior:** happy keeping the DJI collar mic as primary (my recommendation) with the
   earbud mic evaluated on data in P4 — or is dropping the collar mic a goal worth chasing
   earlier?
4. **Companion voice:** distinct from ARIA's `af_heart`? (Samples on demand once the daemon
   stands.)
5. **Confirm mode default** for audio-only sends: spoken echo + tap-to-send (`voice`), or
   trust-the-transcript (`off`) at ~95% accuracy?
6. **Naming:** window/session called `Earbud`/`Companion` here — better name welcome.
