// Phase 3 smoke — session history: capture API round-trip + all three History
// levels compose under the wall budget. Self-cleaning (synthetic conversation
// deleted at the end; turns cascade).
import { strict as assert } from 'node:assert'
import { ensureConversation, recordTurn, listConversations, listTurns, getTurn } from '../dist/history.js'
import { composeScene, paginateText, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'
import { getPool, query } from '../dist/store.js'

const TABS = ['M', 'A', 'C', 'M', 'F'].map((l, i) => ({ label: l, active: i === 1 }))
const SMOKE_PATH = `/tmp/smoke-phase3-${process.pid}`

let convId = null
try {
  // --- capture API round-trip (the same calls SessionLevel fires) ---
  convId = await ensureConversation({ currentId: null, windowId: 'aria', projectPath: SMOKE_PATH, ccSessionId: null })
  assert.ok(Number.isFinite(convId), 'conversation id must be numeric')
  // cc id arrives later → backlink path
  const again = await ensureConversation({ currentId: convId, windowId: 'aria', projectPath: SMOKE_PATH, ccSessionId: `smoke-cc-${process.pid}` })
  assert.equal(again, convId, 'currentId short-circuit must hold')
  await recordTurn(convId, { kind: 'prompt', text: 'what is the meaning of life?', model: 'fable', effort: 'max' })
  await recordTurn(convId, { kind: 'response', text: '42.\n\n' + 'And a long supporting paragraph. '.repeat(40), toolCalls: ['Bash', 'Read'], model: 'fable', effort: 'max' })
  await recordTurn(convId, { kind: 'interrupted', text: 'Interrupted', model: 'fable', effort: 'max' })
  console.error('  capture round-trip (conv + 3 turns, cc-id backlink) ✓')

  // resume path: a NEW level (currentId null) with the same cc id reuses the row
  const resumed = await ensureConversation({ currentId: null, windowId: 'aria', projectPath: SMOKE_PATH, ccSessionId: `smoke-cc-${process.pid}` })
  assert.equal(resumed, convId, 'resume-with-same-cc-id must reuse the conversation')
  console.error('  respawn-with-resume reuses the conversation ✓')

  // --- read API ---
  const convs = await listConversations(SMOKE_PATH, 14, 0)
  assert.equal(convs.total, 1)
  assert.equal(convs.rows[0].id, convId)
  assert.equal(convs.rows[0].turnCount, 3)
  assert.match(convs.rows[0].firstPrompt, /meaning of life/)
  const turns = await listTurns(convId, 14, 0)
  assert.equal(turns.total, 3)
  assert.deepEqual(turns.rows.map((r) => r.kind), ['prompt', 'response', 'interrupted'], 'chronological order')
  const detail = await getTurn(turns.rows[1].id)
  assert.deepEqual(detail.toolCalls, ['Bash', 'Read'])
  assert.ok(detail.text.length > 1000, 'full text preserved (no truncation)')
  console.error('  read API (list/turns/detail, order, tool_calls jsonb) ✓')

  // --- the three on-glass levels compose under budget ---
  const stamp = '06/11 13:37'
  const convItems = ['— prev —', ...Array.from({ length: 14 }, () => `${stamp} · what is the meaning of life he`), '— more —']
  const convsScene = composeScene({ mode: 'browse', menuMode: 'passive', title: 'Aria · history · 15-28/99', menu: ['Reload', 'Main'], items: convItems }, TABS, '● beardos · 1 cc')
  const convsEst = estimateLayoutFrameBytes(convsScene.regions)
  assert.ok(convsEst <= LAYOUT_FRAME_BUDGET_BYTES, `convs level ${convsEst}B over budget`)

  const turnItems = ['— prev —', ...Array.from({ length: 14 }, (_, i) => `${i % 2 ? '«' : '»'} ${'word '.repeat(7).trim()}`), '— more —']
  const turnsScene = composeScene({ mode: 'browse', menuMode: 'capture', title: `Aria · ${stamp} · 15-28/40`, menu: ['Reload', 'Main'], items: turnItems }, TABS, '● beardos · 1 cc')
  const turnsEst = estimateLayoutFrameBytes(turnsScene.regions)
  assert.ok(turnsEst <= LAYOUT_FRAME_BUDGET_BYTES, `turns level ${turnsEst}B over budget`)

  const pages = paginateText(`RESPONSE · ${stamp} · fable/max\n[tools: Bash, Read]\n\n${detail.text}`)
  assert.ok(pages.length > 1, 'long turn paginates')
  const readScene = composeScene({ mode: 'text', title: `Aria · response ${stamp} · 1/${pages.length}`, menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'], text: pages[0] }, TABS, '● beardos · 1 cc')
  const readEst = estimateLayoutFrameBytes(readScene.regions)
  assert.ok(readEst <= LAYOUT_FRAME_BUDGET_BYTES, `read level ${readEst}B over budget`)
  console.error(`  three levels compose: convs ${convsEst}B / turns ${turnsEst}B / read ${readEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

  if (process.argv.includes('--emit-scene')) process.stdout.write(JSON.stringify(convsScene))
} finally {
  if (convId !== null) {
    try { await query('DELETE FROM conversations WHERE id = $1', [convId]) } // turns cascade
    catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  }
  await getPool().end()
}
if (!process.argv.includes('--emit-scene')) console.log('phase3-history: ALL OK')
