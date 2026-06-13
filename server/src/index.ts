// G2CC server entry — Fastify + WebSocket + mDNS discovery.
//
// Routes:
//   GET  /health     — liveness probe
//   GET  /setup      — multi-endpoint QR setup page (HTML)
//   GET  /endpoints  — JSON endpoint list for client refetch (Phase 3A)
//   WS   /ws         — main WebSocket
//
// Inheritance: g2code/server/src/index.ts ported with:
//   - drops the app/dist static serving (no built-in app — Android client connects directly)
//   - adds /endpoints route
//   - rebrand g2code → g2cc

import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from './config.js'
import { startDiscovery, stopDiscovery } from './discovery.js'
import { handleConnection, setWatchdog } from './ws-handler.js'
import { Watchdog } from './watchdog.js'
import { renderSetupPage, getLocalInterfaces } from './setup-page.js'
import { getEndpointJson } from './endpoints.js'
import { warmParakeet } from './stt.js'
import { warmStore } from './store.js'
import { armTimersFromDb } from './timers.js'
import { startCalendarSync } from './calendar.js'
import { startStatsSampler } from './stats.js'
import { startTrashPurge } from './trash.js'

const VERSION = '0.0.1'

// Loud-not-fatal backstop (review 2026-06-11b): Node's default for an
// unhandled rejection is PROCESS EXIT — for the all-day DE that means a dark
// display at the factory over one missed `.catch`. Every instance logged here
// is a bug to fix (fire-and-forget paths must carry their own catches); this
// just converts "server death" into a LOUD log. uncaughtException keeps the
// default crash (state is untrustworthy after one).
process.on('unhandledRejection', (reason) => {
  console.error('[g2cc-server] UNHANDLED REJECTION (bug — a fire-and-forget path is missing its .catch):',
    reason instanceof Error ? reason.stack ?? reason.message : reason)
})

const config = loadConfig()
const watchdogInstance = new Watchdog()
watchdogInstance.on('crash_loop', (sessionId: string) => {
  console.error(`[g2cc-server] Session ${sessionId} in crash loop — stopped respawning`)
})
setWatchdog(watchdogInstance)

const server = Fastify({ logger: false })

await server.register(websocket)

// Health check.
server.get('/health', async () => ({ status: 'ok', version: VERSION }))

// Setup page — multi-endpoint QR.
server.get('/setup', async (_req, reply) => {
  const html = await renderSetupPage(config.port, config.authToken)
  reply.type('text/html').send(html)
})

// Endpoints JSON — Android client refetches on each successful auth so it
// always has the current Tailscale + LAN list.
server.get('/endpoints', async (req, reply) => {
  // Token gate via Authorization: Bearer <token> — same secret as the WS auth.
  const auth = req.headers.authorization
  const expected = `Bearer ${config.authToken}`
  if (auth !== expected) {
    reply.code(401).send({ error: 'unauthorized' })
    return
  }
  reply.send({ endpoints: getEndpointJson(config.port) })
})

// Diagnostics sink — the display harness POSTs batched verbose diag lines here
// when its Diag toggle is on. Token-gated (Bearer), appended verbatim to a
// dedicated log so it doesn't interleave with the main server stream. Loud on
// failure per the no-silent-failure rule.
const DIAG_LOG_PATH = '/tmp/g2cc-harness-diag.log'
server.post('/diag', async (req, reply) => {
  const auth = req.headers.authorization
  if (auth !== `Bearer ${config.authToken}`) {
    reply.code(401).send({ error: 'unauthorized' })
    return
  }
  const body = req.body as { lines?: unknown } | undefined
  const lines = body?.lines
  if (!Array.isArray(lines)) {
    reply.code(400).send({ error: 'body.lines must be a string array' })
    return
  }
  try {
    const text = lines.map((l) => String(l)).join('\n')
    if (text.length > 0) appendFileSync(DIAG_LOG_PATH, text + '\n')
    reply.send({ ok: true, written: lines.length })
  } catch (err) {
    console.error('[g2cc-server] /diag append failed:', err)
    reply.code(500).send({ error: 'diag append failed' })
  }
})

// Harness APK download — token-gated (the APK has the auth token baked in, so it must NOT be
// served publicly; this keeps it inside the same Tailscale/LAN trust boundary as /setup).
// Linked from /setup. Token via ?token= (matches the setup-page link) or Authorization: Bearer.
// Staged under ~/.g2cc (review 2026-06-11b): /tmp is wiped on every boot
// (bootmisc wipe_tmp=YES), so a reboot before Adam installed silently expired
// the staged build. /tmp kept as a fallback for older build instructions.
const APK_PATH = join(homedir(), '.g2cc', 'g2cc-harness.apk')
const APK_PATH_LEGACY = '/tmp/g2cc-harness.apk'
server.get('/apk', async (req, reply) => {
  const token = (req.query as { token?: string } | undefined)?.token
  const bearer = req.headers.authorization
  if (token !== config.authToken && bearer !== `Bearer ${config.authToken}`) {
    reply.code(401).send({ error: 'unauthorized' })
    return
  }
  const path = existsSync(APK_PATH) ? APK_PATH : APK_PATH_LEGACY
  if (!existsSync(path)) {
    reply.code(404).send({ error: 'harness APK not present on server (rebuild + stage to ~/.g2cc/g2cc-harness.apk)' })
    return
  }
  // readFileSync (Buffer) so Fastify sets Content-Length and sends the whole file. NOTE: a streamed
  // reply in this async handler sent 0 bytes (content-length:0) → browsers reported "download
  // failed" with no reason. The ~17 MB sync read is a few ms on a rare manual download — not worth a
  // streaming regression. (Review finding #apk-readFileSync intentionally NOT applied; see HANDOFF.)
  const apk = readFileSync(path)
  reply
    .type('application/vnd.android.package-archive')
    .header('Content-Disposition', 'attachment; filename="g2cc-harness.apk"')
    .send(apk)
})

// WebSocket route.
server.register(async (fastify) => {
  fastify.get('/ws', { websocket: true }, (socket) => {
    handleConnection(socket, config)
  })
})

try {
  await server.listen({ port: config.port, host: config.host })
  console.log(`[g2cc-server] v${VERSION}`)
  console.log(`[g2cc-server] Listening on ${config.host}:${config.port}`)
  console.log('[g2cc-server] Auth token configured (distributed via the /setup QR — never logged)')

  const ifaces = getLocalInterfaces()
  if (ifaces.length > 0) {
    console.log('[g2cc-server] Reachable at:')
    for (const iface of ifaces) {
      console.log(`  ${iface.label.padEnd(12)} http://${iface.address}:${config.port}/setup  (${iface.name})`)
    }
  }
  console.log('[g2cc-server] -> Open a /setup URL on your phone for the QR codes')

  watchdogInstance.start()
  startDiscovery(config.port)
  // Pre-warm the Parakeet STT daemon so the first voice command isn't a ~12 s
  // cold model load (fire-and-forget; lazy-loads on first request if it fails).
  void warmParakeet(config)
  // Pre-warm the Postgres store (migrations) — fire-and-forget: a down DB logs
  // loudly and every store feature lazily retries; the server must not care.
  warmStore()
  // Re-arm durable timers (crash-safe; misses fire immediately as "(late)").
  // RETRIES until it succeeds (review 2026-06-11b): the old one-shot meant a
  // Postgres that was down AT BOOT left every pre-existing timer dormant until
  // the next restart, even after the store self-healed. 60 s = supervision
  // cadence; armOne() is re-arm-idempotent and fire() is atomically guarded,
  // so a retry can never double-fire.
  const armTimers = (attempt: number): void => {
    void armTimersFromDb().catch((e: unknown) => {
      console.error(`[timers] startup re-arm failed (attempt ${attempt}; retrying in 60 s — pre-existing timers stay dormant until this succeeds): ${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => armTimers(attempt + 1), 60_000)
    })
  }
  armTimers(1)
  // Google Calendar sync (15-min pacing) + the 60 s reminder tick (Phase 10).
  startCalendarSync()
  // System-stats sampler (Adam 2026-06-12) — feeds Main → Stats charts.
  startStatsSampler()
  // Files trash daily purge (Phase 17) — drops entries older than 30 days.
  startTrashPurge((m) => console.log(m))
} catch (err) {
  console.error('[g2cc-server] Failed to start:', err)
  process.exit(1)
}

// Graceful shutdown — idempotent guard so double-Ctrl+C doesn't trigger two
// server.close() chains both calling process.exit (each watchdog.stop() and
// stopDiscovery() are individually idempotent, but the close chain is not).
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) {
    console.log('[g2cc-server] (already shutting down)')
    return
  }
  shuttingDown = true
  console.log('\n[g2cc-server] Shutting down...')
  watchdogInstance.stop()
  stopDiscovery()
  // Bug fix #9: catch close rejection — otherwise we'd hang on signal if
  // server.close() rejects (rare but possible: stuck connection). Loud-and-
  // proud per the no-silent-failure rule.
  server.close()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[g2cc-server] server.close() rejected:', err)
      process.exit(1)
    })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
