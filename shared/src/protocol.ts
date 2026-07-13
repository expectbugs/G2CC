// G2CC WebSocket Protocol — Client <-> Server message types
//
// Inheritance: g2code/shared/src/protocol.ts ported with extensions for:
//   - Dispatch-target-agnostic design (vanilla CC today; swarm specialists later)
//   - Directory-picker UX (HUD scrolls /home/user/* and picks cwd for CC subprocess)
//   - confirm_on_hud primitive (Phase 7) — server asks HUD a yes/no question
//   - Channel Router ack/verified delivery status (Phase 7)
//   - Heartbeat (hb / client_hb) per g2aria's reconnect pattern
//
// See docs/INHERITANCE_MAP.md for full source-of-truth lineage.

// ============================================================
// Shared types
// ============================================================

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

export interface SessionSummary {
  id: string                // CC session ID (for --resume)
  name?: string
  project: string
  lastActive: string        // ISO-8601 timestamp
}

export interface ActiveSessionSummary {
  id: string                // pool entry UUID
  name: string
  project: string
  state: 'idle' | 'streaming' | 'permission' | 'processing'
  contextPct: number
}

export interface BackgroundAlert {
  sessionId: string
  alertType: 'permission' | 'complete' | 'error'
}

/** A dispatch target the server can route prompts to. Today the only
 *  target is vanilla Claude Code. When the swarm exists, additional
 *  targets ('swarm-code', 'swarm-full') will be exposed via the same
 *  message shape — no app-side change required. */
export interface DispatchTarget {
  /** Stable identifier — e.g. 'cc' for vanilla Claude Code. */
  id: string
  /** Human-readable label shown on the HUD menu. */
  label: string
  /** Optional sub-flow hint: 'directory-picker' means the HUD must
   *  next show a `/home/user/*` directory list and `directory_select`
   *  is required before prompts can flow. */
  flow?: 'directory-picker' | 'immediate'
}

/** Entry in a directory listing (the /home/user/* picker that
 *  appears after the user selects 'Claude Code' from the menu). */
export interface DirectoryEntry {
  /** Basename, e.g. "aria". */
  name: string
  /** Absolute path, e.g. "/home/user/aria". */
  path: string
  /** mtime as a unix-epoch ms timestamp (for sort by recency). */
  mtime: number
  /** Number of children; informational only — HUD may show or skip. */
  entryCount?: number
}

/** One SMS/MMS conversation summary (Phase 4b). The phone is the data provider
 *  — the server requests threads on demand and the client replies with these.
 *  `id` is the Telephony thread_id (string for JSON safety). */
export interface SmsThread {
  id: string
  name: string         // contact name, or the raw address if unresolved
  address: string      // canonical address (number/short-code)
  snippet: string      // last message, one line
  unread: boolean
  tsMs: number         // last-message epoch ms
}

/** One message within an SMS/MMS thread (Phase 4b). `incoming` = received
 *  (vs. sent by Adam). `imageB64` carries an MMS image part (downscaled JPEG,
 *  the Phase-1 path); absent for text-only messages. */
export interface SmsMessage {
  id: string
  body: string
  incoming: boolean
  tsMs: number
  imageB64?: string
}

/** Now-playing snapshot pushed by the phone's MediaSessionManager (Phase 7).
 *  All fields optional past `playing` — a paused/empty session still reports. */
export interface MediaState {
  playing: boolean
  title?: string
  artist?: string
  album?: string
  durationMs?: number
  positionMs?: number
  /** The controlling app's package (informational; logged). */
  app?: string
  /** Album art — downscaled JPEG base64 (the Phase-1 encode path); pushed once
   *  per track. Absent when the session exposes no art. */
  artB64?: string
}

// ============================================================
// Glasses-OS display contract (Phase 1 — the remote display loop)
//
// The PC owns all state and composes the CURRENT screen into a WireScene; the
// glasses render it and send input back. The model maps 1:1 onto the proven
// Android render.Scene/Region/Content (android/.../render/Scene.kt). The
// client injects its own reserved clock region (CLOCK_CONTAINER_* in
// constants.ts) into every scene — so server regions MUST NOT reuse that
// id/name nor overlap the clock cutout.
// ============================================================

/** A region's content kind. Mirrors render.RegionKind on the client. */
export type SceneRegionKind = 'text' | 'image' | 'list'

/** Text content — the firmware renders the font.
 *  RESERVED NAMES: 'clock' (rejected — the client injects its own) and 'ant'
 *  (the probe/menu screens' antenna — SceneCodec rewrites its text to the OS
 *  version string; don't name a DE region 'ant'). */
export interface SceneTextContent {
  kind: 'text'
  text: string
  /** Container scroll flag (firmware scrolls overflow). On the wire this IS
   *  isEventCapture (text f11 — docs/G2_BLE_PROTOCOL.md §13.2). Layout-level —
   *  a change forces a layout re-push, see Scene.kt. Defaults to false. */
  scroll?: boolean
}
/** Image content: a base64 4bpp-gray BMP the PC already rasterized (the exact
 *  Gray4Bmp format the firmware accepts). Must be ≤288×129 — the cap the
 *  client renderer ENFORCES (G2Renderer MAX_IMAGE_W/H; the official SDK's 144
 *  is unproven on our direct-BLE path) — the PC tiles anything larger. */
export interface SceneImageContent {
  kind: 'image'
  bmpBase64: string
}
/** Native firmware list widget (the DE menu / browse lists — docs/DE_DESIGN.md).
 *  The firmware draws the selection border and reports the tapped index as a
 *  `hub_select` input (container name + index). Items ride the LAYOUT frame
 *  (the wire has no list content-update message), so the client treats an
 *  items change as a layout change (f1=7 rebuild). */
export interface SceneListContent {
  kind: 'list'
  items: string[]
  /** Item width in px; 0 / omit = auto (wire itemContainer f2). */
  itemWidth?: number
  /** Firmware-drawn selection border (wire itemContainer f3). Default true. */
  selectBorder?: boolean
  /** This list is the page's single input-capture region (wire list f12).
   *  EXACTLY ONE capture region per scene (counting text scroll flags). */
  eventCapture?: boolean
}
/** Reserved for Slice 3 — a `widget` content kind (a small spec the client
 *  rasterizes locally). NOT part of the Phase-1 contract. */
export type SceneContent = SceneTextContent | SceneImageContent | SceneListContent

/** Container border/padding styling (wire f5–f8, official schema
 *  docs/G2_BLE_PROTOCOL.md §6.1). All default 0; zero-valued fields are
 *  omitted on the wire so unstyled regions stay byte-identical to the proven
 *  lean schema. */
export interface RegionStyle {
  borderWidth?: number   // 0–5
  borderColor?: number   // 0–15 gray
  borderRadius?: number  // 0–10
  padding?: number       // 0–32
}

/** One region of the composed screen. id + geometry are server-assigned. */
export interface SceneRegion {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  kind: SceneRegionKind
  /** Border/padding styling; omit for the bare (proven) look. */
  style?: RegionStyle
  /** Omit to declare an empty region (content pushed by a later render). */
  content?: SceneContent
}

/** The full desired screen. The client diffs it against the current scene and
 *  re-renders only what changed (dirty-rect diff in G2Renderer.setScene). */
export interface WireScene {
  regions: SceneRegion[]
}

/** A ring/gesture input event forwarded from the client's EventParser.
 *  'text' (multi-surface, 2026-07-13) is a whole typed line/paragraph from a
 *  surface's keyboard (PC page text bar / phone control mode) — routed to the
 *  window manager's onTypedText, NEVER truncated. */
export type InputEventKind =
  | 'tap'
  | 'double_tap'
  | 'scroll_up'
  | 'scroll_down'
  | 'scroll_focus'
  | 'hub_select'
  | 'hub_gesture'
  | 'focus'
  | 'text'

/** Which kind of display/input surface a client attaches as (multi-surface,
 *  2026-07-13). 'phone' = the Android app (BLE bridge and/or on-phone control
 *  mode — ONE surface either way); 'browser' = the PC page (/pc). Absent on
 *  the wire = 'phone' (pre-1.18 APKs send a bare os_attach). */
export type SurfaceKind = 'phone' | 'browser'

// ============================================================
// Client -> Server messages
// ============================================================

export interface AuthMsg {
  type: 'auth'
  token: string
}

/** Ping from client to server keeping the JS event loop visibly alive.
 *  Sent on every server `hb` and proactively every HEARTBEAT_INTERVAL_MS. */
export interface ClientHbMsg {
  type: 'client_hb'
  now: number
  /** Phone battery percent 0-100 (Phase 9; optional — old APKs omit it).
   *  Feeds the dashboard line + the ≤15% notification. */
  battery?: number
  /** GLASSES battery percent 0-100 (Adam 2026-06-12; optional — v≤1.8 APKs
   *  omit it). Decoded client-side from the 09-00/09-01 device-info frames
   *  (G2_BLE_PROTOCOL.md §10, f4.f12) — [U] until the on-glass batch. */
  g2Battery?: number
  /** Are the glasses currently BLE-connected to the phone? (multi-surface
   *  2026-07-13; optional — pre-1.18 APKs omit it → server keeps null =
   *  unknown). Feeds os_status so the PC page can say "live on glasses". */
  g2Connected?: boolean
}

/** A phone notification forwarded by the client's NotificationListenerService
 *  (Phase 9, READ-ONLY v1 — no inline reply). The server maps `package` →
 *  priority (config notifications.packageMap; default 'info') and routes it
 *  into the Phase-4 notification layer. Additive-optional (B6): old servers
 *  ignore unknown message types loudly; old APKs simply never send it. */
export interface NotifyMsg {
  type: 'notify'
  package: string
  title: string
  text: string
  /** StatusBarNotification.postTime (epoch ms). */
  postedAt: number
  /** StatusBarNotification.key — client-side debounce key. */
  key: string
  /** Optional EXTRA_PICTURE payload (Adam 2026-06-12 — MMS images on glass):
   *  client-downscaled JPEG, base64. Absent for picture-less notifications
   *  and on v≤1.8 APKs. The server caps the decoded size (loud reject). */
  imageB64?: string
  /** The notification carries an inline-reply action with a RemoteInput (Phase
   *  4a) — Notices then offers `Reply`, which dictates a reply the client fills
   *  into that RemoteInput. Absent/false on older APKs and non-replyable posts. */
  hasReply?: boolean
}

/** The phone dismissed a notification it had forwarded (Adam 2026-06-13 dismiss
 *  sync) → the server marks the glasses copy seen. Additive-optional (B6): old
 *  servers ignore it. The client sends it only for keys it actually forwarded. */
export interface NotificationDismissedMsg {
  type: 'notification_dismissed'
  /** StatusBarNotification.key. */
  key: string
}

/** Audio format the phone is about to stream. The server routes on
 *  encoding/channels/rate (NOT on `source`) to the appropriate pipeline:
 *    - `int16` mono 16 kHz → legacy path (preprocess + faster-whisper / Parakeet)
 *    - `float32` 2-channel (any rate ≥ 8 kHz) → DJI noise pipeline
 *      (notch → Wiener-with-learned-PSD → Parakeet) via dji_pipeline_cli;
 *      resampled to the profile rate internally.
 *  Anything else loud-fails with stt_error. All fields default to the legacy
 *  16 kHz mono int16 shape for clients that don't set them. */
export interface AudioStartMsg {
  type: 'audio_start'
  sampleRate?: number          // default 16000
  channels?: number            // default 1
  encoding?: 'int16' | 'float32'  // default 'int16'
  // informational only — logged, NOT used for routing. 'dji-bt' is the DJI TX
  // paired straight to the phone over Bluetooth (HFP/SCO): same 16k/1ch/int16
  // wire shape as 'phone-mic', so it rides the legacy mono path.
  source?: 'phone-mic' | 'dji-usb' | 'dji-bt'
  /** Dictation mode (Phase 9). 'dictate' (default/omitted) = one-shot push-to-
   *  talk → the transcript routes to the active window's onStt. 'handsfree' =
   *  a continuous-listening utterance → routed to the VOICE-COMMAND grammar
   *  (Reader next/back, or the "butterscotch"-prefixed OS grammar) instead. */
  mode?: 'dictate' | 'handsfree'
}
export interface AudioEndMsg { type: 'audio_end' }
// Audio data is sent as raw WebSocket binary frames between audio_start and audio_end.

export interface PromptMsg {
  type: 'prompt'
  text: string
}

export interface CommandMsg {
  type: 'command'
  command: string
}

export interface InterruptMsg { type: 'interrupt' }

export interface PermissionResponseMsg {
  type: 'permission_response'
  approved: boolean
}

export interface SetModeMsg {
  type: 'set_mode'
  mode: PermissionMode
}

export interface GetPageMsg {
  type: 'get_page'
  page: number     // 1-indexed
}

/** Request the available dispatch targets. Server responds with
 *  DispatchTargetListMsg containing today's available targets. */
export interface ListDispatchTargetsMsg { type: 'list_dispatch_targets' }

/** Pick which dispatch target subsequent prompts route through.
 *  If the target's `flow === 'directory-picker'`, the client must
 *  next send DirectoryListMsg + DirectorySelectMsg before any prompt. */
export interface DispatchTargetSelectMsg {
  type: 'dispatch_target_select'
  targetId: string
}

/** Request the current /home/user/* directory list (for the HUD picker
 *  that runs after 'Claude Code' is selected as the dispatch target). */
export interface DirectoryListMsg { type: 'directory_list' }

/** Pick a directory as the cwd for the CC subprocess. Server resolves
 *  against ~/.g2cc/sessions.json: if a saved CC session ID exists for
 *  this path, server spawns with --resume; else fresh session. */
export interface DirectorySelectMsg {
  type: 'directory_select'
  path: string
}

export interface SessionResumeMsg {
  type: 'session_resume'
  sessionId: string
}

export interface SessionSwitchMsg {
  type: 'session_switch'
  sessionId: string
}

export interface SessionCloseMsg {
  type: 'session_close'
  sessionId: string
}

export interface ListActiveSessionsMsg { type: 'list_active_sessions' }
export interface ListSessionsMsg { type: 'list_sessions' }

export interface RewindMsg {
  type: 'rewind'
  turns: number
}

/** Response to a server-initiated ConfirmOnHudMsg.
 *  No timeout — the server waits as long as the user needs. */
export interface ConfirmOnHudResponseMsg {
  type: 'confirm_on_hud_response'
  requestId: string
  result: 'confirmed' | 'rejected'
}

/** Free-form diagnostic line from the phone to the server. Server logs it
 *  with a `[client-diag]` prefix so we can observe phone-side state without
 *  needing adb/logcat access. Used heavily during hardware bring-up. */
export interface DiagMsg {
  type: 'diag'
  text: string
}

/** Channel Router ack — signal that a server-tagged outbound message
 *  was successfully delivered to the glasses HUD via BLE.
 *  status='verified' if BLE write callback confirmed; 'unverified'
 *  if the write failed or no callback fired. NOT an I/O timeout —
 *  per spec §10, the operation continues; only delivery status falls. */
export interface BleAckMsg {
  type: 'ble_ack'
  messageId: string
  status: 'verified' | 'unverified'
  reason?: string
}

/** Opt into Glasses-OS mode (Phase 1). After this, the server drives the
 *  display via `render` and reacts to `input`. The legacy dispatch-menu app
 *  never sends this, so it is completely unaffected by the OS path.
 *  Multi-surface (2026-07-13): the connection attaches to the ONE persistent
 *  OsSession as a surface of `surface` kind; absent = 'phone' (pre-1.18 APKs).
 *  Re-sending os_attach on an already-attached connection is idempotent — it
 *  re-runs the attach render (the app uses this after a BLE cold-launch). */
export interface OsAttachMsg { type: 'os_attach'; surface?: SurfaceKind }

/** A surface asks the server to reset things (multi-surface 2026-07-13).
 *  'soft' = refresh the GLASSES connection: routed to the phone surface as
 *  `glasses_reset` (loud error back when no phone is attached).
 *  'hard' = clean-slate the ENTIRE system in-process: broadcast `hard_reset`,
 *  kill every DE CC subprocess, rebuild the WindowManager fresh at the root,
 *  clear the resume-window pointer — ALL durable user data is kept. */
export interface ResetMsg {
  type: 'reset'
  kind: 'soft' | 'hard'
}

/** A ring/gesture input event (from the client's EventParser). The PC owns the
 *  reaction → updates state → sends a new `render`. Optional fields carry the
 *  payloads for the variants that have them. */
export interface InputMsg {
  type: 'input'
  event: InputEventKind
  /** hub_select: the selected container's widget type + index. */
  widgetType?: string
  index?: number
  /** hub_gesture: the raw firmware gesture code. */
  code?: number
  /** focus: the region the firmware reports as focused/scrolled (our own
   *  region name) and its raw f3 value (observed 1/2 — plausibly direction). */
  region?: string
  value?: number
  /** event 'text' (multi-surface 2026-07-13): one Enter-submitted line/
   *  paragraph from a surface's keyboard. Arbitrary length — NEVER truncated
   *  (the no-truncation rule); the WM routes it to the active window. */
  text?: string
}

/** Result of a Phase-4a inline reply the client attempted (filled a forwarded
 *  notification's RemoteInput + fired its PendingIntent). LOUD either way — the
 *  server renders success/failure so a lost reply is never silent. */
export interface NotificationReplyResultMsg {
  type: 'notification_reply_result'
  key: string
  ok: boolean
  error?: string
}

/** Result of a server-requested SMS send (queue D6 — mirrors the Phase-4a
 *  notification_reply_result flow). The client registers sentIntent
 *  PendingIntents (one per multipart part; ok = ALL parts accepted) and
 *  reports the real outcome. OLD APKs never send this — the server's result
 *  card keeps its honest "Handed to phone (unverified)" wording and merely
 *  UPDATES in place when this lands; nothing ever waits on it. */
export interface SmsSendResultMsg {
  type: 'sms_send_result'
  address: string
  ok: boolean
  error?: string
}

/** The phone's current now-playing snapshot (Phase 7) — pushed on every
 *  MediaSession change while the Media window has it subscribed (media_cmd
 *  subscribe/unsubscribe gate it; old APKs never send it). */
export interface MediaStateMsg {
  type: 'media_state'
  state: MediaState
}

/** Reply to a server `sms_threads_request` (Phase 4b) — the phone is the data
 *  provider; the server queried the Telephony provider on its behalf. `error`
 *  set (with empty threads) when the provider read failed (loud, never silent). */
export interface SmsThreadsReplyMsg {
  type: 'sms_threads_reply'
  threads: SmsThread[]
  offset: number
  total: number
  error?: string
}

/** Reply to a server `sms_thread_request` — one thread's messages, paginated
 *  (newest last; image parts ride `imageB64`). `error` set on a provider read
 *  failure. */
export interface SmsThreadReplyMsg {
  type: 'sms_thread_reply'
  threadId: string
  name: string
  address: string
  messages: SmsMessage[]
  page: number
  totalPages: number
  error?: string
}

/** Live turn-by-turn from the phone's Maps nav notification (Phase 6). The
 *  client allow-lists the ongoing Maps nav notification (normally dropped) and
 *  forwards its maneuver/distance/ETA line; the server pins it as a persistent
 *  top-line (NOT a 5 s flash) until `nav_clear`. Updates in place. */
export interface NavUpdateMsg {
  type: 'nav_update'
  text: string
  /** "12 min · 3.4 mi · 14:32" trailing context, if parseable. */
  eta?: string
}

/** Navigation ended (the Maps nav notification was removed) — drop the pinned
 *  nav line (Phase 6). */
export interface NavClearMsg { type: 'nav_clear' }

export type ClientMessage =
  | AuthMsg
  | ClientHbMsg
  | NotifyMsg
  | AudioStartMsg
  | AudioEndMsg
  | PromptMsg
  | CommandMsg
  | InterruptMsg
  | PermissionResponseMsg
  | SetModeMsg
  | GetPageMsg
  | ListDispatchTargetsMsg
  | DispatchTargetSelectMsg
  | DirectoryListMsg
  | DirectorySelectMsg
  | SessionResumeMsg
  | SessionSwitchMsg
  | SessionCloseMsg
  | ListActiveSessionsMsg
  | ListSessionsMsg
  | RewindMsg
  | ConfirmOnHudResponseMsg
  | BleAckMsg
  | DiagMsg
  | OsAttachMsg
  | InputMsg
  | ResetMsg
  | NotificationDismissedMsg
  | NotificationReplyResultMsg
  | SmsSendResultMsg
  | MediaStateMsg
  | SmsThreadsReplyMsg
  | SmsThreadReplyMsg
  | NavUpdateMsg
  | NavClearMsg

// ============================================================
// Server -> Client messages
// ============================================================

export interface AuthResultMsg {
  type: 'auth_result'
  success: boolean
  error?: string
}

/** Server-driven heartbeat. Client must reply with ClientHbMsg
 *  immediately so the server can detect a frozen JS event loop. */
export interface HbMsg {
  type: 'hb'
  now: number
}

/** Initial config snapshot sent after successful auth. */
export interface ConfigSnapshotMsg {
  type: 'config_snapshot'
}

export interface DispatchTargetListMsg {
  type: 'dispatch_target_list'
  targets: DispatchTarget[]
}

export interface DispatchTargetSetMsg {
  type: 'dispatch_target_set'
  targetId: string
  /** Optional — matches the upstream DispatchTarget.flow which is also
   *  optional. JSON.stringify drops undefined keys, so omission on the wire
   *  is identical to nullability in the Kotlin counterpart's `String? = null`. */
  flow?: DispatchTarget['flow']
}

export interface DirectoryListReplyMsg {
  type: 'directory_list_reply'
  entries: DirectoryEntry[]
}

export interface SessionInfoMsg {
  type: 'session_info'
  sessionId: string                // pool entry UUID
  projectPath: string              // absolute path; cwd for the CC subprocess
  mode: string
  poolSize?: number
  poolIndex?: number
  resumed: boolean                 // true if spawned with --resume
  ccSessionId?: string             // CC's own session UUID once init event arrives
}

export interface OutputMsg {
  type: 'output'
  text: string                     // current page content (paginated, never truncated)
  page: number                     // 1-indexed
  totalPages: number
}

export interface TextDeltaMsg {
  type: 'text_delta'
  text: string
}

export interface ResponseCompleteMsg { type: 'response_complete' }

export interface ToolUseMsg {
  type: 'tool_use'
  tool: string
  description: string
}

export interface PermissionRequestMsg {
  type: 'permission_request'
  requestId: string
  tool?: string
  details?: string
}

export interface SttResultMsg {
  type: 'stt_result'
  text: string
}

export interface SttErrorMsg {
  type: 'stt_error'
  error: string
}

export interface StatusMsg {
  type: 'status'
  mode: string
  contextPct: number
  isProcessing: boolean
  poolSize?: number
  poolIndex?: number
  projectName?: string
  backgroundAlerts?: BackgroundAlert[]
}

export interface CcErrorMsg {
  type: 'cc_error'
  error: string
}

export interface SessionListMsg {
  type: 'session_list'
  sessions: SessionSummary[]
}

export interface ActiveSessionListMsg {
  type: 'active_session_list'
  sessions: ActiveSessionSummary[]
}

export interface BackgroundAlertMsg {
  type: 'background_alert'
  sessionId: string
  alertType: 'permission' | 'complete' | 'error'
  details?: string
}

export interface RewindResultMsg {
  type: 'rewind_result'
  success: boolean
  turnsRewound: number
  summary: string
}

/** Ask the HUD a yes/no question. Single-tap → confirmed; double-tap → rejected.
 *  No timeout — the server waits for ConfirmOnHudResponseMsg as long as the
 *  user needs. Server-side promise rejects loudly if the WebSocket disconnects
 *  before a response arrives (NOT silent). */
export interface ConfirmOnHudMsg {
  type: 'confirm_on_hud'
  requestId: string
  text: string                      // arbitrary length; HUD scrolls (no truncation)
}

/** PC → glasses: render this scene. The client builds a render.Scene from it
 *  (injecting the app-owned clock region) and drives G2Renderer.
 *  Only sent to clients that opted in via `os_attach`. */
export interface RenderMsg {
  type: 'render'
  scene: WireScene
}

/** Server → client: start/stop streaming the phone mic (the DE 'Dictate'/'Ask'
 *  menu actions — docs/DE_DESIGN.md §2). The client drives AudioStreamer,
 *  which sends audio_start / binary frames / audio_end back; STT results
 *  return via stt_result and the server routes them to the active window.
 *  Capture failures surface back as a diag message with the '[audio-error]'
 *  prefix, which the server routes to the active window (loud, never silent). */
export interface AudioRequestMsg {
  type: 'audio_request'
  action: 'start' | 'stop'
  /** Capture mode (Phase 9). 'dictate' (default/omitted) = one-shot push-to-talk.
   *  'handsfree' = continuous listening: the client re-arms after each utterance
   *  and tags its audio_start mode:'handsfree' so the server routes to the voice
   *  grammar. Stop ends either. */
  mode?: 'dictate' | 'handsfree'
}

/** Server → client: cancel a forwarded notification on the PHONE (Adam
 *  2026-06-13 dismiss sync) — fired when it's read on glass / MkAll'd. The
 *  client calls NotificationListenerService.cancelNotification(key); a key it
 *  no longer holds is a harmless no-op. Additive-optional (old clients ignore). */
export interface NotificationCancelMsg {
  type: 'notification_cancel'
  key: string
}

/** Server → client: the DE 'Reload' action — recover a possibly-stuck display.
 *  The client ABORTS any in-flight/queued render ops (releasing a wedged image
 *  ack-wait), then re-runs the COLD_INIT re-takeover with its current scene
 *  (the same proven path as the ~80 s slot renewal), re-pushing everything.
 *  The server follows with a fresh `render` of the recomposed state. */
export interface DisplayReloadMsg {
  type: 'display_reload'
}

export interface ErrorMsg {
  type: 'error'
  message: string
}

/** Server → client: fill + fire a forwarded notification's inline-reply
 *  RemoteInput (Phase 4a). The client finds the active notification by key,
 *  fills the reply action's RemoteInput with `text`, and fires its
 *  PendingIntent; it reports back via NotificationReplyResultMsg (loud). */
export interface NotificationReplyMsg {
  type: 'notification_reply'
  key: string
  text: string
}

/** Server → client: a media transport command for the active MediaSession
 *  (Phase 7). subscribe/unsubscribe register/release the MediaController
 *  callback (and subscribe pushes the current state immediately); the rest are
 *  transport. */
export interface MediaCmdMsg {
  type: 'media_cmd'
  cmd: 'play_pause' | 'next' | 'prev' | 'shuffle' | 'subscribe' | 'unsubscribe'
}

/** Server → client: query the phone's SMS/MMS thread list (Phase 4b). The
 *  client reads Telephony.Sms/Mms + resolves contact names and replies with
 *  SmsThreadsReplyMsg. */
export interface SmsThreadsRequestMsg {
  type: 'sms_threads_request'
  offset: number
  limit: number
}

/** Server → client: query one thread's messages, paginated (Phase 4b). */
export interface SmsThreadRequestMsg {
  type: 'sms_thread_request'
  threadId: string
  page: number
}

/** Server → client: send an SMS to `address` (Phase 4b — the SMS-window Reply/
 *  New flow, after the dictation confirm). Uses SmsManager.sendTextMessage
 *  (needs SEND_SMS). Result returns as a fresh sms_thread_reply on the next
 *  thread refresh; the send itself is acked via a `[sms]` diag (loud). */
export interface SmsSendMsg {
  type: 'sms_send'
  address: string
  text: string
}

/** Server → client: ring the phone to find it (Phase 15). `start` maxes
 *  STREAM_ALARM + plays a loud tone (~30 s, self-stopping; cancels on any phone
 *  interaction). `stop` cancels early. Loud diag both ends. */
export interface PhoneLocateMsg {
  type: 'phone_locate'
  action: 'start' | 'stop'
}

/** Server → BROWSER surfaces only (multi-surface 2026-07-13): who is attached
 *  to the OS session + whether the glasses are BLE-live on the phone. Sent on
 *  attach/detach/g2Connected change. NEVER sent to 'phone' surfaces — a
 *  pre-1.18 APK logs a decode failure per unknown message type. */
export interface OsStatusMsg {
  type: 'os_status'
  surfaces: { id: string; kind: SurfaceKind }[]
  /** null = unknown (no phone attached, or a pre-g2Connected APK). */
  g2Connected: boolean | null
}

/** Server → the PHONE surface: refresh the glasses BLE connection (the Soft
 *  Reset button, possibly pressed on the PC page). The app runs its BLE
 *  session recovery KEEPING the WebSocket, then re-sends os_attach — the
 *  server answers any os_attach with a full re-render. */
export interface GlassesResetMsg { type: 'glasses_reset' }

/** Server → ALL surfaces, broadcast immediately BEFORE the server hard-resets
 *  itself in-process (Hard Reset button). The phone reacts with a full local
 *  teardown (BLE + WS) then auto-reconnects into its previous mode; the PC
 *  page shows "system restarting" and lets its reconnect loop re-attach. */
export interface HardResetMsg { type: 'hard_reset' }

/** PC-native views (multi-surface 2026-07-13): the active window's optional
 *  FULL-FIDELITY content for big screens, broadcast to BROWSER surfaces
 *  alongside each render. The glasses scene stays the source of interaction;
 *  these are richer READ panes (in-memory only — the preview() cost class). */
export interface SurfaceViewReader {
  kind: 'reader'
  window: 'reader'
  title: string
  /** The WHOLE current chapter (pages joined) — never truncated. */
  body: string
  /** Current glasses page index + each page's char offset into body, so the
   *  pane can scroll-sync to exactly where the glasses are. */
  page: number
  pageOffsets: number[]
  progress: string
}
export interface SurfaceViewSession {
  kind: 'session'
  window: string
  title: string
  /** The session doc (prompt + streamed response), unpaginated. */
  body: string
  /** Live phase line (thinking/tool/writing…) or null when idle. */
  state: string | null
}
export type SurfaceView = SurfaceViewReader | SurfaceViewSession
export interface SurfaceViewMsg {
  type: 'surface_view'
  view: SurfaceView | null
}

export type ServerMessage =
  | AuthResultMsg
  | HbMsg
  | ConfigSnapshotMsg
  | DispatchTargetListMsg
  | DispatchTargetSetMsg
  | DirectoryListReplyMsg
  | SessionInfoMsg
  | OutputMsg
  | TextDeltaMsg
  | ResponseCompleteMsg
  | ToolUseMsg
  | PermissionRequestMsg
  | SttResultMsg
  | SttErrorMsg
  | StatusMsg
  | CcErrorMsg
  | SessionListMsg
  | ActiveSessionListMsg
  | BackgroundAlertMsg
  | RewindResultMsg
  | ConfirmOnHudMsg
  | RenderMsg
  | AudioRequestMsg
  | DisplayReloadMsg
  | NotificationCancelMsg
  | ErrorMsg
  | NotificationReplyMsg
  | MediaCmdMsg
  | SmsThreadsRequestMsg
  | SmsThreadRequestMsg
  | SmsSendMsg
  | PhoneLocateMsg
  | OsStatusMsg
  | GlassesResetMsg
  | HardResetMsg
  | SurfaceViewMsg
