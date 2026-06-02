// WebSocket handler — message router + per-client state.
//
// Inheritance: g2code/server/src/ws-handler.ts ported with extensions:
//   - Uses Dispatcher abstraction (CCDispatcher today; future swarm specialists
//     plug in via the same interface — no message-type changes required).
//   - New message types per @g2cc/shared/protocol.ts: dispatch_target_list,
//     dispatch_target_select, directory_list, directory_select, confirm_on_hud,
//     confirm_on_hud_response, ble_ack, client_hb, hb.
//   - Drops the 30s execFileSync timeout (already removed in stt.ts via
//     g2aria's no-timeout shape).
//   - Removes 500-char tool-result truncation (handled in cc-session.ts).
//
// Phase 2A scope: dispatch flow (target → directory → session → prompt → stream).
// Phase 3A adds: server-driven hb heartbeat + APP_ACTIVITY_TIMEOUT_MS kick.
// Phase 7 adds: confirm_on_hud server-side promise + BLE-ack Channel Router status.
//
// AUTH_TIMEOUT_MS = 5s security window for unauthenticated sockets — NOT an
// I/O timeout on a long-running operation. Allowed per the rules.

import type { WebSocket } from '@fastify/websocket'
import {
  AUTH_TIMEOUT_MS,
  STREAMING_UPDATE_MS,
  HEARTBEAT_INTERVAL_MS,
  APP_ACTIVITY_TIMEOUT_MS,
} from '@g2cc/shared'
import type {
  ClientMessage,
  ServerMessage,
  PermissionMode,
} from '@g2cc/shared'
import type { G2CCConfig } from './config.js'
import { validateToken } from './auth.js'
import { type CCUsage } from './cc-session.js'
import { SessionPool, type PoolEntry } from './session-pool.js'
import { Watchdog } from './watchdog.js'
import { transcribe, transcribeDji } from './stt.js'
import { markdownToPlaintext, formatToolUse } from './output-parser.js'
import { listProjectDirectories } from './directory-picker.js'
import { CCDispatcher, DISPATCH_TARGETS, type Dispatcher, getDispatchTarget } from './dispatch.js'
import { ChannelRouter } from './channel-router.js'

let watchdog: Watchdog | null = null

export function setWatchdog(w: Watchdog): void { watchdog = w }

export interface WSClient {
  ws: WebSocket
  authenticated: boolean
  authTimer: ReturnType<typeof setTimeout> | null
  audioChunks: Buffer[]
  collectingAudio: boolean
  // 4th-pass-final review MEDIUM: in-flight STT pipeline tracker. Set true
  // when audio_end fires and we kick off handleAudio (async), cleared when
  // handleAudio returns. Blocks audio_start while a transcription is still
  // running so a rapid record/end/record can't produce misattributed
  // stt_result for the NEW recording from the OLD one in flight.
  sttInFlight: boolean
  pool: SessionPool
  /** Active dispatcher target ID — defaults to the first target ('cc'). */
  selectedTargetId: string
  /** Wraps the active pool entry's CCSession when targetId='cc'. */
  dispatcher: Dispatcher | null
  currentPage: number
  autoScroll: boolean
  mode: PermissionMode
  streamBuffer: string
  streamTimer: ReturnType<typeof setTimeout> | null
  /** Server-side state for in-flight confirm_on_hud requests (Phase 7 wires the client side).
   *  Keyed by requestId; resolves the awaiting promise when ConfirmOnHudResponseMsg arrives. */
  confirmCallbacks: Map<string, (result: 'confirmed' | 'rejected') => void>
  /** Phase 3A heartbeat: server-driven hb cadence + activity tracking. */
  hbInterval: ReturnType<typeof setInterval> | null
  livenessInterval: ReturnType<typeof setInterval> | null
  lastAppActivityMs: number
  /** Phase 7 Channel Router — tracks BLE delivery acks per messageId. */
  router: ChannelRouter
  /** Bug-fix-pass-2 #8: format the phone announced on audio_start. Drives
   *  the route taken in audio_end (handleAudio). */
  audioFormat: AudioFormat | null
}

export interface AudioFormat {
  sampleRate: number
  channels: number
  encoding: 'int16' | 'float32'
  source?: string
}

export function sendMsg(client: WSClient, msg: ServerMessage): void {
  if (client.ws.readyState === 1) {
    client.ws.send(JSON.stringify(msg))
  }
}

export function handleConnection(ws: WebSocket, config: G2CCConfig): WSClient {
  const pool = new SessionPool()

  const client: WSClient = {
    ws,
    authenticated: false,
    authTimer: null,
    audioChunks: [],
    collectingAudio: false,
    sttInFlight: false,
    pool,
    selectedTargetId: 'cc',
    dispatcher: null,
    currentPage: 0,
    autoScroll: true,
    mode: config.claude.defaultMode,
    streamBuffer: '',
    streamTimer: null,
    confirmCallbacks: new Map(),
    hbInterval: null,
    livenessInterval: null,
    lastAppActivityMs: Date.now(),
    router: new ChannelRouter(),
    audioFormat: null,
  }

  pool.on('background_alert', (alert: { sessionId: string; alertType: string; details?: string }) => {
    sendMsg(client, {
      type: 'background_alert',
      sessionId: alert.sessionId,
      alertType: alert.alertType as 'permission' | 'complete' | 'error',
      details: alert.details,
    })
  })

  // AUTH_TIMEOUT_MS — security guard, NOT an I/O timeout. See FORBIDDEN_PATTERN_AUDIT.md §A.
  client.authTimer = setTimeout(() => {
    if (!client.authenticated) {
      sendMsg(client, { type: 'auth_result', success: false, error: 'Auth timeout' })
      ws.close(4001, 'Auth timeout')
    }
  }, AUTH_TIMEOUT_MS)

  ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      if (!client.authenticated) return
      if (client.collectingAudio) {
        client.audioChunks.push(Buffer.from(raw as Buffer))
      } else {
        // Loud-fail per LOUD AND PROUD rule: a binary frame outside the
        // audio_start/audio_end window indicates a misbehaving client or
        // protocol drift. Used to be silently dropped (no log).
        console.warn(`[ws] binary frame received outside audio window (collectingAudio=false) — dropping ${(raw as Buffer).length} bytes`)
      }
      return
    }

    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage
    } catch {
      // Malformed JSON: log loudly but don't crash the connection.
      console.warn('[ws] received malformed JSON; ignoring')
      return
    }

    if (!client.authenticated && msg.type !== 'auth') {
      sendMsg(client, { type: 'error', message: 'Not authenticated' })
      return
    }

    // Wrap handleMessage in .catch so any uncaught rejection surfaces (loud)
    // instead of disappearing into the void. Per the no-silent-failure rule:
    // a handler that throws synchronously before its inner try/catch (e.g. a
    // sync entry.session.kill() throwing) used to silently vanish.
    handleMessage(client, msg, config).catch((err: unknown) => {
      console.error('[ws] handleMessage threw:', err)
      sendMsg(client, { type: 'cc_error', error: `Handler crashed: ${err instanceof Error ? err.message : String(err)}` })
    })
  })

  ws.on('close', (code: number, reason: Buffer) => {
    if (client.authTimer) clearTimeout(client.authTimer)
    if (client.streamTimer) clearTimeout(client.streamTimer)
    if (client.hbInterval) clearInterval(client.hbInterval)
    if (client.livenessInterval) clearInterval(client.livenessInterval)
    // Reject any in-flight confirm_on_hud promises — loud failure, not silent.
    for (const [, resolve] of client.confirmCallbacks) {
      // The caller awaits 'confirmed' | 'rejected'. On socket close we surface as 'rejected'
      // with an attached log so the calling code knows why.
      console.warn(`[ws] client closed (code=${code} reason="${String(reason)}") with confirm pending`)
      resolve('rejected')
    }
    client.confirmCallbacks.clear()
    // Phase 7: in-flight Channel Router acks all fall to 'unverified'.
    client.router.onClientDisconnect()
    // Kill all CC subprocesses owned by this client. The pool is per-client
    // (created in handleConnection), so once the WebSocket closes there's no
    // route for these CC processes to send their output anywhere. Leaving them
    // alive orphans them past the WS close (g2code's bug we inherited).
    // Explicit policy: kill on disconnect. The "persist + auto-resume on
    // reconnect" alternative is documented in HOLDS.md but not implemented here.
    // Capture count BEFORE the kill loop — after it runs, client.pool.count is 0
    // and the log would always say "killed 0 sessions" (4th-pass L4).
    const killedCount = client.pool.count
    for (const entry of client.pool.allEntries()) {
      watchdog?.unregister(entry.id)
      client.pool.closeSession(entry.id)
    }
    console.log(`[ws] client closed (code=${code} reason="${String(reason)}") — killed ${killedCount} sessions`)
  })

  return client
}

async function handleMessage(client: WSClient, msg: ClientMessage, config: G2CCConfig): Promise<void> {
  switch (msg.type) {
    case 'auth': {
      const valid = validateToken(msg.token, config)
      client.authenticated = valid
      if (client.authTimer) {
        clearTimeout(client.authTimer)
        client.authTimer = null
      }
      sendMsg(client, { type: 'auth_result', success: valid, error: valid ? undefined : 'Invalid token' })
      if (!valid) {
        client.ws.close(4003, 'Invalid token')
      } else {
        sendMsg(client, { type: 'config_snapshot' })
        // Push the dispatch target list immediately so the HUD can render the
        // top-level menu without an extra round-trip.
        sendMsg(client, { type: 'dispatch_target_list', targets: DISPATCH_TARGETS })
        startHeartbeat(client)
      }
      break
    }

    case 'client_hb': {
      client.lastAppActivityMs = Date.now()
      break
    }

    case 'list_dispatch_targets': {
      sendMsg(client, { type: 'dispatch_target_list', targets: DISPATCH_TARGETS })
      break
    }

    case 'dispatch_target_select': {
      const target = getDispatchTarget(msg.targetId)
      if (!target) {
        sendMsg(client, { type: 'error', message: `Unknown dispatch target: ${msg.targetId}` })
        break
      }
      client.selectedTargetId = target.id
      sendMsg(client, { type: 'dispatch_target_set', targetId: target.id, flow: target.flow })
      // If the target's flow is 'directory-picker', push the list immediately
      // so the HUD doesn't need a separate request.
      if (target.flow === 'directory-picker') {
        sendMsg(client, { type: 'directory_list_reply', entries: listProjectDirectories() })
      }
      break
    }

    case 'directory_list': {
      sendMsg(client, { type: 'directory_list_reply', entries: listProjectDirectories() })
      break
    }

    case 'directory_select': {
      // For 'cc' target: spawn or resume CC in the chosen directory.
      if (client.selectedTargetId !== 'cc') {
        sendMsg(client, { type: 'error', message: `directory_select not supported for target ${client.selectedTargetId}` })
        break
      }
      try {
        const { entry, resumed, wired } = client.pool.getOrCreateByDirectory(msg.path, {
          permissionMode: client.mode,
          effort: config.claude.effort,
          model: config.claude.model,
          systemPrompt: config.claude.systemPrompt,
        })
        // S-H1 + S-H2: only wire listeners + spawn for FRESH entries. A reused
        // entry already has both — calling wireSessionEvents would stack
        // listeners (text fires 2x, 3x, ...) and calling spawn() would orphan
        // the existing live subprocess as a zombie.
        if (!wired) {
          wireSessionEvents(client, entry)
          await entry.session.spawn()
          watchdog?.register(entry.id, entry.session, msg.path)
        }
        client.pool.persistSessionMeta()
        client.dispatcher = new CCDispatcher(entry)
        client.currentPage = 0
        sendMsg(client, {
          type: 'session_info',
          sessionId: entry.id,
          projectPath: msg.path,
          mode: client.mode,
          poolSize: client.pool.count,
          poolIndex: client.pool.indexOf(entry.id),
          resumed,
          ccSessionId: entry.session.ccSessionId ?? undefined,
        })
      } catch (err) {
        sendMsg(client, { type: 'cc_error', error: `Failed to open ${msg.path}: ${err}` })
      }
      break
    }

    case 'audio_start': {
      // Validate format BEFORE accepting binary frames so a bogus shape
      // (sampleRate=0 or channels=0) loud-fails rather than mis-routing.
      const sr = msg.sampleRate ?? 16_000
      const ch = msg.channels ?? 1
      if (sr <= 0 || ch <= 0) {
        sendMsg(client, { type: 'stt_error', error: `Invalid audio_start: sampleRate=${sr} channels=${ch} (must be > 0)` })
        break
      }
      // 4th-pass review MEDIUM: loud-fail when audio_start arrives while
      // we're already collecting. The previous reset was silent — N bytes
      // of audio just vanished. Violates LOUD AND PROUD. Could happen on
      // race conditions, double-tap during recording, or buggy clients.
      if (client.collectingAudio && client.audioChunks.length > 0) {
        const prevBytes = client.audioChunks.reduce((n, c) => n + c.length, 0)
        console.warn(`[ws] audio_start while already collecting — discarding ${prevBytes} bytes of in-progress audio`)
        sendMsg(client, { type: 'stt_error', error: `overlapping audio_start; previous ${prevBytes} bytes discarded` })
      }
      // 4th-pass-final review MEDIUM: also reject if a previous STT is
      // still in flight. Without this, rapid record/end/record produces
      // an stt_result for the PRIOR audio that the client interprets as
      // the NEW recording's result.
      if (client.sttInFlight) {
        sendMsg(client, { type: 'stt_error', error: `audio_start rejected: previous transcription still in flight; wait for stt_result before starting again` })
        break
      }
      client.audioChunks = []
      client.collectingAudio = true
      client.audioFormat = {
        sampleRate: sr,
        channels: ch,
        encoding: msg.encoding ?? 'int16',
        source: msg.source,
      }
      console.log(`[ws] audio_start sr=${client.audioFormat.sampleRate} ch=${client.audioFormat.channels} enc=${client.audioFormat.encoding} src=${client.audioFormat.source ?? '?'}`)
      break
    }

    case 'audio_end': {
      client.collectingAudio = false
      const pcmBuffer = Buffer.concat(client.audioChunks)
      const format = client.audioFormat ?? { sampleRate: 16_000, channels: 1, encoding: 'int16' as const }
      client.audioChunks = []
      client.audioFormat = null
      // 4th-pass-final review MEDIUM: mark in-flight + clear on completion
      // so the audio_start guard above can block rapid double-record.
      client.sttInFlight = true
      void handleAudio(client, pcmBuffer, format, config).finally(() => {
        client.sttInFlight = false
      })
      break
    }

    case 'prompt': {
      // 4th-pass review LOW: bump app-activity timestamp so a long CC turn
      // doesn't get the client kicked for app-side silence.
      client.lastAppActivityMs = Date.now()
      handlePrompt(client, msg.text)
      break
    }

    case 'command': {
      client.lastAppActivityMs = Date.now()
      handlePrompt(client, msg.command)
      break
    }

    case 'interrupt': {
      // Clear turn-scoped state on the active entry so a permission_request
      // that was queued for the now-interrupted turn doesn't leak forward.
      const active = client.pool.getActive()
      if (active) active.pendingPermissionId = null
      client.dispatcher?.interrupt()
      break
    }

    case 'permission_response': {
      client.lastAppActivityMs = Date.now()
      const active = client.pool.getActive()
      if (active?.pendingPermissionId) {
        try {
          active.session.respondToPermission(active.pendingPermissionId, msg.approved)
          active.pendingPermissionId = null
        } catch (err) {
          // 4th-pass-final review HIGH: respondToPermission now throws when
          // CC stdin is dead. Surface the failure loudly so the user knows
          // the tap was lost — better than silent success that does
          // nothing.
          console.error(`[ws] permission_response failed:`, err)
          sendMsg(client, {
            type: 'cc_error',
            error: `Permission tap could not be sent: ${err instanceof Error ? err.message : String(err)}`,
          })
          active.pendingPermissionId = null   // clear it anyway; CC won't honor
        }
      }
      break
    }

    case 'set_mode': {
      const prev = client.mode
      if (prev === msg.mode) break        // no-op
      const active = client.pool.getActive()
      if (!active) {
        // No active session — safe to update locally; nothing to respawn.
        client.mode = msg.mode
        break
      }
      // 4th-pass-final review MEDIUM: refuse set_mode while a permission
      // request is pending. respawning would orphan the request: the HUD's
      // approve/reject tap would target the dead session's requestId,
      // silently swallowed by the new CCSession. User would think their
      // tap worked when it didn't.
      if (active.pendingPermissionId !== null) {
        sendMsg(client, {
          type: 'cc_error',
          error: `set_mode rejected: a permission request is currently pending (${active.pendingPermissionId}). Approve or reject first, then change mode.`,
        })
        break
      }
      // Update local mode AFTER the respawn succeeds so a failure doesn't
      // leave client.mode divergent from the underlying session's mode.
      try {
        await respawnActiveWithMode(client, active, msg.mode, config)
        client.mode = msg.mode
      } catch (err) {
        // respawnActiveWithMode logs + sends cc_error internally for its known
        // failure paths, but we still re-surface here in case something escapes.
        console.error(`[ws] set_mode respawn failed for ${msg.mode}, keeping prev=${prev}:`, err)
        sendMsg(client, { type: 'cc_error', error: `set_mode failed; staying in ${prev}: ${err instanceof Error ? err.message : String(err)}` })
      }
      break
    }

    case 'get_page': {
      const active = client.pool.getActive()
      if (active) {
        const page = active.scrollback.getPage(msg.page - 1)
        sendMsg(client, { type: 'output', ...page })
        client.currentPage = msg.page - 1
      }
      break
    }

    case 'session_switch': {
      try {
        const entry = client.pool.switchTo(msg.sessionId)
        client.dispatcher = new CCDispatcher(entry)
        const page = entry.scrollback.getPage(entry.scrollback.lastPage)
        sendMsg(client, { type: 'output', ...page })
        client.currentPage = entry.scrollback.lastPage
        sendMsg(client, {
          type: 'status',
          mode: client.mode,
          contextPct: entry.contextPct,
          isProcessing: entry.session.isAlive() && entry.session.requestCount > 0,
          poolSize: client.pool.count,
          poolIndex: client.pool.indexOf(msg.sessionId),
          projectName: entry.name,
        })
      } catch {
        sendMsg(client, { type: 'error', message: 'Session not found' })
      }
      break
    }

    case 'session_close': {
      watchdog?.unregister(msg.sessionId)
      client.pool.closeSession(msg.sessionId)
      const active = client.pool.getActive()
      if (active) {
        client.dispatcher = new CCDispatcher(active)
        const page = active.scrollback.getPage(active.scrollback.lastPage)
        sendMsg(client, { type: 'output', ...page })
        sendMsg(client, {
          type: 'status',
          mode: client.mode,
          contextPct: active.contextPct,
          isProcessing: false,
          poolSize: client.pool.count,
          poolIndex: client.pool.indexOf(active.id),
          projectName: active.name,
        })
      } else {
        client.dispatcher = null
      }
      break
    }

    case 'list_active_sessions': {
      sendMsg(client, { type: 'active_session_list', sessions: client.pool.listSessions() })
      break
    }

    case 'session_resume': {
      const saved = SessionPool.listSavedSessions()
      const match = saved.find(s => s.id === msg.sessionId)
      if (!match) {
        sendMsg(client, { type: 'error', message: `Session ${msg.sessionId} not found in history` })
        break
      }
      // 4th-pass review MEDIUM (server): pre-scan for a live pool entry on
      // the same projectPath. Without this, picking a resume entry while
      // another live session exists for the same cwd spawns a SECOND CC
      // subprocess pointing at the same project — competing writers on the
      // same ~/.claude/projects/... state, MAX_CONCURRENT_SESSIONS hit
      // sooner. Mirrors the guard at session-pool.ts:166.
      let existing: ReturnType<typeof client.pool.allEntries>[number] | undefined
      for (const entry of client.pool.allEntries()) {
        if (entry.projectPath === match.project && entry.session.isAlive()) {
          existing = entry
          break
        }
      }
      if (existing) {
        // 4th-pass-final review MEDIUM: warn loudly if the user asked for
        // a SPECIFIC historical session but we're switching to a different
        // live one. The user thinks they're resuming a particular session;
        // they're actually getting "the live one for this dir" which may
        // have different state. Better to log than silently mismatch.
        if (existing.session.ccSessionId && existing.session.ccSessionId !== msg.sessionId) {
          console.warn(`[ws] session_resume requested ${msg.sessionId} but live entry has ccSessionId ${existing.session.ccSessionId} — switching to live`)
        }
        client.pool.switchTo(existing.id)
        client.dispatcher = new CCDispatcher(existing)
        client.currentPage = 0
        client.pool.persistSessionMeta()
        sendMsg(client, {
          type: 'session_info',
          sessionId: existing.id,
          projectPath: match.project,
          mode: client.mode,
          poolSize: client.pool.count,
          poolIndex: client.pool.indexOf(existing.id),
          resumed: true,
          ccSessionId: existing.session.ccSessionId ?? undefined,
        })
        break
      }
      try {
        const entry = client.pool.createResumeSession(match.project, msg.sessionId, {
          permissionMode: client.mode,
          effort: config.claude.effort,
          model: config.claude.model,
          systemPrompt: config.claude.systemPrompt,
        })
        wireSessionEvents(client, entry)
        await entry.session.spawn()
        watchdog?.register(entry.id, entry.session, match.project)
        client.dispatcher = new CCDispatcher(entry)
        sendMsg(client, {
          type: 'session_info',
          sessionId: entry.id,
          projectPath: match.project,
          mode: client.mode,
          poolSize: client.pool.count,
          poolIndex: client.pool.indexOf(entry.id),
          resumed: true,
          ccSessionId: entry.session.ccSessionId ?? undefined,
        })
      } catch (err) {
        sendMsg(client, { type: 'cc_error', error: `Failed to resume: ${err}` })
      }
      break
    }

    case 'list_sessions': {
      sendMsg(client, { type: 'session_list', sessions: SessionPool.listSavedSessions() })
      break
    }

    case 'rewind': {
      const active = client.pool.getActive()
      if (!active?.session.isAlive()) {
        sendMsg(client, { type: 'cc_error', error: 'No active CC session' })
        break
      }
      const turnText = msg.turns >= 999 ? 'the start of the conversation' : `${msg.turns} turn${msg.turns === 1 ? '' : 's'} ago`
      try {
        active.session.sendPrompt(`/rewind ${msg.turns >= 999 ? '' : msg.turns}`.trim())
        sendMsg(client, { type: 'rewind_result', success: true, turnsRewound: msg.turns, summary: `Rewound to ${turnText}` })
      } catch (err) {
        sendMsg(client, { type: 'rewind_result', success: false, turnsRewound: 0, summary: `Rewind failed: ${err}` })
      }
      break
    }

    case 'confirm_on_hud_response': {
      // 4th-pass review LOW: user tapped confirm/reject — clear app-activity
      // signal so a long confirmation window doesn't trigger app-silence kick.
      client.lastAppActivityMs = Date.now()
      const cb = client.confirmCallbacks.get(msg.requestId)
      if (cb) {
        client.confirmCallbacks.delete(msg.requestId)
        cb(msg.result)
      } else {
        console.warn(`[ws] confirm_on_hud_response for unknown requestId ${msg.requestId}`)
      }
      break
    }

    case 'ble_ack': {
      // 4th-pass review LOW: any BLE ack from the phone is an app-activity
      // signal (phone is alive + processing).
      client.lastAppActivityMs = Date.now()
      client.router.onAck(msg.messageId, msg.status, msg.reason)
      break
    }

    case 'diag': {
      // Server-side ISO timestamp + client-side embedded [runId T+s] prefix
      // give us a full timeline: when the client emitted (T+s within its
      // run) AND when the server received (ISO wall clock, captures WS
      // latency). Critical for distinguishing test runs in `tail -f`.
      const now = new Date().toISOString()
      console.log(`${now} [client-diag] ${msg.text}`)
      break
    }

    default: {
      // Exhaustive — TypeScript will surface unhandled message types at compile time.
      const exhaustive: never = msg
      console.warn('[ws] unhandled message type:', exhaustive)
      break
    }
  }
}

async function respawnActiveWithMode(
  client: WSClient, entry: PoolEntry, mode: PermissionMode, config: G2CCConfig,
): Promise<void> {
  // 4th-pass F1: this function used to send cc_error + return on its two
  // internal failure paths instead of throwing, which let the set_mode caller's
  // `client.mode = msg.mode` run after a failure → local mode diverged from
  // underlying session. Now throws on every failure path; the caller's catch
  // is the single place that handles user-facing reporting.
  const ccSessionId = entry.session.ccSessionId
  const projectPath = entry.projectPath

  watchdog?.unregister(entry.id)
  entry.session.kill()
  client.pool.closeSession(entry.id)

  let newEntry: PoolEntry
  try {
    newEntry = ccSessionId
      ? client.pool.createResumeSession(projectPath, ccSessionId, {
          permissionMode: mode,
          effort: config.claude.effort,
          model: config.claude.model,
          systemPrompt: config.claude.systemPrompt,
        })
      : client.pool.createSession(projectPath, {
          permissionMode: mode,
          effort: config.claude.effort,
          model: config.claude.model,
          systemPrompt: config.claude.systemPrompt,
        })
  } catch (err) {
    throw new Error(`Failed to create session for mode switch: ${err instanceof Error ? err.message : String(err)}`)
  }

  wireSessionEvents(client, newEntry)

  try {
    await newEntry.session.spawn()
    watchdog?.register(newEntry.id, newEntry.session, projectPath)
    client.pool.persistSessionMeta()
    client.dispatcher = new CCDispatcher(newEntry)
    sendMsg(client, {
      type: 'session_info',
      sessionId: newEntry.id,
      projectPath,
      mode,
      poolSize: client.pool.count,
      poolIndex: client.pool.indexOf(newEntry.id),
      resumed: ccSessionId !== null,
      ccSessionId: newEntry.session.ccSessionId ?? undefined,
    })
  } catch (err) {
    watchdog?.unregister(newEntry.id)
    client.pool.closeSession(newEntry.id)
    throw new Error(`Failed to spawn with new mode: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function wireSessionEvents(client: WSClient, entry: PoolEntry): void {
  const { session, scrollback, id: sessionId } = entry

  session.on('text', (text: string) => {
    scrollback.append(markdownToPlaintext(text))
  })

  // Stream text deltas to the active client. STREAMING_UPDATE_MS = 300ms
  // debounce — pace the WebSocket flush; not an I/O timeout (FORBIDDEN_PATTERN_AUDIT.md §D).
  session.on('text_delta', (delta: string) => {
    if (client.pool.activeSessionId !== sessionId) return
    client.streamBuffer += delta
    if (!client.streamTimer) {
      client.streamTimer = setTimeout(() => {
        client.streamTimer = null
        if (client.streamBuffer) {
          sendMsg(client, { type: 'text_delta', text: client.streamBuffer })
          client.streamBuffer = ''
        }
      }, STREAMING_UPDATE_MS)
    }
  })

  session.on('tool_use', (info: { name: string; summary: string }) => {
    const line = formatToolUse(info.name, info.summary)
    scrollback.append(line)
    if (client.pool.activeSessionId === sessionId) {
      sendMsg(client, { type: 'tool_use', tool: info.name, description: line })
    }
  })

  session.on('tool_result', (content: string) => {
    // FULL content goes to scrollback — no truncation. Pagination handles long output.
    scrollback.append(content)
  })

  session.on('turn_complete', (info: { text: string; toolCalls: string[]; costUsd: number; usage: CCUsage }) => {
    client.pool.updateUsage(sessionId, info.usage)
    client.pool.persistSessionMeta()

    if (client.pool.activeSessionId === sessionId) {
      if (client.streamTimer) { clearTimeout(client.streamTimer); client.streamTimer = null }
      if (client.streamBuffer) {
        sendMsg(client, { type: 'text_delta', text: client.streamBuffer })
        client.streamBuffer = ''
      }
      sendMsg(client, { type: 'response_complete' })
      if (client.autoScroll) client.currentPage = scrollback.lastPage
      sendMsg(client, { type: 'output', ...scrollback.getPage(client.currentPage) })
      sendMsg(client, {
        type: 'status', mode: client.mode, contextPct: entry.contextPct,
        isProcessing: false, poolSize: client.pool.count,
        poolIndex: client.pool.indexOf(sessionId), projectName: entry.name,
      })
    } else {
      client.pool.emitBackgroundAlert(sessionId, 'complete')
    }
  })

  session.on('error', (message: string) => {
    if (client.pool.activeSessionId === sessionId) {
      sendMsg(client, { type: 'cc_error', error: message })
    } else {
      client.pool.emitBackgroundAlert(sessionId, 'error', message)
    }
  })

  session.on('permission_request', (info: { requestId: string; rawEvent: Record<string, unknown> }) => {
    if (client.mode === 'bypassPermissions') {
      session.respondToPermission(info.requestId, true)
    } else {
      entry.pendingPermissionId = info.requestId
      if (client.pool.activeSessionId === sessionId) {
        sendMsg(client, { type: 'permission_request', requestId: info.requestId, details: JSON.stringify(info.rawEvent) })
      } else {
        client.pool.emitBackgroundAlert(sessionId, 'permission')
      }
    }
  })

  session.on('process_died', (code: number | null) => {
    console.log(`[ws-handler] CC process died (session=${sessionId}, code=${code})`)
  })
}

async function handleAudio(
  client: WSClient,
  pcmBuffer: Buffer,
  format: AudioFormat,
  config: G2CCConfig,
): Promise<void> {
  if (pcmBuffer.length < 100) {
    sendMsg(client, { type: 'stt_error', error: 'Audio too short' })
    return
  }

  // Route based on the phone-announced format:
  //   - DJI USB path (48 kHz / 2 ch / float32 / source='dji-usb'): full noise
  //     pipeline (notch → wiener → parakeet) via pipeline.dji_pipeline_cli.
  //   - Legacy phone-mic (16 kHz / 1 ch / int16): preprocessAudio + faster-whisper
  //     or Parakeet via the existing transcribe() path. Phone mic is the
  //     "no DJI plugged in" fallback for dev iteration; production target is DJI.
  const isDji = format.source === 'dji-usb' &&
    format.encoding === 'float32' &&
    format.channels === 2 &&
    format.sampleRate === 48_000
  const isLegacyShape = format.encoding === 'int16' &&
    format.channels === 1 &&
    format.sampleRate === 16_000

  if (isDji) {
    try {
      const text = await transcribeDji(pcmBuffer, format, config)
      if (!text.trim()) {
        sendMsg(client, { type: 'stt_error', error: 'No speech detected' })
        return
      }
      sendMsg(client, { type: 'stt_result', text })
    } catch (err) {
      sendMsg(client, { type: 'stt_error', error: `Transcription failed: ${err}` })
    }
    return
  }

  if (!isLegacyShape) {
    const reason = `Audio format ${format.encoding}/${format.channels}ch/${format.sampleRate}Hz` +
      ` src=${format.source ?? '?'} not routable. Expected dji-usb (48k/2ch/float32) ` +
      `or phone-mic (16k/1ch/int16).`
    console.warn(`[ws] ${reason}`)
    sendMsg(client, { type: 'stt_error', error: reason })
    return
  }

  try {
    const text = await transcribe(pcmBuffer, config)
    if (!text.trim()) {
      sendMsg(client, { type: 'stt_error', error: 'No speech detected' })
      return
    }
    sendMsg(client, { type: 'stt_result', text })
  } catch (err) {
    sendMsg(client, { type: 'stt_error', error: `Transcription failed: ${err}` })
  }
}

function handlePrompt(client: WSClient, text: string): void {
  if (!client.dispatcher?.isAlive()) {
    sendMsg(client, { type: 'cc_error', error: 'No active CC session — pick a directory from the menu first' })
    return
  }
  const active = client.pool.getActive()
  try {
    client.dispatcher.sendPrompt(text)
    client.autoScroll = true
    client.streamBuffer = ''
    sendMsg(client, {
      type: 'status',
      mode: client.mode,
      contextPct: client.dispatcher.contextPct(),
      isProcessing: true,
      poolSize: client.pool.count,
      poolIndex: active ? client.pool.indexOf(active.id) : 0,
      projectName: active?.name,
    })
  } catch (err) {
    sendMsg(client, { type: 'cc_error', error: `Failed to send prompt: ${err}` })
  }
}

/** Phase 7 entry point — server-side request to ask the HUD a yes/no question.
 *  Returns a Promise that resolves when the client sends back ConfirmOnHudResponseMsg.
 *  No timeout — the user gets as long as they need. If the WebSocket disconnects
 *  before a response arrives, the in-flight callback is invoked with 'rejected'
 *  (loud, logged, not silent).
 *
 *  Phase 7 fix #2: also tags the requestId with the Channel Router so when the
 *  phone's `BleAckMsg` arrives, delivery status is tracked. The returned promise
 *  ONLY surfaces the user's confirm/reject choice — delivery status is a separate
 *  concern that callers can opt into via `awaitDeliveryAck` if they care. */
export function confirmOnHudWithDelivery(
  client: WSClient,
  text: string,
): { response: Promise<'confirmed' | 'rejected'>; delivery: Promise<{ status: 'verified' | 'unverified'; reason?: string }> } {
  const requestId = `cfh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // Register the delivery ack waiter BEFORE sendMsg so a fast inbound BleAck
  // (e.g. WiFi loopback latency under load) can't fire before awaitAck binds.
  // Same logic applies to confirmCallbacks: register the resolver first.
  const delivery = client.router.awaitAck(requestId)
  const response = new Promise<'confirmed' | 'rejected'>((resolve) => {
    client.confirmCallbacks.set(requestId, resolve)
    sendMsg(client, { type: 'confirm_on_hud', requestId, text })
  })
  return { response, delivery }
}

/** Phase 3A heartbeat — start the server-driven hb + APP_ACTIVITY_TIMEOUT_MS kick.
 *  Runs only after a successful auth (so unauthed sockets don't get hb traffic).
 *
 *  setInterval here is health-check cadence, NOT a per-operation timeout. The
 *  `APP_ACTIVITY_TIMEOUT_MS` kick is a security/resource guard that closes
 *  zombie sockets whose JS event loop has frozen — the corresponding mobile
 *  app's connection.ts watchdog will then reconnect automatically per the
 *  five-defence pattern (see g2aria/app/src/connection.ts:280-300). */
function startHeartbeat(client: WSClient): void {
  client.lastAppActivityMs = Date.now()
  client.hbInterval = setInterval(() => {
    if (client.ws.readyState === 1) {
      sendMsg(client, { type: 'hb', now: Date.now() })
    }
  }, HEARTBEAT_INTERVAL_MS)
  client.livenessInterval = setInterval(() => {
    const silent = Date.now() - client.lastAppActivityMs
    if (silent > APP_ACTIVITY_TIMEOUT_MS && client.ws.readyState === 1) {
      console.warn(`[ws] client silent for ${silent}ms — kicking (close 4002)`)
      client.ws.close(4002, `silent for ${silent}ms`)
    }
  }, HEARTBEAT_INTERVAL_MS)
}

/** Phase 7 entry point — server-side request to ask the HUD a yes/no question.
 *  Returns a Promise that resolves when the client sends back ConfirmOnHudResponseMsg.
 *  No timeout — the user gets as long as they need. If the WebSocket disconnects
 *  before a response arrives, the in-flight callback is invoked with 'rejected'
 *  (loud, logged, not silent).
 *
 *  Phase 7 fix #2: tags the requestId with the Channel Router so the BLE
 *  delivery ack (BleAckMsg from phone) is tracked. The returned promise still
 *  resolves only with the user's choice; delivery status is consumed via the
 *  router's fireAndForget bookkeeping. Callers wanting both can use
 *  `confirmOnHudWithDelivery` instead. */
export function confirmOnHud(client: WSClient, text: string): Promise<'confirmed' | 'rejected'> {
  const requestId = `cfh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // Register both BEFORE sendMsg so a fast inbound BleAck or confirm response
  // can't race past the resolvers. (See confirmOnHudWithDelivery for the same
  // ordering concern.)
  client.router.fireAndForget(requestId)
  return new Promise<'confirmed' | 'rejected'>((resolve) => {
    client.confirmCallbacks.set(requestId, resolve)
    sendMsg(client, { type: 'confirm_on_hud', requestId, text })
  })
}
