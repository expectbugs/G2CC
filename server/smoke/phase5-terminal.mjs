// Terminal (tmux) smoke (upgrades.md v2 Phase 5). Runs against a THROWAWAY
// `tmux -L g2cc-smoke-<pid>` server (the phase9-sandbox pattern) — Adam's REAL
// tmux sessions are never listed, captured, keyed, or killed. Tests: the tmux.ts
// helpers (list/capture/send round-trip/new), the 80×22 grid render, and the
// TerminalWindow state machine (sessions→view→keys→dictate→grid→new session).
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'

const SOCK = `g2cc-smoke-${process.pid}`
process.env.G2CC_TMUX_SOCKET = SOCK   // MUST be set before importing ../dist/tmux.js (read at module eval)
const TMUX = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' })

try {
  TMUX('new-session', '-d', '-s', 'work', '-x', '80', '-y', '24')
  TMUX('new-session', '-d', '-s', 'logs', '-x', '80', '-y', '24')

  const { tmuxList, tmuxCapture, tmuxSendKeys, tmuxSendLiteral, tmuxNewSession, renderTerminalImage } = await import('../dist/tmux.js')
  const { composeScene, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } = await import('../dist/os-compose.js')

  const settleCapture = async (session, needle, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const c = await tmuxCapture(session)
      if (c.includes(needle)) return c
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timeout waiting for "${needle}" in ${session}`)
  }

  // === 1. tmux.ts helpers ===
  const sessions = await tmuxList()
  assert.ok(sessions.length === 2 && sessions.every((s) => ['work', 'logs'].includes(s.name)), 'tmuxList finds the two sandbox sessions')
  await tmuxSendKeys('work', ['echo', 'Space', 'TERM_OK_$((6*7))', 'Enter'])
  const cap = await settleCapture('work', 'TERM_OK_42')
  assert.ok(cap.includes('TERM_OK_42'), 'send-keys → capture round-trip')
  await tmuxNewSession('built')
  assert.ok((await tmuxList()).some((s) => s.name === 'built'), 'tmuxNewSession creates a session')
  console.error('  1. tmux helpers: list, send-keys round-trip, new-session ✓')

  // === 2. grid render: capture → 80×22 tiles, composes under the wall ===
  const img = await renderTerminalImage(await tmuxCapture('work'), 480, 222)
  assert.equal(img.tiles.length, 4, 'grid → 4 gray4 tiles')
  const scene = composeScene({ mode: 'tiles', tilesRect: { w: img.w, h: img.h }, title: 'Term · work · grid', menu: ['Keys', 'Dictate', 'Tail', 'Terms', 'Reload', 'Main'], tiles: img.tiles }, [], '● beardos · 1 cc')
  assert.ok(estimateLayoutFrameBytes(scene.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'grid scene under the wall')
  console.error('  2. grid render: 80×22 → 4 tiles, composes under the wall ✓')

  // === 3. TerminalWindow state machine ===
  const { WindowManager } = await import('../dist/os-windows.js')
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 0 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  try {
    const term = wm.windows.find((w) => w.id === 'term')
    assert.ok(term, 'Terminal window registered')

    // sessions → open 'work'
    const sv = await term.view()
    assert.equal(sv.mode, 'browse')
    assert.ok(sv.items.some((i) => i.includes('work')) && sv.items.includes('+ New session'), 'sessions list + New row')
    const workIdx = sv.items.findIndex((i) => i.includes('work'))
    await term.onBrowseSelect(workIdx)
    assert.equal(term.level, 'view'); assert.equal(term.session, 'work'); assert.equal(term.mode, 'tail')
    assert.match((await term.view()).title, /work · tail/, 'tail view of work')

    // Keys → send Enter
    await term.onMenuSelect('Keys'); assert.equal(term.level, 'keys')
    await term.onBrowseSelect(0)   // Enter — should not throw
    assert.equal(term.level, 'keys', 'keys level stays for rapid sequences')
    await term.onBack(); assert.equal(term.level, 'view', 'Back from keys → view')

    // Dictate → send literal text
    await term.onMenuSelect('Dictate'); assert.equal(term.listening, true)
    await term.onMenuSelect('Done'); assert.equal(term.transcribing, true)
    await term.onStt('echo DICTATED_LINE'); assert.equal(term.pendingText, 'echo DICTATED_LINE')
    await term.onMenuSelect('Confirm')
    await tmuxSendKeys('work', ['Enter'])   // run what was typed (literal doesn't auto-Enter, by design)
    await settleCapture('work', 'DICTATED_LINE')
    console.error('  3a. open session, Keys send, Dictate→literal send ✓')

    // tail WIDTH clamp (review fix): a wide/dense capture must compose UNDER the
    // 960 B wall (an 80-col terminal used to → errorView instead of output)
    term.content = Array.from({ length: 30 }, (_, i) => `line${i} ` + 'x'.repeat(90)).join('\n')
    term.level = 'view'; term.mode = 'tail'
    const tv = await term.view()
    const tEst = estimateLayoutFrameBytes(composeScene(tv, [], '● beardos · 1 cc').regions)
    assert.ok(tEst <= LAYOUT_FRAME_BUDGET_BYTES, `tail frame ${tEst}B must be under the wall (${LAYOUT_FRAME_BUDGET_BYTES})`)
    assert.ok(tv.text.includes('›'), 'over-wide lines are clamped with the › marker')
    console.error(`  3b. tail width clamp: dense 90-col capture composes at ${tEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

    // Grid mode
    await term.onMenuSelect('Grid'); assert.equal(term.mode, 'grid')
    const t0 = Date.now()
    while (Date.now() - t0 < 5000 && term.gridImg === null && term.gridFailed === null) await new Promise((r) => setTimeout(r, 50))
    assert.ok(term.gridImg, 'Grid renders an image page')
    await term.onMenuSelect('Tail'); assert.equal(term.mode, 'tail')

    // New session via dictation
    await term.onMenuSelect('Terms'); assert.equal(term.level, 'sessions')
    const sv2 = await term.view()
    const newIdx = sv2.items.findIndex((i) => i.includes('New session'))
    await term.onBrowseSelect(newIdx); assert.equal(term.listening, true, 'New session → name dictation')
    await term.onMenuSelect('Done'); await term.onStt('smoke sesh!!')   // sanitized to "smoke-sesh"
    await term.onMenuSelect('Confirm')
    assert.ok((await tmuxList()).some((s) => s.name === 'smoke-sesh'), 'New session created (name sanitized)')
    assert.equal(term.session, 'smoke-sesh', 'jumped into the new session')
    console.error('  3c. Grid render, New session (sanitized name) → jumped in ✓')
  } finally {
    wm.dispose()   // stops the Terminal capture poll (else the process hangs)
  }
} finally {
  try { execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }) } catch {}
}
console.log('phase5-terminal: ALL OK')
