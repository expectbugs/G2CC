// Phase 7 smoke — Reader: real-EPUB chapter list + chapter read via the
// subprocess, resume-position round-trip (THE feature), corrupt-EPUB loud
// failure, and compose-budget checks for both levels. Uses a COPY of a real
// book so the smoke never pollutes Adam's actual resume positions.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { copyFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises'
import { listChapters, readChapter, savePosition, getPosition, getLastPosition } from '../dist/reader.js'
import { composeScene, paginateText, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'
import { query, getPool } from '../dist/store.js'

const BOOK = `/tmp/smoke-book-${process.pid}.epub`
const CORRUPT = `/tmp/smoke-corrupt-${process.pid}.epub`
const SANDBOX = `/tmp/smoke-books-${process.pid}`
process.env.G2CC_BOOKS_DIR = SANDBOX   // ReaderWindow reads this at import (the G2CC_TMUX_SOCKET pattern) — set BEFORE importing os-windows

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
  assert.equal((await getLastPosition())?.bookPath, BOOK, 'getLastPosition → the most-recently-read book')
  console.error('  2. resume position save/load/upsert + getLastPosition ✓')

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

  // --- 5. library SUBFOLDER navigation + the root "Last" shortcut (Adam 2026-06-18) ---
  await mkdir(`${SANDBOX}/Sci-Fi`, { recursive: true })
  await copyFile('/home/user/books/frankenstein.epub', `${SANDBOX}/RootBook.epub`)
  await copyFile('/home/user/books/frankenstein.epub', `${SANDBOX}/Sci-Fi/Nested.epub`)
  await query('DELETE FROM reader_positions')   // clean slate so "Last" starts ABSENT
  const { WindowManager } = await import('../dist/window-manager.js')   // reads G2CC_BOOKS_DIR=SANDBOX now
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 0 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  try {
    const reader = wm.windows.find((w) => w.id === 'reader')
    let v = await reader.view()
    assert.ok(v.items.includes('Sci-Fi/'), 'root lists the subfolder (name/)')
    assert.ok(v.items.includes('RootBook.epub'), 'root lists the root book')
    assert.ok(!v.menu.includes('Last'), 'no Last shortcut before anything is read')
    // descend into the subfolder
    await reader.onBrowseSelect(v.items.indexOf('Sci-Fi/'))
    v = await reader.view()
    assert.equal(v.items[0], '..', 'subfolder shows .. at row 0')
    assert.ok(v.items.includes('Nested.epub'), 'subfolder lists its book')
    assert.ok(!v.menu.includes('Last'), 'Last is root-only (absent in a subfolder)')
    // back up via the .. row
    await reader.onBrowseSelect(0)
    v = await reader.view()
    assert.ok(v.items.includes('Sci-Fi/') && !v.items.includes('..'), 'back at root (no ..)')
    // tap the root book → opens it (no saved position → chapter list)
    await reader.onBrowseSelect(v.items.indexOf('RootBook.epub'))
    assert.equal(reader.level, 'chapters', 'tapping a book opens it (chapter list, no resume yet)')
    assert.ok(reader.bookPath.endsWith('/RootBook.epub'), 'opened the right path under cwd')
    // now simulate having read it, return to the root library → Last appears + resumes
    await savePosition(`${SANDBOX}/RootBook.epub`, 2, 3)
    reader.level = 'library'; reader.cwd = ''; reader.lastBookLoaded = false
    v = await reader.view()
    assert.ok(v.menu.includes('Last'), 'Last shortcut appears once a book has a saved position')
    await reader.onMenuSelect('Last')
    assert.ok(reader.bookPath.endsWith('/RootBook.epub'), 'Last resumed the most-recently-read book')
    assert.equal(reader.level, 'read', 'Last resumed straight into the saved page')
    console.error('  5. subfolder nav (folder/.., descend) + root Last shortcut ✓')
  } finally { wm.dispose() }

  if (process.argv.includes('--emit-scene')) process.stdout.write(JSON.stringify(readScene))
  else console.log('phase7-reader: ALL OK')
} finally {
  try {
    await query('DELETE FROM reader_positions')
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await unlink(BOOK).catch(() => {})
  await unlink(CORRUPT).catch(() => {})
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {})
  await getPool().end()
}
