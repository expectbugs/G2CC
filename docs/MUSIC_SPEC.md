# Music App — Full Spec (Part D)

**Status: Phase A COMPLETE + gate PASSED 2026-08-05** (knowledge base built, then
remediated after the fabrication incident — see §D14 amendments; reports + the 362-row
diff in `audio/enrich/reports/`). **Phase B is the standing mandate** (HANDOFF §1).
Designed 2026-08-04 with Adam, Q&A-approved. This replaces the earbud lane's music slice
with a standalone, Spotify-shaped music app. `docs/EARBUD_SPEC.md` remains the record of
the rejected lane (its post-mortem is required reading); this document is the build
contract for what replaces it. Companion to `g2_custom_app_spec.md` Parts A/B; if this
conflicts with the Three Absolute Rules or the wire discipline there, those win.

## D0. Mission + scope boundary

A Spotify-like music player for Adam's one work earbud (Pixel Buds 2a), streaming his own
library from the PC: deeply-catalogued music knowledge base → fuzzy-request playlists
("play some hard metal stuff", "something piano and deep"), native bud-tap transport,
brief non-interfering status popups on glass, and explicit-request YouTube grabs via
yt-dlp.

**Out of scope (Adam, this session): everything dictation/TTS/voice-assistant.** Dictation
stays exactly the pre-earbud ring-driven flow (mic = buds over SCO, `stt.micSource`
untouched). TTS, spoken notifications, the wake word, and the Companion get revisited in
their own future session. The physics that killed the old design (SCO listening and A2DP
music are mutually exclusive on classic BT) is *accepted, not fought*: this app has NO
voice-during-music. You interact with the app (glasses ring, taps, PC/phone typing) when
you want different music — exactly Spotify's model.

## D1. Decision record (Adam, 2026-08-04 redesign session)

- **DB:** Postgres `g2cc` for structured metadata; a new **`g2cc_music` collection** on
  the existing Qdrant instance (:6333 — aria's instance; new collection = clean isolation)
  for embeddings.
- **LLM:** **Opus at low effort** for BOTH the enrichment batch and per-request playlist
  parsing ("Haiku sucks"). One-shot `claude --print` (the speak-digest.ts execFile
  pattern: `--tools ''`, env-scrubbed, deterministic fallback on any failure).
- **Enrichment sources: all of them** — full ffprobe tags, MusicBrainz, LRCLIB lyrics,
  librosa audio features, the Opus profile pass, local embeddings; **Last.fm + AcoustID
  as backfill passes once Adam creates the free API keys** (his task; nothing else blocks).
- **No favorites.** **Playlists yes** — manual curation (save queue as playlist, add
  current track, remove/reorder, rename/delete) AND LLM-built on the fly, nameable/kept.
- **Radio/autoplay mode: in** (queue runs low → append nearest-neighbors).
- **Karaoke lyrics level: in** (the existing synced-LRC machinery; renders only when open).
- **Popups:** track changes and the like take over the **ribbon strip at root**, a **brief
  one-line intrusion inside an active window**, and the blanked-screen flash — all
  temporary (~4-5 s auto-revert, the `BLANK_POPUP_MS` display-pacing precedent).
- **Bud taps go native (Spotify-identical):** single = play/pause, double = next, triple
  = previous. Hold is consumed on-device by the buds (ANC/assistant) and never reaches us.
- **yt-dlp:** explicit-request only (NEVER a silent fallback on a library miss); search →
  top-5 pick on glass → **audio-only extraction (video stripped — Adam)** into a
  permanent `YouTube/` library subdir; indexed + enriched like any track.
- **Confirmed suggestions:** pre-transcode the whole library in the research batch;
  gapless-ish playback (pre-staged next track + bigger ExoPlayer buffer — the one
  APK-carrying item); play history + skip tracking (required by radio anyway).
- **Interaction model:** fuzzy requests via normal ring-dictation in the Music window
  (music pauses during dictation by physics, new queue starts after) + typed input from
  the PC/phone surfaces.
- **Old-lane disposal (confirmed):** remove EarbudWindow, the ears supervisor, spoken
  notifications, and the media_button remapping NOW, with this build. The TTS daemon
  pair, speak-digest, companion-mcp, and `~/g2cc-companion` stay **dormant on disk** for
  the future TTS session.

## D2. Removal map (Phase B) — what dies, what sleeps, what survives

**Dies (unwired + deleted):**
- `windows/earbud.ts` (EarbudWindow) + its registry row (MusicWindow takes the Media slot).
- The ears supervisor (`earbud.ts` syncEars/earsRequested/handsfreeLive + the
  `audioOut.earsOn` config key) — the server never again sends
  `audio_request(mode:'handsfree')` on its own. (voice.ts's grammar stays for the future
  revisit; it simply has no always-on feed.)
- Spoken notifications (the notifyHub subscription + `audioOut.notify` policy map).
  Visual notices unchanged.
- The media_button remapping (quiet-speech / Companion-PTT / triple=next) → native
  transport mapping (D6).
- `EarbudAudioService` itself — replaced by the lean `MusicPlayerService` (D5). The
  speech queue / ack windows / half-duplex speech machinery goes with it (speech itself
  is shelved; the WIRE stays — see "survives").
- `os-session.voiceTarget` + `onSttFor`/`onSttErrorFor` earbud routing, the voice.ts
  earbud/companion/whats_playing/quiet grammar rows, `estimateSttConfidence`'s
  confirm-gate consumers (the function may stay — harmless, tested).

**Sleeps (on disk, unwired, untouched — the future TTS session's inventory):**
- `tts.ts` + `audio/pipeline/tts_daemon.py` (+ boot warm call removed), `speak-digest.ts`,
  `companion-mcp.ts` + `~/.g2cc/companion-mcp.json` + `~/g2cc-companion/`,
  `config.companion` + `config.tts` + the rest of `config.audioOut` (keys stay valid so
  configs don't churn twice; validators keep validating them).
- Phone-side: SpeechPlayer, chimes/SoundPool, the `audio-out` cap handling. The server
  just stops sending that family. No APK change required for removal.

**Survives (reused as-is or extended):**
- `music.ts` — index/search/transcode/stream (extended in D3).
- The wire contract: `media_open`/`media_ctl`/`media_event`/`input{media_button}` +
  caps gating (`media-lane`, `earbud-buttons`). Unknown-FIELD additions to existing
  messages are old-APK-safe (`ignoreUnknownKeys` confirmed at WsProtocol.kt:21); new
  message TYPES or behavior families still get new caps.
- Phone-side: ExoPlayer lane, BT-only route guard, becoming-noisy pause, owned
  MediaSession, honest media_events. Zero required app changes for v1.
- `lyrics.ts` (LRCLIB + permanent cache) — batch-driven in D3, karaoke level in D6.
- `MAX_CONCURRENT_SESSIONS` stays 6 (harmless; the Companion may return).

## D3. The music knowledge base (the research phase)

### D3.1 Schema (Postgres `g2cc`, store.ts migrations)

- `tracks` — unchanged (file truth: path/title/artist/album/dur_ms/mtime).
- `track_meta` (1:1 on track_id, ON DELETE CASCADE):
  `genres text[]`, `styles text[]`, `moods text[]`, `energy int` (1-10), `bpm real`,
  `year int`, `vocals text` ('male'|'female'|'mixed'|'instrumental'|'harsh'|'clean'…),
  `language text`, `themes text[]`, `description text` (the one-paragraph profile),
  `dupe_cluster int` (null = unique), `sources jsonb` (per-source raw + provenance),
  `pass_status jsonb` (per-pass done/failed/skipped + timestamps — the resumability
  spine), `updated_at`.
- `play_history`: `track_id, started_at, ended_at, completed bool, skipped bool,
  source text` (tap/voice/radio/playlist/…). A skip = a next/prev/stop/new-queue before
  ~80% position; completion = 'ended' media_event.
- `playlists`: `id, name, origin 'manual'|'llm', request text (the fuzzy ask that built
  it, when llm), created_at, updated_at` + `playlist_tracks (playlist_id, position,
  track_id)`.
- `player_state` (singleton row): queue (track ids jsonb), idx, pos_ms, radio bool,
  updated_at — written debounced on state changes; feeds boot-time Resume.
- Qdrant `g2cc_music`: one point per track, vector from the pinned local embedding
  model, payload `{track_id}`. Collection created with the model's dim; model name +
  dim recorded in config — an embedding-model change = re-embed the collection.

### D3.2 Enrichment pipeline (`audio/enrich/` — Python, the audio venv)

A resumable batch runner (`run_enrichment.py`) with per-pass subcommands; every pass
records per-track `pass_status` and re-runs incrementally (new tracks from yt-dlp get
the same passes on ingest). Library facts verified 2026-08-04: 23 GB, 1,193 indexed
tracks, heavy VGM/remix (OCRemix tributes, SotN, Doom) + Powerglove + Pink Floyd +
Queen + Rob Zombie + Immortal Technique + Jim Croce + Muse — remix-album coverage in
MusicBrainz/Last.fm will be thin; file tags + album context + the Opus pass carry those.

Passes, in order:
1. **tags** — full ffprobe re-probe capturing what the indexer discards today (genre,
   date/year, track#, disc, composer, albumartist, comment) → `sources.tags`.
2. **musicbrainz** — recording lookup by artist+title(+duration), ~1 req/s (their rate
   rule) with a proper identifying User-Agent; genres/tags/year where known. One
   ~25-min pass; misses are recorded, not retried in a loop.
3. **lyrics** — batch-drive the existing lyrics.ts LRCLIB fetch+cache for every track
   (respect the 8 s cap + low concurrency; positive AND negative results cached
   forever). Instrumental (no-lyrics) is itself signal for `vocals`.
4. **audio** — librosa (ALREADY in the venv, 0.11): BPM (beat_track), RMS-energy
   stats, spectral centroid/rolloff → `bpm` + inputs to `energy`. Decode via ffmpeg to
   temp mono WAV; a failed decode logs + skips (never kills the batch).
5. **profile** — the Opus low-effort pass, ~15 tracks/prompt (~80 prompts): everything
   gathered above in, strict-JSON profile out (genres/styles/moods/energy/vocals/
   language/themes/description). JSON parse failure → one retry → per-track 'failed'
   status, LOUD, batch continues. Env-scrubbed subprocess (the HANDOFF §5 scrub list);
   flags re-verified against `claude --help` at build (house rule).
6. **embed** — pinned small local sentence-embedding model via the venv (transformers
   already present; model chosen + pinned at build after a real download/dim check).
   Text = title/artist/album + tags/moods + description + themes + a lyric summary →
   Qdrant upsert.
7. **dedupe** — (normalized artist, normalized title, duration ±2 s) clustering →
   `dupe_cluster` (Powerglove ×3, overlapping Queen/IT rips are real). AcoustID
   fingerprint pass upgrades this when the key exists.
8. **pretranscode** — build the opus-mono-loudnorm cache for the ENTIRE library
   (~23 GB → ~1.5 GB) so every first play is instant forever. Reuses music.ts's exact
   ffmpeg invocation + cache keying (id+mtime+path-hash).
9. **videosweep** — audio-extract any stray video containers found in library roots
   (.webm/.mp4 — the un-indexed `Knights of Cydonia.webm` case) to sibling audio files,
   then index them. Originals untouched.
10. **backfill-lastfm / backfill-acoustid** — when Adam supplies the free keys: Last.fm
   crowd tags (mood/style vocabulary gold) merged into moods/styles; AcoustID
   (chromaprint `fpcalc`) identification for mistagged files + dupe-cluster hardening.
   Re-run profile+embed for tracks whose inputs materially changed.

New venv deps: `psycopg[binary]` (Postgres access), the embedding model, `pyacoustid`+
`chromaprint` (backfill only). Confirm sizes/compat before install (house rule — the
NeMo numpy pin precedent). Qdrant via plain HTTP (no client lib).

**Gate:** a coverage report (per-source hit rates, field fill rates) + a random-sample
profile listing for Adam to eyeball. No app work starts on a knowledge base he hasn't
seen.

## D4. Fuzzy request → queue (the resolver)

Layered, fastest-first; every layer logs which lane answered:

1. **Structured:** token match against artist/album/title + the new genre/mood/style
   vocabulary. Exact-artist/album/playlist-name asks and plain genre words resolve here
   instantly, no LLM.
2. **Opus parse (low effort, one-shot):** the request + the library's actual tag
   vocabulary + order modes in; strict JSON out: `{genres?, styles?, moods?, energy?,
   bpm?, vocals?, artists?, exclude?, order: 'shuffle'|'least_recent'|'newest', size}`
   → SQL over track_meta. Deterministic fallback (lane 1 result, or lane 3) on any
   failure — a dead LLM must never mean dead music.
3. **Embedding:** request text embedded → Qdrant top-K (~50) cosine → blend: filter
   results primary, embedding fills to target size, ranked.

Post-processing always: dupe_cluster dedupe (one member per cluster, prefer the
higher-fidelity file), mild artist-spread shuffle (unless an explicit order mode),
default size ~25. `least_recent` order + skip-weighting read play_history ("something I
haven't heard in a while"). Empty result = honest on-glass message, nothing plays,
nothing falls back to YouTube (D7 is explicit-only).

Requests arrive from: the Music window's Ask row (ring-dictation — music pauses during
capture by physics, the new queue starts after), typed text from the PC page / phone
control surface, and playlist rows. Results **play immediately** (low stakes, fully
reversible — the next ask replaces the queue) with a popup announcing what started.

## D5. `MusicPlayerService` (server/src/music-player.ts)

The lean replacement for EarbudAudioService — a boot-time session-lifetime singleton
(same injected-deps pattern; no os-session/ws-handler imports):

- **State:** queue (track ids + display meta), idx, MusicState
  ('idle'|'opening'|'playing'|'paused'), posMs/posAt extrapolation, volumePct,
  pausedBy ('user'|'capture'), radio flag. All mirrored to `player_state` (debounced).
- **Transport:** playQueue/pause/resume/toggle/skip(±1)/stop/setVolume/seek — the
  existing media_ctl vocabulary, caps-gated via the ported `sendCapped()` door.
- **Capture gate (kept):** `onCaptureState(live)` — dictation start pauses
  (`pausedBy:'capture'`), end resumes. This is the ONLY audio-lane coupling to
  dictation that remains, and it's physics.
- **History:** media_event transitions write play_history (started/ended/skipped per
  D3.1's definitions).
- **Radio:** when radio is on and unplayed-queue-remainder ≤ 2, append ~10
  nearest-neighbors of the last few played tracks (Qdrant), excluding recent history +
  dupe clusters + already-queued. Loud log per append; radio toggles from the window
  menu and persists in player_state.
- **Resume:** on boot with a persisted queue and nothing playing, MusicWindow's Now
  Playing level shows a `Resume: <track> (m:ss)` row. NEVER auto-plays on boot
  (surprise audio in the ear = policy violation).
- **WS-blip behavior (kept from deep-review #14):** phone WS loss does NOT zero the
  music model — ExoPlayer streams over its own HTTP; state re-anchors on the next
  media_event.
- **Popup events emitted (→ D6.3):** track change, queue/playlist start ("▶ 25: hard
  metal"), queue end, paused-by-capture NOT popped (he caused it), pause-on-route-loss
  ("⏸ buds disconnected"), radio append (silent — log only).

### D5.1 Gapless + resilience (the one APK-carrying slice — v1.22, cap `media-prestage`)

Today each track boundary is a WS round-trip (audible seam; a blip at the boundary =
silence). v1.22 adds:
- `media_open` gains optional `next: {id, url, title, artist?, album?, durMs?}` —
  additive field, old-APK-safe. The app loads it as ExoPlayer item 2 (rolling 2-item
  playlist). On auto-transition the app emits `media_event {id: <next.id>,
  state: 'playing', reason: 'auto_advanced'}` (existing message, new reason string);
  the server advances idx WITHOUT re-opening, then sends the following `next` via a
  new `media_ctl {cmd:'preload', ...}` or a re-open — exact shape finalized at build,
  additive either way.
- ExoPlayer buffer raised to minutes-class (custom LoadControl) — Tailscale-at-work
  hiccup insurance.
- The server only sends `next`/preload to a phone announcing cap `media-prestage`.
  v1.20/v1.21 keep working seam-ful without it (server-only v1 ships first and stays
  the compatibility floor).

## D6. Glasses UI

### D6.1 `windows/music.ts` — MusicWindow

Registry: Media category, replacing EarbudWindow's slot (`windows/media.ts` — the
third-party phone-media window — is untouched). Levels:

- **Now Playing** (default): track/artist/album line, m:ss / m:ss position (extrapolated),
  queue pos, radio state. **Ring scroll = volume** (the Buds 2a have no volume gesture;
  this is where it lives). Tap = menu (Pause/Resume · Next · Prev · Seek · Radio on/off ·
  Save queue as playlist · Add current → playlist … · Lyrics · Ask · Browse · Queue).
  A `Resume: …` row appears per D5 when applicable.
- **Ask**: dictate/type a fuzzy request → resolver → plays. Shows the honest
  which-lane-answered line + result count before/while starting.
- **Browse**: Playlists · Artists · Albums · **Moods/Genres** (the new tags as browse
  facets) · Search (dictated/typed token search) · YouTube (D7). Standard browse
  pagination (`_browse.ts`), tap = play-from-here / open.
- **Queue**: current queue rows (▶ marker on idx), tap = jump-to-track; menu: remove
  row, move up/down (curation), clear, save-as-playlist.
- **Playlists**: list → open (rows) → play · rename (dictate) · delete (Cancel-first
  confirm, the reader-jump pattern) · reorder/remove rows. LLM-built playlists keep
  their originating request string as provenance.
- **Lyrics**: the karaoke level — synced-LRC current-line via the existing lyrics.ts +
  Media-window machinery, only rendered while open. Plain-text fallback pages.
- `preview()` (ribbon hover, in-memory only): `♪ <title> — <artist> m:ss · q 3/25` or
  `♪ idle`.

### D6.2 Bud-tap mapping (ws-handler, native semantics)

`media_button`: `play_pause`/`play`/`pause` → toggle · `next` → skip(+1) · `prev` →
skip(−1) · `stop` → stop. Stays un-serialized (audio reflex, not display nav). All
Companion-PTT/quiet-speech branches removed.

### D6.3 Popups (transient chrome — the "don't interfere" contract)

One WM-level transient channel (`musicPopup(line)`), auto-reverting after
`config.music.popupMs` (default ~4500 ms; 0 = off) — sanctioned display pacing
(BLANK_POPUP_MS precedent). Rendering by surface state:
- **Ribbon root:** the strip's text region swaps to the popup line (antenna/capture
  geometry UNCHANGED — scroll keeps working, we only change strip text), then reverts.
  ×0.85 fit margin applies (the fwTextWidth undershoot).
- **Inside an active window:** a one-line top intrusion composited over the view for
  the duration, then a normal re-render restores it. Pure visual: no focus change, no
  capture-region change, conflated with the render pump (a mid-popup content render
  re-applies the popup line rather than fighting it).
- **Blanked:** the existing one-line flash path, then back to dark.
- Popup renders are text-only (multi-packet wall irrelevant) and rare (track cadence).

## D7. YouTube grabs (yt-dlp — verified 2026.06.09 at ~/.local/bin/yt-dlp)

Explicit-only flow, its own Browse row: dictate/type a query → `yt-dlp ytsearch5:` →
top 5 on glass as `title · channel · duration` → pick → download **audio-only**
(`-f bestaudio -x`, opus target, video stripped — Adam's rule) into
`<libraryRoot>/YouTube/` → ffprobe-index → enrichment passes on ingest (tags→profile→
embed; MB/lyrics best-effort) → queued (append or play-now per the invoking menu row).
Progress popup on completion ("✔ grabbed: <title>"); failures render loudly in-window.
No downloads EVER triggered by a failed library search. Network resource cap on the
subprocess (the lyrics.ts sanctioned class — a wedged download must not hang the
window; generous, minutes-class). Flags re-verified against `yt-dlp --help` at build.

## D8. Config additions (`config.ts` — mind the section-merge gotcha)

```jsonc
"music": {
  "libraryDirs": ["/mnt/slug/Music"],      // existing
  "format": "opus", "cacheDir": "~/.g2cc/media-cache",   // existing
  "youtubeDir": "YouTube",                 // subdir of libraryDirs[0]
  "popupMs": 4500,                          // 0 = no popups
  "radioBatch": 10, "queueSize": 25,
  "resolver": { "llm": true, "model": "opus", "effort": "low" },
  "embedModel": "<pinned-at-build>"
}
```
`audioOut.earsOn` + `audioOut.notify` are REMOVED (validators drop them with a loud
one-time note); the rest of `audioOut`/`tts`/`companion` stays dormant-valid (D2).

## D9. Phases + gates

- **Phase A — knowledge base.** D3 schema + enrichment passes 1-9 run to completion.
  *Gate:* coverage report + random-sample profiles reviewed by Adam.
- **Phase B — removal + player core.** D2 removal map; MusicPlayerService; native tap
  mapping; history; resume persistence; popup channel; `phase-earbud.mjs` →
  `phase-music.mjs` (index/meta/resolver-deterministic/player-vs-fake-phone/transcode/
  popup-compose/removal asserts). Server-only. *Gate:* smokes green (35/36-equivalent),
  on-glass: taps drive transport natively, track-change popup at ribbon root + in-window.
- **Phase C — window + resolver + radio.** Full MusicWindow, resolver lanes 1-3,
  playlists CRUD, radio, karaoke level. *Gate:* on-glass "play some hard metal stuff"
  end-to-end; save/reopen a playlist; radio extends a dying queue.
- **Phase D — YouTube.** D7 flow. *Gate:* on-glass named-song grab → audio-only file in
  YouTube/ → playing; enrichment ran on it.
- **Phase E — v1.22 gapless APK + backfills.** D5.1 (cap `media-prestage`, buffer),
  Last.fm/AcoustID passes when keys arrive, tuning from field use. *Gate:* an audible
  A/B at a track boundary; a mid-track server restart that the ear never notices.

Deploy discipline unchanged: server ships first; additive-optional wire; caps for new
behavior; smoke gate + Android baseline (389 until v1.22 touches it); versionCode bump
per install; pinned keystore; no pushes without Adam's word; audio tests never push
sound to the phone.

## D10. Risks

| Risk | Standing |
|---|---|
| Enrichment quality on VGM/remix albums (thin MB/Last.fm coverage) | Expected; file tags + album context + Opus knowledge carry it; the Phase A gate is Adam eyeballing real samples before anything builds on it. |
| Opus one-shot latency/availability on fuzzy asks | Low-effort one-shot is seconds-class; lanes 1/3 are instant and always-on fallback — dead LLM ≠ dead music. |
| Embedding model choice underwhelms on music vocabulary | Pinned + swappable (config), collection re-embeds in minutes at this scale. |
| Track-boundary seam until v1.22 | Accepted for v1 (matches today's field-tested behavior); Phase E closes it. |
| A2DP + BLE coexistence over a full shift (body block) | Unchanged from the field-tested lane — music-on-glass already verified 2026-08-04; keep observing. |
| yt-dlp result quality (wrong version/live cut) | Human-in-the-loop top-5 pick, never auto-first-result. |
| MB/LRCLIB rate etiquette | 1 req/s + identifying UA (MB); low concurrency + permanent negative cache (LRCLIB). |
| psycopg/embedding deps into the NeMo venv | Verify install compat before pulling (the numpy-pin precedent); both are small pure-client libs. |

## D11. Adam's outstanding items

1. ~~Last.fm API key~~ — **assessed redundant 2026-08-05** (the Opus profiles cover its
   tag vocabulary; VGM coverage poor; embedding radio replaces similar-artists). Skip
   unless Adam overrides.
2. **AcoustID API key** (free) — unblocks fingerprint identification of the ~200+
   honest-unknown tracks (would have named the Bastion trilogy instantly) + dedupe
   hardening.
3. ~~The go to start Phase A~~ — given 2026-08-04; Phase A complete.

## D14. Phase A as-built amendments (2026-08-05 — the fabrication incident)

Adam caught invented identities on artistless asset-dump files (full story: CHANGELOG
2026-08-04/05). Standing changes to D3.2, all live in `audio/enrich/`:

- **MB pass:** a file with NO artist tag gets NO search — title-only Lucene matching
  scored bare names ('1h', 'flock') at 100 against unrelated recordings. Honest
  `found:false 'unidentifiable'` instead.
- **New `speech` pass** (not in `all` — scope with `--artistless`/`--ids`/`--track-id`):
  60 s excerpt → parakeet-tdt-0.6b-v2 on CPU (~0.2 s/track; GPU belongs to the live
  server) → `sources.speech {detected, chars, sample}`. ≥30 chars of transcript =
  vocals/speech present. Run it on every future ingest (yt-dlp included).
- **Profile prompt EVIDENCE HIERARCHY (hard rules):** `speechDetected` is authoritative
  for `vocals`; measured features outrank claimed identity (energy judged
  loudness-normalized — quiet masters are not low-energy); uncorroborated identity =
  absent; "unknown origin" + genre `unknown` are CORRECT answers.
- **Copy donors require profile-status ok** — a status-cleared track still carrying its
  old description must never donate it (122 stale copies bit live). Batch dossiers
  snapshot at stage START — land corrections before the stage runs.
- **Curated ground truth** (`sources.profile.curated`) is human-verified and must never
  be LLM-re-rolled (a re-roll regressed CLASS.wav from correct-classical to "hip hop"):
  the Bastion trilogy (in-file tags written, both copies), CLASS.wav ×2, flock.ogg,
  315.ogg.
- **Both indexers read Ogg STREAM tags** (vorbiscomments are per-stream; format-only
  probing indexed tagged .ogg as artistless).
- **Audio pass seek fallback:** broken container duration + mid-file `-ss` = empty decode
  with rc=0; retry-from-0 before declaring failure. Decode-verify before ANY
  corrupt-file deletion (saved Astronomy Domine + Headlong).
- **Library as-built:** 2,672 tracks / 4 roots (3 corrupt rips removed on Adam's word,
  tarball at `~/.g2cc/`); resolver must exclude genre `sound effects` from playlists and
  `spoken word` from shuffle (both are REAL content, not junk).
