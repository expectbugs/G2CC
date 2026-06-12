// Phase 4 smoke — notification layer behavior against a REAL WindowManager
// with a scene-capturing context: title flash, awake overlay, queue-behind-
// overlay, queue-behind-dictation + flush, blanked popup (10s rule, here
// shortened), newest-wins, double-tap wake, seen-marking. Self-cleaning.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { WindowManager, setBlankPopupMsForSmoke } from '../dist/os-windows.js'
import { notify } from '../dist/os-notify.js'
import { query, getPool } from '../dist/store.js'

setBlankPopupMsForSmoke(250)

const EMIT = process.argv.includes('--emit-scene')
// Emit mode: stdout must carry ONLY the scene JSON — server modules log via
// console.log, so route everything to stderr for the pipe run.
if (EMIT) console.log = (...a) => console.error(...a)

const scenes = []
const wm = new WindowManager({
  send: (scene) => scenes.push(scene),
  audio: () => {},
  displayReload: () => {},
  log: (m) => console.error(`    ${m}`),
  pool: { count: 1 },
  config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
  registerWatchdog: () => {},
  unregisterWatchdog: () => {},
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, what, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = pred()
    if (hit) return hit
    await sleep(25)
  }
  throw new Error(`waitFor timed out: ${what}`)
}
const last = () => scenes[scenes.length - 1]
const titleOf = (s) => s?.regions.find((r) => r.name === 'title')?.content?.text ?? ''
const statusOf = (s) => s?.regions.find((r) => r.name === 'status')?.content?.text ?? ''
const menuOf = (s) => s?.regions.find((r) => r.name === 'menu')?.content?.items ?? []
const isBlank = (s) => s?.regions.length === 1 && s.regions[0].name === 'wake'

try {
  // --- baseline: notices window renders ---
  wm.switchTo('notices')
  await waitFor(() => titleOf(last()).includes('Notices'), 'notices view')

  // --- 1. info → title flash + unseen badge, NO overlay ---
  await notify({ source: 'smoke', priority: 'info', title: 'smoke info flash', body: 'hello' })
  await waitFor(() => titleOf(last()).includes('⚠ smoke info flash'), 'title flash')
  assert.ok(statusOf(last()).includes('⚠'), 'status badge shows unseen count')
  assert.ok(!menuOf(last()).includes('Open'), 'info must NOT overlay')
  console.error('  1. info → title flash + badge, no overlay ✓')

  // --- 2. timer while interruptible → full overlay ---
  await notify({ source: 'smoke', priority: 'timer', title: 'tea ready', body: 'the tea is done steeping' })
  await waitFor(() => titleOf(last()).includes('⚠ timer · smoke'), 'timer overlay')
  assert.deepEqual(menuOf(last()), ['Open', 'Dismiss', 'Main'])
  const overlayScene = last()   // stashed for --emit-scene parity check
  console.error('  2. timer → overlay with Open/Dismiss/Main ✓')
  if (EMIT) {
    process.stdout.write(JSON.stringify(overlayScene))
    throw { emitDone: true }   // skip the remaining steps; finally still cleans up
  }

  // --- 3. call while overlay active → QUEUES ---
  await notify({ source: 'smoke', priority: 'call', title: 'Mom', body: 'incoming call' })
  await sleep(150)
  assert.ok(titleOf(last()).includes('⚠ timer'), 'first overlay still showing')
  assert.equal(wm.pendingNotifs.length, 1, 'call queued behind active overlay')
  console.error('  3. call behind overlay → queued ✓')

  // --- 4. Dismiss → queued call flushes ---
  await wm.onSelect('menu', 1)   // Dismiss on the overlay menu
  await waitFor(() => titleOf(last()).includes('⚠ call · smoke'), 'queued call promoted')
  assert.equal(wm.pendingNotifs.length, 0)
  await wm.onSelect('menu', 1)   // Dismiss the call too
  await waitFor(() => titleOf(last()).includes('Notices') || titleOf(last()).includes('⚠ smoke info'), 'back to notices')
  console.error('  4. dismiss → queue flush promotes call, then back to window ✓')

  // --- 5. dictation gate: not interruptible → queue; clear → flush ---
  const aria = wm.windows.find((w) => w.id === 'aria')
  aria.opened = true                  // skip the CC spawn
  aria.session.listening = true       // fake live dictation
  wm.switchTo('aria')
  // NB: the title is flash-overridden (step 1's info is deliberately unread),
  // so detect the aria LISTENING view by its menu instead.
  await waitFor(() => menuOf(last()).includes('Done'), 'aria listening view')
  await notify({ source: 'smoke', priority: 'timer', title: 'queued behind mic', body: 'x' })
  await sleep(150)
  assert.equal(wm.pendingNotifs.length, 1, 'timer queued while listening')
  assert.ok(!menuOf(last()).includes('Open'), 'no overlay during dictation')
  aria.session.listening = false
  wm.requestRender()
  await waitFor(() => titleOf(last()).includes('⚠ timer · smoke'), 'flush after dictation clears')
  await wm.onSelect('menu', 1)   // Dismiss
  console.error('  5. dictation queues overlay; flush on idle render ✓')

  // --- 6. blanked popup: pops, auto-re-blanks, marked seen ---
  wm.switchTo('main')
  // main's menu is the switcher list (title may be flash-overridden)
  await waitFor(() => menuOf(last()).includes('Aria') && menuOf(last()).includes('Reload'), 'main view')
  await wm.onBackGesture()            // blank at Main root
  await waitFor(() => isBlank(last()), 'blanked')
  await notify({ source: 'smoke-blank', priority: 'email', title: 'wake me', body: 'blanked popup test' })
  await waitFor(() => titleOf(last()).includes('⚠ email · smoke-blank'), 'blanked popup (low prio pops too)')
  await waitFor(() => isBlank(last()), 'auto-re-blank after BLANK_POPUP_MS')
  const seen = await query("SELECT seen_at FROM notifications WHERE source = 'smoke-blank' ORDER BY id DESC LIMIT 1")
  assert.ok(seen.rows[0].seen_at !== null, 'blanked popup marked SEEN at display')
  console.error('  6. blanked popup → 250ms → re-blank + seen ✓')

  // --- 7. newest-wins while blanked ---
  await notify({ source: 'smoke-blank', priority: 'info', title: 'first popup', body: 'a' })
  await waitFor(() => titleOf(last()).includes('⚠ info'), 'first popup up')
  await notify({ source: 'smoke-blank', priority: 'sms', title: 'second popup', body: 'b' })
  await waitFor(() => titleOf(last()).includes('⚠ sms'), 'newest replaced the popup')
  await waitFor(() => isBlank(last()), 're-blank after replacement')
  console.error('  7. newest-wins replacement while blanked ✓')

  // --- 8. double-tap during a blanked popup = dismiss + wake ---
  await notify({ source: 'smoke-blank', priority: 'info', title: 'tap to wake', body: 'c' })
  await waitFor(() => titleOf(last()).includes('⚠ info'), 'popup up')
  await wm.onBackGesture()
  await waitFor(() => !isBlank(last()) && !titleOf(last()).includes('⚠ info · smoke-blank'), 'woke to a real window')
  console.error('  8. double-tap on popup → dismiss + wake ✓')

  console.log('phase4-notify: ALL OK')
} catch (e) {
  if (!e || e.emitDone !== true) throw e
} finally {
  wm.dispose()
  try {
    await query("DELETE FROM notifications WHERE source IN ('smoke', 'smoke-blank')")
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await getPool().end()
}
