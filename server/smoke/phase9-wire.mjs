// Phase 9 smoke — the new wire surface end-to-end against a HERMETIC
// throwaway server instance (own HOME → own config/token, port 7399,
// stt=faster-whisper so no Parakeet GPU warm): WS auth → synthetic `notify`
// (package→priority mapping) + `client_hb` battery ≤15% crossing → rows in
// the shared notifications table. The LIVE server/glasses never see these
// (separate process = separate hub). Self-cleaning.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { query, getPool } from '../dist/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 7399
const TOKEN = `smoke-${process.pid}`
const home = mkdtempSync(join(tmpdir(), 'g2cc-smoke-home-'))
mkdirSync(join(home, '.g2cc'), { recursive: true })
writeFileSync(join(home, '.g2cc', 'config.json'), JSON.stringify({
  port: PORT, host: '127.0.0.1', authToken: TOKEN,
  stt: { engine: 'faster-whisper' },   // skips the Parakeet GPU warm
}))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(process.execPath, [join(here, '..', 'dist', 'index.js')], {
  env: { ...process.env, HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d })
child.stderr.on('data', (d) => { serverLog += d })

try {
  // wait for the throwaway server to listen
  const t0 = Date.now()
  while (!serverLog.includes(`Listening on 127.0.0.1:${PORT}`)) {
    if (Date.now() - t0 > 15000) throw new Error(`throwaway server never listened:\n${serverLog.slice(-800)}`)
    if (child.exitCode !== null) throw new Error(`throwaway server exited ${child.exitCode}:\n${serverLog.slice(-800)}`)
    await sleep(50)
  }
  console.error('  throwaway server up on :7399 ✓')

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const inbox = []
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())) } catch { /* binary/garbage */ } })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
  const tAuth = Date.now()
  while (!inbox.some((m) => m.type === 'auth_result')) {
    if (Date.now() - tAuth > 5000) throw new Error('no auth_result')
    await sleep(25)
  }
  assert.equal(inbox.find((m) => m.type === 'auth_result').success, true, 'auth must succeed')
  console.error('  WS auth ✓')

  // synthetic phone notification (gmail → email per the default packageMap)
  const stamp = Date.now()
  ws.send(JSON.stringify({
    type: 'notify', package: 'com.google.android.gm',
    title: `smoke mail ${stamp}`, text: 'phase 9 wire test', postedAt: stamp, key: `smoke|${stamp}`,
  }))
  // battery ≤15% downward crossing (prev null → 9)
  ws.send(JSON.stringify({ type: 'client_hb', now: stamp, battery: 9 }))

  const tRows = Date.now()
  let mailRow = null, battRow = null
  while ((!mailRow || !battRow) && Date.now() - tRows < 8000) {
    const r = await query(
      `SELECT source, priority, title FROM notifications
       WHERE title = $1 OR (source = 'phone' AND title = 'Phone battery 9%' AND ts > now() - interval '30 seconds')`,
      [`smoke mail ${stamp}`])
    mailRow = r.rows.find((x) => x.source === 'gm') ?? mailRow
    battRow = r.rows.find((x) => x.source === 'phone') ?? battRow
    if (!mailRow || !battRow) await sleep(100)
  }
  assert.ok(mailRow, `notify row never landed. server log tail:\n${serverLog.slice(-600)}`)
  assert.equal(mailRow.priority, 'email', 'gmail package must map to email priority')
  assert.ok(battRow, 'battery-crossing notification never landed')
  console.error('  notify → email row + battery 9% crossing row ✓')

  // a second hb at the same level must NOT re-fire (once per crossing)
  ws.send(JSON.stringify({ type: 'client_hb', now: stamp + 1, battery: 8 }))
  await sleep(500)
  const dup = await query(
    "SELECT count(*) AS n FROM notifications WHERE source = 'phone' AND title LIKE 'Phone battery %' AND ts > now() - interval '30 seconds'")
  assert.equal(Number(dup.rows[0].n), 1, 'crossing alert must fire once, not per-hb')
  console.error('  crossing fires once ✓')

  ws.close()
  console.log('phase9-wire: ALL OK')
} finally {
  // Await the child's actual exit with SIGKILL escalation (review 2026-06-11b:
  // an unawaited SIGTERM could leak a live throwaway holding :7399 + its DB
  // timers/calendar intervals). The deletes below land in the smoke DB only
  // now (_env.mjs) — the old cleanup deleted REAL battery notifications.
  if (child.exitCode === null) {
    const gone = new Promise((res) => child.once('exit', res))
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => {
      console.error('  throwaway server ignored SIGTERM for 5 s — SIGKILL')
      child.kill('SIGKILL')
    }, 5000)
    await gone
    clearTimeout(killTimer)
  }
  try {
    await query("DELETE FROM notifications WHERE title LIKE 'smoke mail %' OR (source = 'phone' AND title LIKE 'Phone battery %' AND ts > now() - interval '5 minutes')")
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  rmSync(home, { recursive: true, force: true })
  await getPool().end()
}
