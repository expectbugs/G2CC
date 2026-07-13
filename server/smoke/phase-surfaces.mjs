// Multi-surface fan-out smoke (2026-07-13) — two surfaces (phone + browser)
// on ONE session against a hermetic throwaway server (port 7397):
//   - the browser surface receives os_status; the PHONE surface NEVER does
//     (pre-1.18 APKs log a decode failure per unknown type — the compat rule)
//   - renders fan out IDENTICALLY to every attached surface
//   - a phone-only capability with NO phone attached synthesizes a LOUD
//     error into the window (SMS window restored at boot → requestSmsThreads
//     → "no phone attached" card rendered to the browser)
//   - g2Connected rides client_hb → os_status to browsers
//   - input from the browser drives the session; killing the phone leaves the
//     browser fully functional (the continuity story)
import './_env.mjs'   // DB isolation — MUST be the first import
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
const PORT = 7397
const TOKEN = `smoke-${process.pid}`
const home = mkdtempSync(join(tmpdir(), 'g2cc-smoke-surf-'))
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
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())) } catch { /* binary */ } })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
  const t = Date.now()
  while (!inbox.some((m) => m.type === 'auth_result')) {
    if (Date.now() - t > 5000) throw new Error('no auth_result')
    await sleep(25)
  }
  assert.equal(inbox.find((m) => m.type === 'auth_result').success, true)
  ws.send(JSON.stringify({ type: 'os_attach', surface }))
  return { ws, inbox, renders: () => inbox.filter((m) => m.type === 'render'), statuses: () => inbox.filter((m) => m.type === 'os_status') }
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

const sceneText = (scene) => scene.regions.map((r) => r.content?.text ?? (r.content?.items ?? []).join('\n')).join('\n')
const hasStrip = (scene) => scene.regions.some((r) => r.name === 'strip')

try {
  // Seed the restore pointer BEFORE boot: the server restores the SMS window,
  // whose activation queries phone threads — with no phone attached that must
  // synthesize the loud failure card.
  await saveActiveWindow('sms')

  const t0 = Date.now()
  while (!serverLog.includes(`Listening on 127.0.0.1:${PORT}`)) {
    if (Date.now() - t0 > 15000) throw new Error(`server never listened:\n${serverLog.slice(-800)}`)
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${serverLog.slice(-800)}`)
    await sleep(50)
  }
  console.error('  throwaway server up on :7397 ✓')

  // ---- browser attaches alone: os_status + the no-phone SMS failure card ----
  const browser = await connect('browser')
  await waitFor(() => browser.statuses().length > 0, 'os_status on the browser surface')
  const st0 = browser.statuses().at(-1)
  assert.ok(st0.surfaces.some((s) => s.kind === 'browser'), 'os_status must list the browser surface')
  assert.equal(st0.g2Connected, null, 'g2Connected unknown before any phone hb')
  console.error('  browser attach → os_status (g2Connected=null) ✓')

  await waitFor(() => browser.renders().some((m) => sceneText(m.scene).includes('no phone attached')),
    'the synthesized no-phone SMS failure card')
  assert.ok(serverLog.includes('sms_threads_request needs the phone'), 'toPhone must log the routing failure loudly')
  console.error('  SMS restore with no phone → LOUD failure card rendered to the browser ✓')

  // ---- phone attaches: fan-out + browser-only os_status + g2Connected ----
  const phone = await connect('phone')
  await waitFor(() => phone.renders().length > 0, 'first render on the phone surface')
  // Both surfaces converge on the same latest frame (the attach re-render
  // broadcasts). Poll for equality — intermediate frames may interleave.
  await waitFor(() => {
    const b = browser.renders().at(-1); const p = phone.renders().at(-1)
    return b && p && JSON.stringify(b.scene) === JSON.stringify(p.scene)
  }, 'identical latest render on both surfaces')
  console.error('  render fan-out: latest frame identical on phone + browser ✓')

  phone.ws.send(JSON.stringify({ type: 'client_hb', now: Date.now(), g2Connected: true }))
  await waitFor(() => browser.statuses().some((s) => s.g2Connected === true), 'g2Connected=true reaching the browser via os_status')
  assert.equal(phone.statuses().length, 0, 'the PHONE surface must NEVER receive os_status (old-APK decode safety)')
  console.error('  g2Connected → os_status to browser only; phone got ZERO os_status ✓')

  // ---- input from the browser drives the one session ----
  browser.ws.send(JSON.stringify({ type: 'input', event: 'double_tap' }))
  await waitFor(() => browser.renders().some((m) => hasStrip(m.scene)) && phone.renders().some((m) => hasStrip(m.scene)),
    'ribbon root on BOTH surfaces after browser back-gesture')
  console.error('  browser double_tap → ribbon root broadcast to both ✓')

  // ---- kill the phone: the browser keeps driving ----
  const nRenders = browser.renders().length
  phone.ws.terminate()
  await waitFor(() => browser.statuses().some((s) => !s.surfaces.some((x) => x.kind === 'phone')), 'os_status without the phone after its close')
  browser.ws.send(JSON.stringify({ type: 'input', event: 'tap' }))   // enter the highlighted window
  await waitFor(() => browser.renders().length > nRenders && !hasStrip(browser.renders().at(-1).scene),
    'a fresh in-window render on the browser after the phone died')
  console.error('  phone killed → browser input still drives the session ✓')

  browser.ws.terminate()
  await sleep(200)
  console.log('phase-surfaces: ALL OK')
} finally {
  if (child.exitCode === null) {
    const gone = new Promise((res) => child.once('exit', res))
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => { console.error('  SIGKILL'); child.kill('SIGKILL') }, 5000)
    await gone
    clearTimeout(killTimer)
  }
  try { await query("DELETE FROM os_state WHERE key = 'active_window'") } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  rmSync(home, { recursive: true, force: true })
  await getPool().end()
}
