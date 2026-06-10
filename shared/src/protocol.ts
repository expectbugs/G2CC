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

/** Text content — the firmware renders the font. */
export interface SceneTextContent {
  kind: 'text'
  text: string
  /** Container scroll flag (firmware scrolls overflow). On the wire this IS
   *  isEventCapture (text f11 — docs/G2_BLE_PROTOCOL.md §13.2). Layout-level —
   *  a change forces a layout re-push, see Scene.kt. Defaults to false. */
  scroll?: boolean
}
/** Image content: a base64 4bpp-gray BMP the PC already rasterized (the exact
 *  Gray4Bmp format the firmware accepts). Must be ≤288×144 per the render
 *  constraints — the PC tiles anything larger into multiple image regions. */
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

/** A ring/gesture input event forwarded from the client's EventParser. */
export type InputEventKind =
  | 'tap'
  | 'double_tap'
  | 'scroll_up'
  | 'scroll_down'
  | 'scroll_focus'
  | 'hub_select'
  | 'hub_gesture'
  | 'focus'

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
 *  never sends this, so it is completely unaffected by the OS path. */
export interface OsAttachMsg { type: 'os_attach' }

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
}

export type ClientMessage =
  | AuthMsg
  | ClientHbMsg
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
 *  Mic failures surface as diag messages (loud), never silently. */
export interface AudioRequestMsg {
  type: 'audio_request'
  action: 'start' | 'stop'
}

export interface ErrorMsg {
  type: 'error'
  message: string
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
  | ErrorMsg
