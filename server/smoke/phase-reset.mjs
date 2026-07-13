// Soft/Hard Reset smoke (2026-07-13) — Adam's two buttons, server side:
//   SOFT: routed to the phone surface as glasses_reset (phone-only); with NO
//         phone attached the requesting surface gets a loud error message
//   HARD: broadcast hard_reset → every socket terminated → CC pool reaped →
//         WM rebuilt fresh at the root → resume pointer cleared → DURABLE
//         USER DATA SURVIVES (reader position asserted) → reconnect works
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { query, getPool } from '../dist/store.js'
import { saveActiveWindow } from '../dist/os-state.js'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 7394
const TOKEN = `smoke-${process.pid}`
const home = mkdtempSync(join(tmpdir(), 'g2cc-smoke-reset-'))
mkdirSync(join(home, '.g2cc'), { recursive: true })
writeFileSync(join(home, '.g2cc', 'config.json'), JSON.stringify({
  port: PORT, host: '127.0.0.1', authToken: TOKEN,
  stt: { engine: 'faster-whisper' },
  de: { rootNav: 'ribbon' },
}))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(process.execPath, [join(here, '..', 'dist', 'index.js')], {
  env: { ...process.env, HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d })
child.stderr.on('data', (d) => { serverLog += d })

async function connect(surface) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const inbox = []
  let closed = false
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())) } catch { /* binary */ } })
  ws.on('close', () => { closed = true })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
  const t = Date.now()
  while (!inbox.some((m) => m.type === 'auth_result')) {
    if (Date.now() - t > 5000) throw new Error('no auth_result')
    await sleep(25)
  }
  ws.send(JSON.stringify({ type: 'os_attach', surface }))
  return { ws, inbox, isClosed: () => closed, renders: () => inbox.filter((m) => m.type === 'render') }
}
async function waitFor(fn, what, ms = 8000) {
  const t = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
const hasStrip = (scene) => scene.regions.some((r) => r.name === 'strip')

const BOOK = `/smoke/reset-book-${process.pid}.epub`
try {
  // Durable user data that MUST survive a hard reset + a resume pointer that
  // must NOT.
  await query("DELETE FROM os_state WHERE key = 'active_window'").catch(() => {})
  await query('INSERT INTO reader_positions (book_path, chapter, page) VALUES ($1, 7, 42) ON CONFLICT (book_path) DO UPDATE SET chapter = 7, page = 42', [BOOK])
  await saveActiveWindow('reader')

  const t0 = Date.now()
  while (!serverLog.includes(`Listening on 127.0.0.1:${PORT}`)) {
    if (Date.now() - t0 > 15000) throw new Error(`server never listened:\n${serverLog.slice(-800)}`)
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${serverLog.slice(-800)}`)
    await sleep(50)
  }
  console.error('  throwaway server up on :7394 ✓')

  // ---- SOFT with no phone: loud error to the requester ----
  const browser = await connect('browser')
  await waitFor(() => browser.renders().length > 0, 'first render')
  browser.ws.send(JSON.stringify({ type: 'reset', kind: 'soft' }))
  const err = await waitFor(() => browser.inbox.find((m) => m.type === 'error' && m.message.includes('Soft Reset failed')), 'soft-reset error')
  assert.ok(err.message.includes('no phone attached'), 'the error must say WHY')
  assert.ok(serverLog.includes('glasses_reset (Soft Reset) needs the phone'), 'server must log the routing failure')
  console.error('  soft reset with no phone → loud error to the requester ✓')

  // ---- SOFT with a phone: glasses_reset reaches the phone ONLY ----
  const phone = await connect('phone')
  await waitFor(() => phone.renders().length > 0, 'phone attach render')
  browser.ws.send(JSON.stringify({ type: 'reset', kind: 'soft' }))
  await waitFor(() => phone.inbox.some((m) => m.type === 'glasses_reset'), 'glasses_reset on the phone')
  assert.equal(browser.inbox.filter((m) => m.type === 'glasses_reset').length, 0, 'the browser must NOT receive glasses_reset')
  console.error('  soft reset with a phone → glasses_reset to the phone only ✓')

  // ---- HARD: broadcast, terminate, rebuild, durable data survives ----
  browser.ws.send(JSON.stringify({ type: 'reset', kind: 'hard' }))
  await waitFor(() => browser.inbox.some((m) => m.type === 'hard_reset') || browser.isClosed(), 'hard_reset heads-up (or the close beat it)')
  await waitFor(() => browser.isClosed() && phone.isClosed(), 'both sockets terminated')
  await waitFor(() => serverLog.includes('HARD RESET complete'), 'hard reset completion log')
  console.error('  hard reset → heads-up + all sockets terminated ✓')

  // reconnect: fresh session at the ribbon ROOT (the pointer was cleared,
  // NOT restored to reader)
  const again = await connect('browser')
  const first = await waitFor(() => again.renders()[0]?.scene, 'render after the hard reset')
  assert.ok(hasStrip(first), `post-reset attach must land at the ribbon ROOT, got: ${first.regions.map((r) => r.name).join('+')}`)
  const ptr = await query("SELECT value FROM os_state WHERE key = 'active_window'")
  assert.equal(ptr.rows.length, 0, 'the resume pointer must be CLEARED by a hard reset')
  const pos = await query('SELECT chapter, page FROM reader_positions WHERE book_path = $1', [BOOK])
  assert.deepEqual(pos.rows[0], { chapter: 7, page: 42 }, 'DURABLE USER DATA (reader position) must survive a hard reset')
  console.error('  reconnect → ribbon root; pointer cleared; reader position SURVIVED ✓')
  again.ws.terminate()
  await sleep(200)

  console.log('phase-reset: ALL OK')
} finally {
  if (child.exitCode === null) {
    const gone = new Promise((res) => child.once('exit', res))
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => { console.error('  SIGKILL'); child.kill('SIGKILL') }, 5000)
    await gone
    clearTimeout(killTimer)
  }
  try {
    await query('DELETE FROM reader_positions WHERE book_path = $1', [BOOK])
    await query("DELETE FROM os_state WHERE key = 'active_window'")
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  rmSync(home, { recursive: true, force: true })
  await getPool().end()
}
