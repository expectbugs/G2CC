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

  // === 1b. named-window collision guard (Adam 2026-06-14) ===
  // A session whose WINDOW is named like ANOTHER session must NOT hijack capture/
  // send. The `claude` CLI names its window "claude", so `-t claude` matched
  // session claude2's window instead of session claude. sessionTarget()=`=name:`
  // fixes it. Reproduce: name 'logs' window "work" (collides with session 'work').
  TMUX('rename-window', '-t', 'logs', 'work')   // rename-window also disables auto-rename
  await tmuxSendKeys('logs', ['echo', 'Space', 'IN_LOGS', 'Enter'])
  await tmuxSendKeys('work', ['echo', 'Space', 'IN_WORK_SESH', 'Enter'])
  await settleCapture('work', 'IN_WORK_SESH')
  const capW = await tmuxCapture('work'), capL = await tmuxCapture('logs')
  assert.ok(capW.includes('IN_WORK_SESH') && !capW.includes('IN_LOGS'), 'capture(work) → the SESSION work, not the window named "work" in logs')
  assert.ok(capL.includes('IN_LOGS'), 'capture(logs) → the logs session')
  console.error('  1b. named-window collision: =session: targets the right session ✓')

  // === 2. grid render: capture → 80×22 tiles, composes under the wall ===
  const img = await renderTerminalImage(await tmuxCapture('work'), 480, 222)
  assert.equal(img.tiles.length, 4, 'grid → 4 gray4 tiles')
  const scene = composeScene({ mode: 'tiles', tilesRect: { w: img.w, h: img.h }, title: 'Term · work · grid', menu: ['Keys', 'Dictate', 'Tail', 'Terms', 'Reload', 'Main'], tiles: img.tiles }, [], '● beardos · 1 cc')
  assert.ok(estimateLayoutFrameBytes(scene.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'grid scene under the wall')
  console.error('  2. grid render: 80×22 → 4 tiles, composes under the wall ✓')

  // === 3. TerminalWindow state machine ===
  const { WindowManager } = await import('../dist/window-manager.js')
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

    // Keys hub (Adam 2026-06-18): index 0 = ⌨ Keyboard, 1 = / Slash cmd, then the
    // quick keys (Enter is now at index 2).
    await term.onMenuSelect('Keys'); assert.equal(term.level, 'keys')
    const keysItems = (await term.view()).items
    assert.ok(keysItems[0].includes('Keyboard') && keysItems[1].includes('Slash'), 'Keys leads with Keyboard + Slash, then quick keys')
    await term.onBrowseSelect(2)   // Enter quick-key — stays in keys for rapid sequences
    assert.equal(term.level, 'keys', 'quick-key stays in keys')
    await term.onBack(); assert.equal(term.level, 'view', 'Back from keys → view')

    // On-screen KEYBOARD (Phase 5 fallback — the silent gap): Keys → ⌨ Keyboard →
    // build a string via group→char taps (incl. a '/') → Run sends it literal + Enter.
    const kbdType = async (str) => {
      for (const ch of str) {
        if (ch === ' ') {
          const { cells } = term.kbdModel()
          await term.onBrowseSelect(cells.findIndex((c) => c.t === 'act' && c.a === 'space')); continue
        }
        const g = term.kbdModel().cells.findIndex((c) => c.t === 'group' && c.chars.includes(ch))
        assert.ok(g >= 0, `kbd group for '${ch}'`); await term.onBrowseSelect(g)
        const i = term.kbdModel().cells.findIndex((c) => c.t === 'char' && c.ch === ch)
        assert.ok(i >= 0, `kbd char '${ch}'`); await term.onBrowseSelect(i)
      }
    }
    await term.onMenuSelect('Keys'); await term.onBrowseSelect(0)
    assert.equal(term.level, 'kbd', '⌨ Keyboard → kbd level')
    await kbdType('echo /tmp')
    assert.equal(term.kbdBuf, 'echo /tmp', `keyboard built the exact buffer incl '/' (got "${term.kbdBuf}")`)
    const runIdx = term.kbdModel().cells.findIndex((c) => c.t === 'act' && c.a === 'run')
    await term.onBrowseSelect(runIdx)
    assert.equal(term.level, 'view', 'Run → live tail'); assert.equal(term.kbdBuf, '', 'buffer cleared after Run')
    await settleCapture('work', '/tmp')   // ran (echo printed it)
    console.error('  3a2. on-screen keyboard: group→char build (incl /), Run sends + runs ✓')

    // Slash-command list: Keys → / Slash cmd → tap /clear → sent + Enter
    await term.onMenuSelect('Keys'); await term.onBrowseSelect(1)
    assert.equal(term.level, 'slash', '/ Slash cmd → slash level')
    const slashItems = (await term.view()).items
    await term.onBrowseSelect(slashItems.findIndex((i) => i === '/clear'))
    assert.equal(term.level, 'view', 'slash pick → live tail')
    await settleCapture('work', '/clear')   // the literal command was sent
    console.error('  3a3. slash-command list: /clear sent + runs ✓')

    // Dictation now RUNS on Confirm (Adam 2026-06-18: was send-literal-only, no Enter)
    await term.onMenuSelect('Dictate'); assert.equal(term.listening, true)
    await term.onMenuSelect('Done'); assert.equal(term.transcribing, true)
    await term.onStt('echo r$((40+2))z'); assert.equal(term.pendingText, 'echo r$((40+2))z')
    await term.onMenuSelect('Confirm')   // sends literal + Enter — no manual Enter needed now
    await settleCapture('work', 'r42z')   // 'r42z' only appears if the shell RAN it (input had '40+2')
    console.error('  3a. open session, Dictate→confirm RUNS the command ✓')

    // tail WRAP (Adam 2026-06-14): wide lines WRAP at the pane width (readable)
    // instead of being hard-cut with '›'; the frame still stays UNDER the wall.
    // AND it fits ONE page (≤8 rows) — the old 13-row tail overflowed into an
    // un-scrollable firmware scrollbar (Adam 2026-06-15).
    term.content = Array.from({ length: 30 }, (_, i) => `line${i} ` + 'x'.repeat(90)).join('\n')
    term.level = 'view'; term.mode = 'tail'
    const tv = await term.view()
    const tEst = estimateLayoutFrameBytes(composeScene(tv, [], '● beardos · 1 cc').regions)
    assert.ok(tEst <= LAYOUT_FRAME_BUDGET_BYTES, `tail frame ${tEst}B must be under the wall (${LAYOUT_FRAME_BUDGET_BYTES})`)
    assert.ok(!tv.text.includes('›'), 'wide lines WRAP — no more hard-cut › marker')
    assert.ok(tv.text.includes('x') && tv.text.split('\n').every((l) => l.length <= 60), 'content shown, each row wrapped to the pane width')
    assert.ok(tv.text.split('\n').length <= 6, `tail fits one page (≤6 rows), no overflow scrollbar (got ${tv.text.split('\n').length})`)
    console.error(`  3b. tail WRAP+FIT: dense 90-col capture wraps, ≤6 rows, ${tEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

    // rule-collapse (Adam 2026-06-15/16): Claude Code's full-width '─' separator
    // bar must collapse to ONE FIRMWARE row, not wrap. The firmware fits only ~21
    // box-drawing cols/row (cal), so collapse clamps by COLUMNS to TERM_RULE_COLS=18.
    term.content = ['output above the bar', '─'.repeat(74), 'status below the bar', 'last line'].join('\n')
    const rv = await term.view()
    const ruleRows = rv.text.split('\n').filter((l) => /^─+$/.test(l))
    assert.equal(ruleRows.length, 1, `the 74-col ─ bar collapsed to exactly ONE row (got ${ruleRows.length})`)
    assert.equal(ruleRows[0].length, 18, `collapsed rule clamped to TERM_RULE_COLS=18 firmware-safe cols (${ruleRows[0].length})`)
    console.error('  3b2. rule-collapse: a 74-col ─ separator → 18-col one-row rule ✓')

    // box-drawing width (Adam 2026-06-16): the firmware renders box-drawing ~2× a
    // letter, so a box-drawing-dense line (NOT a pure rule — no horizontal glyph, so
    // collapseRules leaves it) must wrap to ≥2 rows via termTextWidth where a naive
    // 9.6px width would keep it one row → the invisible firmware re-wrap that caused
    // the occasional scrollbar. 30 '┼' = 30×21 ≈ 630px > one ~456px row.
    term.content = '┼'.repeat(30)
    const xv = await term.view()
    assert.ok(xv.text.split('\n').length >= 2, `box-drawing line wraps wide (got ${xv.text.split('\n').length} rows; naive width would give 1)`)
    console.error('  3b3. box-drawing width: a 30-col ┼ line wraps to ≥2 rows (no hidden firmware re-wrap) ✓')

    // Grid mode
    await term.onMenuSelect('Grid'); assert.equal(term.mode, 'grid')
    const t0 = Date.now()
    while (Date.now() - t0 < 5000 && term.gridImg === null && term.gridFailed === null) await new Promise((r) => setTimeout(r, 50))
    assert.ok(term.gridImg, 'Grid renders an image page')
    await term.onMenuSelect('Tail'); assert.equal(term.mode, 'tail')

    // Focus / scrollback: capture history, pre-split into whole PAGES (≤8 rows
    // each, no overflow), start at the live edge, Up/Down step one page, Live
    // returns to the tail.
    await tmuxSendKeys('work', ['seq', 'Space', '1', 'Space', '80', 'Enter'])
    await settleCapture('work', '80')
    term.level = 'view'; term.mode = 'tail'
    await term.onMenuSelect('Focus')
    const fs0 = Date.now()
    while (Date.now() - fs0 < 4000 && (term.scrollPages === null || term.scrollPages[0] === 'capturing scrollback…')) await new Promise((r) => setTimeout(r, 30))
    assert.ok(term.scrollPages && term.scrollPages.length >= 2, `scrollback paginated into pages (${term.scrollPages?.length})`)
    assert.ok(term.scrollPages.every((p) => p.split('\n').length <= 6), 'every scroll page fits the pane (≤6 rows)')
    assert.equal(term.scrollPage, term.scrollPages.length - 1, 'Focus starts at the live edge (newest page)')
    assert.match((await term.view()).title, /scroll \d+\/\d+ \(live\)/, 'Focus → scroll view at the live edge')
    await term.onMenuSelect('Up')
    const afterUp = term.scrollPage
    assert.equal(afterUp, term.scrollPages.length - 2, 'Up steps exactly one page toward older history')
    await term.onMenuSelect('Down')
    assert.equal(term.scrollPage, afterUp + 1, 'Down steps one page back toward live')
    // page past the top → clamps at the oldest page with a (top) marker
    for (let i = 0; i < term.scrollPages.length + 2; i++) await term.onMenuSelect('Up')
    assert.equal(term.scrollPage, 0, 'Up clamps at the oldest page (no underflow)')
    assert.match((await term.view()).title, /\(top\)/, 'oldest page shows (top)')
    // scroll frame stays under the wall
    const scEst = estimateLayoutFrameBytes(composeScene(await term.view(), [], '● beardos · 1 cc').regions)
    assert.ok(scEst <= LAYOUT_FRAME_BUDGET_BYTES, `scroll frame ${scEst}B under the wall`)
    await term.onMenuSelect('Live')
    assert.equal(term.scrollPages, null, 'Live exits scroll')
    assert.match((await term.view()).title, /tail/, 'Live → back to live tail')
    console.error('  3d. Focus/scrollback: paginated ≤6 rows/page, Up/Down step pages, top-clamp, Live ✓')

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
