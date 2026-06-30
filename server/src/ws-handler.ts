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
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
import { transcribe, transcribeDji, transcribeDjiBt } from './stt.js'
import { pcmToWav } from './pcm-wav.js'
import { markdownToPlaintext, formatToolUse } from './output-parser.js'
import { listProjectDirectories, validateProjectPath } from './directory-picker.js'
import { CCDispatcher, DISPATCH_TARGETS, type Dispatcher, getDispatchTarget } from './dispatch.js'
import { ChannelRouter } from './channel-router.js'
import { notify, markSeenByKey, type NotifyPriority } from './os-notify.js'
import { probeScene, gTextScene, gImageScene, ensureRendered, isRate, testKind, testLabel, errorScene } from './os-display.js'
import { menuScene, ensureMenuRendered, menuItemLabel, MENU_ITEM_COUNT } from './os-menu.js'
import { WindowManager } from './window-manager.js'
import { type MemoAudio } from './memo.js'
import { segmentUtterances } from './voice.js'

// Hard ceiling on a single in-flight audio buffer (a resource guard, NOT an I/O timeout — allowed):
// ~6.5 min of 48 kHz/2ch/float32 (~384 KB/s). Bounds memory if audio_end never arrives.
const MAX_AUDIO_BYTES = 150 * 1024 * 1024

/** Last battery % across ALL connections — the ≤15% crossing alert must
 *  survive a WS reconnect (per-connection state re-fired it every re-auth on
 *  a low battery; review 2026-06-11b). Single-user server. */
let lastKnownPhoneBattery: number | null = null

let watchdog: Watchdog | null = null

export function setWatchdog(w: Watchdog): void { watchdog = w }

export interface WSClient {
  ws: WebSocket
  authenticated: boolean
  authTimer: ReturnType<typeof setTimeout> | null
  audioChunks: Buffer[]
  collectingAudio: boolean
  /** Running byte total of the in-flight audio buffer — bounds memory if audio_end never arrives. */
  audioBytes: number
  // In-flight STT pipeline counter. Incremented when audio_end fires AND we
  // actually launch handleAudio with non-empty audio; decremented in the
  // matching .finally. Blocks audio_start while ANY transcription is still
  // running, even if a second audio_end (e.g. a duplicate or no-prior-start)
  // would have completed near-instantly via the <100 byte early return —
  // the prior boolean toggle let those instant returns clear the flag
  // mid-transcription (R2-CRITICAL).
  sttInFlightCount: number
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
  /** Glasses-OS capability probe — set by os_attach. osTest = current test index
   *  (double-tap steps), osFFilled = filled containers in the F fill-test,
   *  osGTimer = the G rate-test interval (cleared on test-change + ws-close). */
  osMode: boolean
  /** Which OS screen os_attach serves. Default 'de' (the window-manager DE,
   *  docs/DE_DESIGN.md); 'menu' = the old cursive 4-tile menu; 'probe' = the
   *  capability-probe matrix (both kept wired for re-runs). */
  osScreen: 'de' | 'menu' | 'probe'
  osTest: number
  osFFilled: number
  /** Current menu selection (menu screen) — moved by antenna-scroll focus events. */
  osMenuSel: number
  osGTimer: ReturnType<typeof setInterval> | null
  /** The DE window manager (osScreen 'de'); created on os_attach. */
  wm: WindowManager | null
  /** Latest phone battery % from client_hb (Phase 9; null until reported). */
  phoneBattery: number | null
  /** Latest GLASSES battery % from client_hb (Adam 2026-06-12; [U]). */
  g2Battery: number | null
  /** The raw PCM (+ format) of the most recent SUCCESSFUL dictation — kept so a
   *  `memo:` intent (Phase 14) can save the clip at confirm time. Overwritten
   *  each dictation; only the last is held. null until the first one. */
  lastDictationAudio: MemoAudio | null
}

export interface AudioFormat {
  sampleRate: number
  channels: number
  encoding: 'int16' | 'float32'
  source?: string
  /** Phase 9: 'handsfree' routes the transcript to the voice grammar (VAD-gated)
   *  instead of the active window's dictation onStt. Omitted = one-shot dictate. */
  mode?: 'dictate' | 'handsfree'
}

export function sendMsg(client: WSClient, msg: ServerMessage): void {
  if (client.ws.readyState === 1) {
    client.ws.send(JSON.stringify(msg))
  }
}

// Glasses-OS probe — G (update-rate) tests push renders on a fixed interval
// (text fast, image slower so the BLE queue doesn't back up). Auto-stops after
// 40 frames; cleared on test-change + ws-close so no orphan timer.
function clearGTimer(client: WSClient): void {
  if (client.osGTimer) { clearInterval(client.osGTimer); client.osGTimer = null }
}
function startGTimer(client: WSClient, kind: 'rate-text' | 'rate-image'): void {
  let counter = 0
  const intervalMs = kind === 'rate-text' ? 250 : 600
  client.osGTimer = setInterval(() => {
    counter++
    if (counter > 40) { clearGTimer(client); return }
    try {
      sendMsg(client, { type: 'render', scene: kind === 'rate-text' ? gTextScene(counter) : gImageScene(counter) })
    } catch (e) {
      console.error('[ws] G-timer render failed:', e instanceof Error ? e.message : String(e))
      clearGTimer(client)
    }
  }, intervalMs)
}

export function handleConnection(ws: WebSocket, config: G2CCConfig): WSClient {
  const pool = new SessionPool()

  const client: WSClient = {
    ws,
    authenticated: false,
    authTimer: null,
    audioChunks: [],
    collectingAudio: false,
    audioBytes: 0,
    sttInFlightCount: 0,
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
    osMode: false,
    osScreen: 'de',
    osTest: 0,
    osFFilled: 0,
    osMenuSel: 0,
    osGTimer: null,
    wm: null,
    phoneBattery: null,
    g2Battery: null,
    lastDictationAudio: null,
  }

  pool.on('background_alert', (alert: { sessionId: string; alertType: string; details?: string }) => {
    sendMsg(client, {
      type: 'background_alert',
      sessionId: alert.sessionId,
      alertType: alert.alertType as 'permission' | 'complete' | 'error',
      details: alert.details,
    })
  })

  // When the pool internally evicts a dead (crash-looped) entry in getOrCreateByDirectory,
  // unregister it from the Watchdog so it doesn't keep a zombie reference to the dead session.
  pool.on('session_evicted', (id: string) => { watchdog?.unregister(id) })

  // L4: surface watchdog crash-loop give-ups to THIS client. The Watchdog is a
  // single global instance but pools are per-connection, so each client filters
  // by pool ownership. Without this, a crash-looped session was only logged
  // server-side (index.ts) and the user learned of it lazily via a misleading
  // "No active CC session" on the next prompt. Removed on ws close (below).
  const onCrashLoop = (sessionId: string): void => {
    const entry = client.pool.get(sessionId)
    if (!entry) return  // not this client's session
    if (client.pool.activeSessionId === sessionId) {
      sendMsg(client, {
        type: 'cc_error',
        error: `Session "${entry.name}" crash-looped and was stopped. Pick a directory from the menu to start it fresh.`,
      })
    } else {
      // emitBackgroundAlert no-ops for the active session; safe here since
      // this branch is the non-active case.
      client.pool.emitBackgroundAlert(sessionId, 'error', 'Session crash-looped and was stopped')
    }
  }
  watchdog?.on('crash_loop', onCrashLoop)

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
        const chunk = Buffer.from(raw as Buffer)
        client.audioBytes += chunk.length
        if (client.audioBytes > MAX_AUDIO_BYTES) {
          // Resource guard: a frozen-stop phone, a dropped audio_end, or a malicious authed
          // peer must not OOM the single-threaded server. Loud-fail + discard.
          console.warn(`[ws] audio buffer hit ${client.audioBytes}B without audio_end — discarding`)
          client.collectingAudio = false
          client.audioChunks = []
          client.audioBytes = 0
          client.audioFormat = null
          // Through the helper so the WM's dictation state machine unwinds too
          // (raw sendMsg left the DE stuck 'transcribing…' — review 2026-06-11).
          sttError(client, `audio stream exceeded ${MAX_AUDIO_BYTES} bytes without audio_end; discarded`)
        } else {
          client.audioChunks.push(chunk)
        }
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
    clearGTimer(client) // Glasses-OS probe G-timer (rate test)
    // Drop the crash-loop listener registered for this client (else the global
    // Watchdog accumulates one dead closure per past connection).
    watchdog?.off('crash_loop', onCrashLoop)
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
    // Phase 4: detach the WM from the global notification hub + kill its popup
    // timer — a dead WM must not accumulate listeners across reconnects.
    client.wm?.dispose()
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
      // Phase 9: phone battery rides the heartbeat (old APKs omit it). The
      // ≤15% alert fires ONCE per downward crossing — re-arms above 15%.
      // `prev` comes from the MODULE-level last-known value, not the
      // per-connection one: per-connection state reset to null on every WS
      // reconnect, so a blippy day with a dying phone re-alerted on every
      // re-auth (review 2026-06-11b). Single-user server — global is correct.
      // Glasses battery (Adam 2026-06-12) — decoded client-side from the
      // 09-00/09-01 device-info frames ([U] until the on-glass batch).
      if (typeof msg.g2Battery === 'number' && msg.g2Battery >= 0 && msg.g2Battery <= 100) {
        client.g2Battery = msg.g2Battery
      }
      if (typeof msg.battery === 'number' && msg.battery >= 0 && msg.battery <= 100) {
        const prev = lastKnownPhoneBattery
        lastKnownPhoneBattery = msg.battery
        client.phoneBattery = msg.battery
        if (msg.battery <= 15 && (prev === null || prev > 15)) {
          console.warn(`[ws] phone battery LOW: ${msg.battery}%`)
          void notify({
            source: 'phone',
            priority: 'info',
            title: `Phone battery ${msg.battery}%`,
            body: `The bridge phone crossed below 15% (now ${msg.battery}%). The glasses die with it — charge soon.`,
          })
        }
      }
      break
    }

    case 'notify': {
      client.lastAppActivityMs = Date.now()
      // Phase 9: phone notification → the Phase-4 layer. Package → priority
      // via config (invalid mapped values log + fall back to 'info').
      // pkg defaults defensively — a malformed message without `package` used
      // to TypeError on the .split below (review 2026-06-11b).
      const pkg = typeof msg.package === 'string' && msg.package ? msg.package : '(unknown)'
      if (pkg === 'com.g2cc.g2cc') {
        console.warn('[ws] notify from our own package — client filter should have caught this; ignored')
        break
      }
      // Drop blocklisted noise (Adam 2026-06-14: "Device ID accessed" spam) —
      // case-insensitive substring match against title OR body.
      const blocked = config.notifications.blockTitles.find((t) => {
        const needle = t.toLowerCase()
        return (msg.title ?? '').toLowerCase().includes(needle) || (msg.text ?? '').toLowerCase().includes(needle)
      })
      if (blocked) {
        console.log(`[ws] notify DROPPED (blocklisted "${blocked}"): ${pkg} "${msg.title}"`)
        break
      }
      const mapped = config.notifications.packageMap[pkg]
      const VALID = new Set(['call', 'timer', 'sms', 'email', 'info'])
      let priority: NotifyPriority = 'info'
      if (mapped !== undefined) {
        if (VALID.has(mapped)) priority = mapped as NotifyPriority
        else console.error(`[ws] notifications.packageMap['${pkg}'] = '${mapped}' is not a valid priority — using 'info'`)
      }
      console.log(`[ws] phone notify ${pkg} → ${priority}: "${msg.title}"${msg.imageB64 ? ` +image(${msg.imageB64.length} b64)` : ''}`)
      // Attached picture (Adam 2026-06-12 — MMS images on glass): decode +
      // persist to ~/.g2cc/notify-img/, then notify() with the path. Caps are
      // LOUD rejects (the notification itself still goes through, imageless).
      const fire = (imagePath: string | null): void => {
        void notify({
          source: pkg.split('.').pop() ?? pkg,
          priority,
          title: msg.title || '(no title)',
          body: msg.text || '(no text)',
          // ALWAYS 'notices' (review 2026-06-11b): the body lives there. The old
          // email→'mail' jump opened the MailWindow's marzello.net Maildir —
          // which does NOT contain the phone-gmail message that triggered it.
          targetWindow: 'notices',
          imagePath,
          key: typeof msg.key === 'string' ? msg.key : undefined,   // dismiss sync (Adam 2026-06-13)
          hasReply: msg.hasReply === true,                          // Phase 4a: inline reply available
        })
      }
      if (typeof msg.imageB64 === 'string' && msg.imageB64.length > 0) {
        if (msg.imageB64.length > 800_000) {   // ~600 KB decoded — way past the client's own downscale
          console.error(`[ws] notify image REJECTED: ${msg.imageB64.length} b64 chars exceeds the 800k cap (client should downscale)`)
          fire(null)
        } else {
          void (async () => {
            try {
              const buf = Buffer.from(msg.imageB64 as string, 'base64')
              const dir = join(homedir(), '.g2cc', 'notify-img')
              await mkdir(dir, { recursive: true })
              const name = `${Date.now()}-${createHash('sha1').update(buf).digest('hex').slice(0, 12)}.jpg`
              const path = join(dir, name)
              await writeFile(path, buf)
              console.log(`[ws] notify image saved: ${path} (${buf.length} B)`)
              fire(path)
            } catch (e) {
              console.error(`[ws] notify image save FAILED (notification fires imageless): ${e instanceof Error ? e.message : String(e)}`)
              fire(null)
            }
          })()
        }
      } else {
        fire(null)
      }
      break
    }
    case 'notification_dismissed': {
      // The phone dismissed a notification it forwarded → mark the glasses copy
      // seen (Adam 2026-06-13 dismiss sync). markSeenByKey is idempotent +
      // emits NO dismissPhone (the phone already cleared it — loop terminator).
      if (typeof msg.key === 'string' && msg.key) {
        void markSeenByKey(msg.key).catch((e: unknown) =>
          console.error(`[ws] notification_dismissed markSeenByKey failed: ${e instanceof Error ? e.message : String(e)}`))
      }
      break
    }

    case 'notification_reply_result': {
      // Phase 4a: the phone reported the inline-reply outcome → Notices renders it.
      if (client.wm) client.wm.onNotificationReplyResult(msg.key, msg.ok === true, typeof msg.error === 'string' ? msg.error : null)
      else console.log(`[ws] notification_reply_result (no WM): key=${msg.key.slice(0, 40)} ok=${msg.ok}`)
      break
    }

    case 'media_state': {
      // Phase 7: now-playing snapshot pushed by the phone → the Media window.
      client.lastAppActivityMs = Date.now()
      if (client.wm) client.wm.onMediaState(msg.state)
      break
    }

    case 'sms_threads_reply': {
      // Phase 4b: the phone (data provider) answered a thread-list query.
      if (client.wm) client.wm.onSmsThreads(msg.threads, msg.offset, msg.total, typeof msg.error === 'string' ? msg.error : null)
      break
    }

    case 'sms_thread_reply': {
      // Phase 4b: the phone answered a single-thread query.
      if (client.wm) client.wm.onSmsThread(msg.threadId, msg.name, msg.address, msg.messages, msg.page, msg.totalPages, typeof msg.error === 'string' ? msg.error : null)
      break
    }

    case 'nav_update': {
      // Phase 6: a live Maps nav line → pinned on glass until nav_clear.
      client.lastAppActivityMs = Date.now()
      if (client.wm) client.wm.onNavUpdate(msg.text, msg.eta)
      break
    }

    case 'nav_clear': {
      if (client.wm) client.wm.onNavClear()
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
      // SRV-1: validate the client-supplied path before it becomes a CC cwd.
      let projectPath: string
      try {
        projectPath = validateProjectPath(msg.path)
      } catch (err) {
        sendMsg(client, { type: 'cc_error', error: `Invalid directory: ${(err as Error).message}` })
        break
      }
      try {
        const { entry, resumed, wired } = client.pool.getOrCreateByDirectory(projectPath, {
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
          watchdog?.register(entry.id, entry.session, projectPath)
        }
        client.pool.persistSessionMeta()
        client.dispatcher = new CCDispatcher(entry)
        client.currentPage = 0
        sendMsg(client, {
          type: 'session_info',
          sessionId: entry.id,
          projectPath,
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
        sttError(client, `Invalid audio_start: sampleRate=${sr} channels=${ch} (must be > 0)`)
        break
      }
      // DJI ONLY (Adam 2026-06-11): a client that fell back to the phone mic must be
      // refused, not transcribed — the announced source is informational for ROUTING,
      // but it is authoritative for POLICY. Routed through sttError so the WM unwinds
      // and the mic is stopped. (Belt-and-braces with the client-side chain change —
      // this also guards an older APK that still has the fallback.)
      if (msg.source === 'phone-mic') {
        sttError(client, 'phone-mic is disabled by policy (DJI only) — connect the DJI TX over Bluetooth and try again')
        break
      }
      // Loud-fail when audio_start arrives while we're already collecting.
      // The previous reset was silent — N bytes of audio just vanished.
      // Violates LOUD AND PROUD. Could happen on race conditions, double-
      // tap during recording, or buggy clients. R5-MEDIUM2: previously
      // also required audioChunks.length > 0, which silently swallowed
      // the zero-byte case (back-to-back audio_starts with no binary
      // frames between them) — those still corrupt audioFormat below
      // and deserve the same loud signal.
      const handsfree = msg.mode === 'handsfree'
      if (client.collectingAudio) {
        const prevBytes = client.audioChunks.reduce((n, c) => n + c.length, 0)
        if (handsfree) {
          // Handsfree re-cuts its own windows (audio_end then audio_start); a
          // stray overlap just rolls the window — NOT an error to surface.
          if (prevBytes > 0) console.log(`[ws] handsfree audio_start while collecting — rolling window (${prevBytes} B dropped)`)
        } else {
          console.warn(`[ws] audio_start while already collecting — discarding ${prevBytes} bytes of in-progress audio`)
          sendMsg(client, { type: 'stt_error', error: `overlapping audio_start; previous ${prevBytes} bytes discarded` })
        }
      }
      // Reject if a previous STT is still in flight. Without this, rapid
      // record/end/record produces an stt_result for the PRIOR audio that
      // the client interprets as the NEW recording's result. R2-CRITICAL:
      // switched from boolean toggle to counter so a near-instant
      // <100-byte handleAudio early-return on a stray audio_end doesn't
      // clear the flag mid-transcription. HANDSFREE EXEMPT (Phase 9): window
      // boundaries legitimately overlap a running transcription, and each
      // handsfree window routes an INDEPENDENT command (no stale-result
      // misrouting risk — there's no dictation waiting on a specific result).
      if (client.sttInFlightCount > 0 && !handsfree) {
        sttError(client, 'audio_start rejected: previous transcription still in flight; wait for stt_result before starting again')
        break
      }
      client.audioChunks = []
      client.audioBytes = 0
      client.collectingAudio = true
      client.audioFormat = {
        sampleRate: sr,
        channels: ch,
        encoding: msg.encoding ?? 'int16',
        source: msg.source,
        mode: msg.mode === 'handsfree' ? 'handsfree' : undefined,   // Phase 9
      }
      console.log(`[ws] audio_start sr=${client.audioFormat.sampleRate} ch=${client.audioFormat.channels} enc=${client.audioFormat.encoding} src=${client.audioFormat.source ?? '?'}${client.audioFormat.mode === 'handsfree' ? ' mode=handsfree' : ''}`)
      break
    }

    case 'audio_end': {
      // R2-HIGH: reject audio_end without preceding audio_start. Previously
      // a stray audio_end (duplicate from the phone, cancellation message)
      // would mutate sttInFlightCount + run a zero-byte handleAudio that
      // returns instantly, corrupting the in-flight tracker.
      if (!client.collectingAudio) {
        console.warn(`[ws] audio_end without prior audio_start — ignoring`)
        sttError(client, 'audio_end without prior audio_start')
        break
      }
      client.collectingAudio = false
      const pcmBuffer = Buffer.concat(client.audioChunks)
      const format = client.audioFormat ?? { sampleRate: 16_000, channels: 1, encoding: 'int16' as const }
      client.audioChunks = []
      client.audioBytes = 0
      client.audioFormat = null
      // Counter-based in-flight tracking (R2-CRITICAL): the handler increments
      // on entry and the .finally decrements. Only callers that actually go
      // async with non-trivial work need protection — but we count every
      // launched handleAudio uniformly so the audio_start guard is robust
      // against any future fast-path early-returns inside handleAudio.
      client.sttInFlightCount++
      void handleAudio(client, pcmBuffer, format, config).finally(() => {
        client.sttInFlightCount = Math.max(0, client.sttInFlightCount - 1)
      }).catch((err: unknown) => {
        // Fire-and-forget chain: without this, a rejection escaping handleAudio's
        // inner try/catches is an unhandled rejection (fatal on Node >=15).
        console.error('[ws] handleAudio rejected:', err)
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
      // Proactively clear the HUD's "processing" indicator. CC may or may not
      // emit a terminal 'result' on SIGINT under --output-format stream-json
      // (unverified); if it does, turn_complete sends another isProcessing:false
      // — idempotent. Without this, an interrupt that yields no result would
      // leave the HUD stuck showing "processing" until the next prompt.
      if (active) {
        sendMsg(client, {
          type: 'status',
          mode: client.mode,
          contextPct: active.contextPct,
          isProcessing: false,
          poolSize: client.pool.count,
          poolIndex: client.pool.indexOf(active.id),
          projectName: active.name,
        })
      }
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
        // Discard any text_delta buffered for the OUTGOING session — its pending
        // flush would otherwise land under the incoming session's view
        // (cross-session bleed). The buffer/timer are per-client, shared across
        // the pool; only accumulation is session-gated, not the flush.
        if (client.streamTimer) { clearTimeout(client.streamTimer); client.streamTimer = null }
        client.streamBuffer = ''
        const entry = client.pool.switchTo(msg.sessionId)
        client.dispatcher = new CCDispatcher(entry)
        const page = entry.scrollback.getPage(entry.scrollback.lastPage)
        sendMsg(client, { type: 'output', ...page })
        client.currentPage = entry.scrollback.lastPage
        sendMsg(client, {
          type: 'status',
          mode: client.mode,
          contextPct: entry.contextPct,
          isProcessing: entry.session.isAlive() && entry.session.isProcessingTurn,
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
      // Same cross-session bleed guard as session_switch: a text_delta buffered
      // for the session we're closing must not flush onto the next active one.
      if (client.streamTimer) { clearTimeout(client.streamTimer); client.streamTimer = null }
      client.streamBuffer = ''
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
      if (active.session.isProcessingTurn) {
        sendMsg(client, { type: 'rewind_result', success: false, turnsRewound: 0, summary: 'A turn is in flight — interrupt or wait before rewinding' })
        break
      }
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
      // '[audio-error]' is the structured marker the client puts on mic-capture
      // failures (AudioStreamer onFailure / mic-FGS refusal). Without routing it
      // into the window manager, a phone-side mic failure left the DE's
      // dictation state machine waiting forever (review 2026-06-10): no
      // audio_start ever arrives, so no stt_result/stt_error can fire.
      if (client.osMode && client.osScreen === 'de' && client.wm && msg.text.includes('[audio-error]')) {
        const reason = msg.text.slice(msg.text.indexOf('[audio-error]') + '[audio-error]'.length).trim()
        void client.wm.onSttError(reason || 'mic capture failed (see client diag)')
      }
      break
    }

    case 'os_attach': {
      // Glasses-OS attach. Default screen = the DE window manager
      // (docs/DE_DESIGN.md); 'menu' = the old cursive 4-tile menu; 'probe' =
      // the capability matrix. Render the first frame.
      client.lastAppActivityMs = Date.now()
      client.osMode = true
      client.osTest = 0
      client.osFFilled = 0
      client.osMenuSel = 0
      try {
        if (client.osScreen === 'de') {
          if (!client.wm) {
            client.wm = new WindowManager({
              send: (scene) => sendMsg(client, { type: 'render', scene }),
              audio: (action, mode) => sendMsg(client, { type: 'audio_request', action, mode }),
              displayReload: () => sendMsg(client, { type: 'display_reload' }),
              log: (msg) => console.log(msg),
              pool: client.pool,
              config,
              registerWatchdog: (entry) => watchdog?.register(entry.id, entry.session, entry.projectPath),
              unregisterWatchdog: (entryId) => watchdog?.unregister(entryId),
              phoneBattery: () => client.phoneBattery,
              g2Battery: () => client.g2Battery,
              lastDictationAudio: () => client.lastDictationAudio,
              dismissPhoneNotification: (key) => sendMsg(client, { type: 'notification_cancel', key }),
              replyToNotification: (key, text) => sendMsg(client, { type: 'notification_reply', key, text }),   // Phase 4a
              mediaCommand: (cmd) => sendMsg(client, { type: 'media_cmd', cmd }),                                // Phase 7
              requestSmsThreads: (offset, limit) => sendMsg(client, { type: 'sms_threads_request', offset, limit }),  // Phase 4b
              requestSmsThread: (threadId, page) => sendMsg(client, { type: 'sms_thread_request', threadId, page }),  // Phase 4b
              sendSms: (address, text) => sendMsg(client, { type: 'sms_send', address, text }),                  // Phase 4b
              phoneLocate: (action) => sendMsg(client, { type: 'phone_locate', action }),                       // Phase 15
            })
          }
          client.wm.requestRender()
          console.log('[ws] os_attach — DE window manager ON (Main)')
        } else if (client.osScreen === 'menu') {
          await ensureMenuRendered() // rasterize + cache all menu tiles once (~1s first time)
          sendMsg(client, { type: 'render', scene: menuScene(0) })
          console.log(`[ws] os_attach — MENU ON; sel 0 = "${menuItemLabel(0)}"`)
        } else {
          await ensureRendered() // rasterize + cache all probe tiles once (~1s first time)
          sendMsg(client, { type: 'render', scene: probeScene(0, 0) })
          console.log(`[ws] os_attach — capability probe ON; ${testLabel(0)}`)
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        console.error('[ws] os_attach render failed:', m)
        sendMsg(client, { type: 'render', scene: errorScene(m) }) // loud, visible — not a silent blank
      }
      break
    }

    case 'input': {
      client.lastAppActivityMs = Date.now()
      if (!client.osMode) {
        console.warn(`[ws] input '${msg.event}' received but client never sent os_attach — ignoring`)
        break
      }
      if (client.osScreen === 'de') {
        const wm = client.wm
        if (!wm) { console.warn('[ws] DE input before window manager exists — ignoring'); break }
        if (msg.event === 'hub_select') {
          // The firmware reports the tapped row: widgetType = our container NAME
          // ('menu' or 'browse'), index = the row (omitted f4 ⇒ 0 handled client-side).
          const region = msg.widgetType ?? '?'
          const index = msg.index ?? 0
          console.log(`[ws] DE select ${region}[${index}]`)
          await wm.onSelect(region, index)
        } else if (msg.event === 'double_tap' || (msg.event === 'hub_gesture' && msg.code === 3)) {
          console.log('[ws] DE back (double-tap)')
          await wm.onBackGesture()
        } else if (msg.event === 'tap') {
          // Sys tap — no DE consumer since the Files antenna revert (2026-06-11);
          // the WM keeps the blanked guard + loud no-op log (the blank scene's
          // wake antenna still produces these). Phase 2: at the ribbon root a tap
          // = enter the highlighted window (wm.onTapGesture routes it).
          await wm.onTapGesture()
        } else if (msg.event === 'focus') {
          // Phase 2: the ribbon strip is a scroll=true antenna — each scroll notch
          // fires a focus event carrying the f3 DIRECTION (1=up, 2=down; confirmed
          // 2026-06-10, docs/G2_BLE_PROTOCOL.md §6.6). The WM moves the ribbon
          // cursor; it is a no-op in menu mode / inside a window / blanked.
          if (msg.value === 1) await wm.onScroll('up')
          else if (msg.value === 2) await wm.onScroll('down')
          else console.log(`[ws] DE focus unknown f3=${msg.value} — not scrolling`)
        } else {
          // Firmware-list scrolls move the on-glass ring silently; nothing to do
          // server-side until a tap reports the chosen index.
          const detail = msg.value !== undefined ? `(${msg.region ?? '?'}:${msg.value})` : msg.code !== undefined ? `(${msg.code})` : ''
          console.log(`[ws] DE ${msg.event}${detail} (no-op)`)
        }
        break
      }
      if (client.osScreen === 'menu') {
        if (msg.event === 'focus') {
          // Antenna scroll → move the selection. f3 (msg.value) is the scroll DIRECTION,
          // CONFIRMED 2026-06-10 from the g2cap capture: f3=1 = scroll-up, f3=2 = scroll-down
          // (docs/G2_BLE_PROTOCOL.md §6.6). Still treat ONLY 1/2 as up/down and ignore anything
          // else (incl. the f3=-1 no-direction default) rather than scrolling the wrong way.
          const prev = client.osMenuSel
          if (msg.value === 2) client.osMenuSel = Math.min(MENU_ITEM_COUNT - 1, prev + 1)   // 2 = down / next
          else if (msg.value === 1) client.osMenuSel = Math.max(0, prev - 1)                // 1 = up / prev
          else { console.warn(`[ws] menu focus unknown f3=${msg.value}; not moving`); break }
          if (client.osMenuSel !== prev) {
            try {
              sendMsg(client, { type: 'render', scene: menuScene(client.osMenuSel) })
            } catch (err) {
              sendMsg(client, { type: 'render', scene: errorScene(err instanceof Error ? err.message : String(err)) })
            }
          }
          console.log(`[ws] menu focus f3=${msg.value} → sel ${client.osMenuSel} "${menuItemLabel(client.osMenuSel)}"`)
        } else if (msg.event === 'double_tap' || (msg.event === 'hub_gesture' && msg.code === 3)) {
          console.log(`[ws] menu SELECT → "${menuItemLabel(client.osMenuSel)}" (sel ${client.osMenuSel})`)
        } else {
          console.log(`[ws] menu: ${msg.event} (no-op)`)
        }
        break
      }
      if (msg.event === 'hub_gesture' && msg.code === 3) {
        // DOUBLE-TAP = next test (global gesture; works even when a test didn't paint).
        clearGTimer(client)
        client.osTest += 1
        client.osFFilled = 0
        const k = testKind(client.osTest)
        try {
          const scene = k === 'rate-text' ? gTextScene(0) : k === 'rate-image' ? gImageScene(0) : probeScene(client.osTest, 0)
          sendMsg(client, { type: 'render', scene })
        } catch (err) {
          sendMsg(client, { type: 'render', scene: errorScene(err instanceof Error ? err.message : String(err)) })
        }
        if (isRate(client.osTest)) startGTimer(client, k as 'rate-text' | 'rate-image')
        console.log(`[ws] → ${testLabel(client.osTest)}`)
      } else if (msg.event === 'tap' && testKind(client.osTest) === 'fill') {
        // F fill-test: each tap fills one more declared container (content-only update).
        client.osFFilled = Math.min(9, client.osFFilled + 1)
        try {
          sendMsg(client, { type: 'render', scene: probeScene(client.osTest, client.osFFilled) })
        } catch (err) {
          console.error('[ws] fill render failed:', err instanceof Error ? err.message : String(err))
        }
        console.log(`[ws] F fill ${client.osFFilled}/9`)
      } else {
        // Log everything else (incl. focus on the antenna tests) without advancing.
        const detail = msg.value !== undefined ? `(${msg.region ?? '?'}:${msg.value})` : msg.code !== undefined ? `(${msg.code})` : ''
        console.log(`[ws] ${msg.event}${detail} on ${testLabel(client.osTest)}`)
      }
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

// ---- Dev capture tee — learn a noise profile / validation clip through the
// EXACT live path (DJI→BT→phone SCO→server) ----
// When the sentinel file exists, the NEXT dictation's RAW pcm (pre-NR, pre-
// normalize) is written to audio/samples/<name>-<ts>.wav and the sentinel is
// deleted (one-shot). Non-invasive: it tees, then transcription proceeds as
// normal. Absolute paths — the server's cwd is .../G2CC/server, not the repo
// root, so a relative 'audio/...' would land in the wrong place.
const CAPTURE_SENTINEL = '/home/user/G2CC/audio/.capture-armed'
const CAPTURE_DIR = '/home/user/G2CC/audio/samples'

function maybeTeeRawCapture(pcmBuffer: Buffer, format: AudioFormat): void {
  let name: string
  try {
    if (!existsSync(CAPTURE_SENTINEL)) return
    const raw = readFileSync(CAPTURE_SENTINEL, 'utf-8').trim()
    name = (raw || 'capture').replace(/[^A-Za-z0-9_-]/g, '') || 'capture'
  } catch (err) {
    console.error(`[capture] sentinel read failed (skipping tee): ${err}`)
    return
  }
  try {
    const bits = format.encoding === 'float32' ? 32 : 16
    const audioFormat = format.encoding === 'float32' ? 3 : 1
    const wav = pcmToWav(pcmBuffer, format.sampleRate, bits, format.channels, audioFormat)
    const secs = pcmBuffer.length / (format.sampleRate * format.channels * (bits / 8))
    const out = join(CAPTURE_DIR, `${name}-${Date.now()}.wav`)
    writeFileSync(out, wav)
    console.log(
      `[capture] ARMED tee → ${out} (${secs.toFixed(1)}s, ${pcmBuffer.length} B, ` +
      `${format.sampleRate}Hz/${format.channels}ch/${format.encoding}) via the live path`,
    )
    unlinkSync(CAPTURE_SENTINEL)   // one-shot: consume the arm
    console.log('[capture] one-shot consumed → disarmed')
  } catch (err) {
    // Loud, but never break the dictation over an aux-capture failure.
    console.error(`[capture] tee FAILED (dictation continues): ${err}`)
  }
}

async function handleAudio(
  client: WSClient,
  pcmBuffer: Buffer,
  format: AudioFormat,
  config: G2CCConfig,
): Promise<void> {
  const isHandsfree = format.mode === 'handsfree'
  if (pcmBuffer.length < 100) {
    if (isHandsfree) return   // a tiny handsfree flush — ignore quietly (not a dictation)
    // sttError (not raw sendMsg) so an accidental Dictate→Done unwinds the WM's
    // 'transcribing…' state instead of hanging it forever (review 2026-06-11).
    sttError(client, 'Audio too short')
    return
  }

  // Tee the RAW live-path audio to disk if armed (one-shot). Must be the
  // unprocessed buffer so a profile learned from it matches the live capture.
  maybeTeeRawCapture(pcmBuffer, format)

  // Route based on the phone-announced format:
  //   - DJI USB path (float32 / 2 ch / rate >= 8 kHz): full noise pipeline
  //     (notch → wiener → parakeet) via pipeline.dji_pipeline_cli. The pipeline
  //     resamples to the noise profile's rate (48 kHz) internally — we don't
  //     require the phone to announce 48 kHz exactly because some USB Audio
  //     Class enumerations don't surface 48 kHz as a top-level sampleRate
  //     (R5-HIGH3). We route purely on encoding/channels/rate and do NOT gate
  //     on `source`: the protocol documents `source` as informational, and
  //     float32/2ch is unambiguously the DJI shape. (Previously this also
  //     required source==='dji-usb', which silently rejected a correctly-shaped
  //     DJI stream whose client omitted the field — contradicting the contract.)
  //   - Legacy phone-mic (16 kHz / 1 ch / int16): preprocessAudio +
  //     faster-whisper or Parakeet via the existing transcribe() path.
  //     Phone mic is the "no DJI plugged in" fallback for dev iteration;
  //     production target is DJI.
  const isDji = format.encoding === 'float32' &&
    format.channels === 2 &&
    format.sampleRate >= 8_000
  const isLegacyShape = format.encoding === 'int16' &&
    format.channels === 1 &&
    format.sampleRate === 16_000

  const memoAudio: MemoAudio = {
    pcm: pcmBuffer, sampleRate: format.sampleRate, channels: format.channels, encoding: format.encoding,
  }

  // Phase 9 handsfree VAD gate (int16-mono only): drop silent buffers WITHOUT a
  // Parakeet call — 8 h of factory silence must not hammer the GPU. No detected
  // utterance → return quietly (silence is normal in handsfree, not an error).
  if (isHandsfree && isLegacyShape) {
    try {
      const i16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2))
      if (segmentUtterances(i16, format.sampleRate).length === 0) {
        console.log('[ws] handsfree: no speech (VAD-gated) — skipped')
        return
      }
    } catch (e) {
      console.warn(`[ws] handsfree VAD gate failed (transcribing anyway): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Deliver a transcript: handsfree → the voice grammar (onVoiceCommand);
  // dictate → the active window's onStt via sttResult. Empty/failed handsfree is
  // QUIET (no dictation is waiting on it — an sttError would disrupt the window).
  const onText = (text: string): void => {
    if (!text.trim()) {
      if (isHandsfree) console.log('[ws] handsfree: empty transcript — ignored')
      else sttError(client, 'No speech detected')
      return
    }
    if (isHandsfree) {
      if (client.osMode && client.osScreen === 'de' && client.wm) {
        console.log(`[ws] handsfree voice → "${text}"`)
        void client.wm.onVoiceCommand(text)
      } else {
        console.log(`[ws] handsfree transcript but no DE window manager — dropped: "${text}"`)
      }
    } else {
      sttResult(client, text, memoAudio)
    }
  }
  const onErr = (err: unknown): void => {
    if (isHandsfree) console.warn(`[ws] handsfree transcribe failed: ${err}`)
    else sttError(client, `Transcription failed: ${err}`)
  }

  if (isDji) {
    try { onText(await transcribeDji(pcmBuffer, format, config)) } catch (err) { onErr(err) }
    return
  }
  if (!isLegacyShape) {
    const reason = `Audio format ${format.encoding}/${format.channels}ch/${format.sampleRate}Hz` +
      ` src=${format.source ?? '?'} not routable. Expected dji-usb (48k/2ch/float32) or phone-mic (16k/1ch/int16).`
    console.warn(`[ws] ${reason}`)
    if (isHandsfree) return   // a misconfigured handsfree shape — quiet (no dictation to unwind)
    sttError(client, reason)
    return
  }
  // DJI-over-Bluetooth (16 kHz mono int16, Adam's daily source): run per-utterance
  // ADAPTIVE local-noise Wiener in the warm daemon before Parakeet (validated to
  // ~halve WER at a realistic spot; ~neutral point-blank). config.stt.djiBtFilter
  // is the kill-switch — set false to fall back to raw transcribe().
  if (config.stt.engine === 'parakeet' && config.stt.djiBtFilter !== false) {
    try { onText(await transcribeDjiBt(pcmBuffer, format, config)) } catch (err) { onErr(err) }
    return
  }
  try { onText(await transcribe(pcmBuffer, config)) } catch (err) { onErr(err) }
}

/** Deliver an STT result: in DE mode it routes to the active window (the
 *  dictation prompt path — docs/DE_DESIGN.md §2); the legacy phone UI gets the
 *  stt_result message either way (harmless in OS mode; useful as diag). */
function sttResult(client: WSClient, text: string, audio?: MemoAudio): void {
  // Phase 14: stash the raw PCM that produced THIS transcript so a `memo:`
  // intent can save the clip at confirm time. Only on a real result (a failed
  // transcription routes through sttError and never sets pendingStt, so a stale
  // buffer here is unreachable anyway).
  if (audio) client.lastDictationAudio = audio
  sendMsg(client, { type: 'stt_result', text })
  if (client.osMode && client.osScreen === 'de' && client.wm) {
    console.log(`[ws] DE stt → active window: "${text}"`)
    void client.wm.onStt(text)
  }
}

function sttError(client: WSClient, error: string): void {
  sendMsg(client, { type: 'stt_error', error })
  if (client.osMode && client.osScreen === 'de' && client.wm) {
    void client.wm.onSttError(error)
  }
}

function handlePrompt(client: WSClient, text: string): void {
  if (!client.dispatcher?.isAlive()) {
    sendMsg(client, { type: 'cc_error', error: 'No active CC session (it may have ended or crash-looped) — pick a directory from the menu first' })
    return
  }
  const active = client.pool.getActive()
  // A second stdin user message mid-turn kills CC with error_during_execution
  // (hardware 2026-06-11). The DE queues; this legacy path refuses loudly.
  if (active?.session.isProcessingTurn) {
    sendMsg(client, { type: 'cc_error', error: 'A turn is already in flight — wait for it to finish (or interrupt) before prompting again' })
    return
  }
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
  // A repeated auth on the same socket re-enters here — clear the previous pair
  // or it leaks (only the latest pair is cleared on ws close).
  if (client.hbInterval) clearInterval(client.hbInterval)
  if (client.livenessInterval) clearInterval(client.livenessInterval)
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
