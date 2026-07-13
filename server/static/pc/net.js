// net.js — the PC surface's WebSocket lifecycle. Mirrors the phone
// ConnectionManager's defences at browser scale:
//   auth{token} within the server's 5 s window → os_attach{surface:'browser'}
//   reply client_hb to EVERY hb + a proactive one every 10 s (the server kicks
//   clients silent > 45 s — background-tab timer throttling still fires ≥1/min,
//   and the reconnect loop covers the worst case)
//   reconnect forever: backoff 1 s ×1.5 → 30 s; a 5 s liveness tick forces a
//   reconnect after 30 s of inbound silence. Cadences are keepalive/pacing —
//   compatible with the no-timeouts rule (nothing bounds an operation).

const HB_MS = 10_000
const LIVENESS_TICK_MS = 5_000
const SILENCE_LIMIT_MS = 30_000
const BACKOFF_START_MS = 1_000
const BACKOFF_FACTOR = 1.5
const BACKOFF_MAX_MS = 30_000

export class Net {
  /**
   * @param {string} token
   * @param {{ onMessage: (msg: object) => void,
   *           onState: (state: string, detail?: string) => void }} handlers
   */
  constructor(token, handlers) {
    this.token = token
    this.handlers = handlers
    this.ws = null
    this.attached = false
    this.backoffMs = BACKOFF_START_MS
    this.lastInboundAt = Date.now()
    this.hbTimer = setInterval(() => this.proactiveHb(), HB_MS)
    this.livenessTimer = setInterval(() => this.livenessCheck(), LIVENESS_TICK_MS)
    this.reconnectTimer = null
    this.closedByUs = false
  }

  connect() {
    this.closedByUs = false
    this.handlers.onState('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let ws
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`)
    } catch (e) {
      this.handlers.onState('error', `socket create failed: ${e.message}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.lastInboundAt = Date.now()
      ws.send(JSON.stringify({ type: 'auth', token: this.token }))
    }
    ws.onmessage = (ev) => {
      this.lastInboundAt = Date.now()
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }   // binary/garbage — not ours
      if (msg.type === 'auth_result') {
        if (msg.success) {
          this.backoffMs = BACKOFF_START_MS
          this.attached = true
          ws.send(JSON.stringify({ type: 'os_attach', surface: 'browser' }))
          this.handlers.onState('online')
        } else {
          this.handlers.onState('error', `auth REJECTED: ${msg.error ?? '?'} — re-open /pc from /setup`)
          this.closedByUs = true   // no point hammering a bad token
          ws.close()
        }
        return
      }
      if (msg.type === 'hb') {
        this.sendRaw({ type: 'client_hb', now: Date.now() })
        return
      }
      this.handlers.onMessage(msg)
    }
    ws.onclose = () => {
      this.attached = false
      if (this.closedByUs) { this.handlers.onState('stopped'); return }
      this.handlers.onState('reconnecting', `in ${(this.backoffMs / 1000).toFixed(1)}s`)
      this.scheduleReconnect()
    }
    ws.onerror = () => { /* onclose follows and handles it */ }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * BACKOFF_FACTOR)
      this.connect()
    }, this.backoffMs)
  }

  proactiveHb() {
    this.sendRaw({ type: 'client_hb', now: Date.now() })
  }

  livenessCheck() {
    if (!this.ws || this.ws.readyState !== 1) return
    if (Date.now() - this.lastInboundAt > SILENCE_LIMIT_MS) {
      this.handlers.onState('reconnecting', 'inbound silence > 30s — cycling the socket')
      try { this.ws.close() } catch { /* onclose reconnects */ }
    }
  }

  /** True when the message actually went into an OPEN socket. */
  sendRaw(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  /** User-visible send (input/text/reset): false = surface it in the strip. */
  send(msg) {
    const ok = this.sendRaw(msg)
    if (!ok) this.handlers.onState('error', 'send failed — not connected')
    return ok
  }
}
