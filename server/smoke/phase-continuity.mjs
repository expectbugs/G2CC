// Multi-surface continuity smoke (2026-07-13) — the core persistence property
// against a HERMETIC throwaway server (own HOME/config/token, port 7398,
// ribbon root-nav = Adam's live shape):
//
//   Part 1 (session survives disconnect): attach → tap into a window →
//   hard-close the WS → reconnect + re-attach → the FIRST render is still the
//   in-window scene (NOT the ribbon root) — the WindowManager was neither
//   disposed nor rebuilt. The close log says the surface detached + only
//   LEGACY sessions (0) were killed.
//
//   Part 2 (restart resume, W1-B): SIGTERM the server, start a fresh process
//   on the SAME home/DB, attach → the restored active window renders (Reader
//   restored via os_state), NOT the root.
import './_env.mjs'   // DB isolation — MUST be the first import
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { query, getPool } from '../dist/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 7398
const TOKEN = `smoke-${process.pid}`
const home = mkdtempSync(join(tmpdir(), 'g2cc-smoke-cont-'))
mkdirSync(join(home, '.g2cc'), { recursive: true })
writeFileSync(join(home, '.g2cc', 'config.json'), JSON.stringify({
  port: PORT, host: '127.0.0.1', authToken: TOKEN,
  stt: { engine: 'faster-whisper' },
  de: { rootNav: 'ribbon' },
}))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startServer() {
  const child = spawn(process.execPath, [join(here, '..', 'dist', 'index.js')], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { child, log: '' }
  child.stdout.on('data', (d) => { state.log += d })
  child.stderr.on('data', (d) => { state.log += d })
  return state
}

async function waitListening(state) {
  const t0 = Date.now()
  while (!state.log.includes(`Listening on 127.0.0.1:${PORT}`)) {
    if (Date.now() - t0 > 15000) throw new Error(`server never listened:\n${state.log.slice(-800)}`)
    if (state.child.exitCode !== null) throw new Error(`server exited ${state.child.exitCode}:\n${state.log.slice(-800)}`)
    await sleep(50)
  }
}

async function stopServer(state) {
  if (state.child.exitCode === null) {
    const gone = new Promise((res) => state.child.once('exit', res))
    state.child.kill('SIGTERM')
    const killTimer = setTimeout(() => {
      console.error('  server ignored SIGTERM for 5 s — SIGKILL')
      state.child.kill('SIGKILL')
    }, 5000)
    await gone
    clearTimeout(killTimer)
  }
}

/** Open + auth + os_attach a surface; returns { ws, inbox, renders() }. */
async function attachSurface(surface) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const inbox = []
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())) } catch { /* binary */ } })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
  const t = Date.now()
  while (!inbox.some((m) => m.type === 'auth_result')) {
    if (Date.now() - t > 5000) throw new Error('no auth_result')
    await sleep(25)
  }
  assert.equal(inbox.find((m) => m.type === 'auth_result').success, true, 'auth must succeed')
  ws.send(JSON.stringify(surface ? { type: 'os_attach', surface } : { type: 'os_attach' }))
  return {
    ws,
    inbox,
    renders: () => inbox.filter((m) => m.type === 'render'),
  }
}

const hasStrip = (scene) => scene.regions.some((r) => r.name === 'strip')

async function waitRender(client, pred, what, ms = 8000) {
  const t = Date.now()
  for (;;) {
    const hit = client.renders().find((m) => pred(m.scene))
    if (hit) return hit.scene
    if (Date.now() - t > ms) {
      const seen = client.renders().map((m) => m.scene.regions.map((r) => r.name).join('+')).join(' | ')
      throw new Error(`${what} never rendered. renders seen: ${seen || '(none)'}`)
    }
    await sleep(50)
  }
}

// Earlier suite tests run REAL in-process WindowManagers against the shared
// smoke DB — their switchTo calls persist active_window (correct behavior!),
// which this server would faithfully restore at boot and land the first
// attach INSIDE a window instead of at the ribbon root. Clear the pointer
// BEFORE booting so part 1 starts from the true boot default.
await query("DELETE FROM os_state WHERE key = 'active_window'").catch(() => { /* table may not exist yet — fine */ })

let state = startServer()
try {
  await waitListening(state)
  console.error('  throwaway server up on :7398 ✓')

  // ---- Part 1: the session survives a WS disconnect ----
  const c1 = await attachSurface('phone')
  await waitRender(c1, hasStrip, 'ribbon root (first attach)')
  console.error('  attach → ribbon root ✓')

  // Tap at the ribbon root enters the highlighted window (slot 0 = Main).
  c1.ws.send(JSON.stringify({ type: 'input', event: 'tap' }))
  const inWin = await waitRender(c1, (s) => !hasStrip(s), 'in-window scene after tap')
  const winTitle = inWin.regions.find((r) => r.name === 'title')?.content?.text ?? '(?)'
  console.error(`  tap → entered window ("${winTitle}") ✓`)

  // Hard-close the socket. The session must live on.
  const preCloseLog = state.log.length
  c1.ws.terminate()
  const tClose = Date.now()
  while (!state.log.slice(preCloseLog).includes('session lives on')) {
    if (Date.now() - tClose > 5000) throw new Error(`close never logged surface detach:\n${state.log.slice(-800)}`)
    await sleep(50)
  }
  const closeSlice = state.log.slice(preCloseLog)
  assert.ok(closeSlice.includes('killed 0 LEGACY sessions'), `close must kill only LEGACY sessions (0):\n${closeSlice.slice(-400)}`)
  assert.ok(!/killed [1-9]\d* /.test(closeSlice), 'close must not kill any real sessions')
  console.error('  WS close → surface detached, session alive, 0 kills ✓')

  // Reconnect + re-attach: the FIRST render must still be the in-window scene
  // (the old per-connection WM would have rebuilt at the ribbon root).
  const c2 = await attachSurface('phone')
  const back = await waitRender(c2, () => true, 'first render after re-attach')
  assert.ok(!hasStrip(back), `re-attach must resume IN-WINDOW (continuity), got regions: ${back.regions.map((r) => r.name).join('+')}`)
  const backTitle = back.regions.find((r) => r.name === 'title')?.content?.text ?? '(?)'
  assert.equal(backTitle, winTitle, 'the SAME window must be on screen after reconnect')
  assert.ok(state.log.includes('DE session resumed'), 'os_attach log must say the session resumed')
  console.error('  reconnect → SAME window, same title, no reset ✓')
  c2.ws.terminate()
  await sleep(200)

  // ---- Part 2: restart resume (os-state pointer across a server restart) ----
  // The tap above persisted active_window='main' (the boot default — restoring
  // it is a no-op), so verify the WRITE happened, then point it at a real
  // window and restart: the fresh process must reopen it. (Driving the ribbon
  // drawer to reach Timers by taps would be UI-fragile; rewriting the pointer
  // tests exactly the persist/restore contract.)
  const t2 = Date.now()
  let persisted = null
  while (persisted === null && Date.now() - t2 < 5000) {
    const r = await query("SELECT value FROM os_state WHERE key = 'active_window'")
    persisted = r.rows[0]?.value ?? null
    if (persisted === null) await sleep(100)
  }
  assert.equal(persisted, 'main', `switchTo must persist the active window (got ${JSON.stringify(persisted)})`)
  console.error('  active_window persisted on switchTo ✓')

  await query(`UPDATE os_state SET value = to_jsonb('timers'::text) WHERE key = 'active_window'`)
  await stopServer(state)
  assert.ok(state.log.includes('Shutting down'), 'graceful shutdown must run')
  state = startServer()
  await waitListening(state)
  console.error('  server restarted on the same HOME/DB ✓')

  const c3 = await attachSurface('phone')
  // The restore is an async DB load racing the attach — wait for the Timers
  // scene (title contains 'Timers'), whether it is the first render or follows
  // a root paint.
  await waitRender(c3, (s) => {
    const title = s.regions.find((r) => r.name === 'title')?.content?.text ?? ''
    return !hasStrip(s) && title.includes('Timers')
  }, 'restored Timers window after restart')
  assert.ok(state.log.includes('restart-resume → timers'), `restore must log its switch:\n${state.log.slice(-400)}`)
  console.error('  restart → attach lands in the RESTORED window (Timers) ✓')
  c3.ws.terminate()
  await sleep(200)

  console.log('phase-continuity: ALL OK')
} finally {
  await stopServer(state)
  // Drop the pointer — a leftover row would make the NEXT run's part-1 boot
  // restore a window and fail the "attach → ribbon root" assertion.
  try { await query("DELETE FROM os_state WHERE key = 'active_window'") } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  rmSync(home, { recursive: true, force: true })
  await getPool().end()
}
