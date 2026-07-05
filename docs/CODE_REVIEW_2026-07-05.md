# Whole-Project Code Review — 2026-07-05

**Scope:** the ENTIRE project (server TS, windows, shared wire contract, Python helpers, smoke
suite, dormant audio pipeline, live Android client). **Method:** 18 disjoint-slice finder agents
(Fable 5, max effort) working from a shared brief encoding the architecture, hardware truths, the
Three Absolute Rules' sanctioned exceptions, frozen layers, and every known don't-re-chase item —
then ONE adversarial verifier per finding (also Fable 5 max, default posture REFUTE: re-read the
cited code ±120 lines, verify the quote exists, trace reachability, check sanctioned lists, judge
the proposed fix against menu-parity/frozen layers). Fixes were then applied in smoke-gated batches
and the complete diff re-reviewed by a fresh 3-lens adversarial pass (server logic / project
invariants / periphery+Kotlin).

**Raw numbers:** 72 findings filed → 65 CONFIRMED & FIXED · 1 confirmed-then-refuted (kept as
hardening) · 6 REFUTED (5 by verifiers, 1 by direct empirical test during fixing). 96 improvement
proposals collected (curated list at the end — NOT implemented; Adam's call).

**Verification:** server smoke 27/28 after every batch (phase10-calendar = the known OAuth env
red) — and the suite now runs in ~33 s (was ~100 s; seven phases leaked the pg pool). Android:
228/228 unit tests green, **APK v1.16 built + staged** at `~/.g2cc/g2cc-harness.apk`.
`read_epub.py` changes verified byte-identical (chapters + pages) against all 45 real books in
`~/books` — resume positions and pagemaps unaffected. Menu-mode (`rootNav:'menu'`) byte-parity
preserved: every WM/render change is ribbon-gated or value-identical in menu mode.

**The fix diff itself was then adversarially re-reviewed** (3 Fable-max lenses: server logic /
project invariants / periphery+Kotlin). The INVARIANTS lens returned ZERO findings — menu-mode
byte-parity, the Three Rules, frozen layers, and the byte-wall all held across the whole diff.
The other lenses caught 4 LOW refinements to the new code, all accepted + fixed: (1) the
watchdog's stale-resume clear was re-primed by the adopt block for ever-init'd sessions (adopt now
skipped when the stale branch fires); (2) the Android closed-latch needed disconnect() to hold
connect()'s monitor or a microsecond straggler window remained (@Synchronized added); (3) a stale
art-encode failure could clobber a newer track's committed art key (reset now conditional on
still owning the key); (4) the new scene_to_png 'ant' check had the wrong polarity — the client
REWRITES that region, it doesn't reject it (demoted to a warning). One additional gap was caught
by direct empirical testing during fixing: the spelled-out "could not be delivered" matched no
delivery rule once the bad catch-all was removed (the `n'?t` forms only match contractions) —
rule 1 now carries `\bnot be delivered\b`; a 13-case status matrix passes.

---

## Two findings worth telling the story of

- **`server/src/games.ts:32` — REFUTED BY EMPIRICAL TEST (evidence artifact).** Finder and
  verifier both "confirmed" the ANSI-strip regex was missing its `\x1b` prefix and mangling
  rpg-cli's `[xxxx]` bars. `od -c` shows the prefix was ALWAYS there — as a literal 0x1b byte,
  invisible in the text views both agents (and the file-read tooling) used; both tested a
  reconstruction of the regex, not the regex. The real regex passes bars and strips real ANSI
  (node-verified). Fix applied: the literal ESC byte is now the escaped, greppable `\x1b` form —
  behavior-identical, and the next reader/tool can't be fooled. *Lesson: verbatim-quote
  verification fails on invisible bytes; test the artifact, not the quotation.*
- **`server/src/ws-handler.ts:662` — CONFIRMED in pass 1, REFUTED in pass 2; guard KEPT.** A
  duplicate `audio_end` mid-transcription routes through `sttError()`, unwinding the live
  'transcribing…' state so the real transcript gets discarded. Both verifiers agree the unwind
  mechanism is real; they disagree on reachability (the v1.13+ client's synchronized stop path
  can't emit the duplicate; an older sideloaded APK demonstrably could). The server-side guard
  (log-only when `sttInFlightCount > 0`) changes nothing for legitimate inputs and makes the
  guard's own "ignoring" comment true — kept as defense-in-depth.

## HIGH-severity fixes (the ones that mattered most)

1. **Blackjack save wipe on every idle disconnect** (`windows/games.ts:624`) — the WM is rebuilt
   per WS connection and `dispose()` persisted unconditionally, so ANY connection where Blackjack
   was never opened upserted the constructor-fresh $1000 game over the real save. persist() is now
   gated on a successful load (`loadOk`, the paperclips C-F1 pattern); a failed load disables
   persisting (loud) and re-enter retries; a save landing after a fast Deal keeps the live hand.
2. **Stale `--resume` id crash loop** (`session-pool.ts:185` + `cc-session.ts` + `watchdog.ts`) —
   CC prunes ~30-day-old sessions; a stale sessions.json id died instantly at spawn (before
   system/init), the watchdog respawned with the SAME id ×5, and every directory re-pick re-read
   the same stale id: a permanent loop whose on-glass recovery hints re-triggered it. Now: CC's
   "No conversation found" errors[] sets a staleResume flag (plus the died-before-init heuristic);
   watchdog + pool clear the resume target and go FRESH, loudly; the next healthy session
   overwrites sessions.json. Also fixed: the error card now shows CC's real `errors[]` text
   instead of a bare "CC error_during_execution".
3. **Trash purge data loss** (`trash.ts:48` + `windows/files.ts` doTransfer) — a file MOVED into
   the Trash location kept its old mtime (rename preserves it), so anything >30 days old was
   rm -rf'd within a day while the UI promised "restorable for 30 days". Move-into-Trash now
   routes through `moveToTrash` (canonical `<ms>-` stamp); the purge fallback uses
   max(mtime, ctime) (rename updates ctime); digit-prefixed names only count as deposit stamps in
   a plausible epoch-ms range ('2024-report.pdf' no longer parses as epoch 2024); purge readdir
   failures are loud (was: silent purge death).
4. **SMS Back-after-send showed the thread WITHOUT the sent message** (`windows/sms.ts:334`) —
   'Back' is WM-reserved, so the re-pull branch in the reply menu was dead code; Back rendered
   pre-send pages ("did it send?" → duplicate-send risk). onBack now re-pulls the thread from the
   result card. Send status is also honest now: "Handed to phone (unverified)" — the wire has no
   send-result message (full result flow queued as an improvement; the old "SmsManager has no
   per-message ACK" comment was factually wrong).
5. **Deliveries inverted statuses** (`deliveries.ts:64`) — the bare `\bdelivered\b` catch-all
   marked "will be delivered tomorrow" and "was not delivered" as delivered=true. Rules now:
   negated forms → delayed; future/scheduled forms → arriving soon (new rule BEFORE delivered);
   delivered keeps anchored past-tense forms + subject-leading "Delivered".
6. **Reader cross-book state pollution** (`windows/reader.ts:239`) — opening a never-read book B
   after reading book A kept A's chapter/page/pages in memory: history pushes, 'Bookmark Last',
   and the ribbon preview recorded B at A's coordinates (durable DB pollution). openBook now
   resets per-book state before the parse; error paths keep in-book coordinates.
7. **Media album art lost/stuck** (`windows/media.ts:219` + client `MediaBridge.kt`) — the phone
   pushes art ONCE per track; any transport push (artB64=null) wholesale-replaced server state, so
   the Art page claimed "No album art" after a Play/Pause, or spun forever on a track change while
   the Art view was up. Server carries art forward within a track + re-kicks the render on the
   late art push; client-side, `lastArtKey` commits only once a bitmap is actually in hand and a
   failed encode resets it (late-loading art used to be skipped for the whole track), and repeat
   subscribe() no longer stacks leaked session listeners.
8. **Stale-lastView tap window at ribbon transition** (`window-manager.ts:910`, medium-rounding-
   high) — parking to the ribbon nulled lastView only AFTER the async preview fetch; a tap in that
   window drove the PARKED window ('Ask' → hot mic under the ribbon, no indicator, no stop path —
   switchTo skips onDeactivate for parked windows). lastView now nulls synchronously in toRibbon()
   plus an at-ribbon hub_select guard (the "symmetric half" of the existing renderRibbon guard).

## All confirmed + fixed findings

| Sev | Site | Finding (fixed) |
|---|---|---|
| HIGH | `server/src/deliveries.ts:64` | Bare \bdelivered\b catch-all marks future-tense and negated delivery mail as delivered=true ('will be delivered tomorrow', 'was not delivered') |
| HIGH | `server/src/session-pool.ts:185` | Stale saved resume id in sessions.json causes a permanent, self-repeating crash loop for that directory (never invalidated) |
| HIGH | `server/src/trash.ts:48` | Files moved INTO the Trash location via the Move flow are purged within 24h, not 30 days (mtime fallback vs rename-preserved mtime) |
| HIGH | `server/src/windows/_session.ts:562` | Starting dictation does not clear Suggest state — Confirm then sends the stale robot suggestion instead of the confirmed transcript |
| HIGH | `server/src/windows/games.ts:624` | Blackjack: persist() not gated on the async save-load — a failed or late loadBlackjack lets a fresh $1000 game overwrite the real save |
| HIGH | `server/src/windows/media.ts:219` | Album art lost/stuck: server overwrites state wholesale while the client pushes artB64 only once per track |
| HIGH | `server/src/windows/reader.ts:239` | openBook leaves stale previous-book state (chapter/page/pages/chapterTitle) when the new book has no saved position, polluting history/bookmarks/preview with cross-book coordinates |
| HIGH | `server/src/windows/sms.ts:334` | Post-send thread re-pull is dead code: reserved 'Back' is intercepted by the WM, so Back after sending shows the stale thread without the sent message |
| MEDIUM | `android/…/service/ConnectionService.kt:202` | [client-side APK] BT adapter bounce during the scanning phase permanently strands `_connecting=true` — the BT-ON auto-recovery gates itself off and no scan-failure event ever fires |
| MEDIUM | `android/…/service/MediaBridge.kt:51` | MediaBridge.subscribe() leaks the previous OnActiveSessionsChangedListener on every repeat subscribe |
| MEDIUM | `android/…/service/MediaBridge.kt:139` | pushNow() marks lastArtKey before the bitmap exists — late-loading album art is permanently skipped for the track |
| MEDIUM | `scripts/render_terminal.py:30` | Grid render silently truncates panes wider than 220 cols / taller than 48 rows, dropping the bottom (live-edge) rows |
| MEDIUM | `server/smoke/_env.mjs:60` | DB-override path warns but does not block: six phases then run unscoped DELETEs that would destroy production data (D-F4 guard applied inconsistently) |
| MEDIUM | `server/src/cc-session.ts:460` | Error-result detail extraction ignores the `errors: string[]` field that current CC actually populates — glass shows bare "CC error_during_execution" instead of the real reason |
| MEDIUM | `server/src/config.ts:203` | authToken 'regeneration' branch never regenerates when authToken is present-but-invalid — log claims a new token was minted while the bad value is persisted back |
| MEDIUM | `server/src/deliveries.ts:113` | Carrier mail fetched from narvar.com / shop.app / oncehub.com is silently dropped — carrierFromAddr has no mapping, contradicting the module's 'never a silent miss' rule |
| MEDIUM | `server/src/lyrics.ts:93` | Transient LRCLIB HTTP errors (5xx/429) are cached forever as a permanent negative |
| MEDIUM | `server/src/stats.ts:173` | Stats sampler ticks overlap with no in-flight guard — a hung/slow nvidia-smi accumulates unbounded child processes and fds |
| MEDIUM | `server/src/window-manager.ts:910` | Stale lastView between parking and the ribbon render lets taps drive the PARKED window (mic start / browse actions with zero on-screen feedback) |
| MEDIUM | `server/src/window-manager.ts:852` | pendingNotifs promotion is unreachable while the ribbon is on screen — queued timer/call alarms stall (badge only) |
| MEDIUM | `server/src/window-manager.ts:1402` | Voice 'blank' leaves activeOverlay dangling — the blanked screen relights with the overlay, and the blank-flash auto-clear never re-blanks |
| MEDIUM | `server/src/windows/_session.ts:331` | Interrupted turns route through the generic 'error' handler, which drops the queued prompt the Interrupt design comment promises will drain |
| MEDIUM | `server/src/windows/files.ts:875` | In-flight image render hijacks later levels: actions-level menu transitions (Del/Move/Copy/Stats-file) and the op executors never bump navSeq |
| MEDIUM | `server/src/windows/files.ts:844` | Tree-menu 'Up' leaves focus='menu': browse rows go dead, and the recovery double-tap ejects to locations (or clean out of the window at a location root) |
| MEDIUM | `server/src/windows/mail.ts:503` | stopCompose never resets level: Reload-during-compose or park-to-ribbon-and-return strands Mail on a permanent fake-busy 'Preparing…' screen |
| MEDIUM | `server/src/windows/reader.ts:631` | Jump 'Cancel' (and Options->'Mark') force level='read' when reading was never entered — with pages=[] the first scroll-forward opens chapter index 1, silently skipping chapter 0 and persisting the wrong position |
| MEDIUM | `server/src/windows/sms.ts:286` | SMS reply reports fabricated 'Sent to X.' — the phone swallows SmsManager/SecurityException failures into DiagLog and no outcome path exists |
| MEDIUM | `server/src/windows/terminal.ts:532` | refreshTail()/openSession() restart the capture poll after onDeactivate (unguarded ensurePoll after an await) |
| MEDIUM | `server/src/windows/terminal.ts:319` | New-session failure message never reaches the glass — view() wipes lastError on the next successful session-list fetch |
| LOW | `android/…/audio/AudioStreamer.kt:90` | winLimit Int overflow for ≥96 kHz stereo float32 disables handsfree window re-cutting |
| LOW | `android/…/audio/MicCapture.kt:139` | Same-instance stop()→start() race: the old read-loop's finally block releases the NEW capture's AudioRecord |
| LOW | `android/…/net/ConnectionManager.kt:169` | No closed-latch: a reconnectJob straggler entering connect() after disconnect()/shutdown() creates an unkillable zombie authed WebSocket |
| LOW | `android/…/service/NotifyListener.kt:170` | [client-side APK] Notification-debounce eviction is FIFO, not LRU — a hot, constantly-re-posting key is evicted while actively suppressed, re-forwarding identical content |
| LOW | `android/…/service/NotifyListener.kt:187` | [client-side APK] Newest-wins supersede skips the imageless-re-post path — an in-flight MMS image retry loop later forwards stale title/text out of order |
| LOW | `audio/pipeline/nlms.py:63` | nlms_clean silently accepts int PCM via a bare float32 cast without normalization — the exact bug class the project's 4th-pass F2 fix loud-fails in notch_filter and spectral_subtract |
| LOW | `audio/pipeline/parakeet_daemon.py:93` | Daemon profile-job path silently averages differing stereo channels — mixes the TX1 noise reference into speech, contradicting dji_pipeline_cli's R6-HIGH refusal guard |
| LOW | `audio/tools/verify_dji_settings.py:91` | --json mode crashes with AttributeError on JSON booleans — normalize_yes calls .lower() on non-string answers |
| LOW | `scripts/import_cc_history.mjs:77` | Import records isMeta system-injected user lines (system-reminders, skill base-dir injections, image placeholders) as Adam's prompts |
| LOW | `scripts/read_epub.py:129` | _norm keys TOC entries by basename only — two spine files with the same basename in different directories share one anchor list, producing wrong chapter splits/titles |
| LOW | `scripts/scene_to_png.py:74` | Client-rule mirror is incomplete: scenes with region id <= 0 or an empty name pass the tool but are hard-rejected on the phone; the reserved 'ant' name rewrite is neither flagged nor mirrored |
| LOW | `scripts/send_mail.py:50` | plain_body() swallows decode failures silently — an outbound reply/forward loses the quoted original with no log |
| LOW | `scripts/send_mail.py:84` | file_to_sent() writes the Sent copy directly into cur/ without the maildir tmp/-then-rename step — a concurrent mbsync can sync a partially-written file |
| LOW | `server/smoke/phase-blackjack.mjs:199` | Seven phases leak the pg pool (no getPool().end()), each adding a ~10 s idle-client dead tail — ~70 s of pure wait per run-all |
| LOW | `server/smoke/phase13-deliveries.mjs:104` | Load-bearing cross-phase cleanup failures are swallowed with bare catch {} — a failed delete would break OTHER phases' title assertions with zero breadcrumbs |
| LOW | `server/smoke/phase4b-sms.mjs:72` | Step 4's 'provider error renders loudly' gates nothing: the error is injected while the window is at level 'thread', where sms.ts view() returns before the threadsError branch |
| LOW | `server/smoke/phase9-voice.mjs:111` | SMS provider stub uses a wrong message shape ({from,text,ts,mms} vs the wire's {id,body,incoming,tsMs}), so the voice-read thread renders 'Me · NaN/NaN NaN:NaN' and the smoke cannot see it |
| LOW | `server/src/output-parser.ts:67` | Bullet transform bakes '▸' — a documented does-NOT-render firmware glyph — into every CC list line on the legacy display path (scrollback arrows same class) |
| LOW | `server/src/session-pool.ts:257` | Error/interrupted turns carry fabricated zero usage, and updateUsage overwrites the real contextPct with 0 |
| LOW | `server/src/session-pool.ts:174` | getOrCreateByDirectory evicts only the FIRST dead entry then breaks — a live entry for the same path later in iteration is skipped, yielding two live CC subprocesses on one directory |
| LOW | `server/src/stats.ts:233` | series() fabricates 0 for null samples (and the promised log doesn't exist) — charts render false 0 °C / 0 % / 0 GB dips |
| LOW | `server/src/trash.ts:42` | purgeOldTrash swallows ALL readdir errors, not just the documented missing-dir case — a purge that stops working is silent forever |
| LOW | `server/src/voice.ts:21` | WAKE_RE rejects Parakeet's vocative comma after 'hey' ('Hey, Butterscotch, ...') — wake command silently ignored via the sanctioned quiet path |
| LOW | `server/src/window-manager.ts:1249` | Blank-entry via double-tap drops a live Maps navLine (plain black) — contradicts the documented Phase 6 'nav owns the blanked screen' |
| LOW | `server/src/window-manager.ts:550` | loadWindowUsage merge overwrites fresh in-session MRU stamps/counts (and the pre-load persist clobbers the durable use_count) |
| LOW | `server/src/window-manager.ts:1164` | fullBleedMenuCaptures() diverges from composeFullBleedScene's menuCaptures on scrollContent with non-text mode — routing vs on-glass capture can disagree |
| LOW | `server/src/windows/_session.ts:570` | 'Done' has no stale-tap guard: sets transcribing=true unconditionally, wedging 'transcribing…' and able to resurrect a canceled dictation's result |
| LOW | `server/src/windows/_session.ts:1157` | Model/Effort tap during an in-flight respawn mutates opts even though respawn() refuses — UI, preview, and history rows then claim a model/effort the subprocess is not running |
| LOW | `server/src/windows/_util.ts:35` | clampConfirmBody gates on UTF-8 bytes but cuts by UTF-16 code units: multi-byte bodies are not clamped, the '+N more chars' count goes negative, and the cut can split a surrogate pair |
| LOW | `server/src/windows/deliveries.ts:68` | Deliveries list silently hard-capped at the newest 42 rows — older tracked deliveries are unreachable and the title reports the capped count as the total |
| LOW | `server/src/windows/games.ts:1287` | rpg cd: hero death during the cd still commits this.cwd to the target — window location desyncs from the hero's real post-respawn location |
| LOW | `server/src/windows/reader.ts:586` | Library tap resolves indices against a fresh readdir, not the rendered listing — a file added/removed between render and tap shifts rows and opens the wrong entry |
| LOW | `server/src/windows/search.ts:140` | Canceling (or switching away from) an in-flight search renders a false 'No results for "q"' screen |
| LOW | `server/src/windows/terminal.ts:712` | Grid mode goes stale/stuck: Reload during an in-flight grid render leaves a forever-spinner, and input-hub sends return to a pre-command grid |
| LOW | `server/src/ws-handler.ts:773` | set_mode respawns only the ACTIVE session — other live pool entries keep their old permission mode while status/session_info report the client-wide client.mode for them |
| LOW | `server/src/ws-handler.ts:1404` | Fire-and-forget void client.wm.onVoiceCommand(text) has no .catch and onVoiceCommand has no internal try/catch on its dispatch path — a rejecting voice command lands in the global unhandledRejection backstop with no DE feedback or resync |

## Refuted findings (verified NOT bugs — do not re-chase)

- `server/src/windows/terminal.ts:655` — "empty dictation Confirm sends bare Enter": unreachable;
  ws-handler's onText gate rejects blank transcripts before sttResult ever fires.
- `scripts/read_epub.py:188` — "_id_offsets swallows parse failures": Python 3.13's HTML5 parser
  routes all malformed constructs to parse_bogus_comment; the cited AssertionError paths are dead
  code on the interpreter runEpub actually uses (empirically demonstrated).
- `server/src/paperclips.ts:397` — "throwing auto-fire starves the 30s save mirror": no
  persistent-throw state is constructible against the real engine calls.
- `android/…/service/MediaBridge.kt:99` — "attach() races the @Synchronized methods": every server
  message is marshaled onto the main looper (`Dispatchers.Main.immediate`), so the claimed
  cross-thread interleaving cannot occur.
- `server/smoke/phase-blackjack.mjs:139` — "natural-redeal loop acts on a stale scene": microtask
  FIFO deterministically orders the render send before settle()'s first poll.
- `server/src/games.ts:32` (ANSI regex) and `server/src/ws-handler.ts:662` (duplicate audio_end):
  see "Two findings worth telling the story of" above.

## Present-only items (found + verified, deliberately NOT fixed — Adam's call)

- **Menu-mode blank drops a live nav line** (`window-manager.ts` menu-mode double-tap-blank twin,
  ~:1290): same inconsistency as the ribbon site (fixed), but it lives on the byte-parity-frozen
  classic path. One-line change (`navLine ? blankFlashScene(navLine) : blankScene()`) whenever
  menu-mode parity stops being a constraint (§2.2.8 cutover retires menu mode anyway).
- **True SMS send-result flow**: needs an additive `sms_send_result` client→server message + the
  client wiring a real `sentIntent` PendingIntent — an APK+server lockstep change (the Notices
  reply-result pattern). Queued in improvements; the interim honest wording ships now.

## Improvements & optimizations (curated from 96 proposals — NOT implemented)

**Recommended (I'd do these next):**
1. **Timing-safe token compare + /setup surface review** (transport) — `validateToken` and the
   HTTP token gates use plain `===` on a bearer token, and /setup serves the token to any
   unauthenticated LAN/tailnet peer by design. Cheap hardening for the day the LAN isn't trusted.
2. **Blank-screen re-send dedupe** (WM) — while blanked, every chrome refresh re-sends an
   identical blankScene (a full ack-gated f1=7 rebuild) for zero visual change; cache the last
   blank-surface string. Real BLE churn reduction for the drive-blanked case.
3. **invokeMenu → handleSwitchTo** (WM) — the voice path re-implements switch semantics and drops
   `SwitchTo.open`; one call removes a latent trap + the duplication.
4. **MTU-failure guard in the BLE client** (Android) — `requestMtu` has no fail handler and AA
   packetization assumes MTU ≥ 245; a failed negotiation would silently truncate writes. Findings
   welcome / fixes gated (frozen-layer adjacent): flag → verify on glass.
5. **Persist sessions.json at system/init** (cc-bridge) — resume ids currently persist only on
   turn_complete; a session that inits but never completes a turn is lost to resume. Complements
   today's stale-resume fix.
6. **Reader marks/jump `ret` tracking** (the pendingNav.ret pattern) — Back from Bookmarks/Recent/
   Jump should return where you entered from; today's fix covered Jump-Cancel, the browse lists
   still hardcode their return.
7. **wrapLinesPx cut=0 guard** (compose) — a pathological glyph-width input could loop forever in
   the hard-split; one clamp line. Latent, nasty class.
8. **run-all per-phase wall-clock** (smoke) — one summary line; makes the next pool-leak-class
   regression obvious.

**Worth doing, lower priority:** GPU-only single-flight already shipped; remaining: renderBlocks
in-flight dedupe (compose) · veth/docker filter in /endpoints · scrollback pagination cache ·
boardCache recency + in-flight eviction guard (games) · SmsProvider contact-resolution off the
full-table walk (Android) · watchdog per-session nextAttemptAt (kills the in-loop backoff sleeps)
· stale ~/.g2cc/notify-img age purge · Files "rendering image…" placeholder page (removes the
dead-air that invites the tap-race the navSeq fixes now guard) · Mail pickRecipient unreachable
menu · read_maildir tiny-image (tracking pixel) skip · Gray4Bmp corrupt-BMP reporting ·
capture.py hard-fail on missing DJI device + single-mic (mono TX2) capture mode (matches the
CLAUDE.md default pipeline) · smoke ALL-OK marker channel unification · dead-code sweeps
(overlayFromBlank machinery, EvenHub builder half, BluetoothStateReceiver/AppState/StateMachine/
Prefs, SetupActivity, Blackjack.clearTable, paperclips pacer-on-deactivate).

**UX ideas surfaced (glasses-interaction-model compatible):** ribbon alt-tab landing on slot 1
when exiting Main (Main never gets an MRU stamp, so "previous" is off-by-one on Main exits —
semantics are Adam's call) · surface tmux send failures on glass · rpg output that completes
after leaving the rpg area gets a notice instead of vanishing · forwarded-mail body notes dropped
attachments · pendingPermission surfacing on session re-entry.

## Deferred exactly as before (unchanged by this review)

phase10-calendar env red (OAuth refresh_token) · Blackjack smoke random-deal flake + tuning
embargo · Games width (456 in full-bleed) · §3.5 extension to files/calendar/notices · §3.6
End-Feature popup · Reader geometry-fingerprint + scroll-reading statusLine suppression ·
sessions.json cross-connection lost-update · faster-whisper sentinel · G2Renderer frozen
semantics · parked Android code (probe/, G2Pipeline, hud/, G2CCService, MainActivity,
Teleprompter).
