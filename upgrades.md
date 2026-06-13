# G2CC upgrades v2 — the 2026-06-12 queue

> **This file REPLACES the 2026-06-11 upgrades doc** (Phases 1–11, all shipped and
> smoke-verified — the full annotated v1 lives in git at `60e6578:upgrades.md`; the WHY
> is CHANGELOG r3–r17; the per-phase record is UPGRADE_PROGRESS.md). Same contract as
> v1: this is the WORK QUEUE — dependency-sorted, individually shippable phases, each
> smoke-verified before the next; Adam's gate answers get recorded inline; §D lists
> what is deliberately OUT or carried over still-gated. Scope extended
> 2026-06-12 (Adam's idea-reviews): navigation line, media controls, full
> mail, Reader voice-paging, stats alerts, universal search, deliveries,
> audio memos, phone finder, OBD-II, Files trash, the category-launcher Main.
> Rejections recorded in §D. **Scope extended again 2026-06-13 (Adam's two
> explicit asks): Phase 18 (chess tile-redraw fix) and Phase 19 (Files
> file-manager overhaul incl. the "970 bytes" dir-listing wall) — these go
> FIRST.**
>
> House rules apply unchanged (HANDOFF.md "Hard-learned lessons" + CLAUDE.md): the
> multi-packet wall, B2 blank-wake, B4 subprocess-everything, B5 state hygiene, the
> Three Absolute Rules, additive-optional wire changes, prime directive.

## Implementation status (2026-06-13)

**DONE + smoke-verified (server-only; CHANGELOG r18; NO APK):** Phase 18 (chess
tile-redraw), Phase 19 (Files overhaul incl. the "970 B" wall, dir ops,
rename/mkdir), Phase 17 (trash — folded into 19), Phase 2 (blank flash),
Phase 10 (stats alerts). Whole-project review done → `docs/CODE_REVIEW_2026-06-13.md`
(fixed the Files pickDest navigation + the phase10 smoke flake; 4 client findings
deferred there).

**NOT yet implemented:**
- Server, ready to build: **3** (Suggest — touches SessionLevel's confirm flow),
  **5** (tmux), **8** (full Mail), **11** (Main categories — premature; gated on a
  window count we haven't reached), **12** (Search), **14** (memos — needs the PCM
  buffer plumbed from ws-handler to the intent handler).
- Server, gated: **13** (Deliveries — needs the one-time `gmail.readonly`
  re-consent at home).
- Client (need an APK + Adam's on-glass verify): **1** (MMS retry), **4a/4b**
  (SMS), **6** (nav line), **7** (media), **9** (voice), **15** (phone finder).
- Hardware-gated: **16** (OBD — vGate dongle on backorder).

---

## Status corrections from on-glass testing (2026-06-12)

- **G2 battery: VERIFIED WORKING** (v1.10) — diag shows `[batt] glasses battery →
  73…76%` live; §10 of G2_BLE_PROTOCOL.md is de-[U]'d. The status-bar G slot is real.
- **MMS images: STILL BROKEN — root cause #2 in hand** (Phase 1 below).

---

## Decision answers (Adam, 2026-06-12 — all questions resolved)

1. **Blank-flash mark-seen**: do NOT mark seen; the ⚠ badge nags until read.
2. **SMS scope**: BOTH slices — 4a notification-reply, then 4b full Telephony
   threads (he uses Google Messages; the watch precedent is full-history).
3. **tmux**: opens into a SESSION MENU (`tmux ls` + `New session`) — pick one;
   a `Sessions` menu option re-picks for easy juggling. Read-only-until-focus
   default stands.
4. **Suggest model**: `claude-opus-4-8` + `--effort medium`, locked.
5. **Lyrics**: LRCLIB fetch approved (cache-forever in Postgres).
6. **Voice-paging mic budget**: approved — the DJI is built for all-day wear
   and he rotates two TXs through a charging case; the phone is active all
   day regardless. (This approval unlocked the full Phase-9 voice layer.)
7. **Main categories**: grouping approved as proposed WITH one change — the
   top-level verb is renamed **Ask → Dictate** and becomes the voice-control
   entry point (see the reshaped Phase 9).
8. **Deliveries source**: NOT migadu (human-only box) — carrier/bulk mail
   lives in his GMAIL; Phase 13 reads Gmail instead.
9. **OBD**: "whatever is most useful" — spec locks to a classic-BT ELM327
   with AUTO-SLEEP (vGate iCar Pro BT3.0) so it can live plugged in; the
   G2CC app itself is the bridge (no Tasker/Aria hop — see Phase 16).
10. **Trash purge**: 30 days confirmed.

Standing micro-defaults (spec'd, not asked): the wake word is literally
"G2" per Adam's examples (false-positive risk handled by requiring a
grammar-matched command after it — [U] tune on factory audio); voice
commands that SEND content (prompts/replies) require a VOICE confirm
("G2 confirm" / "G2 cancel") — the confirm step stays sacred, voiced;
Phase 13 needs a one-time Google re-consent at home (gmail.readonly added
to aria's OAuth scopes).

---

## Phase 1 — Fix MMS image display (small; client v1.11)

**Evidence** (diag 2026-06-12 22:44): Messages posts the conversation notification
TWICE — first text-only ("Image" placeholder, forwarded fine), then a re-post with
the MessagingStyle data URI attached. v1.10 FINDS the URI
(`content://com.google.android.apps.messaging.sharing.fileprovider/rcs_attachments/…`)
but `openInputStream` yields nothing decodable — NO SecurityException (the listener
URI grant is fine): the RCS attachment file isn't fully written/servable at
notification time. Then the image-aware dedup stamp (r17) blocks every LATER re-post
with the same URI, so it never retries.

**Fix** (all in `NotifyListener.kt` + a small `ConnectionService` hook):
- Split the unreadable diagnostics: stream-null vs zero-bounds vs exception (each
  logged distinctly — next failure self-identifies).
- **Delayed retry**: when an image URI exists but is unreadable, DEFER that forward
  ~2s/5s/10s (bounded supervision retries — a resource cap, not an I/O timeout) and
  send WITH the image on first success; after the window, forward imageless + loud.
  Run retries on the service scope, never the NLS main thread.
- **Dedup repair**: only commit an image-bearing stamp once the image actually
  ENCODED (or the retry window expired) — a later re-post with the same URI must be
  allowed to retry, not be eaten.
- Verify: send an MMS, expect `[notify] picture WxH → … JPEG n B` in diag + the
  image page in Notices. Unit-test the stamp/retry state machine.

## Phase 2 — Blank-screen flash: 5 s, text-only, NO UI (small; server-only)

Adam (2026-06-12): *"i use blank mode when driving … i don't need the whole-ass UI
suddenly hitting me in the face."* Replaces the full-view blanked popup from gate
A3.5. **The B2 hardware rule is load-bearing here: the flash scene must keep
`blankScene()`'s scroll-text wake region** — compose the flash as
blankScene-regions + ONE text region in the title-bar slot (y=0 h=33, px-clamped).

- Content: `SMS from Becky` / `E-Mail from rfr82409@yahoo` / `Call from X` (kind
  label from priority + the notification title, which carries the sender) and
  `Timer: tea` for timers. One line. No menu, no body, no overlay machinery.
- `BLANK_POPUP_MS` 10_000 → **5_000** (already smoke-tunable via
  `setBlankPopupMsForSmoke`).
- Semantics: every priority flashes while blanked; newest-wins replacement;
  auto-re-blank; double-tap during the flash wakes (the user is engaging).
  **NOT marked seen** (Adam 2026-06-12, Q1): the glance is missable — the ⚠
  badge keeps nagging until read in Notices.
- Touch points: `os-windows.ts` onNotification blanked-branch + a
  `blankFlashScene(line)` in os-compose (estimator-guarded); phase4 smoke pins the
  region set (wake region present, ≤1 capture, no menu).

## Phase 3 — Suggest-next-prompt (medium; server-only)

One-shot `claude --print --model claude-opus-4-8 --effort medium` predicts Adam's
next prompt from the conversation; he confirms before anything is sent (the
confirm step stays sacred — robot text gets the Parakeet treatment).

- **Trigger**: `Suggest` appears as the TOP session-menu option when idle with ≥1
  completed response. Tap → status `suggesting…` → one-shot subprocess (the
  execFile pattern: stdin listener, maxBuffer, loud reject; stateless — no pool
  slot, no watchdog).
- **Context**: last ~15 turns from the Phase-3 history DB (already captures
  everything, incl. tool-call names — "run the tests" vs "fix that" depends on what
  CC just did) + a dedicated system prompt (`server/prompts/suggest.md`): predict
  the USER's next message, terse, imperative, Adam's voice, output ONLY the prompt.
- **UX**: result rides the existing confirm-page machinery — menu
  `[Confirm, Regenerate, Cancel]`; Confirm → the normal `prompt()` path (queue/busy
  rules apply); Regenerate re-runs (fresh subprocess); Cancel restores. Stale-seq
  guard on the async return; hidden while busy; a failed call renders the error
  card and never blocks Ask/Dictate.
- Verify: smoke with a fake CLI (`CLAUDE_CLI` env override) asserting menu order,
  confirm-send path, stale discard.

## Phase 4 — Full SMS/MMS integration (large; client + server, two slices)

**4a — Reply from the glasses via notification RemoteInput** (works for ANY
messenger; no SMS permissions): the classic watch-bridge pattern — the client finds
the active notification by key, fills the reply action's RemoteInput, fires its
PendingIntent.
- Wire (additive): `notify` gains `hasReply: bool` + the client handles a new
  `notification_reply {key, text}` server message (old clients ignore it).
- Server: Notices read view gains `Reply` when hasReply — dictation confirm flow
  composes; the reply goes back over the WS. Loud result either way.
- Caveat: only live (non-dismissed) notifications can be replied to — the client
  reports failure loudly and the server renders it.

**4b — The SMS window** (Google Messages data, true threads):
- Client (v1.12): `READ_SMS` + `READ_CONTACTS` permissions (one-time grants at
  home, prime-directive-compatible); a query surface over
  `Telephony.Sms`/`Mms` + `canonical-addresses` + contact-name resolution; MMS
  image parts via `Mms.Part` (same downscale/encode path as Phase 1). New additive
  client messages: `sms_threads_reply` / `sms_thread_reply` (paged) — the client
  becomes a data provider the server queries on demand.
- Server: an `SMS` window — threads list (name · last line · unread) → thread view
  (paginated, newest last; image parts = page-≥2 image pages) → `Reply` (dictation
  confirm → 4a's RemoteInput when live, else `SmsManager.sendTextMessage` w/
  `SEND_SMS`) → `New` (pick contact → dictate).
- MMS SENDING is OUT for v1 (receive/view only — `sendMultimediaMessage` is a
  swamp; text replies cover the need).
- Verify: provider-query unit tests w/ fixtures client-side; server smoke with a
  scripted provider double.

## Phase 5 — The tmux window (large; server-only)

The glasses become another client of Adam's REAL tmux session — no mosh needed:
the G2CC transport (BLE→phone→WS with reconnect/backoff) IS the roaming layer, and
the server is the tmux host.

- **Entry = a session MENU** (Adam, A2): the window opens on a browse list from
  `tmux ls` (name · windows · attached?) + a `New session` row; picking one
  runs the control-mode attach. A `Sessions` menu option inside the terminal
  re-opens the list for juggling multiple sessions; the title always names the
  attached session.
- **Attach**: `tmux -C attach -t <session>` control-mode subprocess (the cc-session
  shape: long-lived, line-parsed `%output`/`%window-*` events, stdin 'error'
  listener, watchdog-style respawn). Read-only until input focus is explicitly
  taken (default stands).
- **Display**: tail mode = firmware text, last ~6 wrapped lines, ~62 ms updates
  (render-conflated; perfect for watching CC/builds); grid mode = page-≥2 IMAGE
  page, PIL monospace 6×10 px → a true **80×22** terminal snapshot (~4 s tile push,
  on-demand page flip; htop/vim legible). The PAGE-2 rule, again.
- **Input**: quick-keys menu first (`Enter · Ctrl-C · q · y · n · ↑ ↓ Tab Esc` —
  one tap each, covers most interactive life) → dictation via the confirm flow →
  `tmux send-keys -l`; the on-screen keyboard level last (rows of character groups
  in the native list, tap-row → tap-char, plus Bksp/Space/Shift rows — slow-ass by
  design, it's the fallback).
- Safety: keys go to ONE explicitly-focused pane; the window title always names
  pane + focus state; losing the WS mid-input changes nothing server-side (tmux
  session is local and durable).
- Verify: hermetic smoke against a throwaway `tmux -L g2cc-smoke` server (mirror of
  the phase9 sandbox pattern); send-keys round-trip; grid-render parity through
  scene_to_png.

## Phase 6 — Navigation line on glass (small; client allow-list + server)

His pain: Maps auto-backgrounds itself mid-navigation; voice prompts arrive too
late; the watch shows only the next maneuver. Google Maps' live nav
notification is ongoing-flagged — we already RECEIVE ongoing (r17 manifest
change) and drop it; allow-list `com.google.android.apps.maps` nav
notifications through as a new `nav` class. It carries the current maneuver +
distance + the "12 min · 3.4 mi · 14:32 ETA" line — that's the watch's data,
now on glass: a PERSISTENT top-line while blanked (nav is continuous, not a
5 s flash — the Phase-2 flash machinery with no auto-dismiss while the nav
notification lives; updates in place; clears when navigation ends). Awake =
a normal title-flash class. No Tasker needed — the listener sees everything
Tasker would. Single-maneuver lookahead is inherent to the source (own-routing
REJECTED — see §D).

## Phase 7 — Media controls window (Adam-specced)

MediaSessionManager via the existing NLS grant (`getActiveSessions`) — works
for any player. New additive wire: client `media_state` (track/artist/album/
duration/position/playing + small album-art JPEG b64, the Phase-1 downscale
path) pushed on change; server `media_cmd {play_pause|next|prev|shuffle}`.

- **Menu order is the safety design** (Adam): `Play/Pause` TOP, `Skip` below,
  `Prev`, `Random`, … — an accidental tap pauses, never skips mid-song.
- Content: "a real media player" — track · artist · album, a position bar
  (text-rendered `▕████░░▏ 2:31/4:05`, ticked ~5 s by server-side extrapolation
  from PlaybackState, no per-second wire spam) + a **small album-art image
  region** beside the text (≤4-image-region budget allows a text+image mixed
  compose mode; art pushes once per track, ~1 s).
- **Lyrics**: LRCLIB lookup (artist+title+duration; Q6) → cached forever in
  Postgres → a lyrics PAGE; when the LRC is synced, the CURRENT line renders
  large and advances with position — glasses karaoke for free. No lyrics found
  = the page says so; never blocks the player.

## Phase 8 — Mail becomes a full mail program

Adam: reply/compose/forward + "image conversion and display automatically" —
the standard controls were always the plan's missing half.

- **Read side**: `read_maildir.py read` grows part extraction — inline/attached
  images (cid + attachments) saved to a temp cache → page-≥2 IMAGE pages via
  the proven pipeline (the Notices/MMS pattern). HTML-only mail keeps the text
  fallback; REMOTE images stay unfetched (privacy + complexity — out).
- **Write side**: a `send_mail.py` (msmtp or smtplib → smtp.migadu.com, reusing
  the ONE set of migadu credentials mbsync already uses — one-time ~/.msmtprc,
  NEVER committed) building proper RFC822 — Reply (quoted original +
  In-Reply-To/References threading), Reply-all, Forward (original attached),
  Compose (contact = dictated or picked from recent senders). All text via the
  dictation confirm flow; the read view menu gains
  `[Reply, Forward, Del, Mark unread, …]`.
- **Del** moves to the Maildir `.Trash` (mbsync propagates) — confirm page,
  **Cancel-first** (the r17 rule). Mark-unread = S-flag removal (mark_read's
  inverse). Sent mail lands in the Maildir Sent folder for mbsync.
- Verify: sandbox-Maildir round-trips in smoke (compose→file exists w/ correct
  headers; reply threading; image-part extraction against a fixture mail).

## Phase 9 — The voice-control layer (Adam, A6/A7: "control everything via voice when necessary")

Two slices; the hands-free pipeline is shared. The mic budget is approved
(all-day-wear DJI, rotating TXs). Ask is renamed **Dictate** (lands with Ph11's
menu work) — dictation is the entry point for BOTH prompts and OS control.

**9a — Reader voice-paging** (the proof slice): while Reader is open AND its
per-session `Voice: on` toggle is set, the mic streams continuously; the
server VAD-segments → warm Parakeet (the GPU idles all day anyway) → accepts
ONLY a bare "next"/"back" utterance (anything with other words is ignored —
factory chatter must not page); one page per utterance. Client: a new additive
`mode: handsfree` on audio_start; leaving Reader / toggling off / WS drop
stops the stream (the established mic-hygiene rules).

**9b — "G2" wake-word OS control** (gloves-on, input-free operation): an
explicit always-on toggle streams continuously EVERYWHERE; utterances are
transcribed and parsed against a DETERMINISTIC grammar gated on the "G2"
prefix (Adam's examples: "G2 Mail", "G2 SMS", "G2 read first E-Mail",
"G2 read Becky's last text"):
- **Navigation/read commands execute immediately** (harmless + reversible):
  window switching by name/category, blank/wake, next/back/up, "read first
  e-mail", "read <name>'s last text" (the SMS half needs Ph4b), timers/notes
  (the existing confirmed-dictation intents, now voice-reachable).
- **Content-SENDING commands voice-confirm**: anything that would send a
  prompt/reply renders the normal confirm page and waits for "G2 confirm" /
  "G2 cancel" (or a tap) — nothing reaches CC/SMS/mail unread, voiced.
- Non-matching utterances are silently ignored (logged at debug volume —
  the one sanctioned quiet path, else 8 h of factory audio = log spam);
  a "G2"-prefixed utterance that matches NO grammar rule logs loudly.
- [U] heavy: wake-word false-positive/miss rates need factory-audio tuning;
  the grammar ships small and grows from his real usage.

## Phase 10 — Stats threshold alerts (small; server-only)

The 10 s sampler feeds rules: `(metric, threshold, SUSTAIN duration, re-arm)` —
**sustained means sustained** (Adam: "not just a couple of minutes while
generating an image"). Defaults to tune in config:
- GPU temp > 87 °C for 10 min · CPU temp > 95 °C for 5 min (throttle land)
- RAM > 95 % AND swap > 50 % for 10 min · any volume > 95 % for 30 min
- Re-arm: no repeat within 2 h unless it dropped below and re-crossed.
Fires priority `info` through the notification layer (flash class — and the
Phase-2 blank flash if dark). Smoke: synthetic ring injection → alert fires
once, sustain window respected, re-arm honored.

## Phase 11 — Main becomes a category launcher (Adam 2026-06-12, XFCE-style)

The window count is about to double (SMS, Media, Terminal, Search, Deliveries,
Car) — the flat switcher menu won't scale. New Main:
- **Menu = categories** (approved, A7): **`Dictate`** (renamed from Ask —
  the voice entry point for prompts AND OS control, Ph9) stays TOP-LEVEL,
  then `AI` (Aria, CC) · `Comms` (Mail, SMS, Notices) · `Media` (Media
  player, Reader) · `Tools` (Files, Terminal, Search, Timers) · `Info`
  (Calendr, Stats, Deliveries, Car) · `Games` · `Reload`. Tap a category →
  the MENU swaps to that category's programs (Back/double-tap returns to
  categories — the established level pattern).
- **Content = MRU dashboard**: the two-column summaries show only the MOST
  RECENTLY USED windows — as many as fit ONE page (~10–12 across two columns;
  WM tracks switch timestamps). Selecting a category swaps the content to that
  category's programs' summaries. Never paginates.
- Window `category` becomes an OsWindow field; the dash/menu derive from it
  (new windows self-place). Smoke: category nav round-trip, MRU ordering,
  one-page guarantee.

## Phase 12 — Universal Search (server-only)

Dictate a query (the Ask confirm flow, scoped to a new Search window) → ONE
results list across: mail (subjects + read-path bodies via read_maildir), file
NAMES under the Files locations (bounded find, B4 subprocess), conversation
history (Postgres `turns` ILIKE/tsvector), and the notes inbox. Rows tagged by
source (`✉/📄/🗨/📝`); tap opens the thing in its OWN window (Mail read /
Files actions / History read / note view). Paged, loud empties, per-source
failures isolated (one slow source can't blank the rest — Promise.all with
per-row catches, the dashboard-summary pattern).

## Phase 13 — Deliveries (server-only; GMAIL-driven — A8)

Carrier/bulk mail lands in Adam's GMAIL (migadu is the human-only box), so the
source is the Gmail API via **aria's existing Google OAuth + a one-time
`gmail.readonly` scope re-consent** (the calendar precedent, gate A3.1; done
at home once when this phase lands). A 15-min sync queries carrier senders
(`from:(usps.com OR ups.com OR fedex.com OR amazon.com) newer_than:30d` —
list grows from real mail), parses tracking id/carrier/status/last-update
into a `deliveries` table; unparsed carrier mail renders LOUDLY as
`(unparsed — see log)` rows, never a silent miss. Surfaces: a dashboard line
(`Deliveries: 2 in transit · 1 out today`), a small window (list → detail),
an out-for-delivery flash. Fallback if OAuth scope is refused: an mbsync
gmail channel w/ app password into a second Maildir (same parser).

## Phase 14 — Audio memos (small; server + intent)

`memo: <anything>` at the Ask confirm step (sibling of `note:`): saves BOTH
the raw audio clip (the buffered PCM already in hand → wav on disk under
~/g2cc-memos/) AND the Parakeet transcript (Postgres row + a line in the
notes inbox pointing at the wav). Retention unlimited (the standing rule).
A `Memos` page under the Notes/Search surfaces later if volume warrants.

## Phase 15 — Phone finder (tiny; client + intent)

`find my phone` intent (Ask confirm) → server sends `phone_locate` (additive)
→ client maxes STREAM_ALARM volume + plays a loud tone ~30 s (FGS may start
playback; restore volume after; cancel on any phone interaction). Loud diag
both ends.

## Phase 16 — OBD-II Car window (hardware-gated; the G2CC app IS the bridge — A9)

Simpler than the Tasker/Aria relay Adam sketched: the phone app already talks
to both the truck's airspace and the server. **Dongle: vGate iCar Pro
Bluetooth 3.0** (classic SPP — a separate radio path from the glasses' BLE;
AUTO-SLEEP so it lives in the OBD port without draining the truck battery;
~$25). Flow: the app watches for the bonded dongle's ACL_CONNECTED (it wakes
with the ignition) → opens a classic BluetoothSocket worker in
ConnectionService → polls PIDs (coolant, RPM, speed, voltage, DTCs) → streams
additive `obd_state` over the EXISTING WS. The server STORES history
(`obd_samples` — trends/DTC log, unlimited per the retention rule) and renders
a `Car` window (live gauges page + DTC list w/ plain-English lookups) + a
dashboard line while connected. Works with the glasses OFF too — phone→server
logging continues, so drives are recorded regardless. [U] real-truck
verification; final PID list tuned on the actual vehicle.

## Phase 17 — Files trash can (small; server-only)

`Del` moves to `~/.g2cc-trash/<timestamp>-<name>` instead of unlink (same-FS
rename; EXDEV falls back to copy+remove — the r16 transfer machinery).
Purge entries older than 30 days (confirmed, A10) on a daily sweep, LOUDLY
logged. The
confirm page stays Cancel-first; the result page says "moved to trash
(restorable for 30 days)". A `Trash` location appears in Files locations —
restore = the existing Move flow.

## Phase 18 — Chess: tiles redraw ONLY when the board changes (Adam 2026-06-13)

Adam: *"the image tiles for the chessboard should ONLY redraw when changed,
not every single time I do anything, and only the changed tile should redraw,
not all 4 every time."*

**Root cause (verified in the wire stack, not guessed):** the board is 4 image
tiles in the content pane; the menu is a native LIST in the left slot. The
chess Moves flow (the 2026-06-12 design) keeps the board in the content pane
while the MENU swaps piece-groups → SAN moves → Confirm. But on the client,
`Scene.diff` flags ANY list-items change as `layoutChanged` (there is **no
list-content-update opcode** — `DisplayProto` has only f1=0 launch / f1=3
image / f1=5 text / f1=7 layout / f1=12 keepalive; list items ride the layout
frame), and the f1=7 layout rebuild re-declares every region and re-pushes
**all** image content (`setScene`→`imageContentOps(allImageRegions)` — a
re-declared image container is emptied on the firmware, so unchanged tiles
MUST be re-pushed or they blank). Net: every selection tap re-pushes the SAME
board (~4 tiles × ~1 s = the multi-second lag), 3-4× per move.

**The firmware constraint is load-bearing and UNVERIFIABLE here:** whether an
f1=7 preserves an unchanged image container's pixels is untested on the glass,
and an all-black tile CRASHES the glasses — so the fix must NOT gamble on
"skip re-pushing unchanged tiles after a rebuild." It works WITH the diff
instead: only let tiles ride the wire when the *position* is genuinely new,
and keep the menu stable while a board is on screen so the per-tile content
diff (already implemented, client-side) can do its job.

**Fix (server-only; `os-windows.ts` GamesWindow + a smoke):**
- **Selection leaves the board.** `chess-pieces` and `chess-moves` become
  **content browse lists** (piece groups; then that group's SANs) with a
  stable `[Back, Reload, Main]` menu — NO board tiles. Selection taps are now
  instant (a browse-list is cheap text, no image push). The board is shown on:
  `chess` (the live position) and `chess-confirm` (the move PREVIEW) — the two
  places the board is the actual subject and the position is new.
- **Board-bearing menus stay constant.** On the `chess` level the cycling
  `Skill: N` item becomes a constant `Skill` (value shown in the title/info),
  so cycling skill / other secondary actions don't change the list → no f1=7
  → no board re-push. `New game`/`Moves` were already constant.
- **No identical re-renders.** The window already tracks `boardFen` and the
  `renderBoard` promise-cache dedups; assert no new tile push happens when the
  FEN is unchanged. The per-tile diff then gives "only the changed tile" for
  free on any board update that lands on an unchanged layout.
- **Documented residue:** a genuinely-new board shown right after a layout
  change (browse→preview, confirm→result) still pushes all 4 tiles — that f1=7
  wipe is the firmware constraint above. The fix kills the REDUNDANT
  same-position re-pushes (the complaint) and caps new-position pushes at ≤2
  per move (preview + result) instead of 3-4. NOTE: this trades away the
  2026-06-12 "board stays visible during selection" choice for responsiveness
  — a 1-line revert restores tiles on those levels if Adam prefers the lag.
- Verify: phase11-games smoke asserts chess-pieces/chess-moves render `browse`
  (not `tiles`), the chess-level menu has a constant `Skill`, and re-entering a
  level with the same FEN yields byte-identical board tiles (cache hit).

## Phase 19 — Files becomes a real file manager, properly (Adam 2026-06-13)

Adam: the file manager *"won't list the contents of a directory with too many
files or files with really long names … an error about it being 970 bytes or
something,"* plus *"add more file-manager-esque usages like copying
directories and such … a well-considered pass … make it a lot better."*

**Root cause of the "970 bytes" failure (verified):** `composeScene` runs
`estimateLayoutFrameBytes()` and THROWS over `LAYOUT_FRAME_BUDGET_BYTES` (960)
to stay under the multi-packet wall. Files paginates with a FIXED
`BROWSE_PAGE = 14` rows; a deep cwd (long title, middle-clamped but still
~110 B) + 14 long filenames (each clamped to 40 B = 43 B encoded) + the `..`
row + chrome ≈ 970 B → the throw lands in `errorView` and the directory NEVER
displays. The page size must be **byte-aware**, not a fixed count.

**Fix A — byte-aware browse pagination (the bug; `os-windows.ts`):**
- `browsePageItems(all, offset, reserveBytes?)` packs as many rows as fit a
  conservative per-page byte budget (Σ 3 + UTF-8 bytes per row) AND ≤ a row cap
  that leaves headroom under the 20-item SDK list cap for the prev/more rows.
  Long names → fewer rows/page; short names → more (strictly better than 14).
  It returns `{ items, map, prevOffset, nextOffset }` (variable pages mean
  prev/more can't be `±BROWSE_PAGE` anymore — they jump to the real adjacent
  page boundary, computed deterministically from 0 so view() and the tap
  handler always agree). `reserveBytes` lets a caller that prepends rows (Files
  prepends `..`) reserve their budget.
- Update every `browsePageItems` tap site to set its offset from
  `prevOffset`/`nextOffset` instead of `± BROWSE_PAGE`. The DB-paged windows
  (Mail/Notices/History) keep their fixed-LIMIT fetch but render through the
  same byte-aware trim so a full page of long subjects can't wall either.
- The compose-side throw STAYS as the loud backstop (now effectively
  unreachable for browse) — defense in depth, never a silent blank.

**Fix B — directories are first-class (Adam's "copying directories and such"):**
- `Move`/`Copy`/`Del`/`Stats`/`Rename` now work on DIRECTORIES, not just files.
  Tapping a dir still DESCENDS (fast nav, the 2026-06-12 rule); to ACT on a
  directory you enter it and use the tree-level menu, which operates on the
  CURRENT dir: `[Up, New, Copy, Move, Del, Rename, Stats, Reload, Main]`. "Copy
  folder A into B" = enter A → Copy → pick B → Copy here. Files get the existing
  tap→actions menu (now with Rename).
- `doTransfer` handles dirs: copy = `fs.cp(src,dst,{recursive,errorOnExist})`;
  move = `rename` then EXDEV-fallback to recursive `cp`+`rm` (the r16 transfer
  machinery, extended). Delete handles dirs via `fs.rm(path,{recursive})` —
  the confirmDel page (Cancel-first) gains a "recursively, N items" warning for
  dirs. All ops stay `opBusy`-serialized, loud on every outcome, no overwrites.
- **New folder** and **Rename** take a name via the dictation confirm flow
  (Files gains `onStt`/`onSttError`, mirroring SessionLevel): `New` → dictate →
  confirm → `mkdir`; `Rename` → dictate → confirm → `rename` within the same
  dir (name only; no path moves — that's Move). Robot text gets the Parakeet
  confirm so a misheard name never lands silently.
- Phase 17's trash integrates here (Del → `~/.g2cc-trash`, restorable) — built
  together; a `Trash` location + restore-via-Move.
- Verify: phase1-files smoke gets a deep dir of long-named files (no throw,
  pages navigate), a recursive dir copy + move (EXDEV path with a temp other-FS
  shim), a recursive delete, a mkdir, and a rename round-trip on a sandbox tree.

## §D — Carried over / deliberately OUT (unchanged gates)

- **Lichess** (v1 Phase 11 deferral, gate A3.2): waits for Adam's `board:play`
  token after the on-glass batch tests clean; spec block lives in the v1 doc
  (`60e6578:upgrades.md` §Phase 11).
- **v1 Phase 12 stretch** (streaming STT; the layer-3 `display` MCP tool — needs a
  design doc first): still gated on Adam's explicit go-ahead.
- **v1 Section D**: calls (root-vs-SIP decision pending), hat-gated items
  (HAT_BRIDGE_SPEC.md), swarm-gated dispatch, Mermaid/```image fences.
- **MMS sending** (new): out until 4b proves the read path.
- **REJECTED 2026-06-12 (Adam)**: own-routing GPS navigation ("implementing our
  own entire parallel GPS tracker is a little much" — the Ph6 notification
  mirror is the feature); RSVP speed-reading (split attention, gloves);
  CC recipes (CC already does it); n8n intents (unused leftover); morning
  briefing (aria covers it); notification profiles (manual tweaking preferred).

## Order + verification contract

Suggested order: **18 → 19 (+17) → 2 → 10 → 3 → 14 → 11 → 12 → 8 → 5 → 13 → 1
→ 6 → 7 → 4a → 15 → 4b → 9 → 16** (Adam's two 2026-06-13 explicit asks FIRST —
the chess redraw fix and the Files overhaul, with the Files trash P17 folded
into P19 since they share the same code; then the server-only batch that can
be fully smoke-verified here; then the client batch that needs an APK rebuild +
Adam's on-glass check; OBD last — hardware-gated). Every phase: build → smoke
(extend the suite — the isolated `g2cc_smoke` DB + temp-notes rules from
`_env.mjs` apply) → restart → CHANGELOG WHY-entry → HANDOFF refresh → Adam's
on-glass check for anything [U].

// Note:  Wake-word should be "butterscotch" as that is ideal for the STT.
