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
import { loadConfig } from './config.js'
import { startDiscovery, stopDiscovery } from './discovery.js'
import { handleConnection, setWatchdog } from './ws-handler.js'
import { Watchdog } from './watchdog.js'
import { renderSetupPage, getLocalInterfaces } from './setup-page.js'
import { getEndpointJson } from './endpoints.js'

const VERSION = '0.0.1'

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
  console.log(`[g2cc-server] Auth token: ${config.authToken}`)

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
