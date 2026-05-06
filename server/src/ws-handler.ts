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
import { transcribe } from './stt.js'
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

    void handleMessage(client, msg, config)
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
    console.log(`[ws] client closed (code=${code} reason="${String(reason)}")`)
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
        const { entry, resumed } = client.pool.getOrCreateByDirectory(msg.path, {
          permissionMode: client.mode,
          effort: config.claude.effort,
          model: config.claude.model,
          systemPrompt: config.claude.systemPrompt,
        })
        wireSessionEvents(client, entry)
        await entry.session.spawn()
        watchdog?.register(entry.id, entry.session, msg.path)
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
      client.audioChunks = []
      client.collectingAudio = true
      break
    }

    case 'audio_end': {
      client.collectingAudio = false
      const pcmBuffer = Buffer.concat(client.audioChunks)
      client.audioChunks = []
      void handleAudio(client, pcmBuffer, config)
      break
    }

    case 'prompt': {
      handlePrompt(client, msg.text)
      break
    }

    case 'command': {
      handlePrompt(client, msg.command)
      break
    }

    case 'interrupt': {
      client.dispatcher?.interrupt()
      break
    }

    case 'permission_response': {
      const active = client.pool.getActive()
      if (active?.pendingPermissionId) {
        active.session.respondToPermission(active.pendingPermissionId, msg.approved)
        active.pendingPermissionId = null
      }
      break
    }

    case 'set_mode': {
      const prev = client.mode
      client.mode = msg.mode
      if (prev !== msg.mode) {
        const active = client.pool.getActive()
        if (active) await respawnActiveWithMode(client, active, msg.mode, config)
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
      client.router.onAck(msg.messageId, msg.status, msg.reason)
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
    sendMsg(client, { type: 'cc_error', error: `Failed to switch mode: ${err}` })
    return
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
    sendMsg(client, { type: 'cc_error', error: `Failed to spawn with new mode: ${err}` })
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

async function handleAudio(client: WSClient, pcmBuffer: Buffer, config: G2CCConfig): Promise<void> {
  if (pcmBuffer.length < 100) {
    sendMsg(client, { type: 'stt_error', error: 'Audio too short' })
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
 *  (loud, logged, not silent). */
export function confirmOnHud(client: WSClient, text: string): Promise<'confirmed' | 'rejected'> {
  const requestId = `cfh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise<'confirmed' | 'rejected'>((resolve) => {
    client.confirmCallbacks.set(requestId, resolve)
    sendMsg(client, { type: 'confirm_on_hud', requestId, text })
  })
}
