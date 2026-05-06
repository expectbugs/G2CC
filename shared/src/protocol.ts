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

/** Audio format the phone is about to stream. The server uses this to route
 *  to the appropriate preprocessing pipeline:
 *    - `int16` mono 16 kHz → existing path (RNNoise + faster-whisper / Parakeet)
 *    - `float32` stereo 48 kHz → NLMS+DFN path (Phase 8; not yet fully wired —
 *      server fails LOUD on this format until the pipeline lands)
 *  All fields default to the legacy 16 kHz mono int16 shape for backward
 *  compatibility with clients that don't set them. */
export interface AudioStartMsg {
  type: 'audio_start'
  sampleRate?: number          // default 16000
  channels?: number            // default 1
  encoding?: 'int16' | 'float32'  // default 'int16'
  source?: 'phone-mic' | 'dji-usb'  // informational; server doesn't gate on it
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
  flow: DispatchTarget['flow']
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
  | ErrorMsg
