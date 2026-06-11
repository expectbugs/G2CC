# G2CC code review — 2026-06-11 (the post-DE full pass)

Nine-agent review (8 subsystem finders + a rules/recent-diff sweeper, Fable 5 max
thinking) over the whole codebase, focused on everything since the v1.0 hardening
(7d0319c). **Every finding was independently re-verified against source before any
fix** — plus five live-subprocess experiments against `claude` 2.1.170 and one AOSP
source pull. ~60 raw findings → **~45 confirmed (all fixed)**, 2 rejected, the rest
duplicates/known-parked.

## Rejected (verified NOT bugs)
- paginateText "trailing empty row on exact multiples" — disproven by direct trace +
  repl (96-char token → [48,48]).
- "rate_limit `includes()` never matches" — disproven empirically (the event logs as
  exactly `rate_limit_event`, 4/4 runs). The REAL bug was scope (see below).

## Empirically established (live CC 2.1.170, /tmp/cc-sigint-test/*)
1. **SIGINT mid-turn makes `claude --print` emit result/error_during_execution and
   EXIT** — so every glasses Interrupt killed the subprocess (scary death card +
   watchdog respawn churn). The stream-json `control_request {subtype:'interrupt'}`
   aborts the turn, returns control_response/success, and the process stays alive
   and accepts the next prompt. → `interrupt()` rewritten to use it; the aborted
   turn renders as a calm "Interrupted".
2. **`rate_limit_event` fires at EVERY session init** (no throttling involved) — the
   whole-session scan mislabeled any empty-detail error as "likely throttled".
   → turn-scoped flag, softened wording.
3. **CC --print never emitted a can_use_tool control_request** in default mode — the
   on-glass permission flow is dormant at the CC layer today. Deny shape aligned to
   the SDK control protocol (success + behavior:'deny'; 'error' subtype means the
   control request itself failed) — still [U] hardware-unverified.
4. **Tool results ride `type:'user'` events** (tool_result content blocks); the
   `type:'tool'` branch is dead on 2.1.x. → user-event parsing added.
5. **AOSP AudioRecord.java:1617**: `read(byte[],…)` returns ERROR_INVALID_OPERATION
   for ENCODING_PCM_FLOAT — the DJI-USB float path could never capture a single
   frame. → float[] read + LE serialization.

## Fixed — server (highest impact first)
- **cc-session stdin EPIPE** could kill the whole server (no 'error' listener; no
  global handler) — listener added; spawn() now also resolves the real spawn
  outcome ('spawn' vs 'error' race) so ENOENT rejects into the callers' catches.
- **Watchdog backoff resurrection** (3 finders): unregister during the 2-32 s
  backoff still respawned + re-registered the session → immortal zombie CC owned by
  no pool entry. Post-sleep + post-spawn identity re-checks added.
- **THE WALL FAMILY**: errorView was unpaginated (a >750 B traceback made the error
  screen itself unpaintable); titles/status/antenna lines unclamped (deep Files cwd
  → every recompose client-rejected; long MCP tool name → 33px-bar wrap = firmware
  scrollbar; an 8-glyph mount label broke per-notch antenna input); paginateText
  counted UTF-16 chars (CJK pages → >1000 B rebuilds; caps/digit lines → invisible
  7th-row clip). Now: px-measured wrap (incl. CJK width), per-page byte ceiling,
  px-clamped chrome, and `estimateLayoutFrameBytes()` guarding EVERY composed frame
  (mirrored into scene_to_png.py, which previously skipped the one rule that
  actually wedges hardware).
- **STT dictation wedge cluster** (3 finders): five server reject paths sent raw
  stt_error that never reached the WM (status stuck "transcribing…" forever) and
  never stopped the phone mic — which the live client also never stops on WS drop;
  menu() invited re-Dictate mid-transcription (second utterance silently lost).
  All rejects now route through sttError() → WM; onSttError/stopDictation stop the
  mic (idempotent); a `transcribing` menu (Cancel/Reload/Main) replaces the verb.
- **Session-state hygiene**: close() now clears busy/permission/tool state (was:
  "thinking…" + wrong menus over "Session closed"; Approve-after-close wedged busy
  with no turn); process_died/error drop pending permissions; Approve/Deny never
  touches busy on stale taps.
- **Permission FIFO**: overlapping control_requests no longer clobber each other
  (the orphaned request blocked its tool call forever); dictation states are
  stopped (loudly) when a permission arrives. Dormant under bypass + finding 3
  above, but correct now.
- **Queued-prompt fixes**: the drain no longer erases the just-finished answer
  (retainDoc prepends it); respawn() drops the queue (stale prompt no longer fires
  after a later unrelated turn); prompt() re-checks busy after the revive await
  (double-send race).
- Mail: read failures now render (refresh() was nulling lastError before the list
  view ever showed it) + per-message isolation in read_maildir list (one unreadable
  file bricked the whole inbox) + unknown-charset bodies fall through to the
  lenient decoder (LookupError repro'd: iso-8859-8-i).
- Files: statSync().isFile() before openSync (a writer-less FIFO froze the entire
  server forever); listDir via withFileTypes (the per-entry stat pass blocked the
  event loop on big/cold dirs — per antenna notch); tree-level focus flip (the
  rendered Reload/Main menu was unreachable dead UI).
- WM: input ignored while blanked (single tap was silently driving the active
  window); lastView browse default unified with compose (index-0 action swap);
  picker spawn failures now showError + log (was: bare "ERROR" title).
- stt.ts: tmp-name collisions (Date.now() only); ParakeetDaemon stdout identity
  gate (post-overflow respawn could resolve a job with the dead daemon's text);
  preprocess loud-fails odd-length PCM; handleAudio rejection guard; heartbeat
  interval leak on re-auth; legacy prompt/rewind mid-turn guard; scrollback trim
  marker; renderSingleTile strict asserts; renderImageFile callback try/catch.

## Fixed — client (APK v1.5)
- **abort() drops queued jobs without onComplete** → render pump wedged permanently
  after a Reload racing a queued scene (2 finders). Queue now drains with
  rollback + onComplete(false), newest-first.
- **display_reload could abandon a HEALTHY mid-image chunk chain on a live link
  then COLD_INIT on top of it — the documented r4 glasses-crash recipe.** abort()
  is now epoch-fenced: young image parks survive (the job stops at its region
  boundary after the ack); parks older than IMAGE_PARK_STALE_MS (3 s) = the real
  wedge, released as before; teardown uses force=true.
- **preempt() released healthy layout-ack parks** → overlapping f1=7 rebuilds on
  fast antenna scrolls (unprobed §9 territory) + rollback lied about delivered
  layouts. Now released only past LAYOUT_PARK_GRACE_MS (500 ms — the wall case);
  younger parks complete their ack then skip at the boundary. preemptRequested
  boolean → per-job preemptSeq snapshot (a preempt aimed at a QUEUED stale scene
  was being cleared on dequeue); `aborting` reset race → per-job epoch.
- **f1=5 text updates now wall-checked** (an oversize text frame was silently eaten
  by firmware and never re-sent — permanent display divergence).
- **MicCapture/AudioStreamer**: float read fixed (above); USB fallback paths log
  instead of emitting fatal Failure (a stereo-init miss killed the streamer, then
  the successful phone-mic frames were all dropped and the read loop leaked
  forever); stop() always stops the mic; post-stop read-race failures are no longer
  reported (they discarded the just-recorded dictation's real transcript); WS drop
  stops the streamer; "already streaming" refusal surfaces as [audio-error].
- **ConnectionManager**: single-endpoint reconnects never engaged backoff
  (zero-delay hot loop for any server outage); wsGen increment/read made atomic +
  connect() synchronized (double-socket race).
- **ConnectionService**: sticky restart (null intent) now reconnects — the all-day
  backbone actually survives a system kill; mic-FGS denial retries on the next
  foreground start (the advertised "reopen the app" now works); pump drains the
  conflated channel before rendering a captured stale scene.
- **Crash-proofing**: Gray4Bmp.decode bounds (negative dataOff / int-overflow →
  AIOOBE escaped the IAE-only catches and killed the process); renderer + pump
  catches broadened to Exception; EventParser.decodeHubAck wrapped → Malformed
  (truncated varint crashed the BLE notify thread).
- validate(): list items measured in UTF-8 bytes (wire truth); region names ≤16 B.
- Scene rollback preserves the scroll flag via sentinel (spurious f1=7 rebuilds +
  silent flag downgrades).

## Docs
DE_DESIGN clock geometry (469/107, leading-space inset) + Reload-row mechanism;
CONTENT_API marked legacy-tiles; G2_BLE_PROTOCOL §7 notes the enforced 129 cap;
protocol.ts documents the reserved 'ant' name; stale comments fixed.

## Deferred (documented, deliberate)
- No render-ack on the WS (client reject → server lastView optimistic) — largely
  mitigated by the server-side wall guard; revisit with the scene-version echo.
- Tap-vs-rebuild scene-version echo (pre-existing).
- Single-user sessions.json locking; HOLDS C3/C4/C5 unchanged.

## Verification
`npm run build -w server` clean; gradle `testDebugUnitTest assembleDebug` green
(225+ tests; 2 rewritten for the new abort/preempt contract + 3 new covering
young-park/stale-park/queue-drain); 9-case compositor smoke (worst-case Mail page
914 B, deep-path title clamp, CJK 473 B pages, bounded errorView, status/antenna
clamps, oversize-scene throw) + scene_to_png parity: OK. APK v1.5 at
/tmp/g2cc-harness.apk (old v1.4 stays wire-compatible with the new server).
