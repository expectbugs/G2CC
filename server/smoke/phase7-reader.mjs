// Phase 7 smoke — Reader: real-EPUB chapter list + chapter read via the
// subprocess, resume-position round-trip (THE feature), corrupt-EPUB loud
// failure, and compose-budget checks for both levels. Uses a COPY of a real
// book so the smoke never pollutes Adam's actual resume positions.
import { strict as assert } from 'node:assert'
import { copyFile, writeFile, unlink } from 'node:fs/promises'
import { listChapters, readChapter, savePosition, getPosition } from '../dist/reader.js'
import { composeScene, paginateText, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'
import { query, getPool } from '../dist/store.js'

const BOOK = `/tmp/smoke-book-${process.pid}.epub`
const CORRUPT = `/tmp/smoke-corrupt-${process.pid}.epub`

try {
  await copyFile('/home/user/books/frankenstein.epub', BOOK)

  // --- 1. chapter list + read through the execFile path ---
  const meta = await listChapters(BOOK)
  assert.ok(meta.title.toLowerCase().includes('frankenstein'))
  assert.ok(meta.chapters.length > 10, `expected many chapters, got ${meta.chapters.length}`)
  const ch = await readChapter(BOOK, 4)
  assert.ok(ch.text.length > 1000, 'chapter text substantial')
  assert.ok(!/<[a-z]+[^>]*>/i.test(ch.text.slice(0, 2000)), 'no html tags leak into text')
  console.error(`  1. real EPUB: ${meta.chapters.length} chapters, ch4 "${ch.chapterTitle}" ${ch.text.length} chars ✓`)

  // --- 2. resume position round-trip + upsert ---
  assert.equal(await getPosition(BOOK), null, 'fresh book has no position')
  await savePosition(BOOK, 4, 7)
  assert.deepEqual(await getPosition(BOOK), { chapter: 4, page: 7 })
  await savePosition(BOOK, 5, 0)   // upsert
  assert.deepEqual(await getPosition(BOOK), { chapter: 5, page: 0 })
  console.error('  2. resume position save/load/upsert ✓')

  // --- 3. corrupt EPUB loud-fails (never wedges) ---
  await writeFile(CORRUPT, 'this is not an epub at all')
  await assert.rejects(() => listChapters(CORRUPT), /read_epub failed/, 'corrupt epub must reject loudly')
  console.error('  3. corrupt EPUB → loud rejection ✓')

  // --- 4. both levels compose under budget ---
  const TABS = []
  const chapterItems = ['— prev —', ...meta.chapters.slice(0, 14).map((c) => `${c.idx + 1}. ${c.title}`.slice(0, 34)), '— more —']
  const chaptersScene = composeScene({
    mode: 'browse', menuMode: 'passive',
    title: 'Reader · Frankenstein; or, the m… · 31 sections',
    menu: ['Reload', 'Main'], items: chapterItems,
  }, TABS, '● beardos · 1 cc')
  const chapEst = estimateLayoutFrameBytes(chaptersScene.regions)
  assert.ok(chapEst <= LAYOUT_FRAME_BUDGET_BYTES, `chapters ${chapEst}B over budget`)
  const pages = paginateText(ch.text)
  assert.ok(pages.length > 3, 'long chapter paginates')
  const readScene = composeScene({
    mode: 'text', title: `Frankenstein · ${ch.chapterTitle} · 2/${pages.length}`,
    menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'], text: pages[1],
  }, TABS, '● beardos · 1 cc')
  const readEst = estimateLayoutFrameBytes(readScene.regions)
  assert.ok(readEst <= LAYOUT_FRAME_BUDGET_BYTES, `read page ${readEst}B over budget`)
  console.error(`  4. compose: chapters ${chapEst}B / read ${readEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

  if (process.argv.includes('--emit-scene')) process.stdout.write(JSON.stringify(readScene))
  else console.log('phase7-reader: ALL OK')
} finally {
  try {
    await query('DELETE FROM reader_positions WHERE book_path = $1', [BOOK])
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await unlink(BOOK).catch(() => {})
  await unlink(CORRUPT).catch(() => {})
  await getPool().end()
}
