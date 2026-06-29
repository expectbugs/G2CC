// Suggest smoke (upgrades.md v2 Phase 3) — the one-shot predict-next-prompt
// flow. Two layers: (1) the suggest.ts module against a FAKE claude CLI
// (CLAUDE_CLI override) — transcript formatting + loud empties; (2) the REAL
// SessionLevel state machine (reached via the Aria window, the same way
// phase11 reaches games.level) — menu order, the confirm→prompt() send path,
// Regenerate, and the stale-seq discard. No real claude is ever spawned (the
// session subprocess is never opened; only the fake one-shot runs).
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { writeFileSync, chmodSync, rmSync } from 'node:fs'
import { ensureConversation, recordTurn, recentTurns } from '../dist/history.js'
import { getPool, query } from '../dist/store.js'

// --- a fake claude CLI: capture stdin (the transcript) to a sidecar, sleep a
//     beat (so the stale-discard race is real), print a canned prediction. ---
const FAKE = `/tmp/g2cc-fake-claude-${process.pid}.sh`
const SIDECAR = `/tmp/g2cc-fake-claude-stdin-${process.pid}.txt`
writeFileSync(FAKE, `#!/bin/bash\ncat > '${SIDECAR}'\nsleep 0.2\nprintf 'run the tests\\n'\n`)
chmodSync(FAKE, 0o755)
process.env.CLAUDE_CLI = FAKE   // both cc-session + suggest honor it; only suggest runs here

// suggest.js reads CLAUDE_CLI at module-eval, so import AFTER the override.
const { suggestNextPrompt } = await import('../dist/suggest.js')
const { readFileSync } = await import('node:fs')

let convId = null
try {
  // === layer 1: the suggest module ===
  const out = await suggestNextPrompt(
    [{ kind: 'prompt', text: 'add a dark mode toggle', toolCalls: [] },
     { kind: 'response', text: 'Done — added it to Settings.', toolCalls: ['Edit', 'Bash'] }],
    '/tmp')
  assert.equal(out, 'run the tests', 'returns the CLI stdout, trimmed')
  const seen = readFileSync(SIDECAR, 'utf8')
  assert.match(seen, /USER: add a dark mode toggle/, 'USER turn formatted')
  assert.match(seen, /ASSISTANT \[used tools: Edit, Bash\]: Done/, 'ASSISTANT turn carries tool names')
  await assert.rejects(() => suggestNextPrompt([], '/tmp'), /no conversation history/, 'empty turns loud-reject')
  console.error('  1. suggest module: transcript format + tool names + empty-reject ✓')

  // === recentTurns round-trip (the prediction context source) ===
  convId = await ensureConversation({ currentId: null, windowId: 'aria', projectPath: `/tmp/smoke-suggest-${process.pid}`, ccSessionId: null })
  await recordTurn(convId, { kind: 'prompt', text: 'first' })
  await recordTurn(convId, { kind: 'response', text: 'ok', toolCalls: ['Read'] })
  await recordTurn(convId, { kind: 'prompt', text: 'second' })
  const rt = await recentTurns(convId, 15)
  assert.deepEqual(rt.map((t) => t.kind), ['prompt', 'response', 'prompt'], 'chronological oldest→newest')
  assert.deepEqual(rt[1].toolCalls, ['Read'], 'tool_calls preserved')
  const rt2 = await recentTurns(convId, 2)
  assert.deepEqual(rt2.map((t) => t.text), ['ok', 'second'], 'limit keeps the MOST RECENT, still chronological')
  console.error('  2. recentTurns: chronological, tool_calls, limit-keeps-newest ✓')

  // === layer 2: the real SessionLevel state machine, via the Aria window ===
  const { WindowManager } = await import('../dist/window-manager.js')
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {},
    log: () => {},
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  const settle = async (pred, what, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (pred()) return
      await new Promise((r) => setTimeout(r, 15))
    }
    throw new Error(`timeout: ${what}`)
  }
  try {
    const sess = wm.windows.find((w) => w.id === 'aria').session
    // Wire a captured conversation under THIS session (the real history path).
    const sConv = await ensureConversation({ currentId: null, windowId: 'aria', projectPath: sess.projectPath, ccSessionId: null })
    await recordTurn(sConv, { kind: 'prompt', text: 'add a dark mode toggle' })
    await recordTurn(sConv, { kind: 'response', text: 'Done.', toolCalls: ['Edit'] })
    sess.convId = sConv
    sess.completedTurns = 1

    // menu: Suggest leads when there's a completed response; gone without one.
    assert.deepEqual(sess.menu(), ['Suggest', 'Ask', 'Next', 'Prev', 'Prompts', 'Options', 'Reload', 'Main'], 'Suggest leads the idle menu')
    sess.completedTurns = 0
    assert.ok(!sess.menu().includes('Suggest'), 'no Suggest without a completed response')
    sess.completedTurns = 1
    console.error('  3. menu: Suggest leads iff a completed response exists ✓')

    // capture the send path WITHOUT spawning a real session
    const sent = []
    sess.prompt = async (t) => { sent.push(t) }

    // Suggest → suggesting… → confirm card
    await sess.onMenu('Suggest')
    assert.equal(sess.phase(), 'suggesting…', 'status flips immediately')
    await settle(() => sess.pendingSuggestion !== null, 'suggestion arrives')
    assert.equal(sess.pendingSuggestion, 'run the tests')
    assert.deepEqual(sess.menu(), ['Confirm', 'Regenerate', 'Cancel', 'Reload', 'Main'], 'confirm-card menu')
    assert.equal(sess.phase(), 'suggestion?')
    console.error('  4. Suggest → suggesting… → [Confirm, Regenerate, Cancel] confirm card ✓')

    // Confirm → the suggested text goes through prompt()
    await sess.onMenu('Confirm')
    assert.deepEqual(sent, ['run the tests'], 'Confirm sends the prediction through prompt()')
    assert.equal(sess.pendingSuggestion, null, 'card cleared after send')
    console.error('  5. Confirm sends the prediction via prompt() ✓')

    // Regenerate → re-runs the one-shot
    await sess.onMenu('Suggest')
    await settle(() => sess.pendingSuggestion !== null, 'first suggestion')
    await sess.onMenu('Regenerate')
    assert.equal(sess.suggesting, true, 'Regenerate restarts the one-shot')
    await settle(() => sess.pendingSuggestion === 'run the tests' && !sess.suggesting, 'regenerated')
    console.error('  6. Regenerate re-runs the one-shot ✓')

    // Cancel from the confirm card restores the conversation
    await sess.onMenu('Cancel')
    assert.equal(sess.pendingSuggestion, null)
    assert.equal(sess.suggesting, false)
    assert.equal(sess.phase(), null, 'back to idle')

    // STALE DISCARD: cancel while the one-shot is in flight → its late result drops
    await sess.onMenu('Suggest')
    assert.equal(sess.suggesting, true)
    await sess.onMenu('Cancel')                       // bumps the seq mid-flight
    assert.equal(sess.suggesting, false, 'Cancel stops it immediately')
    await new Promise((r) => setTimeout(r, 500))       // past the fake's 0.2s return
    assert.equal(sess.pendingSuggestion, null, 'the stale one-shot result was discarded')
    console.error('  7. Cancel mid-flight discards the late one-shot result (stale-seq) ✓')
  } finally {
    wm.dispose()
  }
} finally {
  if (convId !== null) {
    try { await query(`DELETE FROM conversations WHERE project_path LIKE $1`, [`/tmp/smoke-suggest-%`]) } catch {}
    try { await query(`DELETE FROM conversations WHERE project_path = $1`, ['/home/user/aria']) } catch {}
  }
  rmSync(FAKE, { force: true })
  rmSync(SIDECAR, { force: true })
  await getPool().end()
}
console.log('phase3b-suggest: ALL OK')
