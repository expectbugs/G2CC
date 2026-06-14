// Phase 6 + 15 smoke — the navigation line (pinned awake-title + persistent
// blanked surface, cleared on nav_clear) and the find-my-phone intent parse.
// Real WindowManager + scene capture. Self-cleaning.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/os-windows.js'
import { parseIntent } from '../dist/intents.js'
import { getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const scenes = []
const titleOf = (s) => s?.regions?.find((r) => r.name === 'title')?.content?.text ?? ''
const flashOf = (s) => s?.regions?.find((r) => r.name === 'flash')?.content?.text ?? ''
const isBlank = (s) => s?.regions?.length === 1 && s.regions[0].name === 'wake'
const last = () => scenes[scenes.length - 1]
async function waitFor(pred, what) {
  for (let i = 0; i < 200; i++) { if (pred()) return; await sleep(25) }
  throw new Error(`waitFor timed out: ${what} (last title="${titleOf(last())}", blank=${isBlank(last())})`)
}

// ---------- 1. find-my-phone intent (pure) ----------
{
  assert.equal(parseIntent('find my phone')?.kind, 'findphone')
  assert.equal(parseIntent('locate phone')?.kind, 'findphone')
  assert.equal(parseIntent("where's my phone")?.kind, 'findphone')
  assert.equal(parseIntent('ring my phone')?.kind, 'findphone')
  assert.equal(parseIntent('please find my phone')?.kind, 'findphone')
  assert.equal(parseIntent('find my keys'), null)   // only the phone
  console.error('  1. find-my-phone intent parse ✓')
}

// ---------- 2. nav line through the WM ----------
{
  const locates = []
  const wm = new WindowManager({
    send: (scene) => scenes.push(scene),
    audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 1 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
    phoneLocate: (action) => locates.push(action),
  })
  try {
    wm.requestRender()   // os_attach does this on the real server; the harness must too
    await waitFor(() => titleOf(last()).includes('Main'), 'initial Main')

    // awake: nav rides the title bar
    wm.onNavUpdate('Turn right on 5th', '5 min · 1.2 mi')
    await waitFor(() => titleOf(last()).includes('Turn right on 5th'), 'nav in awake title')
    wm.onNavClear()
    await waitFor(() => !titleOf(last()).includes('Turn right'), 'nav cleared from title')
    console.error('  2. nav line rides the awake title; clears ✓')

    // blanked: nav is the PERSISTENT surface (not a 5 s flash)
    await wm.onBackGesture()                       // blank at Main root
    await waitFor(() => isBlank(last()), 'blanked')
    wm.onNavUpdate('Turn left on Main St', '12 min')
    await waitFor(() => flashOf(last()).includes('Turn left on Main St'), 'nav pinned on the blank screen')
    // a new nav update replaces in place (still shown, not re-blanked)
    wm.onNavUpdate('Continue 2 mi', '11 min')
    await waitFor(() => flashOf(last()).includes('Continue 2 mi'), 'nav updates in place')
    // clear → back to plain blank
    wm.onNavClear()
    await waitFor(() => isBlank(last()), 're-blank on nav_clear')
    console.error('  3. nav pins the blanked screen, updates in place, clears → blank ✓')

    // phoneLocate wiring is callable (the intent path forwards 'start')
    wm.dispose()
    void locates   // (the full Aria→intent→phoneLocate path is integration-level)
  } finally {
    wm.dispose()
  }
}

console.log('phase6-nav-phone: ALL OK')
await getPool().end()
