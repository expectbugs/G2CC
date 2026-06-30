// windows/files.ts — filesystem browser: tree + preview/image viewer + ops + trash (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, constants as fsConstants } from 'node:fs'
import { rename, copyFile, unlink, mkdir, rm, cp } from 'node:fs/promises'
import { join, basename, dirname, resolve as resolvePath } from 'node:path'
import { execFile } from 'node:child_process'
import { DE_CONTENT_W, DE_CONTENT_H } from '@g2cc/shared'
import type { OsWindow, WmContext, WinView, WindowOpen } from './types.js'
import { browsePageItems, browseRowBytes } from './_browse.js'
import { paginateText, errorView } from '../os-compose.js'
import { renderImageFile, type RenderedImage } from '../os-content.js'
import { moveToTrash, TRASH_DIR } from '../trash.js'

const FILES_ROOT = '/home/user'
/** Files window head-preview bound (event-loop-blocking read guard). */
const FILE_PREVIEW_BYTES = 256 * 1024


/** Files (locations REVERTED to a plain browse list 2026-06-11 — Adam: the
 *  per-notch antenna live preview "feels janky"): the root level is a normal
 *  browse list of LOCATIONS — Root / Home / Downloads / G2CC / each mounted
 *  drive — tap a row to enter tree browsing (dirs descend, '..' ascends,
 *  files open a bounded head preview / the image viewer). Double-tap walks
 *  back with the Mail-style focus flip at each browse level: read → tree →
 *  tree menu → locations → locations menu → Main. */
/** Human size: 1536 → "1.5K", 3 GB → "3.0G". */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  const units = ['K', 'M', 'G', 'T']
  let v = n
  let u = -1
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${units[u]}`
}

/** `-rwxr-x---`-style mode string from st_mode. */
function fmtMode(mode: number): string {
  const r = (b: number): string => `${b & 4 ? 'r' : '-'}${b & 2 ? 'w' : '-'}${b & 1 ? 'x' : '-'}`
  return r((mode >> 6) & 7) + r((mode >> 3) & 7) + r(mode & 7)
}

export class FilesWindow implements OsWindow {
  readonly id = 'files'
  readonly tab = 'Files'
  readonly label = 'Files'
  readonly category = 'Tools' as const
  /** The REAL-file-manager rework (Adam 2026-06-12): `..` is ALWAYS row 0 at
   *  the tree level (at a location root it pops to locations — "trapped in DL
   *  forever" is dead), the tree menu carries Up/Stats, tapping a FILE opens
   *  an ACTION level (Open/Move/Copy/Rename/Del/Stats) instead of auto-opening,
   *  and Move/Copy run a destination picker where tapping a folder asks
   *  Open vs "<verb> here". Dirs still descend on tap (fast navigation).
   *  2026-06-13 (Adam): directories are first-class — when descended BELOW a
   *  location root, the tree menu's New/Copy/Move/Rename/Del act on the CURRENT
   *  dir (recursive cp/rm); Rename + New folder take a name via dictation (the
   *  'name' level mirrors SessionLevel's confirm flow). */
  private level: 'locations' | 'tree' | 'read' | 'image' | 'actions' | 'confirmDel' | 'stats' | 'pickDest' | 'pickAction' | 'opResult' | 'name' = 'locations'
  private locs: { label: string; path: string }[] = []
  private locOffset = 0
  private stack: string[] = []
  private offset = 0
  private entries: { name: string; isDir: boolean }[] = []
  private pages: string[] = []
  private page = 0
  private readName = ''
  private img: RenderedImage | null = null   // the image-viewer payload
  /** Navigation sequence — bumped on every browse action/back so an in-flight
   *  image render / du can detect it was superseded (stale-swap guard). */
  private navSeq = 0
  /** tree-level focus: content rows (default) ⇄ the menu list (double-tap) — without
   *  this the tree's rendered menu was dead UI (review 2026-06-11). */
  private focus: 'content' | 'menu' = 'content'
  // ---- file-manager state (Adam 2026-06-12) ----
  /** What the actions/op flow is operating on — a tapped FILE (a child of cwd),
   *  or the CURRENT DIR itself (2026-06-13: dir ops live in the tree menu). */
  private actionPath: string | null = null
  private actionName = ''
  private actionSize = 0
  /** The target is a directory (recursive cp/rm; "(directory)" not a byte size). */
  private actionIsDir = false
  /** The target IS the current dir (vs a child file/dir) — a move/del then pops
   *  the stack to the parent, a rename rewrites the stack top. */
  private actionIsCwd = false
  private actionVerb: 'move' | 'copy' | null = null
  /** Destination picker: empty destStack = picking a location first. */
  private destStack: string[] = []
  private destOffset = 0
  private destEntries: string[] = []
  /** The folder tapped in the picker (the Open vs "<verb> here" prompt). */
  private pickTarget: string | null = null
  /** Where the stats level was opened from (Back returns there). */
  private statsFrom: 'actions' | 'tree' = 'tree'
  /** One filesystem operation at a time — taps during one are loud no-ops. */
  private opBusy = false
  // ---- name-entry dictation (Adam 2026-06-13: Rename + New folder) ----
  /** What the confirmed dictated name does, and where Back/Cancel returns. */
  private nameVerb: 'rename' | 'mkdir' | null = null
  private nameFrom: 'actions' | 'tree' = 'tree'
  /** Dictation state machine, mirroring SessionLevel (the confirm step is
   *  sacred — a misheard name never lands without Adam reading it). */
  private listening = false
  private transcribing = false
  private pendingName: string | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    return this.level === 'locations' ? 'locations' : this.cwd()
  }

  /** Ribbon preview (READ-ONLY, in-memory): the current location/cwd + a few
   *  CACHED directory entries from the last view() listing. NO readdir, NO du,
   *  NO subprocess — empty cache falls back to just the cwd. */
  preview(): string | null {
    if (this.level === 'locations') {
      if (!this.locs.length) return null   // never listed → summary 'locations'
      return ['Files · locations', ...this.locs.slice(0, 5).map((l) => `${l.label} — ${l.path}`)].join('\n')
    }
    const cwd = this.cwd()
    const where = cwd.length > 36 ? '…' + cwd.slice(-35) : cwd
    const lines = [`Files · ${where}`]
    if (this.entries.length) {
      const dirs = this.entries.filter((e) => e.isDir).length
      const files = this.entries.length - dirs
      lines.push(`${dirs} dir${dirs === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}`)
      for (const e of this.entries.slice(0, 4)) {
        const name = e.name.length > 34 ? e.name.slice(0, 33) + '…' : e.name
        lines.push(e.isDir ? `${name}/` : name)
      }
    } else {
      lines.push('(open to list its contents)')
    }
    return lines.join('\n')
  }

  private cwd(): string { return this.stack[this.stack.length - 1] ?? FILES_ROOT }
  private destCwd(): string | null { return this.destStack[this.destStack.length - 1] ?? null }

  /** The common areas (Adam's list; 'DL' = Downloads, kept short from the
   *  antenna era) + drives that are ACTUALLY MOUNTED per /proc/mounts (an
   *  unmounted /mnt/* mountpoint is just an empty dir — don't list it). */
  private refreshLocations(): void {
    const out = [
      { label: 'Root', path: '/' },
      { label: 'Home', path: '/home/user' },
      { label: 'DL', path: '/home/user/Downloads' },
      { label: 'G2CC', path: '/home/user/G2CC' },
    ]
    // The Trash location appears only once something has been trashed (Phase
    // 17) — restore = navigate in + Move out.
    if (existsSync(TRASH_DIR)) out.push({ label: 'Trash', path: TRASH_DIR })
    try {
      // /proc/mounts: "<dev> <mountpoint> <fstype> …" — mountpoints octal-escape
      // spaces etc. (\040). Keep real mounts under /mnt/ or /run/media/user/.
      const seen = new Set<string>()
      for (const line of readFileSync('/proc/mounts', 'utf8').split('\n')) {
        const mp = line.split(' ')[1]
        if (!mp) continue
        const path = mp.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
        if ((path.startsWith('/mnt/') || path.startsWith('/run/media/user/')) && !seen.has(path)) {
          seen.add(path)
          out.push({ label: basename(path), path })
        }
      }
    } catch (e) {
      this.ctx.log(`[os] files: cannot read /proc/mounts: ${(e as Error).message}`)
    }
    this.locs = out
    // An unmount can shrink the list under a saved paging offset — snap back.
    if (this.locOffset >= out.length) this.locOffset = 0
  }

  private listDir(dir: string): { name: string; isDir: boolean }[] {
    // withFileTypes: the dirent already knows isDirectory() — the old per-entry
    // statSync pass fully blocked the event loop for tens of seconds on a huge or
    // cold-HDD directory (review 2026-06-11). Only symlinks still need one stat
    // each to classify their target.
    const dirents = readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'))
    const entries = dirents.map((d) => {
      let isDir = d.isDirectory()
      if (!isDir && d.isSymbolicLink()) {
        try { isDir = statSync(join(dir, d.name)).isDirectory() } catch { /* dangling symlink — list as file; open loud-fails */ }
      }
      return { name: d.name, isDir }
    })
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    return entries
  }

  async view(): Promise<WinView> {
    if (this.level === 'image') {
      const im = this.img
      if (!im) { this.level = 'tree'; return this.view() }
      return {
        mode: 'tiles',
        tilesRect: { w: im.w, h: im.h },
        title: `Files · ${this.readName} (${im.w}×${im.h})`,
        menu: ['Back', 'Reload', 'Main'],
        tiles: im.tiles,
      }
    }
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Files · ${this.readName}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    if (this.level === 'actions') {
      return {
        mode: 'text',
        title: `Files · ${this.actionName}`,
        menu: ['Open', 'Move', 'Copy', 'Rename', 'Del', 'Stats', 'Back', 'Reload', 'Main'],
        text: `${this.actionName}\n${fmtBytes(this.actionSize)}\n\nin ${this.cwd()}`,
      }
    }
    if (this.level === 'name') {
      // Dictation/confirm for Rename + New folder (mirrors SessionLevel).
      const what = this.nameVerb === 'rename' ? `Rename ${this.actionName}` : 'New folder'
      if (this.listening) {
        return { mode: 'text', title: `Files · ${what}`, menu: ['Done', 'Cancel', 'Reload', 'Main'],
          text: `🎤 listening… say the ${this.nameVerb === 'rename' ? 'new name' : 'folder name'}, then Done.` }
      }
      if (this.transcribing) {
        return { mode: 'text', title: `Files · ${what}`, menu: ['Cancel', 'Reload', 'Main'], text: '⏳ transcribing…' }
      }
      if (this.pendingName !== null) {
        const action = this.nameVerb === 'rename'
          ? `rename to:\n  ${this.pendingName}`
          : `create folder:\n  ${this.pendingName}\nin ${this.cwd()}`
        return { mode: 'text', title: `Files · ${what} — confirm?`, menu: ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main'],
          text: `Heard "${this.pendingName}".\nConfirm to ${action}` }
      }
      // Shouldn't render (entering 'name' starts listening) — recover loudly.
      this.ctx.log('[os] files: name level with no dictation state — back to tree')
      this.level = 'tree'
      return this.view()
    }
    if (this.level === 'confirmDel') {
      const kind = this.actionIsDir ? 'directory (recursive)' : fmtBytes(this.actionSize)
      return {
        mode: 'text',
        title: `Files · delete?`,
        // Cancel FIRST (Adam 2026-06-12): an accidental second tap on the
        // same spot lands on Cancel, never on the destructive option — the
        // Approve/Deny-at-index-2/3 permission-menu rationale.
        menu: ['Cancel', 'DELETE', 'Reload', 'Main'],
        text: `Delete ${this.actionName}?\n(${kind})\n\nMoves to Trash — restorable for 30 days.`,
      }
    }
    if (this.level === 'stats') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Files · stats${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    if (this.level === 'opResult') {
      return {
        mode: 'text',
        title: 'Files · result',
        menu: ['Back', 'Reload', 'Main'],
        text: this.pages[0] ?? '',
      }
    }
    if (this.level === 'pickAction') {
      const verb = this.actionVerb === 'move' ? 'Move here' : 'Copy here'
      return {
        mode: 'text',
        title: `Files · ${this.actionVerb} ${this.actionName}`,
        menu: ['Open', verb, 'Cancel', 'Reload', 'Main'],
        text: `${this.pickTarget ?? '?'}\n\nOpen = browse into it\n${verb} = ${this.actionVerb} ${this.actionName} into it`,
      }
    }
    if (this.level === 'pickDest') {
      const verb = this.actionVerb === 'move' ? 'Move here' : 'Copy here'
      const cwd = this.destCwd()
      if (cwd === null) {
        // Stage 1: pick a location (no "<verb> here" — a list isn't a folder).
        this.refreshLocations()
        const paged = browsePageItems(this.locs.map((l) => l.label), this.destOffset)
        return {
          mode: 'browse',
          menuMode: this.focus === 'menu' ? 'capture' : 'passive',
          title: `Files · ${this.actionVerb} → pick location`,
          menu: ['Cancel', 'Reload', 'Main'],
          items: paged.items,
        }
      }
      let dirs: string[]
      try {
        dirs = this.listDir(cwd).filter((e) => e.isDir).map((e) => e.name)
      } catch (e) {
        return errorView('Files · error', (e as Error).message)
      }
      this.destEntries = dirs
      const paged = browsePageItems(dirs.map((d) => d + '/'), this.destOffset, browseRowBytes('..'), 1)
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: `Files · ${this.actionVerb} → ${cwd}`,
        menu: [verb, 'Cancel', 'Reload', 'Main'],
        items: ['..', ...paged.items],
      }
    }
    if (this.level === 'locations') {
      this.refreshLocations()
      if (this.locs.length === 0) return errorView('Files · error', 'no locations found')
      const paged = browsePageItems(this.locs.map((l) => l.label), this.locOffset)
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: 'Files · locations',
        menu: ['Reload', 'Main'],
        items: paged.items,
      }
    }
    // tree
    let listed: { name: string; isDir: boolean }[]
    try {
      listed = this.listDir(this.cwd())
    } catch (e) {
      return errorView('Files · error', (e as Error).message)
    }
    this.entries = listed
    const labels = this.entries.map((e) => (e.isDir ? e.name + '/' : e.name))
    const paged = browsePageItems(labels, this.offset, browseRowBytes('..'), 1)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Files · ${this.cwd()}`,
      menu: this.treeMenu(),
      // `..` is ALWAYS row 0 — at a location root it pops to locations
      // (the old gate on stack depth left no visible way out of e.g. DL).
      items: ['..', ...paged.items],
    }
  }

  /** Tree-level menu (Adam 2026-06-13). `New` (mkdir here) + `Stats` are always
   *  offered; the CURRENT-DIR ops (Copy/Move/Rename/Del — recursive) appear only
   *  when descended BELOW a location root (stack.length > 1), so a location root
   *  like /home/user can never be moved/deleted out from under itself. */
  private treeMenu(): string[] {
    return this.stack.length > 1
      ? ['Up', 'New', 'Copy', 'Move', 'Rename', 'Del', 'Stats', 'Reload', 'Main']
      : ['Up', 'New', 'Stats', 'Reload', 'Main']
  }

  async onReload(): Promise<void> {
    this.focus = 'content'   // a menu action hands focus back to the rows
    // Reload is the unstick: a wedged name-entry dictation drops the mic and
    // returns to the tree (the documented Reload contract — clear transients).
    if (this.level === 'name') {
      this.stopNameEntry('reload')
      this.actionIsCwd = false; this.actionIsDir = false
      this.level = 'tree'
    }
    // view() re-lists the current level fresh on the recompose — Reload
    // REFRESHES IN PLACE at every level (it never resets to locations; a
    // fresh WS connection is what resets window state).
  }

  // ---- navigation helpers ----

  private upOne(): void {
    this.navSeq++
    if (this.stack.length > 1) {
      this.stack.pop()
      this.offset = 0
    } else {
      this.level = 'locations'
      this.offset = 0
    }
    this.requestRender()
  }

  /** Open the actions level for a tapped FILE (Adam 2026-06-12: tap = options,
   *  Open is the top one — "like a real file manager"). */
  private openActions(path: string, name: string): void {
    try {
      const st = statSync(path)
      this.actionPath = path
      this.actionName = name
      this.actionSize = st.size
      this.actionIsDir = false   // the actions level is files-only; dirs act via the tree menu
      this.actionIsCwd = false
      this.level = 'actions'
      this.requestRender()
    } catch (e) {
      this.pages = [`ERROR statting ${name}:\n${(e as Error).message}`]
      this.page = 0
      this.readName = name
      this.level = 'read'
      this.requestRender()
    }
  }

  /** The proven open path (preview/image/FIFO guard) — now behind the
   *  actions level's Open. */
  private async openFile(path: string, name: string): Promise<void> {
    // Image viewer (Adam 2026-06-11): fit + dither + 4 tiles, aspect preserved.
    if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(name)) {
      this.readName = name
      // Stale-swap guard (review 2026-06-11b): any navigation during the PIL
      // subprocess invalidates this request.
      const seq = ++this.navSeq
      try {
        const img = await renderImageFile(path, DE_CONTENT_W, DE_CONTENT_H)
        if (seq !== this.navSeq) {
          this.ctx.log(`[os] files: image render for '${name}' superseded by newer navigation — discarded`)
          return
        }
        this.img = img
        this.level = 'image'
      } catch (err) {
        if (seq !== this.navSeq) {
          this.ctx.log(`[os] files: image render FAILURE for '${name}' superseded — discarded: ${(err as Error).message}`)
          return
        }
        this.pages = [`ERROR rendering image ${name}:\n${(err as Error).message}`]
        this.page = 0
        this.level = 'read'
      }
      this.requestRender()
      return
    }
    try {
      // Bounded HEAD PREVIEW (DE_DESIGN §4) — an unbounded readFileSync on a
      // multi-GB file blocks the whole event loop for seconds (review
      // 2026-06-10). Read ONLY the head from disk. This is a navigational
      // preview, clearly labeled; full content is reachable via a CC session.
      const st = statSync(path)
      if (!st.isFile()) {
        // openSync on a writer-less FIFO blocks in the kernel FOREVER — single
        // thread, whole server frozen, nothing recovers it (review 2026-06-11).
        // Sockets/devices are equally not preview material.
        this.pages = [`(special file — not previewable)\n\n${name}`]
        this.page = 0
        this.readName = name
        this.level = 'read'
        this.requestRender()
        return
      }
      const size = st.size
      const fd = openSync(path, 'r')
      let buf: Buffer
      try {
        buf = Buffer.alloc(Math.min(size, FILE_PREVIEW_BYTES))
        readSync(fd, buf, 0, buf.length, 0)
      } finally {
        closeSync(fd)
      }
      const head = buf.subarray(0, 8192)
      if (head.includes(0)) {
        this.pages = [`(binary file)\n\n${name}\n${size} bytes`]
      } else {
        const text = buf.toString('utf8')
        const banner = size > FILE_PREVIEW_BYTES
          ? `(head preview — first ${FILE_PREVIEW_BYTES} of ${size} bytes; open via CC for the rest)\n\n`
          : ''
        this.pages = paginateText(banner + text)
      }
      this.page = 0
      this.readName = name
      this.level = 'read'
      this.requestRender()
    } catch (err) {
      this.pages = [`ERROR reading ${name}:\n${(err as Error).message}`]
      this.page = 0
      this.readName = name
      this.level = 'read'
      this.requestRender()
    }
  }

  // ---- directory actions (Adam 2026-06-13) — operate on the CURRENT dir ----

  /** A tree-menu op on the current directory (Copy/Move/Del). Targets cwd
   *  itself; only valid when descended below a location root. */
  private beginDirAction(verb: 'move' | 'copy' | 'del'): void {
    if (this.stack.length <= 1) { this.ctx.log(`[os] files: ${verb} at a location root — refused (LOUD)`); return }
    this.navSeq++
    this.actionPath = this.cwd()
    this.actionName = basename(this.cwd())
    this.actionSize = 0
    this.actionIsDir = true
    this.actionIsCwd = true
    if (verb === 'del') { this.level = 'confirmDel'; this.requestRender(); return }
    this.actionVerb = verb
    this.destStack = []
    this.destOffset = 0
    this.focus = 'content'
    this.level = 'pickDest'
    this.requestRender()
  }

  /** Start name-entry dictation for Rename (target = actionPath) or New folder
   *  (mkdir in cwd). Mirrors SessionLevel: listening → Done → transcribing →
   *  pendingName → Confirm. */
  private startNameEntry(verb: 'rename' | 'mkdir', from: 'actions' | 'tree', target?: { path: string; name: string }): void {
    this.navSeq++
    this.nameVerb = verb
    this.nameFrom = from
    if (verb === 'rename') {
      if (target) { this.actionPath = target.path; this.actionName = target.name }
      // else the actions-level target (a file) is already set in actionPath/Name.
      if (!this.actionPath) { this.ctx.log('[os] files: rename with no target — ignored (LOUD)'); return }
    }
    this.pendingName = null
    this.transcribing = false
    this.listening = true
    this.level = 'name'
    this.ctx.audio('start')
    this.requestRender()
  }

  /** Clear the name-entry dictation (Cancel / Back / deactivate); stops the mic
   *  if it's live (loud via the WS). */
  private stopNameEntry(why: string): void {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    if (this.listening || this.transcribing || this.pendingName !== null) {
      this.ctx.log(`[os] files: name-entry cleared (${why})`)
    }
    this.listening = false
    this.transcribing = false
    this.pendingName = null
    this.nameVerb = null
  }

  /** Validate a dictated file/dir name: trimmed, single path component, no
   *  separators or dot-only names. Returns the clean name or an error string. */
  private cleanName(raw: string): { name: string } | { error: string } {
    // Trim + collapse internal whitespace; KEEP spaces (valid) + the rest verbatim.
    const name = raw.trim().replace(/\s+/g, " ")
    if (!name) return { error: 'empty name' }
    if (name === '.' || name === '..') return { error: `"${name}" is not a valid name` }
    if (name.includes('/')) return { error: 'name cannot contain "/" (use Move to change folders)' }
    return { name }
  }

  private async doRename(): Promise<void> {
    const src = this.actionPath
    const raw = this.pendingName
    if (!src || raw === null || this.opBusy) { this.ctx.log('[os] files: rename with no target/name / op in flight — ignored (LOUD)'); return }
    const clean = this.cleanName(raw)
    if ('error' in clean) {
      this.ctx.log(`[os] files: rename rejected: ${clean.error}`)
      this.pages = [`RENAME rejected:\n${clean.error}`]
      this.page = 0; this.level = 'opResult'; this.requestRender(); return
    }
    this.opBusy = true
    const dst = join(dirname(src), clean.name)
    try {
      if (dst === src) throw new Error('the name is unchanged')
      if (existsSync(dst)) throw new Error(`${clean.name} already exists in this folder`)
      await rename(src, dst)
      this.ctx.log(`[os] files: RENAMED ${src} → ${dst}`)
      this.pages = [`Renamed to\n${clean.name}`]
      // If we renamed the dir we're standing in, follow it (rewrite the stack top).
      if (this.actionIsCwd && this.stack.length > 0) this.stack[this.stack.length - 1] = dst
      this.actionPath = this.actionIsCwd ? this.cwd() : null
    } catch (e) {
      this.ctx.log(`[os] files: rename ${src} → ${dst} FAILED: ${(e as Error).message}`)
      this.pages = [`RENAME FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.pendingName = null
    this.nameVerb = null
    this.actionIsCwd = false
    this.actionIsDir = false
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  private async doMkdir(): Promise<void> {
    const raw = this.pendingName
    if (raw === null || this.opBusy) { this.ctx.log('[os] files: mkdir with no name / op in flight — ignored (LOUD)'); return }
    const clean = this.cleanName(raw)
    if ('error' in clean) {
      this.ctx.log(`[os] files: mkdir rejected: ${clean.error}`)
      this.pages = [`NEW FOLDER rejected:\n${clean.error}`]
      this.page = 0; this.level = 'opResult'; this.requestRender(); return
    }
    this.opBusy = true
    const dst = join(this.cwd(), clean.name)
    try {
      if (existsSync(dst)) throw new Error(`${clean.name} already exists here`)
      await mkdir(dst)
      this.ctx.log(`[os] files: MKDIR ${dst}`)
      this.pages = [`Created folder\n${clean.name}\nin ${this.cwd()}`]
    } catch (e) {
      this.ctx.log(`[os] files: mkdir ${dst} FAILED: ${(e as Error).message}`)
      this.pages = [`NEW FOLDER FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.pendingName = null
    this.nameVerb = null
    this.actionIsCwd = false
    this.actionIsDir = false
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  // ---- file operations (Adam 2026-06-12) ----

  /** Stats for the tapped FILE or the CURRENT DIR. Dir totals run du -sbx
   *  async (one filesystem, no mount crossing — du across / would count
   *  every drive) with a placeholder + the seq stale-guard. */
  private showStats(target: 'file' | 'dir'): void {
    this.statsFrom = target === 'file' ? 'actions' : 'tree'
    if (target === 'file' && this.actionPath) {
      try {
        const st = statSync(this.actionPath)
        this.pages = paginateText([
          this.actionName,
          '',
          `size:   ${fmtBytes(st.size)} (${st.size} bytes)`,
          `mode:   ${fmtMode(st.mode)} (${(st.mode & 0o7777).toString(8)})`,
          `owner:  uid ${st.uid} · gid ${st.gid}`,
          `modified: ${st.mtime.toLocaleString()}`,
          `changed:  ${st.ctime.toLocaleString()}`,
          '',
          `in ${this.cwd()}`,
        ].join('\n'))
      } catch (e) {
        this.pages = [`ERROR statting ${this.actionName}:\n${(e as Error).message}`]
      }
      this.page = 0
      this.level = 'stats'
      this.requestRender()
      return
    }
    // Current-dir stats: instant counts, async du total swap.
    const dir = this.cwd()
    let dirs = 0; let files = 0
    try {
      for (const e of this.listDir(dir)) { if (e.isDir) dirs++; else files++ }
    } catch (e) {
      this.pages = [`ERROR listing ${dir}:\n${(e as Error).message}`]
      this.page = 0
      this.level = 'stats'
      this.requestRender()
      return
    }
    const seq = ++this.navSeq
    this.pages = paginateText(`${dir}\n\n${dirs} dir(s) · ${files} file(s) (dotfiles hidden)\n\ntotal size: ⏳ computing (du)…`)
    this.page = 0
    this.level = 'stats'
    this.requestRender()
    execFile('du', ['-sbx', dir], { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (seq !== this.navSeq) { this.ctx.log(`[os] files: du for ${dir} superseded — discarded`); return }
      const total = err
        ? `du FAILED: ${stderr?.toString().split('\n')[0] ?? err.message}`
        : `${fmtBytes(Number(stdout.toString().split('\t')[0]))} (same filesystem; dotfiles included)`
      this.pages = paginateText(`${dir}\n\n${dirs} dir(s) · ${files} file(s) (dotfiles hidden)\n\ntotal size: ${total}`)
      this.requestRender()
    })
  }

  private async doDelete(): Promise<void> {
    const path = this.actionPath
    if (!path || this.opBusy) { this.ctx.log('[os] files: delete with no target / op in flight — ignored (LOUD)'); return }
    this.opBusy = true
    const wasCwd = this.actionIsCwd
    try {
      // Trash, not unlink (Phase 17): restorable for 30 days via the Trash
      // location + the Move flow. moveToTrash handles dirs + cross-FS itself.
      const dest = await moveToTrash(path, Date.now())
      this.ctx.log(`[os] files: TRASHED ${this.actionIsDir ? 'dir ' : ''}${path} → ${dest}`)
      this.pages = [`Moved ${this.actionName} to Trash.\n(restorable for 30 days)`]
      // Deleting the dir we were standing in leaves the stack top dangling —
      // pop to the parent so the tree relists a real directory.
      if (wasCwd && this.stack.length > 1) this.stack.pop()
    } catch (e) {
      this.ctx.log(`[os] files: trash ${path} FAILED: ${(e as Error).message}`)
      this.pages = [`DELETE FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.actionPath = null
    this.actionIsCwd = false
    this.actionIsDir = false
    this.offset = 0
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  /** Move/copy actionPath into [destDir]. Handles DIRECTORIES recursively
   *  (fs.cp / fs.rm — Adam 2026-06-13). No overwrites — a name collision
   *  loud-fails (pick a different folder). Move falls back to copy+remove
   *  across filesystems (EXDEV — /mnt drives are separate FSes). A folder may
   *  never be copied/moved into itself or a descendant. */
  private async doTransfer(destDir: string): Promise<void> {
    const src = this.actionPath
    const verb = this.actionVerb
    if (!src || !verb || this.opBusy) { this.ctx.log('[os] files: transfer with no source/verb / op in flight — ignored (LOUD)'); return }
    this.opBusy = true
    const wasCwd = this.actionIsCwd
    const dst = join(destDir, this.actionName)
    try {
      if (this.actionIsDir) {
        const rsrc = resolvePath(src)
        const rdst = resolvePath(destDir)
        if (rdst === rsrc || rdst.startsWith(rsrc + '/')) {
          throw new Error('cannot move/copy a folder into itself or one of its subfolders')
        }
      }
      if (existsSync(dst)) throw new Error(`${dst} already exists (no overwrites — pick another folder or rename first)`)
      if (verb === 'copy') {
        if (this.actionIsDir) await cp(src, dst, { recursive: true, errorOnExist: true, force: false })
        else await copyFile(src, dst, fsConstants.COPYFILE_EXCL)
      } else {
        try {
          await rename(src, dst)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
          // Cross-filesystem move: copy then remove the source (dirs recursively).
          if (this.actionIsDir) { await cp(src, dst, { recursive: true, errorOnExist: true, force: false }); await rm(src, { recursive: true }) }
          else { await copyFile(src, dst, fsConstants.COPYFILE_EXCL); await unlink(src) }
        }
      }
      this.ctx.log(`[os] files: ${verb.toUpperCase()} ${this.actionIsDir ? 'dir ' : ''}${src} → ${dst}`)
      this.pages = [`${verb === 'move' ? 'Moved' : 'Copied'} ${this.actionName}\n→ ${destDir}`]
      if (verb === 'move') {
        // Moved the dir we were in → follow it to its new home (the old parents
        // still exist, so Up keeps working); a file/child move just clears the target.
        if (wasCwd && this.stack.length > 0) this.stack[this.stack.length - 1] = dst
        this.actionPath = wasCwd ? this.cwd() : null
      }
    } catch (e) {
      this.ctx.log(`[os] files: ${verb} ${src} → ${dst} FAILED: ${(e as Error).message}`)
      this.pages = [`${verb.toUpperCase()} FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.actionVerb = null
    this.actionIsCwd = false
    this.actionIsDir = false
    this.pickTarget = null
    this.destStack = []
    this.destOffset = 0
    this.offset = 0
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  // ---- input ----

  async onBrowseSelect(index: number): Promise<void> {
    this.navSeq++   // any new browse action supersedes an in-flight image render/du
    if (this.level === 'locations') {
      const { map, prevOffset, nextOffset } = browsePageItems(this.locs.map((l) => l.label), this.locOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] files locations: index ${index} out of range`); return }
      if (m === -1) { this.locOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.locOffset = nextOffset; this.requestRender(); return }
      const loc = this.locs[m]
      if (!loc) { this.ctx.log(`[os] files locations: no location at ${m} — resyncing`); this.requestRender(); return }
      this.stack = [loc.path]
      this.offset = 0
      this.focus = 'content'
      this.level = 'tree'
      this.requestRender()
      return
    }
    if (this.level === 'pickDest') {
      const cwd = this.destCwd()
      if (cwd === null) {
        // Stage 1: pick the destination location.
        const { map, prevOffset, nextOffset } = browsePageItems(this.locs.map((l) => l.label), this.destOffset)
        const m = map[index]
        if (m === undefined) { this.ctx.log(`[os] files pick: index ${index} out of range`); return }
        if (m === -1) { this.destOffset = prevOffset; this.requestRender(); return }
        if (m === -2) { this.destOffset = nextOffset; this.requestRender(); return }
        const loc = this.locs[m]
        if (!loc) { this.ctx.log(`[os] files pick: no location at ${m} — resyncing`); this.requestRender(); return }
        this.destStack = [loc.path]
        this.destOffset = 0
        this.requestRender()
        return
      }
      // Stage 2: '..' row 0, then dirs; tapping a dir prompts Open vs "<verb> here".
      let i = index
      if (i === 0) {
        if (this.destStack.length > 1) this.destStack.pop()
        else this.destStack = []
        this.destOffset = 0
        this.requestRender()
        return
      }
      i -= 1
      const { map, prevOffset, nextOffset } = browsePageItems(this.destEntries.map((d) => d + '/'), this.destOffset, browseRowBytes('..'), 1)
      const m = map[i]
      if (m === undefined) { this.ctx.log(`[os] files pick: index ${index} out of range`); return }
      if (m === -1) { this.destOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.destOffset = nextOffset; this.requestRender(); return }
      const dir = this.destEntries[m]
      if (!dir) { this.ctx.log(`[os] files pick: no dir at ${m} — resyncing`); this.requestRender(); return }
      this.pickTarget = join(cwd, dir)
      this.level = 'pickAction'
      this.requestRender()
      return
    }
    if (this.level !== 'tree') { this.ctx.log(`[os] files: browse select ${index} outside a browse level — ignored`); return }
    // `..` is ALWAYS row 0 (Adam 2026-06-12) — at a location root it pops to
    // the locations list instead of trapping.
    if (index === 0) { this.upOne(); return }
    const i = index - 1
    const labels = this.entries.map((e) => (e.isDir ? e.name + '/' : e.name))
    const { map, prevOffset, nextOffset } = browsePageItems(labels, this.offset, browseRowBytes('..'), 1)
    const m = map[i]
    if (m === undefined) { this.ctx.log(`[os] files: index ${index} out of range`); return }
    if (m === -1) { this.offset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.offset = nextOffset; this.requestRender(); return }
    const e = this.entries[m]
    const path = join(this.cwd(), e.name)
    if (e.isDir) {
      this.stack.push(path)
      this.offset = 0
      this.requestRender()
      return
    }
    // A FILE: open the action menu (Open/Move/Copy/Del/Stats) — Adam 2026-06-12.
    this.openActions(path, e.name)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'tree') {
      // Tree menu (2026-06-13): Up/New/Stats always; Copy/Move/Rename/Del act on
      // the CURRENT dir, only present (treeMenu) when descended below a root.
      switch (label) {
        case 'Up': this.upOne(); return
        case 'Stats': this.showStats('dir'); return
        case 'New': this.startNameEntry('mkdir', 'tree'); return
        case 'Copy': this.beginDirAction('copy'); return
        case 'Move': this.beginDirAction('move'); return
        case 'Del': this.beginDirAction('del'); return
        case 'Rename': {
          if (this.stack.length <= 1) { this.ctx.log('[os] files: rename at a location root — refused (LOUD)'); return }
          this.actionIsDir = true; this.actionIsCwd = true
          this.startNameEntry('rename', 'tree', { path: this.cwd(), name: basename(this.cwd()) })
          return
        }
        default: this.ctx.log(`[os] files tree: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    if (this.level === 'actions') {
      const path = this.actionPath
      if (!path) { this.ctx.log('[os] files: action with no target — back to tree'); this.level = 'tree'; this.requestRender(); return }
      switch (label) {
        case 'Open': await this.openFile(path, this.actionName); return
        case 'Move': case 'Copy': {
          this.actionVerb = label === 'Move' ? 'move' : 'copy'
          this.destStack = []
          this.destOffset = 0
          this.focus = 'content'
          this.level = 'pickDest'
          this.requestRender()
          return
        }
        case 'Rename': this.startNameEntry('rename', 'actions'); return
        case 'Del': { this.level = 'confirmDel'; this.requestRender(); return }
        case 'Stats': { this.showStats('file'); return }
        default: this.ctx.log(`[os] files actions: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    if (this.level === 'name') {
      switch (label) {
        case 'Done':
          if (!this.listening) { this.ctx.log('[os] files name: Done but not listening — ignored'); return }
          this.listening = false; this.transcribing = true; this.ctx.audio('stop'); this.requestRender(); return
        case 'Re-record':
          this.pendingName = null; this.transcribing = false; this.listening = true; this.ctx.audio('start'); this.requestRender(); return
        case 'Cancel': {
          const back = this.nameFrom
          this.stopNameEntry('cancel')
          this.actionIsCwd = false; this.actionIsDir = false
          this.level = back === 'actions' && this.actionPath ? 'actions' : 'tree'
          this.focus = 'content'
          this.requestRender(); return
        }
        case 'Confirm':
          if (this.pendingName === null) { this.ctx.log('[os] files name: Confirm with no pending name — ignored (LOUD)'); return }
          if (this.nameVerb === 'rename') { await this.doRename(); return }
          if (this.nameVerb === 'mkdir') { await this.doMkdir(); return }
          this.ctx.log('[os] files name: Confirm with no verb — ignored (LOUD)'); return
        default: this.ctx.log(`[os] files name: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    if (this.level === 'confirmDel') {
      if (label === 'DELETE') { await this.doDelete(); return }
      if (label === 'Cancel') { this.level = this.actionIsCwd ? 'tree' : 'actions'; this.focus = 'content'; this.requestRender(); return }
      this.ctx.log(`[os] files confirmDel: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'pickDest') {
      if (label === 'Cancel') {
        const wasCwd = this.actionIsCwd
        this.actionVerb = null
        this.actionIsCwd = false
        this.actionIsDir = false
        this.destStack = []
        this.destOffset = 0
        // A current-dir op came from the tree menu; a file op from the actions level.
        this.level = wasCwd ? 'tree' : 'actions'
        this.focus = 'content'
        this.requestRender()
        return
      }
      if (label === 'Move here' || label === 'Copy here') {
        const cwd = this.destCwd()
        if (!cwd) { this.ctx.log('[os] files pick: "here" at the location list — pick a location first (LOUD)'); return }
        await this.doTransfer(cwd)
        return
      }
      this.ctx.log(`[os] files pickDest: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'pickAction') {
      if (label === 'Open') {
        const t = this.pickTarget
        if (t) { this.destStack.push(t); this.destOffset = 0 }
        this.pickTarget = null
        this.level = 'pickDest'
        this.requestRender()
        return
      }
      if (label === 'Move here' || label === 'Copy here') {
        const t = this.pickTarget
        if (!t) { this.ctx.log('[os] files pick: no target folder — ignored (LOUD)'); return }
        await this.doTransfer(t)
        return
      }
      if (label === 'Cancel') {
        this.pickTarget = null
        this.level = 'pickDest'
        this.requestRender()
        return
      }
      this.ctx.log(`[os] files pickAction: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'read' || this.level === 'stats') {
      switch (label) {
        case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
        case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
        default: this.ctx.log(`[os] files ${this.level}: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    this.ctx.log(`[os] files: menu '${label}' at ${this.level} — ignored`)
  }

  /** Back chain: image/read → whence they came; actions → tree; confirmDel →
   *  actions; stats → actions|tree; pickAction → pickDest; pickDest → up a
   *  dir → location stage → actions (cancel); opResult → tree; tree →
   *  (menu-focus flip) → locations; locations → (flip) → Main. */
  async onBack(): Promise<boolean> {
    this.navSeq++   // navigation supersedes an in-flight image render/du
    if (this.level === 'name') {
      const back = this.nameFrom
      this.stopNameEntry('back')
      this.actionIsCwd = false; this.actionIsDir = false
      this.level = back === 'actions' && this.actionPath ? 'actions' : 'tree'
      this.focus = 'content'
      this.requestRender()
      return true
    }
    if (this.level === 'image') { this.level = this.actionPath ? 'actions' : 'tree'; this.img = null; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'read') { this.level = this.actionPath ? 'actions' : 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'actions') { this.actionPath = null; this.level = 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'confirmDel') { this.level = this.actionIsCwd ? 'tree' : 'actions'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'stats') { this.level = this.statsFrom === 'actions' && this.actionPath ? 'actions' : 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'pickAction') { this.pickTarget = null; this.level = 'pickDest'; this.requestRender(); return true }
    if (this.level === 'pickDest') {
      // First double-tap flips focus to the menu list so the verb ("Move/Copy
      // here") + Cancel/Reload/Main become tappable — without this they were
      // dead UI and there was NO way to deposit into a location ROOT (review
      // 2026-06-13). A second double-tap pops up a dir / out of the picker.
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      if (this.destStack.length > 1) { this.destStack.pop(); this.destOffset = 0 }
      else if (this.destStack.length === 1) { this.destStack = []; this.destOffset = 0 }
      else { const wasCwd = this.actionIsCwd; this.actionVerb = null; this.actionIsCwd = false; this.actionIsDir = false; this.level = wasCwd ? 'tree' : 'actions' }
      this.requestRender()
      return true
    }
    if (this.level === 'opResult') { this.level = 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'tree') {
      // First pop flips focus to the menu list (Up/Stats/Reload/Main reachable —
      // review 2026-06-11); `..` row 0 is the always-visible up-a-level.
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'locations'
      this.requestRender()
      return true
    }
    // locations (the window root): same Mail-style flip — content rows → the
    // menu list (Reload/Main reachable) → out to Main.
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }

  // ---- name-entry dictation hooks (Adam 2026-06-13: Rename + New folder) ----

  /** A transcript for the name-entry confirm step. Discarded unless we're
   *  actively transcribing (Cancel / a window pop cleared it) — the confirm
   *  step stays sacred (no silent name lands). */
  async onStt(text: string): Promise<void> {
    if (this.level !== 'name' || !this.transcribing) {
      this.ctx.log(`[os] files: STT arrived but not awaiting a name (level=${this.level}) — discarded: "${text.slice(0, 60)}"`)
      return
    }
    this.transcribing = false
    this.pendingName = text.trim()
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    this.listening = false
    this.transcribing = false
    this.ctx.log(`[os] files: STT error during name entry — ${error}`)
    this.pendingName = null
    // Stay on the name level so the user can Re-record (the menu offers it via
    // the no-state branch? no — drop to the source level loudly instead).
    const back = this.nameFrom
    this.actionIsCwd = false; this.actionIsDir = false
    this.nameVerb = null
    this.level = back === 'actions' && this.actionPath ? 'actions' : 'tree'
    this.requestRender()
  }

  /** Phase 12: open a search-hit FILE — navigate to its parent directory at the
   *  tree level so Adam can act on it (Copy/Move/Del/preview). The stack is
   *  built as the FULL chain from a matching location root down to the parent,
   *  so `..` ascends correctly (upOne pops the stack — a single-element stack
   *  would jump straight to locations). */
  async onOpen(open: WindowOpen): Promise<void> {
    if (open.kind !== 'file') { this.ctx.log(`[os] files: ignoring onOpen kind '${open.kind}'`); return }
    this.stopNameEntry('search open')
    this.navSeq++
    this.actionPath = null; this.actionIsCwd = false; this.actionIsDir = false
    const parent = dirname(open.path)
    if (!existsSync(parent)) {
      this.ctx.log(`[os] files: onOpen parent '${parent}' missing — landing at locations`)
      this.level = 'locations'; this.locOffset = 0; this.focus = 'content'; this.requestRender()
      return
    }
    this.refreshLocations()
    // longest matching location root (Home beats Root for /home/user/… paths)
    const root = this.locs
      .map((l) => l.path)
      .filter((lp) => parent === lp || parent.startsWith(lp.endsWith('/') ? lp : lp + '/'))
      .sort((a, b) => b.length - a.length)[0]
    if (!root) {
      this.ctx.log(`[os] files: onOpen '${parent}' under no known location — landing at locations`)
      this.level = 'locations'; this.locOffset = 0; this.focus = 'content'; this.requestRender()
      return
    }
    const rel = parent.slice(root.length).split('/').filter(Boolean)
    const stack = [root]
    let cur = root
    for (const seg of rel) { cur = join(cur, seg); stack.push(cur) }
    this.stack = stack
    this.offset = 0
    this.focus = 'content'
    this.level = 'tree'
    this.requestRender()
  }

  /** Mic must not outlive focus (the established dictation hygiene rule). */
  onDeactivate(): void {
    if (this.listening || this.transcribing || this.pendingName !== null) {
      this.stopNameEntry('window switch')
      this.actionIsCwd = false; this.actionIsDir = false
      this.level = 'tree'
    }
  }

  /** A notification overlay must not repaint over the sacred confirm step. */
  interruptible(): boolean {
    return !(this.listening || this.transcribing || this.pendingName !== null)
  }
}
