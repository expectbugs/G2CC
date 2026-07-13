// os-session.ts — the persistent OS session (multi-surface continuity, 2026-07-13).
//
// Before this module, the OS session (WindowManager + SessionPool + phone-fed
// state) was a property of ONE WebSocket connection: built lazily on os_attach,
// disposed on ws close, every CC subprocess killed with it (the explicit
// kill-on-disconnect policy, ws-handler ws.on('close')). Taking the glasses off
// reset the OS to Main and killed live CC work.
//
// Now the session is a PROCESS SINGLETON created at server boot. WebSocket
// connections attach to it as SURFACES (phone app / PC browser page) that all
// receive the same `render` broadcast and all feed input into the one
// WindowManager. Disconnecting a surface detaches it; the session — window
// state, CC subprocesses, everything — lives on. That is the continuity story:
// glasses on the charger, keep reading from the PC, pull out the phone, keep
// going. See the plan: persistence + multi-surface control.
//
// Design notes:
//   - Single global session (single user, single token). No per-token keying.
//   - The WindowManager is constructed AT BOOT, not on first attach — timers /
//     notifications queue properly while nothing is attached, and restart
//     resume (os-state.ts) is one code path.
//   - Phone-only capabilities (dictation mic, SMS, media, notification reply,
//     phone locate, display_reload) route to the NEWEST-attached phone surface
//     via toPhone(). When no phone is attached the failure is synthesized into
//     the window's existing reply channel — LOUD AND PROUD, never silent.
//   - Legacy paths (dispatch menu, 'menu'/'probe' screens) keep their
//     per-connection SessionPool in ws-handler; the DE pool lives here.
//   - hardReset() rebuilds pool + WM in-process (there is NO supervisor to
//     restart an exited server — verified 2026-07-13, PID parented to init).

import type { WebSocket } from '@fastify/websocket'
import type { ServerMessage, SurfaceKind, WireScene } from '@g2cc/shared'
import type { G2CCConfig } from './config.js'
import type { MemoAudio } from './memo.js'
import { SessionPool } from './session-pool.js'
import { WindowManager } from './window-manager.js'
import type { Watchdog } from './watchdog.js'
import { notify } from './os-notify.js'
import { setScoutSurfacesProvider } from './scout-live.js'
import { paperclips } from './paperclips.js'
import { loadActiveWindow, clearActiveWindow } from './os-state.js'

export interface OsSurface {
  id: string
  kind: SurfaceKind
  ws: WebSocket
  attachedAt: number
}

let surfaceSeq = 0

export class OsSession {
  /** THE DE session pool — CC subprocesses here survive surface disconnects.
   *  They die only on explicit close (session_close / window actions), a
   *  watchdog crash-loop give-up, hard reset, or server shutdown. */
  pool: SessionPool
  /** The one WindowManager — constructed at boot in initOsSession. */
  wm!: WindowManager
  private surfaces = new Map<string, OsSurface>()
  private watchdog: Watchdog | null = null
  /** Injected from index.ts (ws-handler's closeAllClients — a direct import
   *  would be a module cycle): terminate every live WS client. */
  private terminateClients: () => number = () => 0
  private hardResetting = false

  // ---- phone-fed session state (moved off the per-connection WSClient) ----
  phoneBattery: number | null = null
  g2Battery: number | null = null
  /** Glasses BLE-connected per the phone's client_hb. null = unknown (no phone
   *  attached yet, or a pre-1.18 APK that doesn't report it). */
  g2Connected: boolean | null = null
  /** The raw PCM (+ format) of the most recent SUCCESSFUL dictation — kept so a
   *  `memo:` intent can save the clip at confirm time. */
  lastDictationAudio: MemoAudio | null = null

  constructor(readonly config: G2CCConfig) {
    this.pool = new SessionPool()
  }

  // ---- surface registry ----

  /** Attach a connection as a surface. Idempotent per socket: re-attaching an
   *  already-attached ws updates its kind and returns the existing surface
   *  (the app re-sends os_attach after a BLE cold-launch to force a repaint). */
  attach(ws: WebSocket, kind: SurfaceKind): OsSurface {
    for (const s of this.surfaces.values()) {
      if (s.ws === ws) {
        if (s.kind !== kind) {
          console.log(`[os-session] surface ${s.id} re-attached as '${kind}' (was '${s.kind}')`)
          s.kind = kind
        } else {
          console.log(`[os-session] surface ${s.id} (${s.kind}) re-attached`)
        }
        this.broadcastOsStatus()
        return s
      }
    }
    const surface: OsSurface = { id: `srf-${++surfaceSeq}`, kind, ws, attachedAt: Date.now() }
    this.surfaces.set(surface.id, surface)
    console.log(`[os-session] surface ${surface.id} (${kind}) attached — ${this.surfaces.size} attached`)
    this.broadcastOsStatus()
    return surface
  }

  /** Detach a surface (ws close). The session lives on — that is the point. */
  detach(surfaceId: string): void {
    const s = this.surfaces.get(surfaceId)
    if (!s) return
    this.surfaces.delete(surfaceId)
    console.log(`[os-session] surface ${surfaceId} (${s.kind}) detached — ${this.surfaces.size} remain; session lives on`)
    this.broadcastOsStatus()
  }

  hasDisplay(): boolean { return this.surfaces.size > 0 }

  surfaceList(): { id: string; kind: SurfaceKind }[] {
    return [...this.surfaces.values()].map((s) => ({ id: s.id, kind: s.kind }))
  }

  /** The newest-attached phone surface (the app's silent-drop recovery can
   *  briefly overlap an old and a new socket — newest wins). */
  phoneSurface(): OsSurface | null {
    let best: OsSurface | null = null
    for (const s of this.surfaces.values()) {
      if (s.kind === 'phone' && (best === null || s.attachedAt > best.attachedAt)) best = s
    }
    return best
  }

  // ---- sends ----

  /** Send to every attached surface. Stringifies ONCE. Returns sends made. */
  broadcast(msg: ServerMessage): number {
    const str = JSON.stringify(msg)
    let n = 0
    for (const s of this.surfaces.values()) {
      if (s.ws.readyState === 1) {
        s.ws.send(str)
        n++
      }
    }
    return n
  }

  broadcastRender(scene: WireScene): void {
    this.broadcast({ type: 'render', scene })
  }

  /** Send to browser surfaces only (os_status / surface_view — a pre-1.18 APK
   *  logs a decode failure per unknown message type, so phones never see these). */
  broadcastToBrowsers(msg: ServerMessage): number {
    const str = JSON.stringify(msg)
    let n = 0
    for (const s of this.surfaces.values()) {
      if (s.kind === 'browser' && s.ws.readyState === 1) {
        s.ws.send(str)
        n++
      }
    }
    return n
  }

  broadcastOsStatus(): void {
    this.broadcastToBrowsers({
      type: 'os_status',
      surfaces: this.surfaceList(),
      g2Connected: this.g2Connected,
    })
  }

  /** Route a phone-only message to the phone surface. Returns false (with a
   *  loud log) when no phone is attached — callers synthesize the truthful
   *  failure into the requesting window's reply channel. */
  toPhone(msg: ServerMessage, what: string): boolean {
    const phone = this.phoneSurface()
    if (!phone || phone.ws.readyState !== 1) {
      console.error(`[os-session] ${what} needs the phone — no phone surface attached (${this.surfaces.size} surface(s): ${this.surfaceList().map((s) => s.kind).join(',') || 'none'})`)
      return false
    }
    phone.ws.send(JSON.stringify(msg))
    return true
  }

  /** The phone reported (or changed) glasses-BLE state via client_hb. */
  setG2Connected(v: boolean): void {
    if (this.g2Connected === v) return
    this.g2Connected = v
    console.log(`[os-session] glasses BLE ${v ? 'CONNECTED' : 'disconnected'} (per phone client_hb)`)
    this.broadcastOsStatus()
  }

  // ---- lifecycle (boot + hard reset) ----

  /** One-time boot wiring (initOsSession). */
  bootstrap(watchdog: Watchdog | null, terminateClients: () => number): void {
    this.watchdog = watchdog
    this.terminateClients = terminateClients
    // The crash-loop listener is on the GLOBAL watchdog and reads this.pool at
    // call time, so it survives hardReset's pool swap — registered ONCE here.
    watchdog?.on('crash_loop', (sessionId: string) => {
      const entry = this.pool.get(sessionId)
      if (!entry) return // not a DE-pool session (a legacy per-connection pool owns it)
      void notify({
        source: 'watchdog',
        priority: 'info',
        title: 'CC session crash-looped',
        body: `Session "${entry.name}" crash-looped and was stopped. Open its window to start it fresh.`,
        targetWindow: 'notices',
      })
    })
    this.wirePool()
    this.buildWm()
    // /scout/live/status truthfulness: how many surfaces are actually looking.
    setScoutSurfacesProvider(() => this.surfaces.size)
    // Restart resume (os-state): reopen the last active window. Fire-and-forget
    // — a down DB logs loudly and the WM simply stays at the root; the restore
    // self-guards against racing a user who navigated first (restoreActiveWindow).
    if (this.config.de.resumeWindow !== false) {
      void loadActiveWindow().then((id) => {
        if (id) this.wm.restoreActiveWindow(id)
      }).catch((e: unknown) => {
        console.error(`[os-session] restart-resume load failed (staying at the root): ${e instanceof Error ? e.message : String(e)}`)
      })
    } else {
      console.log('[os-session] restart-resume disabled (de.resumeWindow=false)')
    }
  }

  /** Per-pool-instance event wiring (re-run after hardReset swaps the pool). */
  private wirePool(): void {
    // background_alert: the DE surfaces session state via its own window
    // listeners — this is belt-and-braces logging so a background session's
    // alert is never fully invisible even when no window is watching.
    this.pool.on('background_alert', (alert: { sessionId: string; alertType: string; details?: string }) => {
      console.warn(`[os-session] background_alert ${alert.alertType} for ${alert.sessionId}${alert.details ? `: ${alert.details}` : ''}`)
    })
    this.pool.on('session_evicted', (id: string) => { this.watchdog?.unregister(id) })
  }

  /** Build (or rebuild) THE WindowManager wired to this session. */
  private buildWm(): void {
    this.wm = new WindowManager({
      send: (scene) => { this.broadcastRender(scene) },
      audio: (action, mode) => {
        if (!this.toPhone({ type: 'audio_request', action, mode }, `audio_request(${action})`)) {
          // Synthesize the failure into the window's dictation-error channel —
          // deferred a microtask so a ctx.audio call from inside a window
          // handler can't re-enter that same window synchronously.
          queueMicrotask(() => {
            void this.wm.onSttError('No phone attached — dictation needs the phone. Type from the PC page / phone keyboard instead.')
          })
        }
      },
      displayReload: () => {
        // BLE unstick — meaningless without a phone; the recompose that follows
        // still reaches every surface as a normal render. Loud log only.
        this.toPhone({ type: 'display_reload' }, 'display_reload')
      },
      log: (msg) => console.log(msg),
      pool: this.pool,
      config: this.config,
      registerWatchdog: (entry) => this.watchdog?.register(entry.id, entry.session, entry.projectPath),
      unregisterWatchdog: (entryId) => this.watchdog?.unregister(entryId),
      phoneBattery: () => this.phoneBattery,
      g2Battery: () => this.g2Battery,
      lastDictationAudio: () => this.lastDictationAudio,
      hasDisplay: () => this.hasDisplay(),
      dismissPhoneNotification: (key) => {
        this.toPhone({ type: 'notification_cancel', key }, 'notification_cancel')
        // No reply channel — the phone's cancel is idempotent and best-effort
        // by contract; absence is already loudly logged by toPhone.
      },
      replyToNotification: (key, text) => {
        if (!this.toPhone({ type: 'notification_reply', key, text }, 'notification_reply')) {
          queueMicrotask(() => { this.wm.onNotificationReplyResult(key, false, 'no phone attached — replies need the phone') })
        }
      },
      mediaCommand: (cmd) => {
        this.toPhone({ type: 'media_cmd', cmd }, `media_cmd(${cmd})`)
        // Media window renders "no data" without a phone; toPhone already logged.
      },
      requestSmsThreads: (offset, limit) => {
        if (!this.toPhone({ type: 'sms_threads_request', offset, limit }, 'sms_threads_request')) {
          queueMicrotask(() => { this.wm.onSmsThreads([], offset, 0, 'no phone attached — SMS needs the phone') })
        }
      },
      requestSmsThread: (threadId, page) => {
        if (!this.toPhone({ type: 'sms_thread_request', threadId, page }, 'sms_thread_request')) {
          queueMicrotask(() => { this.wm.onSmsThread(threadId, '', '', [], 1, 1, 'no phone attached — SMS needs the phone') })
        }
      },
      sendSms: (address, text) => {
        if (!this.toPhone({ type: 'sms_send', address, text }, 'sms_send')) {
          queueMicrotask(() => { this.wm.onSmsSendResult(address, false, 'no phone attached — the SMS was NOT sent') })
        }
      },
      phoneLocate: (action) => this.toPhone({ type: 'phone_locate', action }, `phone_locate(${action})`),
    })
  }

  /** HARD RESET (Adam's button, 2026-07-13): kill everything cleanly and
   *  rebuild the ENTIRE live system to a clean initial state, IN-PROCESS
   *  (no supervisor exists to restart an exited server). ALL durable user
   *  data is preserved — reader positions, timers, notifications, history,
   *  the CC resume index, MRU. What dies: every DE CC subprocess, the
   *  WindowManager (rebuilt fresh at the root), the paperclips jsdom, all
   *  client sockets (their reconnect loops bring every surface back fresh),
   *  and all session transients. */
  async hardReset(): Promise<void> {
    if (this.hardResetting) {
      console.warn('[os-session] hard reset already in progress — ignoring the duplicate request')
      return
    }
    this.hardResetting = true
    try {
      console.warn('[os-session] ═══ HARD RESET ═══ killing all live state (durable user data preserved)')
      // 1. Courtesy heads-up so UIs can show "restarting" before their socket
      //    drops (v1.18 phones also run a full local teardown on it), then one
      //    event-loop turn so the frames actually flush before terminate().
      this.broadcast({ type: 'hard_reset' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      // 2. Flush the CC resume index while sessions are still alive (it reads
      //    the LIVE session map), then kill every DE CC subprocess.
      try { this.pool.persistSessionMeta() } catch (e) {
        console.error(`[os-session] hard reset: resume-index flush failed (continuing): ${e instanceof Error ? e.message : String(e)}`)
      }
      const nSessions = this.pool.count
      for (const entry of this.pool.allEntries()) {
        this.watchdog?.unregister(entry.id)
        try { this.pool.closeSession(entry.id) } catch (e) {
          console.error(`[os-session] hard reset: closing session ${entry.id} threw: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      console.warn(`[os-session] hard reset: killed ${nSessions} DE CC session(s) (resume index flushed first)`)
      // 3. Dispose the WM — hub listeners, pacers, window resources (Terminal
      //    poll), the scout live sink.
      try { this.wm.dispose() } catch (e) {
        console.error(`[os-session] hard reset: wm.dispose threw: ${e instanceof Error ? e.message : String(e)}`)
      }
      // 4. Paperclips: flush the save + drop the process-lifetime jsdom so the
      //    next open rebuilds from the persisted save.
      await paperclips.shutdown('hard reset')
      // 5. Clear the resume-window pointer so the rebuilt WM boots at the root
      //    (a down DB logs loudly and the pointer simply survives — acceptable,
      //    the reset still happened).
      try { await clearActiveWindow() } catch (e) {
        console.error(`[os-session] hard reset: clearing the resume pointer failed (it will survive): ${e instanceof Error ? e.message : String(e)}`)
      }
      // 6. Terminate every client socket — the phone's five-defence reconnect
      //    and the PC page's backoff loop bring every surface back fresh.
      const nClients = this.terminateClients()
      console.warn(`[os-session] hard reset: terminated ${nClients} client socket(s) (they auto-reconnect)`)
      this.surfaces.clear()   // close events also detach; explicit for determinism
      // 7. Reset transients + fresh pool + fresh WM.
      this.phoneBattery = null
      this.g2Battery = null
      this.g2Connected = null
      this.lastDictationAudio = null
      this.pool = new SessionPool()
      this.wirePool()
      this.buildWm()
      console.warn('[os-session] ═══ HARD RESET complete — clean initial state; waiting for surfaces to reconnect ═══')
    } finally {
      this.hardResetting = false
    }
  }

}

let session: OsSession | null = null

/** Create THE OsSession + its WindowManager at server boot. Idempotent-hostile
 *  by design: a second call is a bug and throws. */
export function initOsSession(
  config: G2CCConfig,
  watchdog: Watchdog | null,
  terminateClients: () => number,
): OsSession {
  if (session) throw new Error('initOsSession called twice — the OS session is a boot-time singleton')
  const s = new OsSession(config)
  session = s
  s.bootstrap(watchdog, terminateClients)
  console.log('[os-session] OS session + WindowManager created at boot (multi-surface persistence ON)')
  return s
}

/** The boot-created session. Throws (loud) if init never ran — every caller is
 *  inside the server process where initOsSession is unconditional at boot. */
export function getOsSession(): OsSession {
  if (!session) throw new Error('OsSession not initialized — initOsSession(config, watchdog, terminateClients) must run at boot')
  return session
}
