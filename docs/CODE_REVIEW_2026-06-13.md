# Code review — 2026-06-13 (whole-project, post the Phase 18/19/2/10/17 batch)

Five parallel read-only review passes (my new code; the WM/compose core; server
infra; client Kotlin; Python scripts), then EVERY candidate finding
double-checked against the code before acting (Adam's standing rule: a finding
that merely *fits* isn't *proven*). Outcome: the real server-side bugs are fixed
+ smoke-verified (12/12); two "findings" were verified NOT real; four real
CLIENT findings are deferred (I can't on-glass-verify, and the rules forbid
shipping blind BLE/service changes — they're listed here for the next APK cycle).

This is the actionable record. CHANGELOG r18 has the prose WHY.

---

## FIXED (server-only, smoke-verified)

### F1 — Files `pickDest` navigation (MED; two reviewers converged, one reproduced at runtime)
`os-windows.ts` FilesWindow. Two coupled defects in the destination picker:
- The pickDest menu (`[<verb> here, Cancel, Reload, Main]`) was rendered with
  `menuMode` following `this.focus`, but pickDest's `onBack` popped the dest
  stack and NEVER flipped focus to `'menu'` (unlike every other browse level).
  So the menu was a passive region — the verb / Cancel / Reload / Main were
  **dead UI**, and **depositing a file into a location ROOT** (e.g. move into
  `/home/user` itself) was impossible (the only reachable deposit was
  tap-a-subfolder → pickAction).
- Cancelling / backing out of a **current-directory** Move/Copy (`actionIsCwd`,
  which comes from the tree menu, not the actions level) landed in the FILE
  `actions` level, rendering the directory as a 0-byte file, and leaked
  `actionIsCwd`/`actionIsDir`.

**Fix:** pickDest `onBack` now flips `content→menu` on the first double-tap
(verb/Cancel reachable; matches tree/locations), then pops on the next; the
Cancel handler + the location-stage back return to `tree` when `actionIsCwd`
(else `actions`) and clear `actionIsCwd`/`actionIsDir`. Smoke `phase1-files`
asserts the flip makes the menu the capture region (`8a-flip`).

### F2 — `phase10-calendar` smoke flake (it was a TEST bug, not a product bug)
`sweepReminders()` (calendar.ts) fires each reminder with `void notify(...)`
(fire-and-forget — deliberate; the live glasses react to the hub emit, not a DB
read) and returns a count from the atomic `reminded_at` UPDATE. The test then
read the `notifications` table SYNCHRONOUSLY and raced the still-pending INSERT
across the pg Pool → intermittently 0 rows. **Fix:** the test polls
(`waitForRows`). The product is correct as-is — awaiting `notify()` in the sweep
would couple a 60 s render-class tick to a store write (violates
no-await-store-in-a-hot-path). Verified 3/3 reruns green.

### F3 — `actionIsCwd`/`actionIsDir` not cleared in `doRename`/`doMkdir` (LOW; hygiene)
`doDelete`/`doTransfer` cleared them; the two name-entry ops didn't. No concrete
misroute (every reader re-sets them first), but the project's "transient flags
clear on every exit path" rule. Fixed.

---

## VERIFIED NOT REAL (do not re-chase)

### N1 — "calendar ghost-delete wipes the agenda on an empty fetch"
`upsertEvents` DELETEs future-window events whose uid isn't in the fetched set;
an empty fetch (`uids=[]`) would delete all. BUT `read_gcal.py` wraps `main()`
in `try/except → stderr + sys.exit(1)`, and `fetchCalendar` REJECTS on non-zero
exit, so `syncCalendar` throws BEFORE upsert/delete. A `[]` (exit 0) therefore
only means a genuinely-empty calendar — where deleting the (also-empty) future
cache is correct. Not a bug.

### N2 — "`void this.setDoc(...)` / `void this.prompt(...)` in `turn_complete` = unhandled rejection"
`prompt()` is fully `try`/`catch`ed (every throw → `showError`, the early
returns handle the rest) so it can't reject; `setDoc()` is synchronous (no
`await`; pure-text assembly + a render the WM loop catches). Neither `void` can
reject. Not a bug.

---

## DEFERRED — real CLIENT findings (need an APK + Adam's on-glass verify)

I did NOT change client code: I can't verify on real glasses, and breaking the
daily-driver BLE/notification path unmonitored is the exact failure the rules
guard against. Apply + verify these next APK cycle (bump `OsLayout.OS_VERSION`):

### C1 — MMS image decode/encode on the MAIN thread (MED)
`service/NotifyListener.kt` `forward()` → `loadPicture()` (`BitmapFactory.decodeStream`
of a multi-MB MMS photo) + `encodeJpegB64()` (scale + JPEG, up to 2×) run inline
on the NotificationListener MAIN thread. The file's own KDoc says callbacks
"run on the MAIN thread — keep them cheap"; a slow/throwing callback is what
produces the zombie-listener state it works to avoid. **Fix:** offload
`loadPicture`+`encodeJpegB64` to a background dispatcher (the service scope) and
forward when done. (The expensive path is gated behind the dedup check, so only
the first occurrence per image pays it — but on the main thread.)

### C2 — reconnect dead-end on a DISCONNECT (not error) mid-`recoverSession` (MED, uncertain)
`service/ConnectionService.kt` `onLensDisconnected`: during an in-flight
`recoverSession()` (`recovering=true`, `_launched=false`), a lens that reaches
`GattConnected` then emits `Disconnected` (RF/body-block / powered off) hits the
`else if (recovering)` branch — which ONLY logs. It doesn't clear `recovering`,
doesn't retry, and `teardown()` already cancelled the watchdog/sync/clock jobs.
Recovery then depends entirely on Nordic `useAutoConnect(true)` re-firing Ready.
The sibling `Error` branch deliberately clears `recovering`/`_connecting` for
exactly this reason — the `Disconnected` path lacks the equivalent. **Fix:**
mirror the Error branch's re-arm (or clear `recovering` so the watchdog can
re-trigger).

### C3 — `_connecting` never reset on a successful launch (LOW; currently masked)
`service/ConnectionService.kt`: `connect()` sets `_connecting=true`; it's cleared
on scan-fail / pre-launch error / cold-launch FAILURE / teardown — never on the
success path. Masked today because every guard also checks `_launched`. **Fix:**
set `_connecting.value=false` alongside `_launched.value=true` in the
cold-launch-OK block.

### C4 — `startForeground` fallback `catch` is itself uncaught (LOW, uncertain)
`service/ConnectionService.kt` `startInForeground()`: if the typed
`startForeground` throws, the `catch` calls `startForeground(...,
CONNECTED_DEVICE)` with no surrounding try — a second throw (e.g.
`ForegroundServiceStartNotAllowedException` on a background-initiated start)
crashes the service start. **Fix:** wrap the fallback too; log + `stopSelf()`
rather than crash.

---

## NOTED — by-design / dormant (decisions for Adam, not bugs)
- **Timer re-fire during a DB outage** (timers.ts `fire()`): if the
  `SET fired=true` UPDATE throws, it notifies anyway and the row stays
  `fired=false`, so a restart re-fires it "(late)" — the deliberate "loud, never
  silently drop an alarm" tradeoff, but it can duplicate alarms while Postgres is
  down. Policy call.
- **Mail dashboard summary is stale** until the window is first opened
  (reads view-cached `this.total`, unlike Timers/Calendar/Notices which query
  fresh) — leaving it because a fresh count means spawning `read_maildir.py` on
  every 30 s dashboard render.
- **RNNoise runs at 16 kHz into a 48 kHz model** (audio-preprocess.ts) — only on
  the LEGACY phone-mic path, which is removed per the prime directive (DJI
  bypasses it). Dormant.
- Python render scripts (`render_chart`/`render_board`) raise bare `KeyError` on
  a missing JSON field and `render_board` has no min-canvas guard — all loud-fail
  (exit 1, server rejects cleanly) and aren't reachable with the fixed
  server-supplied args. `scene_to_png.py` (offline dev tool) misses a
  string-typed reserved clock id. Low value; left.
