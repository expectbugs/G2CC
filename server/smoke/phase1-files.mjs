// Phase 1 smoke — Files locations as a plain browse list (antenna reverted).
// Composes the new locations views and asserts the hardware rules hold:
// exactly one event-capture region, frame estimate under the wall budget,
// and blankScene()'s load-bearing wake antenna untouched (B2).
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { getPool } from '../dist/store.js'
import { strict as assert } from 'node:assert'
import { composeScene, blankScene, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'

const TABS = ['M', 'A', 'C', 'M', 'F'].map((l, i) => ({ label: l, active: i === 4 }))
const STATUS = '● beardos · 1 cc'

function captures(scene) {
  return scene.regions.filter((r) =>
    (r.kind === 'text' && r.content?.scroll) ||
    (r.kind === 'list' && r.content?.eventCapture))
}

// --- 1. The real-world locations list (passive focus: content rows capture) ---
const LOCS = ['Root', 'Home', 'DL', 'G2CC', 'lilhomie', 'turtle', 'slug', 'vault']
const passive = composeScene({
  mode: 'browse',
  menuMode: 'passive',
  title: 'Files · locations',
  menu: ['Reload', 'Main'],
  items: LOCS,
}, TABS, STATUS)
let cap = captures(passive)
assert.equal(cap.length, 1, `locations(passive): expected 1 capture region, got ${cap.map((r) => r.name)}`)
assert.equal(cap[0].name, 'browse', 'locations(passive): the content list must hold capture')
const menuRegion = passive.regions.find((r) => r.name === 'menu')
assert.equal(menuRegion.kind, 'list', 'menu must be a real list (no antenna text region)')
assert.deepEqual(menuRegion.content.items, ['Reload', 'Main'])
const est = estimateLayoutFrameBytes(passive.regions)
assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `locations frame ${est}B over budget ${LAYOUT_FRAME_BUDGET_BYTES}`)
console.error(`  locations(passive): ${passive.regions.length} regions, est ${est}B, capture=browse ✓`)

// --- 2. Focus-flipped (menu captures; content passive) ---
const flipped = composeScene({
  mode: 'browse',
  menuMode: 'capture',
  title: 'Files · locations',
  menu: ['Reload', 'Main'],
  items: LOCS,
}, TABS, STATUS)
cap = captures(flipped)
assert.equal(cap.length, 1, `locations(flipped): expected 1 capture, got ${cap.map((r) => r.name)}`)
assert.equal(cap[0].name, 'menu', 'locations(flipped): the menu list must hold capture')
console.error(`  locations(flipped): capture=menu ✓`)

// --- 3. Paged worst case: 14 rows + both nav rows (the browsePageItems shape) ---
const bigItems = ['— prev —', ...Array.from({ length: 14 }, (_, i) => `mounted-drive-${String(i).padStart(2, '0')}`), '— more —']
const paged = composeScene({
  mode: 'browse',
  menuMode: 'passive',
  title: 'Files · locations',
  menu: ['Reload', 'Main'],
  items: bigItems,
}, TABS, STATUS)
const pagedEst = estimateLayoutFrameBytes(paged.regions)
assert.ok(pagedEst <= LAYOUT_FRAME_BUDGET_BYTES, `paged locations frame ${pagedEst}B over budget`)
assert.equal(captures(paged).length, 1)
console.error(`  locations(paged 16 rows): est ${pagedEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

// --- 4. B2 trap: blankScene's wake antenna must remain EXACTLY as proven ---
const blank = blankScene()
assert.equal(blank.regions.length, 1, 'blankScene must stay single-region')
const wake = blank.regions[0]
assert.equal(wake.name, 'wake')
assert.equal(wake.kind, 'text')
assert.equal(wake.content.scroll, true, 'wake region MUST keep scroll=true (input dies otherwise — hardware, twice)')
console.error('  blankScene wake antenna intact ✓')

// --- 5. Emit the passive scene for scene_to_png parity (MANUAL step:
//     `node phase1-files.mjs --emit-scene | scripts/scene_to_png.py` — run-all
//     does NOT pipe it; the old comment claimed it did, review 2026-06-11b) ---
if (process.argv.includes('--emit-scene')) {
  process.stdout.write(JSON.stringify(passive))
} else {
  // --- 6. The file-manager rework (Adam 2026-06-12): drive the REAL Files
// window in a sandbox dir — `..`-always, file tap → actions, move/copy/del
// round-trips, dir stats. WM windows are exercised via the public tap API.
{
  const { WindowManager } = await import('../dist/window-manager.js')
  const { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const sandbox = mkdtempSync(join(tmpdir(), 'g2cc-files-smoke-'))
  mkdirSync(join(sandbox, 'sub'))
  writeFileSync(join(sandbox, 'a.txt'), 'hello files\n')

  const scenes = []
  const wm = new WindowManager({
    send: (sc) => scenes.push(sc),
    audio: () => {}, displayReload: () => {},
    log: (m) => console.error(`    ${m}`),
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  const settle = async (pred, what) => {
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      const sc = scenes[scenes.length - 1]
      if (sc && pred(sc)) return sc
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`timeout settling: ${what}`)
  }
  const text = (sc, name = 'content') => sc.regions.find((r) => r.name === name)?.content?.text ?? ''
  const items = (sc) => sc.regions.find((r) => r.name === 'browse')?.content?.items ?? []
  const menu = (sc) => sc.regions.find((r) => r.name === 'menu')?.content?.items ?? []
  try {
    const files = wm.windows.find((w) => w.id === 'files')
    assert.ok(files, 'files window present')
    // Steer the window into the sandbox without UI-walking the locations list:
    // locations → tree happens via onBrowseSelect in production; the sandbox
    // isn't a location, so seed the stack directly (private-state poke, the
    // same approach phase5 avoids — justified: the LEVELS under test all sit
    // BELOW tree).
    files.stack = [sandbox]
    files.level = 'tree'
    wm.switchTo('files')
    let sc = await settle((x) => items(x)[0] === '..' && items(x).includes('a.txt'), 'tree list')
    assert.equal(items(sc)[1], 'sub/', 'dirs sort first after ..')
    assert.deepEqual(menu(sc), ['Up', 'New', 'Stats', 'Reload', 'Main'], 'tree menu at a location root: Up/New/Stats (no dir ops on the root)')
    console.error('  6a. tree: `..` always row 0, Up/New/Stats in the menu ✓')

    // file tap → ACTIONS level
    await files.onBrowseSelect(2)   // ['..', 'sub/', 'a.txt'] → a.txt
    sc = await settle((x) => menu(x)[0] === 'Open', 'actions level')
    assert.deepEqual(menu(sc), ['Open', 'Move', 'Copy', 'Rename', 'Del', 'Stats', 'Back', 'Reload', 'Main'])
    assert.match(text(sc), /a\.txt/)
    console.error('  6b. file tap → actions (Open top) ✓')

    // COPY → pick dest: location stage → seed dest dir directly → "Copy here"
    await files.onMenuSelect('Copy')
    sc = await settle((x) => (x.regions.find((r) => r.name === 'title')?.content?.text ?? '').includes('pick location'), 'pick location stage')
    files.destStack = [sandbox]   // seed (sandbox isn't a location)
    files.requestRender?.() ?? wm.requestRender()
    await files.onBrowseSelect(1)   // ['..', 'sub/'] → sub/ → pickAction prompt
    sc = await settle((x) => menu(x).includes('Copy here') && menu(x)[0] === 'Open', 'pickAction prompt')
    await files.onMenuSelect('Copy here')
    sc = await settle((x) => /Copied/.test(text(x)), 'copy result')
    assert.ok(existsSync(join(sandbox, 'sub', 'a.txt')), 'copy landed')
    assert.ok(existsSync(join(sandbox, 'a.txt')), 'copy kept the source')
    console.error('  6c. Copy → folder prompt → "Copy here" round-trip ✓')

    // back to tree, MOVE the copy out of sub via direct dest, then DELETE it
    await files.onBack()   // opResult → tree
    files.stack = [join(sandbox, 'sub')]
    wm.requestRender()
    await settle((x) => items(x).includes('a.txt') && (x.regions.find((r) => r.name === 'title')?.content?.text ?? '').includes('sub'), 'sub listing')
    await files.onBrowseSelect(1)   // ['..', 'a.txt'] → a.txt → actions
    await settle((x) => menu(x)[0] === 'Open', 'actions for sub/a.txt')
    await files.onMenuSelect('Move')
    files.destStack = [sandbox]
    await files.onMenuSelect('Move here')   // collision → loud FAIL page (a.txt exists at dest)
    sc = await settle((x) => /FAILED/.test(text(x)), 'collision refused')
    assert.match(text(sc), /already exists/)
    console.error('  6d. move collision → loud no-overwrite refusal ✓')

    await files.onBack()   // opResult → tree
    files.stack = [join(sandbox, 'sub')]
    wm.requestRender()
    await settle((x) => items(x).includes('a.txt') && (x.regions.find((r) => r.name === 'title')?.content?.text ?? '').includes('sub'), 'sub listing again')
    await files.onBrowseSelect(1)   // a.txt → actions
    await settle((x) => menu(x)[0] === 'Open', 'actions again')
    await files.onMenuSelect('Del')
    sc = await settle((x) => menu(x)[0] === 'Cancel' && menu(x)[1] === 'DELETE', 'confirm page (Cancel first — accidental double-tap safe)')
    assert.match(text(sc), /restorable for 30 days/)
    await files.onMenuSelect('DELETE')
    sc = await settle((x) => /to Trash/.test(text(x)), 'delete (trash) result')
    assert.ok(!existsSync(join(sandbox, 'sub', 'a.txt')), 'file removed from its original path')
    console.error('  6e. Del → confirmation → moved to Trash ✓')

    // dir stats (du async swap)
    await files.onBack()   // opResult → tree
    files.stack = [sandbox]
    wm.requestRender()
    await settle((x) => items(x).includes('sub/'), 'sandbox listing')
    await files.onMenuSelect('Stats')
    sc = await settle((x) => /total size: (?!⏳)/.test(text(x)), 'du swap')
    assert.match(text(sc), /1 dir\(s\) · 1 file\(s\)/)
    console.error('  6f. dir Stats: counts + async du total ✓')

    // `..` at the location root pops to locations (the DL trap)
    await files.onBack()   // stats → tree
    await settle((x) => items(x)[0] === '..', 'tree again')
    await files.onBrowseSelect(0)
    sc = await settle((x) => (x.regions.find((r) => r.name === 'title')?.content?.text ?? '').includes('locations'), 'locations after ..')
    console.error('  6g. `..` at the location root → locations (no more DL trap) ✓')

    // --- 7. THE "970 bytes" FIX (Adam 2026-06-13): a DEEP cwd (long title) +
    // many LONG filenames must paginate byte-aware, never trip compose's 960 B
    // wall guard (which used to throw the whole directory into errorView). ---
    const deep = join(sandbox, 'a-fairly-long-directory-name-segment', 'another-long-nested-segment-here')
    mkdirSync(deep, { recursive: true })
    for (let i = 0; i < 40; i++) writeFileSync(join(deep, `a-rather-long-file-name-number-${String(i).padStart(2, '0')}.txt`), 'x')
    files.stack = [deep]
    files.level = 'tree'
    files.offset = 0
    files.focus = 'content'
    wm.requestRender()
    // The discriminator: a browse list with a '— more —' row. The OLD bug threw
    // in compose → errorView (text mode, no 'browse' region) → this never appears.
    sc = await settle((x) => items(x).includes('— more —'), 'deep dir paginated (not errorView)')
    const deepTitle = sc.regions.find((r) => r.name === 'title')?.content?.text ?? ''
    assert.ok(deepTitle.includes('Files ·') && !deepTitle.includes('error'), 'deep dir must NOT fall into errorView (the 970 B wall)')
    const deepEst = estimateLayoutFrameBytes(sc.regions)
    assert.ok(deepEst <= LAYOUT_FRAME_BUDGET_BYTES, `deep-dir frame ${deepEst}B over budget — the wall fix failed`)
    const fileRows = items(sc).filter((r) => r.endsWith('.txt')).length
    assert.ok(fileRows < 14, `byte-aware page must shrink for long names (got ${fileRows} rows)`)
    // MORE advances to a real next page (variable-size pages → nextOffset jump).
    const moreIdx = items(sc).indexOf('— more —')   // rendered index (incl. the `..` row)
    await files.onBrowseSelect(moreIdx)
    sc = await settle((x) => items(x).includes('— prev —'), 'page 2 (— prev — present)')
    assert.ok(estimateLayoutFrameBytes(sc.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'page 2 also under budget')
    console.error(`  7. deep dir + 40 long names: ${fileRows} rows/page, est ${deepEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES}, MORE/PREV navigate ✓`)

    // --- 8. Directories are first-class: recursive Copy + the self-copy guard. ---
    const srcdir = join(sandbox, 'srcdir')
    mkdirSync(join(srcdir, 'nested'), { recursive: true })
    writeFileSync(join(srcdir, 'top.txt'), 'top')
    writeFileSync(join(srcdir, 'nested', 'deep.txt'), 'deep')
    mkdirSync(join(sandbox, 'destdir'))
    files.stack = [sandbox, srcdir]   // descended below the root → dir ops appear
    files.level = 'tree'; files.offset = 0; files.focus = 'content'
    wm.requestRender()
    sc = await settle((x) => menu(x).includes('Copy') && menu(x).includes('Move'), 'tree menu with dir ops (descended)')
    assert.deepEqual(menu(sc), ['Up', 'New', 'Copy', 'Move', 'Rename', 'Del', 'Stats', 'Reload', 'Main'])
    // self-copy guard: try to copy srcdir INTO srcdir/nested → must loud-fail
    await files.onMenuSelect('Copy')
    await settle((x) => (x.regions.find((r) => r.name === 'title')?.content?.text ?? '').includes('pick location'), 'copy dest stage')
    files.destStack = [join(srcdir, 'nested')]
    wm.requestRender()
    await settle((x) => menu(x).includes('Copy here'), 'dest = srcdir/nested')
    // 2026-06-13 review fix: pickDest double-tap now flips focus to the menu so
    // the verb / Cancel are reachable (were dead UI — depositing into a location
    // ROOT was impossible). Verify the flip makes the menu the capture region.
    await files.onBack()
    const flipped = await settle((x) => captures(x)[0]?.name === 'menu', 'pickDest flip → menu captures')
    assert.ok(menu(flipped).includes('Copy here'), 'the verb rides the now-capturing menu')
    console.error('  8a-flip. pickDest double-tap flips focus → verb reachable ✓')
    await files.onMenuSelect('Copy here')
    sc = await settle((x) => /FAILED/.test(text(x)), 'self-copy refused')
    assert.match(text(sc), /into itself/)
    console.error('  8a. dir copy into a descendant → refused ✓')
    // real recursive copy srcdir → destdir/srcdir
    await files.onBack()                       // opResult → tree
    files.stack = [sandbox, srcdir]; files.level = 'tree'; files.offset = 0; files.focus = 'content'; wm.requestRender()
    await settle((x) => menu(x).includes('Copy'), 'tree dir ops again')
    await files.onMenuSelect('Copy')
    await settle((x) => (x.regions.find((r) => r.name === 'title')?.content?.text ?? '').includes('pick location'), 'copy dest stage 2')
    files.destStack = [join(sandbox, 'destdir')]; wm.requestRender()
    await settle((x) => menu(x).includes('Copy here'), 'dest = destdir')
    await files.onMenuSelect('Copy here')
    sc = await settle((x) => /Copied/.test(text(x)), 'dir copy result')
    assert.ok(existsSync(join(sandbox, 'destdir', 'srcdir', 'top.txt')), 'recursive copy: top.txt')
    assert.ok(existsSync(join(sandbox, 'destdir', 'srcdir', 'nested', 'deep.txt')), 'recursive copy: nested/deep.txt')
    assert.ok(existsSync(join(srcdir, 'top.txt')), 'copy kept the source dir')
    console.error('  8b. recursive directory Copy round-trip ✓')

    // --- 9. Rename a file via the dictation confirm flow. ---
    files.stack = [sandbox]; files.level = 'tree'; files.offset = 0; files.focus = 'content'; wm.requestRender()
    sc = await settle((x) => items(x).includes('a.txt'), 'sandbox listing for rename')
    await files.onBrowseSelect(items(sc).indexOf('a.txt'))
    await settle((x) => menu(x)[0] === 'Open', 'actions for rename')
    await files.onMenuSelect('Rename')
    sc = await settle((x) => menu(x)[0] === 'Done', 'name level listening')
    assert.match(text(sc), /listening/)
    await files.onMenuSelect('Done')
    await settle((x) => /transcribing/.test(text(x)), 'transcribing')
    await files.onStt('renamed file.txt')
    sc = await settle((x) => menu(x)[0] === 'Confirm', 'name confirm')
    assert.match(text(sc), /renamed file\.txt/)
    await files.onMenuSelect('Confirm')
    sc = await settle((x) => /Renamed/.test(text(x)), 'rename result')
    assert.ok(existsSync(join(sandbox, 'renamed file.txt')), 'renamed target exists')
    assert.ok(!existsSync(join(sandbox, 'a.txt')), 'old name gone')
    console.error('  9. Rename via dictation → confirm → renamed ✓')

    // --- 10. New folder (mkdir) via dictation. ---
    files.stack = [sandbox]; files.level = 'tree'; files.offset = 0; files.focus = 'content'; wm.requestRender()
    await settle((x) => menu(x).includes('New'), 'tree menu with New')
    await files.onMenuSelect('New')
    await settle((x) => menu(x)[0] === 'Done', 'mkdir listening')
    await files.onMenuSelect('Done')
    await settle((x) => /transcribing/.test(text(x)), 'mkdir transcribing')
    await files.onStt('My New Folder')
    sc = await settle((x) => menu(x)[0] === 'Confirm', 'mkdir confirm')
    await files.onMenuSelect('Confirm')
    sc = await settle((x) => /Created folder/.test(text(x)), 'mkdir result')
    assert.ok(existsSync(join(sandbox, 'My New Folder')), 'new folder created')
    console.error('  10. New folder via dictation → mkdir ✓')
  } finally {
    wm.dispose()
    rmSync(sandbox, { recursive: true, force: true })
    rmSync(process.env.G2CC_TRASH_DIR, { recursive: true, force: true })
  }
}

await getPool().end()   // review 2026-07-05: a leaked pool idles ~10 s before the process can exit
console.log('phase1-files: ALL OK')
}
