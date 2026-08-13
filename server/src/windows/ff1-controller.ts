// windows/ff1-controller.ts — the FF1-on-G2 sub-controller (games/ff1/PLAN.md
// §7; GamesWindow delegates while its level === 'ff1', exactly like 'pc'/'bj').
//
// Screen-adaptive root: the daemon's classifier verdict (battle / map / dialog
// / shop / gamemenu / title screens) picks the view + verbs. Battles are 100 %
// native text (§7.1): command entry walks OUR menus at text speed (the game
// hasn't moved), then one battle_round op drives the game's real menus with
// verified presses and returns the scraped log. Maps are a TEXT placeholder
// until Ph-D lands the two-tile image pipeline.
//
// Ring mapping (§8.1): menu list = the focus everywhere (scroll = nav, tap =
// select, double-tap = back); cursor mode (↑↓←→ A B) drives the game's own
// menus for unscripted screens. Undo is a STANDING VERB in every view (§8.4,
// Cancel-first confirm) — nothing an accidental tap can do is unrecoverable.
//
// The Three Rules: every failure path renders/logs LOUD (daemon death notice,
// desyncs, budget overruns come back as op errors and show in the view);
// battle logs paginate with full history (NO truncation); no timeouts (ops are
// frame-budgeted daemon-side; nothing here waits on a clock).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WmContext, WinView } from './types.js'
import { paginateText, fwTextWidth, wrapLinesPx } from '../os-compose.js'
import { encodeGray4Single } from '../os-content.js'
import { browsePageItems } from './_browse.js'
import { kbdModel, type KbdCell } from './_kbd.js'
import { ff1, type Ff1EngineConfig } from '../ff1/engine.js'
import { FF1_DIR } from '../ff1/bridge.js'
import type {
  Ff1Char, Ff1CharCommand, Ff1Checkpoint, Ff1Snapshot,
} from '../ff1/types.js'

/** Spell metadata (names + target types for the magic menus). Committed JSON
 *  generated from ROM tables with lineage (games/ff1/data/spells.json). */
interface SpellMeta { id: number; name: string; level: number; slot: number; target: string }
const SPELLS: SpellMeta[] = (() => {
  try {
    const raw = JSON.parse(readFileSync(join(FF1_DIR, 'data', 'spells.json'), 'utf8')) as { spells: SpellMeta[] }
    return raw.spells
  } catch (e) {
    // The window still opens (battle magic menus degrade loudly).
    console.error(`[ff1] spells.json load failed (magic menus degraded): ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
})()

type Ff1Level =
  | 'root'            // screen-adaptive (map/dialog/shop/menu/title/battle-entry)
  | 'battle-magic'    // spell pick for the current entry char
  | 'battle-drink'    // HEAL/PURE potion pick for the current entry char
  | 'battle-target'   // enemy/ally pick for the pending action
  | 'battle-confirm'  // Cancel-first Go over the collected round
  | 'battle-log'      // post-round paginated log
  | 'auto-confirm'    // Cancel-first fight-until (repeat last round) confirm
  | 'undo'            // checkpoint browse list
  | 'undo-confirm'    // Cancel-first restore confirm
  | 'sys'             // Save/Slots/Export/New system menu (Ph-E)
  | 'reset-confirm'   // Cancel-first NEW GAME (console reset)
  | 'slots'           // labeled-slot browse list
  | 'slot-confirm'    // Cancel-first slot load confirm
  | 'name-kbd'        // ring keyboard composing a 4-glyph name (§7.4)
  | 'minimap'         // trail minimap tile (sm maps)
  | 'formation'       // battle-start formation glance (config toggle)

const STEP_COUNTS = [1, 2, 3, 5, 8] as const

/** Battle-entry collection state (native menus — the game hasn't moved). */
interface EntryState {
  living: number[]                  // party slots, entry order
  idx: number                       // index into living
  commands: Ff1CharCommand[]
  /** A pending action awaiting its target pick (battle-target level). */
  pendingAction: {
    action: 'fight' | 'magic' | 'drink'
    level?: number; slot?: number; spell?: SpellMeta; potion?: number
  } | null
  /** battlecounter ($F7) at entry start — a DIFFERENT battle (new encounter
   *  while a stale entry lingered) rebuilds the collection from scratch. */
  battleKey: number
}

function col(s: string, maxPx = 222): string {
  if (fwTextWidth(s) <= maxPx) return s
  let out = ''
  for (const ch of s) { if (fwTextWidth(out + ch) > maxPx) break; out += ch }
  return out
}

/** One Slots row. The label already carries the screen ("ROUX · ow (153,170)
 *  · 80G"), so appending `screen` again just pushed the timestamp — the only
 *  thing that tells two slots apart — off the 40-byte row (2026-08-13). */
function slotRow(s: { label: string; screen: string; at: string }): string {
  return `${s.at.slice(5, 16).replace('T', ' ')} ${s.label}`
}

/** The scraper's unknown-tile marker (bridge/scrape.py :: UNKNOWN_CHAR). */
const UNKNOWN = '\u{FFFD}'

/** Make a raw screen scrape READABLE on 7 glass rows (2026-08-13 review).
 *  FF1 draws shopkeepers, window borders and class sprites as 8×8 tiles, and
 *  those land in the text grid as unknown glyphs: the Coneria weapon shop
 *  scraped 18 lines of which TEN were a solid diamond of `\u{FFFD}`, pushing
 *  Sell/Exit/gold off the bottom of the pane. So: drop lines that carry no
 *  real character, collapse each run of unknowns to a single `·` (the tile is
 *  still SHOWN — never silently dropped, the no-truncation rule), and trim
 *  blank edges. Nothing readable is removed; only sprite noise is compressed. */
export function cleanScrape(lines: string[]): string[] {
  const out = lines
    .filter((ln) => [...ln].some((ch) => ch !== ' ' && ch !== UNKNOWN))
    .map((ln) => ln.replace(new RegExp(`${UNKNOWN}+`, 'gu'), '·').replace(/\s+$/, ''))
  while (out.length && !out[0].trim()) out.shift()
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out
}

export class Ff1Controller {
  private level: Ff1Level = 'root'
  private entry: EntryState | null = null
  private stepIdx = 0
  private opBusy: string | null = null        // op label while one runs (LOUD ignore on overlap)
  private opError: string | null = null       // last op failure — rendered until the next op
  private roundPages: string[] = []
  private roundPage = 0
  private roundOutcome: string | null = null
  private undoList: Ff1Checkpoint[] = []
  private undoOffset = 0
  private pendingUndo: Ff1Checkpoint | null = null
  private returnLevel: Ff1Level = 'root'      // where Undo's Back returns to
  // --- Ph-D map tiles (PLAN §7.2): encoded bmps + raw-payload change keys.
  // Fetched ONLY at op completions (one push per completed macro — we own the
  // clock); a tile re-encodes/re-pushes only when its bytes changed.
  private mapTop: string | null = null
  private mapBottom: string | null = null
  private mapTopKey: string | null = null
  private mapBottomKey: string | null = null
  private mapFailed: string | null = null
  private mapFrameHash: string | null = null
  private mapSeq = 0
  // --- Ph-E state
  private lastCommands: Ff1CharCommand[] | null = null   // fight-until repeats these
  private lastCommandsKey = -1                            // battlecounter they belong to
  private slots: { id: string; label: string; screen: string; at: string }[] = []
  private slotsOffset = 0
  private pendingSlot: { id: string; label: string } | null = null
  private kbdBuf = ''
  private kbdGroup: string | null = null
  private kbdShift = true                                 // names lead uppercase
  private kbdCells: KbdCell[] = []
  private miniTile: string | null = null
  private formationTileBmp: string | null = null
  private formationKey = -1                               // battlecounter it was rendered for
  /** Battle picker rows as last RENDERED + their slot map — picks resolve by
   *  browse INDEX against these (Ph-F review: label matching wrapped/collided). */
  private pickRows: string[] = []
  private pickTargets: number[] = []
  // --- scraped-screen paging (shops, the game's own menus, dialog boxes).
  // Those screens are up to 21 lines and the pane shows ~7, with no scroll —
  // Sell/Exit and three of four equip rows were simply unreachable before.
  private scrapePage = 0
  private scrapeKey = ''
  /** Commands of a round that is IN FLIGHT (entry is cleared at fire time, so
   *  the confirm card used to blank for the ~1 s the op runs). */
  private runningCmds: Ff1CharCommand[] | null = null
  /** Pending 'New Game' confirm (Sys → New → Cancel-first). */
  private pendingReset = false
  /** frameHashes whose unknown-tile report has already been logged — the LOUD
   *  scrape-miss channel was declared in the wire types and read by nobody. */
  private unknownSeen = new Set<string>()

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  private cfg(): Ff1EngineConfig {
    const g = this.ctx.config.games?.ff1
    // undoDepth clamps to ≥1 (review find: 0 passed `?? 30` straight through
    // and silently disabled the whole §8.4 undo net; the daemon also refuses)
    return { rngJitter: g?.rngJitter ?? true, undoDepth: Math.max(1, g?.undoDepth ?? 30) }
  }
  private showEnemyHp(): boolean { return this.ctx.config.games?.ff1?.showEnemyHp ?? false }
  private showFormationTile(): boolean { return this.ctx.config.games?.ff1?.formationTile ?? false }

  // ------------------------------------------------ lifecycle (from GamesWindow)

  enter(): void {
    this.level = 'root'
    this.entry = null
    this.opError = null
    // Idle daemon deaths repaint immediately (Ph-F review find: with no
    // inflight op nothing re-rendered — the glass froze on a stale frame).
    ff1.onStatusChange = () => this.requestRender()
    void ff1.ensureStarted(this.cfg()).then(async () => {
      await ff1.state()   // fresh classify for the root view
      this.syncMapTiles()
      this.requestRender()
    }).catch((e: unknown) => {
      this.ctx.log(`[os] ff1: engine start failed: ${e instanceof Error ? e.message : String(e)}`)
      this.requestRender()
    })
    this.requestRender()   // paint "starting…" immediately
  }

  onDeactivate(): void { void ff1.flush() }
  leave(): void { void ff1.flush() }
  dispose(): void { void ff1.flush() }

  summary(): string {
    const st = ff1.status()
    if (!st.running) return 'ff1 · idle'
    const snap = ff1.cachedSnapshot()
    return `ff1 · ${snap?.screen ?? '?'}`
  }

  statusLine(): string | null {
    const st = ff1.status()
    // the engine's notice text is the honest one ('died — respawns on the
    // next action'); the old hard-coded 'respawned' claimed a recovery that
    // hadn't happened (Ph-F pass-3 find)
    if (st.daemonNotice) return `⚠ ${st.daemonNotice}`.slice(0, 46)
    if (st.loadError) return `⚠ ${st.loadError}`.slice(0, 46)
    if (st.saveError) return '⚠ unsaved'
    // op failures ride the status bar too (Ph-F review find: the maptiles
    // view has no text region, so a pace/steps failure was invisible there;
    // the full text still renders in the map view's error fallback).
    if (this.opError) return `⚠ ${this.opError}`.slice(0, 46)
    if (this.opBusy) return `ff1 · ${this.opBusy}…`
    // Walking a map shows IMAGE tiles, which have no text region — so party HP
    // was invisible for the entire exploration half of the game (2026-08-13
    // review). The status bar is the one text channel a maptiles frame still
    // has: compact HP in party order + gold, no names (they are on the ribbon
    // preview and every menu).
    const snap = this.snap()
    if (snap && (snap.screen === 'ow' || snap.screen === 'sm') && !this.opBusy) {
      const hp = snap.state.party
        .map((c) => (c.alive ? `${c.hp}/${c.maxhp}` : '✝')).join(' ')
      return `${hp} · ${snap.state.gold}G`
    }
    return null
  }

  /** Ribbon preview (READ-ONLY): the cached snapshot only — party HP, gold,
   *  position, screen. NO daemon op, NO state mutation. */
  preview(): string | null {
    const st = ff1.status()
    if (!st.running) return st.loadError ? `FF1\n⚠ ${st.loadError.slice(0, 38)}` : null
    const snap = ff1.cachedSnapshot()
    if (!snap) return 'FF1 · booting'
    const lines = [`FF1 · ${snap.screen}`]
    for (const c of snap.state.party) {
      lines.push(col(`${c.alive ? '' : '✝'}${c.name} L${c.level} ${c.hp}/${c.maxhp}`, 200))
    }
    lines.push(`${snap.state.gold} G · (${snap.state.pos.x},${snap.state.pos.y})`)
    return lines.join('\n')
  }

  // ------------------------------------------------ op plumbing

  /** Run one engine op with the busy-guard + LOUD error surfacing. Every
   *  completion is a MACRO BOUNDARY: if the game is on a map screen, the two
   *  map tiles refresh exactly once here (§7.2 push policy — never mid-op,
   *  never on a timer; interrupts win because a battle/dialog screen simply
   *  isn't a map, so no fetch happens). `onFail` runs after the error is
   *  recorded (level recovery for confirm flows). */
  private runOp(label: string, fn: () => Promise<unknown>, after?: (r: unknown) => void,
    onFail?: () => void): void {
    if (this.opBusy) { this.ctx.log(`[os] ff1: '${label}' while '${this.opBusy}' runs — ignored (LOUD)`); return }
    this.opBusy = label
    this.opError = null
    this.requestRender()
    void fn().then((r) => {
      this.opBusy = null
      if (after) after(r)
      this.syncMapTiles()
      this.requestRender()
    }).catch((e: unknown) => {
      this.opBusy = null
      this.opError = e instanceof Error ? e.message : String(e)
      this.ctx.log(`[os] ff1: ${label} FAILED: ${this.opError}`)
      if (onFail) onFail()
      this.requestRender()
    })
  }

  /** Fetch both map crops and re-encode ONLY the changed one(s). No-op off
   *  map screens. `force` (Peek) drops the change keys first. Seq-guarded so
   *  a superseded fetch can't paint stale tiles. */
  private syncMapTiles(force = false): void {
    const snap = this.snap()
    if (!snap || (snap.screen !== 'ow' && snap.screen !== 'sm')) return
    if (force) { this.mapTopKey = null; this.mapBottomKey = null; this.mapFrameHash = null }
    // frameHash gate (Ph-F pass-2 efficiency find): identical frame ⇒ both
    // crops are identical — skip the two fetches entirely.
    if (!force && snap.frameHash && snap.frameHash === this.mapFrameHash && this.mapTop && this.mapBottom) return
    const seq = ++this.mapSeq
    void (async () => {
      const [top, bottom] = await Promise.all([ff1.frameGray4('map-top'), ff1.frameGray4('map-bottom')])
      if (seq !== this.mapSeq) return
      let changed = false
      if (top.gray4 !== this.mapTopKey) {
        this.mapTop = encodeGray4Single(Buffer.from(top.gray4, 'base64'), 'ff1 map-top').bmpBase64
        this.mapTopKey = top.gray4
        changed = true
      }
      if (bottom.gray4 !== this.mapBottomKey) {
        this.mapBottom = encodeGray4Single(Buffer.from(bottom.gray4, 'base64'), 'ff1 map-bottom').bmpBase64
        this.mapBottomKey = bottom.gray4
        changed = true
      }
      this.mapFailed = null
      this.mapFrameHash = snap.frameHash ?? null
      if (changed) this.requestRender()
    })().catch((e: unknown) => {
      if (seq !== this.mapSeq) return
      this.mapFailed = e instanceof Error ? e.message : String(e)
      this.ctx.log(`[os] ff1: map tile fetch FAILED: ${this.mapFailed}`)
      this.requestRender()
    })
  }

  private press(buttons: string[], label: string): void {
    this.runOp(label, () => ff1.press(buttons, label))
  }

  // ------------------------------------------------ battle entry helpers

  private snap(): Ff1Snapshot | null { return ff1.cachedSnapshot() }

  private beginEntry(snap: Ff1Snapshot): void {
    // canInput (daemon-computed: not DEAD|STONE|STUN|SLEEP) — the game skips
    // those chars' menus, so collecting a command for them desyncs entry
    // (Ph-F pass-3 find). Absent field (older snapshot) falls back to alive.
    const living = snap.state.party
      .filter((c) => (c.canInput ?? c.alive))
      .map((c) => c.slot)
    this.entry = { living, idx: 0, commands: [], pendingAction: null, battleKey: snap.state.battlecounter }
    this.level = 'root'
  }

  private entryChar(snap: Ff1Snapshot): Ff1Char | null {
    if (!this.entry) return null
    const slot = this.entry.living[this.entry.idx]
    return snap.state.party.find((c) => c.slot === slot) ?? null
  }

  private aliveEnemies(snap: Ff1Snapshot): { slot: number; name: string; hp: number }[] {
    return (snap.state.battle?.enemies ?? []).filter((e) => e.alive)
  }

  /** Formation label: names ×count (e.g. "IMP ×5"). */
  private formation(snap: Ff1Snapshot): string {
    const counts = new Map<string, number>()
    for (const e of this.aliveEnemies(snap)) counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
    return [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ') || '(none)'
  }

  /** A char's known spells at ALL EIGHT levels. L5-8 sit on the magic box's
   *  second page, which bank_0C.asm :: MenuSelection_Magic flips ITSELF when
   *  Down is pressed on row 3 — so the executor's one-Down-per-level walk
   *  reaches them unchanged (2026-08-13: the old 1-4 cap was a missing-fixture
   *  guard, and it made every late-game spell — CUR4, LIF2, NUKE, FADE, WALL —
   *  uncastable). */
  private knownSpells(c: Ff1Char): { meta: SpellMeta; charges: number; level: number; slotIdx: number }[] {
    const out: { meta: SpellMeta; charges: number; level: number; slotIdx: number }[] = []
    for (let lv = 1; lv <= 8; lv++) {
      const slots = c.spells[lv - 1] ?? []
      slots.forEach((v, slotIdx) => {
        if (v === 0) return
        const id = (lv - 1) * 8 + (v - 1)
        const meta = SPELLS[id]
        if (!meta) { this.ctx.log(`[os] ff1: no spell meta for id ${id} (L${lv} v${v}) — row skipped LOUDLY`); return }
        out.push({ meta, charges: c.mp[lv - 1] ?? 0, level: lv, slotIdx })
      })
    }
    return out
  }

  /** Commit the pending command and advance to the next living char (or the
   *  Go confirm once everyone has one). */
  private commitCommand(cmd: Ff1CharCommand): void {
    const e = this.entry
    if (!e) { this.ctx.log('[os] ff1: commitCommand with no entry state — ignored (LOUD)'); return }
    e.commands.push(cmd)
    e.pendingAction = null
    e.idx++
    this.level = e.idx >= e.living.length ? 'battle-confirm' : 'root'
    this.requestRender()
  }

  private fireRound(): void {
    const e = this.entry
    if (!e || e.commands.length === 0) { this.ctx.log('[os] ff1: Go with no commands — ignored (LOUD)'); return }
    // Busy pre-guard BEFORE any mutation (Ph-F review find: clearing entry
    // first meant a Go during a busy op silently discarded the whole round).
    if (this.opBusy) { this.ctx.log(`[os] ff1: Go while '${this.opBusy}' runs — kept the collected round, tap again (LOUD)`); return }
    const cmds = e.commands
    this.lastCommands = cmds            // fight-until repeats these (§8.2)
    this.lastCommandsKey = e.battleKey
    this.entry = null
    this.runningCmds = cmds             // keeps the confirm card honest while it runs
    this.level = 'battle-confirm'
    this.runOp('battle round', () => ff1.battleRound(cmds), (r) => {
      this.runningCmds = null
      const resp = r as Ff1Snapshot & { battleRound?: { log: string[]; outcome: string } }
      const br = resp.battleRound
      if (!br) { this.opError = 'battle_round returned no round data'; this.level = 'root'; return }
      this.roundOutcome = br.outcome
      const body = br.log.length ? br.log.join('\n') : '(no combat messages scraped)'
      this.roundPages = paginateText(`Outcome: ${br.outcome}\n\n${body}`)
      this.roundPage = 0
      this.level = 'battle-log'
    }, () => {
      // battle_round FAILED (desync raised). The daemon REWINDS to its
      // pre-round savestate before the error reaches us (ff1_daemon
      // battle_guard), so the battle is intact and the next tap is a clean
      // retry; Undo still reaches the same point deliberately. Leaving level
      // at 'battle-confirm' with a null entry was a dead end (review find) —
      // the root view rebuilds entry and shows the error.
      this.runningCmds = null
      this.level = 'root'
    })
  }

  /** Fight-until (§8.2): repeat the last round's commands until battle end /
   *  any ally under 25 % HP / charges out / the round cap. */
  private fireAuto(): void {
    const cmds = this.lastCommands
    if (!cmds) { this.ctx.log('[os] ff1: Auto with no last round — ignored (LOUD)'); return }
    if (this.opBusy) { this.ctx.log(`[os] ff1: Auto while '${this.opBusy}' runs — ignored (LOUD)`); return }
    this.runOp('fight-until', () => ff1.battleAuto(cmds, { minHpPct: 25, maxRounds: 30 }), (r) => {
      const resp = r as Ff1Snapshot & { battleAuto?: { rounds: number; outcome: string; stopped: string; log: string[] } }
      const ba = resp.battleAuto
      if (!ba) { this.opError = 'battle_auto returned no data'; this.level = 'root'; return }
      this.roundOutcome = ba.outcome
      const body = ba.log.length ? ba.log.join('\n') : '(no combat messages scraped)'
      this.roundPages = paginateText(
        `Outcome: ${ba.outcome} after ${ba.rounds} round(s)\nStopped: ${ba.stopped}\n\n${body}`)
      this.roundPage = 0
      this.level = 'battle-log'
    })
  }

  // ------------------------------------------------ views

  async view(): Promise<WinView> {
    const st = ff1.status()
    if (!st.running) {
      // Three honest sub-states (pass-3 find: the spinner used to show for an
      // idle daemon DEATH, promising progress that wasn't happening):
      const body = st.loadError
        ? `Failed to start:\n${st.loadError}\n\nReload to retry.`
        : st.daemonNotice
          ? `⚠ ${st.daemonNotice}\n\nReload (or any action) respawns the daemon\nand restores the last savestate.`
          : '⏳ starting FF1 (cynes daemon)…'
      return { mode: 'text', title: 'FF1', menu: ['Reload', 'Main'], text: body }
    }
    const snap = this.snap()
    if (!snap) return { mode: 'text', title: 'FF1', menu: ['Reload', 'Main'], text: '⏳ first snapshot…' }
    const err = this.opError ? `⚠ ${this.opError}\n\n` : ''
    const busy = this.opBusy ? ` · ${this.opBusy}…` : ''

    if (this.level === 'undo') return this.undoView()
    if (this.level === 'undo-confirm') return this.undoConfirmView()
    if (this.level === 'sys') return this.sysView(snap, err)
    if (this.level === 'reset-confirm') return this.resetConfirmView()
    if (this.level === 'slots') return this.slotsView()
    if (this.level === 'slot-confirm') return this.slotConfirmView()
    if (this.level === 'name-kbd') return this.kbdView()
    if (this.level === 'minimap') return this.minimapView(snap, err)
    if (this.level === 'battle-log') {
      const suffix = this.roundPages.length > 1 ? ` · ${this.roundPage + 1}/${this.roundPages.length}` : ''
      // the pager view is reused for the .sav receipt — don't call that a round
      const head = this.roundOutcome === 'export' ? 'FF1 · .sav exported' : `FF1 · round — ${this.roundOutcome ?? '?'}`
      return {
        mode: 'text',
        title: `${head}${suffix}`,
        menu: ['Continue', 'Next', 'Prev', 'Undo', 'Main'],
        text: this.roundPages[this.roundPage] ?? '',
      }
    }
    if (snap.screen === 'battle' && snap.state.battle) {
      // Party wiped (btl_result 1: the game-over screen halts with $81 still
      // in-battle — Ph-F pass-2 find: entry with living=[] rendered a
      // nonsense '1/0' view with every verb dead): the §8.4 net IS the way
      // out, say so plainly.
      // Keyed on "nobody is up" ALONE (2026-08-13): btl_result is stale
      // during command entry (it holds the PREVIOUS battle's outcome until
      // DoBattleRound zeroes it — bridge/battle.py), so a `result === 1` term
      // could declare a game over over a perfectly healthy party.
      if (!snap.state.party.some((c) => c.alive)) {
        return {
          mode: 'text',
          title: 'FF1 · the party has fallen',
          menu: ['Undo', 'Main'],
          text: `${err}Game over — everyone is down.\n\nUndo rewinds to a checkpoint (the battle start\nis always one) and the fight can go differently:\nRNG honesty re-rolls every retry.`,
        }
      }
      if (this.level === 'formation') return this.formationView(snap, err)
      // battle-start glance (config toggle, default OFF): once per encounter
      if (this.showFormationTile() && this.formationKey !== snap.state.battlecounter) {
        this.formationKey = snap.state.battlecounter
        this.formationTileBmp = null
        this.level = 'formation'
        this.syncFormationTile()
        return this.formationView(snap, err)
      }
      if (this.level === 'battle-magic') return this.magicView(snap, err)
      if (this.level === 'battle-drink') return this.drinkView(snap, err)
      if (this.level === 'battle-target') return this.targetView(snap, err)
      if (this.level === 'battle-confirm') return this.goConfirmView(snap, err)
      if (this.level === 'auto-confirm') return this.autoConfirmView(snap, err)
      return this.entryView(snap, err, busy)
    }
    return this.screenView(snap, err, busy)
  }

  /** LOUD scrape-miss channel (Ff1Snapshot.unknownTiles): one compact line per
   *  distinct frame, so a font/format drift is visible in the log instead of
   *  only as `·` on glass. Rate-limited by frameHash — a static screen is
   *  reported once, not once per render. */
  private reportUnknownTiles(snap: Ff1Snapshot): void {
    const unknown = snap.unknownTiles
    if (!Array.isArray(unknown) || unknown.length === 0) return
    const key = snap.frameHash ?? ''
    if (this.unknownSeen.has(key)) return
    if (this.unknownSeen.size > 200) this.unknownSeen.clear()
    this.unknownSeen.add(key)
    const pats = [...new Set(unknown.map((u) => (u as { pattern?: string }).pattern ?? '?'))]
    this.ctx.log(`[os] ff1 scrape: ${unknown.length} unknown tile(s) on '${snap.screen}' `
      + `(${pats.length} distinct, e.g. ${pats.slice(0, 3).join(' ')}) — shown as '·' (LOUD)`)
  }

  /** One page of a cleaned screen scrape + whether paging verbs are needed.
   *  The page resets whenever the screen's TEXT changes, so moving the game's
   *  own cursor never leaves you stranded on a page that no longer exists. */
  private scrapePages(snap: Ff1Snapshot, err: string, tail: string): string[] {
    this.reportUnknownTiles(snap)
    const body = cleanScrape(snap.text ?? [])
    const text = `${err}${body.join('\n') || '(no scraped text)'}${tail}`
    if (text !== this.scrapeKey) { this.scrapeKey = text; this.scrapePage = 0 }
    const pages = paginateText(text)
    if (this.scrapePage >= pages.length) this.scrapePage = Math.max(0, pages.length - 1)
    return pages
  }

  /** The game's OWN screens (shop / menus / dialog): cleaned, paginated, and
   *  always with the full cursor verb set. Dialog boxes ignore the arrows
   *  harmlessly; the equip and item screens NEED them (2026-08-13: they landed
   *  in the A/B-only dialog view, so nothing below party slot 1 could be
   *  reached and equipping was impossible). */
  private scrapedView(snap: Ff1Snapshot, err: string, busy: string,
    label: string, extra: string[], tail: string): WinView {
    const pages = this.scrapePages(snap, err, tail)
    const paging = pages.length > 1 ? ['Next', 'Prev'] : []
    const suffix = pages.length > 1 ? ` · ${this.scrapePage + 1}/${pages.length}` : ''
    return {
      mode: 'text',
      title: `FF1 · ${label}${suffix}${busy}`,
      menu: [...extra, '↑', '↓', '←', '→', 'A', 'B', ...paging, 'Undo', 'Main'],
      text: pages[this.scrapePage] ?? '',
    }
  }

  /** The screen-adaptive non-battle root. */
  private screenView(snap: Ff1Snapshot, err: string, busy: string): WinView {
    const s = snap.state
    const partyLine = s.party.filter((c) => c.alive).map((c) => `${c.name} ${c.hp}/${c.maxhp}`).join(' · ')
    switch (snap.screen) {
      case 'ow':
      case 'sm': {
        const where = snap.screen === 'ow' ? 'Overworld' : `Map ${s.pos.mapId}`
        const title = `FF1 · ${where} (${s.pos.x},${s.pos.y}) ×${STEP_COUNTS[this.stepIdx]}${busy}`
        const menu = ['↑', '↓', '←', '→', '×N', 'A', 'B', 'Battle', 'Menu', 'Peek',
          ...(snap.screen === 'sm' ? ['Mini'] : []), 'Sys', 'Undo', 'Main']
        // An op failure DROPS to the text fallback even when tiles exist —
        // maptiles mode has no text region, so this is where the full error
        // renders (Ph-F review find; statusLine carries the short form).
        if (!this.mapTop || !this.mapBottom || this.opError || this.mapFailed) {
          const why = this.mapFailed
            ? `map tiles FAILED: ${this.mapFailed}\nPeek retries.`
            : (this.mapTop && this.mapBottom ? '' : '⏳ map tiles rendering…')
          return {
            mode: 'text', title, menu,
            text: `${err}${why}\n\n${partyLine}\n${s.gold} G · ${s.pos.vehicle} · facing ${s.pos.facing}`,
          }
        }
        return { mode: 'maptiles', title, menu, topTile: this.mapTop, bottomTile: this.mapBottom }
      }
      case 'dialog':
        return this.scrapedView(snap, err, busy, 'dialog', [], '\n\nA advances · B closes')
      case 'shop':
      case 'gamemenu':
      case 'mainmenu':
      case 'partyselect':
      case 'nameentry': {
        const labels: Record<string, string> = {
          shop: 'shop', gamemenu: 'menu', mainmenu: 'title menu',
          partyselect: 'party select', nameentry: 'name entry',
        }
        // The naming grid gets the ring-driven macro (§7.4): Name opens the
        // tap keyboard, the macro drives the 6-press protocol. Cursor mode
        // stays available for manual play. gamemenu gets Sys (save/export).
        const extra = snap.screen === 'nameentry' ? ['Name']
          : snap.screen === 'gamemenu' ? ['Sys'] : []
        return this.scrapedView(snap, err, busy, labels[snap.screen], extra,
          '\n\ncursor mode: arrows move, A confirms, B backs')
      }
      case 'title':
        // the pre-game attract/prologue family (classifier: no live party) —
        // Start drives it forward; full cursor mode for the menus beyond
        return this.scrapedView(snap, err, busy, 'title', ['Start'],
          '\n\nStart advances · then cursor mode takes over')
      case 'transition':
        return {
          mode: 'text', title: `FF1 · …${busy}`, menu: ['A', 'B', 'Reload', 'Undo', 'Main'],
          text: `${err}Screen in transition — Reload re-reads.`,
        }
      default:
        return {
          mode: 'text', title: `FF1 · ${snap.screen}${busy}`, menu: ['A', 'B', 'Reload', 'Undo', 'Main'],
          text: `${err}Unrecognized screen (${snap.screen}).\n${partyLine}\n\nA/B to nudge · Undo to rewind · Reload re-reads.`,
        }
    }
  }

  /** Battle command entry (§7.1): our menus, per living char. */
  private entryView(snap: Ff1Snapshot, err: string, busy: string): WinView {
    const b = snap.state.battle!
    if (!this.entry || this.entry.battleKey !== snap.state.battlecounter) this.beginEntry(snap)
    const e = this.entry!
    const ch = this.entryChar(snap)
    // The twocol columns clamp PER LINE (os-compose clampCol), so a long
    // error was cut mid-sentence with an ellipsis and its tail existed only
    // in the server log. Wrap it to the column width first (2026-08-13).
    const errLines = err ? wrapLinesPx(err.trim(), 262).concat('') : []
    const left: string[] = [...errLines, col(this.formation(snap))]
    if (this.showEnemyHp()) {
      for (const en of this.aliveEnemies(snap)) left.push(col(`${en.name} s${en.slot} ${en.hp}hp`))
    }
    left.push('')
    for (const c of e.commands) left.push(col(`✓ ${this.describeCommand(snap, c)}`))
    if (b.noRun) left.push('⚠ NO RUN formation')
    const right = snap.state.party.map((c) => {
      const mark = c.slot === e.living[e.idx] ? '>' : c.alive ? ' ' : '✝'
      const chg = c.maxmp.some((m) => m > 0) ? ` c${c.mp.slice(0, 4).join('/')}` : ''
      return col(`${mark}${c.name} ${c.hp}/${c.maxhp}${chg}`)
    })
    const auto = this.lastCommands && this.lastCommandsKey === snap.state.battlecounter ? ['Auto'] : []
    return {
      mode: 'twocol',
      title: `FF1 · ${ch?.name ?? '?'} (${e.idx + 1}/${e.living.length})${busy}`,
      menu: ['Fight', 'Magic', 'Drink', 'Item', 'Run', 'RunAll', ...auto, 'Undo', 'Main'],
      textLeft: left.join('\n'),
      textRight: right.join('\n'),
    }
  }

  private describeCommand(snap: Ff1Snapshot, c: Ff1CharCommand): string {
    const name = snap.state.party.find((p) => p.slot === c.char)?.name ?? `#${c.char}`
    if (c.action === 'fight') {
      const en = snap.state.battle?.enemies.find((x) => x.slot === c.target)
      return `${name}: FIGHT ${en?.name ?? '?'} s${c.target}`
    }
    if (c.action === 'drink') {
      const who = snap.state.party.find((p) => p.slot === c.target)?.name ?? `#${c.target}`
      return `${name}: ${c.potion === 1 ? 'PURE' : 'HEAL'} → ${who}`
    }
    if (c.action === 'magic') {
      const spellName = this.spellNameFor(snap, c) ?? `L${c.level} s${c.slot}`
      let tgt = ''
      if (c.target !== undefined) {
        const tname = this.spellTargetIsEnemy(snap, c)
          ? snap.state.battle?.enemies.find((x) => x.slot === c.target)?.name
          : snap.state.party.find((p) => p.slot === c.target)?.name
        tgt = ` → ${tname ?? `#${c.target}`}`
      }
      return `${name}: ${spellName}${tgt}`
    }
    return `${name}: RUN`
  }

  private spellNameFor(snap: Ff1Snapshot, c: Ff1CharCommand): string | null {
    const ch = snap.state.party.find((p) => p.slot === c.char)
    if (!ch || c.level === undefined || c.slot === undefined) return null
    const v = ch.spells[c.level - 1]?.[c.slot] ?? 0
    if (v === 0) return null
    return SPELLS[(c.level - 1) * 8 + (v - 1)]?.name ?? null
  }

  private spellTargetIsEnemy(snap: Ff1Snapshot, c: Ff1CharCommand): boolean {
    const ch = snap.state.party.find((p) => p.slot === c.char)
    if (!ch || c.level === undefined || c.slot === undefined) return false
    const v = ch.spells[c.level - 1]?.[c.slot] ?? 0
    if (v === 0) return false
    return SPELLS[(c.level - 1) * 8 + (v - 1)]?.target === 'one-enemy'
  }

  /** Spell pick (charges live from RAM — §7.1 "L3 FIR2 ×2/3"). BROWSE mode
   *  (Ph-F review find: as MENU rows, 'L1 CURE 2/2' measures 111 px against
   *  the 90 px menu cap and wraps on glass, breaking tap→row mapping — the
   *  full-width browse pane holds them; picks resolve by INDEX). */
  private magicView(snap: Ff1Snapshot, err: string): WinView {
    const ch = this.entryChar(snap)
    if (!ch) return this.entryView(snap, err, '')
    this.pickRows = this.knownSpells(ch).map((s2) =>
      `L${s2.level} ${s2.meta.name} ${s2.charges}/${ch.maxmp[s2.level - 1] ?? 0}`)
    return {
      mode: 'browse',
      menuMode: 'passive',
      title: `FF1 · ${ch.name} magic${err ? ' · ⚠' : ''}`,
      menu: ['Back', 'Main'],
      items: this.pickRows.length ? [...this.pickRows] : ['(no castable spells)'],
    }
  }

  /** DRINK potion pick (HEAL / PURE, live counts from RAM). Rows the game
   *  cannot use (0 left) are shown but refused on tap, exactly like a spell
   *  with no charges — the game's own menu would open a "Nothing" box and
   *  CANCEL the whole action, which strands entry. */
  private drinkView(snap: Ff1Snapshot, err: string): WinView {
    const ch = this.entryChar(snap)
    const p = snap.state.potions ?? { heal: 0, pure: 0 }
    this.pickRows = [`HEAL ×${p.heal}`, `PURE ×${p.pure}`]
    return {
      mode: 'browse',
      menuMode: 'passive',
      title: `FF1 · ${ch?.name ?? '?'} drink${err ? ' · ⚠' : ''}`,
      menu: ['Back', 'Main'],
      items: [...this.pickRows],
    }
  }

  /** Target pick for the pending fight/magic action. BROWSE mode + index
   *  resolution (same review find; also disambiguates twin party members —
   *  label-matching sent every heal to the first of two identical names). */
  private targetView(snap: Ff1Snapshot, err: string): WinView {
    const e = this.entry
    const ch = this.entryChar(snap)
    const pa = e?.pendingAction
    if (!e || !ch || !pa) return this.entryView(snap, err, '')
    const targetsEnemies = pa.action === 'fight'
      || (pa.action === 'magic' && pa.spell?.target === 'one-enemy')
    if (targetsEnemies) {
      this.pickTargets = this.aliveEnemies(snap).map((en) => en.slot)
      this.pickRows = this.aliveEnemies(snap).map((en) =>
        `${en.name} s${en.slot}${this.showEnemyHp() ? ` ${en.hp}hp` : ''}`)
    } else {
      this.pickTargets = snap.state.party.map((c) => c.slot)
      this.pickRows = snap.state.party.map((c) =>
        `${c.slot}: ${c.alive ? '' : '✝'}${c.name} ${c.hp}/${c.maxhp}`)
    }
    const what = pa.action === 'fight' ? 'FIGHT'
      : pa.action === 'drink' ? (pa.potion === 1 ? 'PURE' : 'HEAL')
        : pa.spell?.name ?? 'spell'
    return {
      mode: 'browse',
      menuMode: 'passive',
      title: `FF1 · ${ch.name} ${what} → target${err ? ' · ⚠' : ''}`,
      menu: ['Back', 'Main'],
      items: [...this.pickRows],
    }
  }

  /** Cancel-first fight-until confirm (§8.2 — repeats the LAST round).
   *  Command lines UN-clamped (Ph-F review: col() silently cut approval
   *  text; the text region wraps long lines instead). */
  private autoConfirmView(snap: Ff1Snapshot, err: string): WinView {
    const lines = (this.lastCommands ?? []).map((c) => this.describeCommand(snap, c))
    return {
      mode: 'text',
      title: 'FF1 · fight until…',
      menu: ['Cancel', 'Go', 'Undo', 'Main'],
      text: `${err}Repeats the last round each round:\n${lines.join('\n')}\n\n`
        + 'Stops: battle end · any ally < 25% HP ·\ncharges out · 30-round cap.\n'
        + 'Fight targets re-pick the weakest LIVING enemy\nat entry (the picker only offers living slots).',
    }
  }

  /** Cancel-first Go (the last pick FIRES the round — §8.4 insurance).
   *  Command lines UN-clamped (review: never truncate approval text).
   *  While the round is IN FLIGHT the same card shows the commands that are
   *  running, with no Go: firing cleared `entry` first, so the glass showed an
   *  empty confirm card with a live Go button for the ~1 s of the op. */
  private goConfirmView(snap: Ff1Snapshot, err: string): WinView {
    const running = this.runningCmds
    const cmds = running ?? this.entry?.commands ?? []
    const lines = cmds.map((c) => this.describeCommand(snap, c))
    if (running) {
      return {
        mode: 'text',
        title: 'FF1 · round running…',
        menu: ['Undo', 'Main'],
        text: `${err}${lines.join('\n')}\n\n⏳ driving the real battle menus…`,
      }
    }
    return {
      mode: 'text',
      title: 'FF1 · round ready',
      menu: ['Cancel', 'Go', 'Undo', 'Main'],
      text: `${err}${lines.join('\n')}\n\nGo runs the round through the real battle menus.\nCancel re-picks from the first character.`,
    }
  }

  /** Formation glance tile fetch (once per encounter, seq-free: keyed by
   *  battlecounter so a stale fetch of a PAST battle just never lands). */
  private syncFormationTile(): void {
    const key = this.formationKey
    void ff1.frameGray4('formation').then((r) => {
      if (this.formationKey !== key) return
      this.formationTileBmp = encodeGray4Single(Buffer.from(r.gray4, 'base64'), 'ff1 formation').bmpBase64
      this.requestRender()
    }).catch((e: unknown) => {
      if (this.formationKey !== key) return
      this.ctx.log(`[os] ff1: formation tile FAILED (entry continues without it): ${e instanceof Error ? e.message : String(e)}`)
      // only fall through to entry if the user is still ON the glance —
      // never yank them out of Undo/anywhere else (Ph-F review find)
      if (this.level === 'formation') this.level = 'root'
      this.requestRender()
    })
  }

  private formationView(snap: Ff1Snapshot, err: string): WinView {
    const title = `FF1 · ${this.formation(snap)}`
    if (!this.formationTileBmp) {
      return { mode: 'text', title, menu: ['Enter', 'Undo', 'Main'], text: `${err}⏳ formation rendering…` }
    }
    return { mode: 'tile', title, menu: ['Enter', 'Undo', 'Main'], tile: this.formationTileBmp }
  }

  /** Trail minimap (PLAN §7 v1 = breadcrumbs): a 200×100 gray4 tile, 2 px per
   *  map tile, windowed ±50/±25 around the player. Explored trail = gray-6,
   *  player = white. Advisory (session-lifetime daemon trail). */
  private renderMinimap(data: { player: [number, number]; tiles: [number, number][] }): string {
    // 3 px per map tile (2026-08-13): at 2 px on a dim gray4 panel a walked
    // street was a scatter of near-invisible specks. 68×34 tiles still spans a
    // whole 64-wide standard map horizontally, and the trail is gray-9 against
    // black with a white player block.
    const SCALE = 3
    const W = 204, H = 102
    const px = new Uint8Array(W * H)
    const [pxx, pyy] = data.player
    const x0 = pxx - Math.floor(W / SCALE / 2), y0 = pyy - Math.floor(H / SCALE / 2)
    const plot = (tx: number, ty: number, v: number): void => {
      const gx = (tx - x0) * SCALE, gy = (ty - y0) * SCALE
      if (gx < 0 || gy < 0 || gx > W - SCALE || gy > H - SCALE) return
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) px[(gy + dy) * W + gx + dx] = v
      }
    }
    for (const [tx, ty] of data.tiles) plot(tx, ty, 9)
    plot(pxx, pyy, 15)
    const buf = Buffer.alloc(4 + W * H)
    buf.writeUInt16LE(W, 0)
    buf.writeUInt16LE(H, 2)
    Buffer.from(px).copy(buf, 4)
    return encodeGray4Single(buf, 'ff1 minimap').bmpBase64
  }

  /** Minimap verbs (2026-08-13): 'Refresh' + 'Back' are OURS. The old menu was
   *  ['Reload','Undo','Main'] — fullBleed strips Reload AND Main, so the glass
   *  showed a single 'Undo' cell: the documented "Reload to grow the trail"
   *  was gone and there was no way back to the map short of leaving FF1. */
  private static readonly MINIMAP_MENU = ['Refresh', 'Back', 'Undo', 'Main']

  private minimapView(snap: Ff1Snapshot, err: string): WinView {
    const s = snap.state
    const title = `FF1 · minimap · map ${s.pos.mapId} (${s.pos.x},${s.pos.y})`
    const menu = [...Ff1Controller.MINIMAP_MENU]
    if (!this.miniTile) {
      return { mode: 'text', title, menu, text: `${err}⏳ trail rendering…` }
    }
    return { mode: 'tile', title, menu, tile: this.miniTile }
  }

  private openMinimap(): void {
    this.miniTile = null
    this.level = 'minimap'
    this.runOp('minimap', () => ff1.minimap(), (r) => {
      this.miniTile = this.renderMinimap(r as { player: [number, number]; tiles: [number, number][] })
    })
  }

  private sysView(snap: Ff1Snapshot, err: string): WinView {
    const s = snap.state
    return {
      mode: 'text',
      title: 'FF1 · system',
      menu: ['SaveSlot', 'Slots', 'Export', 'New', 'Back', 'Main'],
      text: `${err}In-game save present: ${s.sramSavePresent ? 'YES' : 'no (inn-sleep to create one)'}\n`
        + `Gold ${s.gold} · battles ${s.battlecounter}\n\n`
        + 'SaveSlot stores a labeled savestate slot (PG).\n'
        + 'Slots lists/loads them (Cancel-first).\n'
        + 'Export writes the 8 KB .sav for PC emulators —\n'
        + 'refused loudly unless an in-game save exists.\n'
        + 'New resets the console to the title screen.',
    }
  }

  /** Cancel-first NEW GAME (2026-08-13). The engine always boots into the
   *  stored savestate, so without a console reset the title screen — and with
   *  it party select and the ring name keyboard — was unreachable for good. */
  private resetConfirmView(): WinView {
    const err = this.opError ? `⚠ ${this.opError}\n\n` : ''
    return {
      mode: 'text',
      title: 'FF1 · new game?',
      menu: ['Cancel', 'Confirm', 'Main'],
      text: `${err}Reset the console back to the title screen.\n\n`
        + 'The running party is checkpointed first, so Undo\n'
        + 'comes straight back to it, and the cartridge save\n'
        + 'survives — CONTINUE still finds it.\n'
        + 'Confirm resets · Cancel keeps playing.',
    }
  }

  private slotsView(): WinView {
    const rows = this.slots.map((s2) => slotRow(s2))
    const display = rows.length ? rows : ['(no slots saved yet)']
    const paged = browsePageItems(display, this.slotsOffset)
    return {
      mode: 'browse',
      menuMode: 'passive',
      title: `FF1 · Slots (${this.slots.length})`,
      menu: ['Back', 'Main'],
      items: paged.items,
    }
  }

  private slotConfirmView(): WinView {
    const p = this.pendingSlot
    const err = this.opError ? `⚠ ${this.opError}\n\n` : ''
    return {
      mode: 'text',
      title: 'FF1 · load slot?',
      menu: ['Cancel', 'Confirm', 'Main'],
      text: err + (p
        ? `Load slot:\n${p.label}\n\n⚠ Replaces the LIVE game (the current state\nauto-checkpoints first — Undo recovers).\nConfirm loads · Cancel keeps playing.`
        : '(nothing pending)'),
    }
  }

  private kbdView(): WinView {
    const { items, cells } = kbdModel(this.kbdGroup, this.kbdShift)
    this.kbdCells = cells
    return {
      mode: 'browse',
      menuMode: 'passive',
      title: `FF1 · name: "${this.kbdBuf}" (${this.kbdBuf.length}/4)`,
      menu: ['Back', 'Main'],
      items: [...items],
    }
  }

  private undoView(): WinView {
    const rows = this.undoList.map((c) => `↩ ${c.label} · ${c.at.slice(11, 19)}`)
    const display = rows.length ? rows : ['(no checkpoints yet)']
    const paged = browsePageItems(display, this.undoOffset)
    return {
      mode: 'browse',
      menuMode: 'passive',
      title: `FF1 · Undo (${this.undoList.length})`,
      menu: ['Back', 'Main'],
      items: paged.items,
    }
  }

  private undoConfirmView(): WinView {
    const p = this.pendingUndo
    const err = this.opError ? `⚠ ${this.opError}\n\n` : ''
    return {
      mode: 'text',
      title: 'FF1 · confirm rewind',
      menu: ['Cancel', 'Confirm', 'Main'],
      text: err + (p
        ? `Rewind to:\n${p.label}\n(${p.at})\n\nThe current state checkpoints first — an undo can be undone.\nConfirm restores · Cancel keeps playing.`
        : '(nothing pending)'),
    }
  }

  // ------------------------------------------------ input

  async onMenuSelect(label: string): Promise<void> {
    const st = ff1.status()
    if (!st.running) {
      // LOUD, not a silent drop (Ph-F review find): the not-running view
      // (with Reload) re-renders so the user sees why the tap did nothing.
      this.ctx.log(`[os] ff1: '${label}' while the engine is not running (${st.loadError ?? st.daemonNotice ?? 'starting'}) — repainting (LOUD)`)
      this.requestRender()
      return
    }
    const snap = this.snap()
    if (!snap) { this.ctx.log('[os] ff1: tap before the first snapshot — repainting (LOUD)'); this.requestRender(); return }

    // Standing verbs first (§8.4).
    if (label === 'Undo') { this.opError = null; this.openUndo(); return }
    // A verb that OPENS a level is the user moving on: drop a stale error so
    // it stops following them into unrelated views (2026-08-13 — a refused
    // Drink still headed the magic, target and Go screens three levels later).
    if (this.opError && ['Magic', 'Fight', 'Sys', 'Mini', 'Cancel', 'Back', 'Continue'].includes(label)) {
      this.opError = null
    }

    if (this.level === 'undo-confirm') { this.undoConfirmSelect(label); return }
    if (this.level === 'battle-log') { this.battleLogSelect(label); return }
    if (this.level === 'battle-confirm') { this.goConfirmSelect(label); return }
    if (this.level === 'auto-confirm') { this.autoConfirmSelect(label); return }
    if (this.level === 'battle-magic' || this.level === 'battle-drink' || this.level === 'battle-target') {
      this.ctx.log(`[os] ff1 ${this.level}: menu '${label}' — rows are content taps (Back/Main are WM-handled) (LOUD)`)
      return
    }
    if (this.level === 'sys') { this.sysSelect(snap, label); return }
    if (this.level === 'reset-confirm') { this.resetConfirmSelect(label); return }
    if (this.level === 'slot-confirm') { this.slotConfirmSelect(label); return }
    if (this.level === 'minimap') {
      // 'Refresh' is ours (the reserved 'Reload' is stripped in fullBleed —
      // the minimap's only refresh used to be unreachable); 'Back' is
      // WM-handled and pops to the map.
      if (label === 'Refresh') { this.openMinimap(); return }
      this.ctx.log(`[os] ff1 minimap: unknown verb '${label}' (LOUD)`)
      return
    }
    if (this.level === 'formation') {
      if (label === 'Enter') { this.level = 'root'; this.requestRender(); return }
      this.ctx.log(`[os] ff1 formation: unknown verb '${label}' (LOUD)`)
      return
    }
    if (snap.screen === 'battle' && snap.state.battle) { this.entrySelect(snap, label); return }
    this.screenSelect(snap, label)
  }

  private sysSelect(snap: Ff1Snapshot, label: string): void {
    if (label === 'SaveSlot') {
      const s = snap.state
      const lead = s.party[0]?.name ?? '?'
      const slotLabel = `${lead} · ${snap.screen} (${s.pos.x},${s.pos.y}) · ${s.gold}G`
      this.runOp('save slot', () => ff1.saveSlot(slotLabel), () => { this.opError = null })
      return
    }
    if (label === 'Slots') {
      this.runOp('list slots', () => ff1.listSlots(), (r) => {
        this.slots = r as { id: string; label: string; screen: string; at: string }[]
        this.slotsOffset = 0
        this.level = 'slots'
      })
      return
    }
    if (label === 'Export') {
      this.runOp('.sav export', () => ff1.savExport(), (r) => {
        const res = r as { path: string; bytes: number }
        this.opError = null
        this.roundPages = paginateText(`.sav exported:\n${res.path}\n(${res.bytes} bytes — loads in Mesen-class emulators)`)
        this.roundPage = 0
        this.roundOutcome = 'export'
        this.level = 'battle-log'   // reuse the pager view for the receipt
      })
      return
    }
    if (label === 'New') { this.pendingReset = true; this.level = 'reset-confirm'; this.requestRender(); return }
    this.ctx.log(`[os] ff1 sys: unknown verb '${label}' (LOUD)`)
  }

  private resetConfirmSelect(label: string): void {
    if (label === 'Confirm') {
      if (!this.pendingReset) { this.level = 'sys'; this.requestRender(); return }
      if (this.opBusy) { this.ctx.log(`[os] ff1: New Game Confirm while '${this.opBusy}' runs — confirm kept, tap again (LOUD)`); return }
      this.pendingReset = false
      this.runOp('new game (reset)', () => ff1.reset(), () => {
        this.entry = null
        this.roundPages = []
        this.level = 'root'
      })
      return
    }
    if (label === 'Cancel') { this.pendingReset = false; this.level = 'sys'; this.requestRender(); return }
    this.ctx.log(`[os] ff1 reset-confirm: unknown verb '${label}' (LOUD)`)
  }

  private slotConfirmSelect(label: string): void {
    if (label === 'Confirm') {
      const p = this.pendingSlot
      if (!p) { this.level = 'slots'; this.requestRender(); return }
      if (this.opBusy) { this.ctx.log(`[os] ff1: slot Confirm while '${this.opBusy}' runs — pick kept, tap again (LOUD)`); return }
      this.pendingSlot = null
      // (the daemon's load op auto-checkpoints since the pass-2 fix — no
      // client-side checkpoint needed)
      this.runOp('load slot', () => ff1.loadSlot(p.id), () => {
        this.entry = null
        this.level = 'root'
      })
      return
    }
    if (label === 'Cancel') { this.pendingSlot = null; this.level = 'slots'; this.requestRender(); return }
    this.ctx.log(`[os] ff1 slot-confirm: unknown verb '${label}' (LOUD)`)
  }

  private autoConfirmSelect(label: string): void {
    if (label === 'Go') {
      // guards FIRST — flipping the level before them dismissed the confirm
      // without firing when busy (the mutate-before-guard class, fifth copy;
      // Ph-F pass-3 find)
      if (!this.lastCommands) { this.ctx.log('[os] ff1: Auto Go with no last round — ignored (LOUD)'); return }
      if (this.opBusy) { this.ctx.log(`[os] ff1: Auto Go while '${this.opBusy}' runs — confirm kept, tap again (LOUD)`); return }
      this.level = 'root'
      this.fireAuto()
      return
    }
    if (label === 'Cancel') { this.level = 'root'; this.requestRender(); return }
    this.ctx.log(`[os] ff1 auto-confirm: unknown verb '${label}' (LOUD)`)
  }

  private screenSelect(snap: Ff1Snapshot, label: string): void {
    const dirs: Record<string, string> = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' }
    if (snap.screen === 'ow' || snap.screen === 'sm') {
      if (dirs[label]) {
        const want = STEP_COUNTS[this.stepIdx]
        this.runOp(`step ${dirs[label]}`, () => ff1.steps(dirs[label], want),
          (r) => this.stepDone(r, dirs[label], want))
        return
      }
      if (label === '×N') { this.stepIdx = (this.stepIdx + 1) % STEP_COUNTS.length; this.requestRender(); return }
      if (label === 'A') { this.press(['A'], 'A (talk/search)'); return }
      if (label === 'B') { this.press(['B'], 'B'); return }
      if (label === 'Menu') { this.press(['Start'], 'open game menu'); return }
      if (label === 'Peek') { this.syncMapTiles(true); return }
      if (label === 'Battle') { this.runOp('pace', () => ff1.pace(200), (r) => this.paceDone(r)); return }
      if (label === 'Mini') { this.openMinimap(); return }
      if (label === 'Sys') { this.level = 'sys'; this.requestRender(); return }
    } else {
      // Cursor mode (dialog/shop/gamemenu/title/party/name screens).
      if (label === 'Start') { this.press(['Start'], `${snap.screen} Start`); return }
      if (label === 'Name' && snap.screen === 'nameentry') {
        this.kbdBuf = ''
        this.kbdGroup = null
        this.kbdShift = true
        this.level = 'name-kbd'
        this.requestRender()
        return
      }
      if (label === 'Sys' && snap.screen === 'gamemenu') { this.level = 'sys'; this.requestRender(); return }
      // scraped-screen paging (the game's own screens are up to 21 lines and
      // the pane shows ~7 — before this, Sell/Exit and three of four equip
      // rows had no way to be seen at all)
      if (label === 'Next') { this.scrapePage++; this.requestRender(); return }
      if (label === 'Prev') { this.scrapePage = Math.max(0, this.scrapePage - 1); this.requestRender(); return }
      const cursor: Record<string, string> = { ...dirs, A: 'A', B: 'B' }
      const btn = cursor[label] ? { '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right', A: 'A', B: 'B' }[label] : null
      if (btn) { this.press([btn], `${snap.screen} ${btn}`); return }
    }
    this.ctx.log(`[os] ff1 ${snap.screen}: menu '${label}' — not a verb here (LOUD)`)
  }

  /** Step outcome → LOUD report. `stopped`/`committed` rode every steps
   *  response and were thrown away: walking into a wall changed nothing on
   *  screen and said nothing, which on glass (where a map push costs seconds)
   *  is indistinguishable from a dropped tap. 'battle'/'mapchange' speak for
   *  themselves — the new screen IS the report — so only a short walk is
   *  surfaced. */
  private stepDone(r: unknown, dir: string, want: number): void {
    const resp = r as Ff1Snapshot
    if (resp.stopped === 'blocked') {
      const got = resp.committed ?? 0
      this.opError = got === 0
        ? `can't go ${dir} — blocked`
        : `${dir} stopped after ${got}/${want} — blocked`
      return
    }
    if (resp.stopped === 'done' || resp.stopped === undefined) return
    if ((resp.committed ?? want) < want && resp.stopped !== 'battle' && resp.stopped !== 'mapchange') {
      this.opError = `${dir}: ${resp.stopped} after ${resp.committed ?? 0}/${want}`
    }
  }

  /** Pace outcome → LOUD report; a battle stop flips to entry via dispatch. */
  private paceDone(r: unknown): void {
    const resp = r as Ff1Snapshot & { pace?: { paces: number; stopped: string; battlestep0: number; battlestep1: number } }
    const p = resp.pace
    if (!p) { this.opError = 'pace returned no report'; return }
    if (p.stopped !== 'battle') {
      const tick = p.battlestep1 === p.battlestep0
        ? ' — battlestep NEVER TICKED (this spot cannot encounter; move elsewhere)'
        : ''
      this.opError = `pace: ${p.stopped} after ${p.paces} paces${tick}`
    }
  }

  private entrySelect(snap: Ff1Snapshot, label: string): void {
    if (!this.entry || this.entry.battleKey !== snap.state.battlecounter) this.beginEntry(snap)
    const e = this.entry!
    const ch = this.entryChar(snap)
    if (!ch) { this.ctx.log('[os] ff1: entry char missing — resyncing (LOUD)'); this.entry = null; this.requestRender(); return }
    switch (label) {
      case 'Fight': {
        const enemies = this.aliveEnemies(snap)
        if (enemies.length === 1) { this.commitCommand({ char: ch.slot, action: 'fight', target: enemies[0].slot }); return }
        e.pendingAction = { action: 'fight' }
        this.level = 'battle-target'
        this.requestRender()
        return
      }
      case 'Magic': {
        if (!ch.maxmp.some((m) => m > 0)) { this.ctx.log(`[os] ff1: ${ch.name} has no magic — ignored (LOUD)`); return }
        this.level = 'battle-magic'
        this.requestRender()
        return
      }
      case 'Drink': {
        const p = snap.state.potions
        if (!p || (p.heal <= 0 && p.pure <= 0)) {
          this.opError = 'no HEAL or PURE potions — buy some at an item shop'
          this.ctx.log('[os] ff1: Drink with no potions — refused LOUDLY')
          this.requestRender()
          return
        }
        this.level = 'battle-drink'
        this.requestRender()
        return
      }
      case 'Item':
        // NOT a deferral note any more — a statement of what the verb IS.
        // FF1's battle ITEM menu casts a spell from the character's own
        // EQUIPPED gear (Zeus Gauntlet → LIT, Heal staff → HEAL: bank_0C.asm
        // :: BattleSubMenu_Item walks ch_weapons/ch_armor). With no such item
        // in the party there is nothing to drive and nothing to verify, so it
        // stays out rather than shipping unexercised press code.
        this.opError = 'ITEM casts a spell from EQUIPPED gear — this party has none'
        this.ctx.log('[os] ff1: Item refused — no spell-casting equipment (LOUD)')
        this.requestRender()
        return
      case 'Run':
        this.commitCommand({ char: ch.slot, action: 'run' })
        return
      case 'RunAll': {
        for (let i = e.idx; i < e.living.length; i++) e.commands.push({ char: e.living[i], action: 'run' })
        e.idx = e.living.length
        this.level = 'battle-confirm'
        this.requestRender()
        return
      }
      case 'Auto':
        if (!this.lastCommands || this.lastCommandsKey !== snap.state.battlecounter) {
          this.ctx.log('[os] ff1: Auto without a last round for THIS battle — ignored (LOUD)')
          return
        }
        this.level = 'auto-confirm'
        this.requestRender()
        return
      default:
        this.ctx.log(`[os] ff1 battle-entry: unknown verb '${label}' (LOUD)`)
    }
  }

  /** Spell pick by browse INDEX (rows = pickRows as last rendered). */
  private magicPick(snap: Ff1Snapshot, index: number): void {
    const ch = this.entryChar(snap)
    const e = this.entry
    if (!ch || !e) { this.level = 'root'; this.requestRender(); return }
    const known = this.knownSpells(ch)
    const hit = known[index]
    const expectRow = hit ? `L${hit.level} ${hit.meta.name} ${hit.charges}/${ch.maxmp[hit.level - 1] ?? 0}` : undefined
    if (!hit || this.pickRows[index] !== expectRow) {
      this.ctx.log(`[os] ff1 magic: row ${index} drifted (rendered '${this.pickRows[index]}') — resyncing (LOUD)`)
      this.requestRender()
      return
    }
    if (hit.charges <= 0) {
      this.opError = `${hit.meta.name}: no charges left (L${hit.level} is 0/${ch.maxmp[hit.level - 1] ?? 0})`
      this.ctx.log(`[os] ff1: ${hit.meta.name} refused — 0 charges (LOUD)`)
      this.requestRender()
      return
    }
    const t = hit.meta.target
    if (t === 'one-enemy' || t === 'one-ally') {
      e.pendingAction = { action: 'magic', level: hit.level, slot: hit.slotIdx, spell: hit.meta }
      this.level = 'battle-target'
      this.requestRender()
      return
    }
    // caster / all-enemies / whole-party — no picker (the executor handles it).
    this.commitCommand({ char: ch.slot, action: 'magic', level: hit.level, slot: hit.slotIdx })
  }

  /** Potion pick by browse INDEX (0 = HEAL, 1 = PURE — the game's own row
   *  order, bank_0C BattleSubMenu_Drink `btlcurs_y AND #$01`). */
  private drinkPick(snap: Ff1Snapshot, index: number): void {
    const e = this.entry
    const ch = this.entryChar(snap)
    if (!e || !ch) { this.level = 'root'; this.requestRender(); return }
    if (index !== 0 && index !== 1) { this.ctx.log(`[os] ff1 drink: row ${index} out of range (LOUD)`); return }
    const p = snap.state.potions ?? { heal: 0, pure: 0 }
    const have = index === 0 ? p.heal : p.pure
    if (have <= 0) {
      this.opError = `${index === 0 ? 'HEAL' : 'PURE'}: none left`
      this.ctx.log(`[os] ff1: drink row ${index} refused — 0 left (LOUD)`)
      this.requestRender()
      return
    }
    e.pendingAction = { action: 'drink', potion: index }
    this.level = 'battle-target'
    this.requestRender()
  }

  /** Target pick by browse INDEX (slot from pickTargets — twins stay distinct). */
  private targetPick(snap: Ff1Snapshot, index: number): void {
    const e = this.entry
    const ch = this.entryChar(snap)
    const pa = e?.pendingAction
    if (!e || !ch || !pa) { this.level = 'root'; this.requestRender(); return }
    const slot = this.pickTargets[index]
    if (slot === undefined) { this.ctx.log(`[os] ff1 target: row ${index} out of range (LOUD)`); return }
    const targetsEnemies = pa.action === 'fight'
      || (pa.action === 'magic' && pa.spell?.target === 'one-enemy')
    if (targetsEnemies && !this.aliveEnemies(snap).some((en) => en.slot === slot)) {
      this.ctx.log(`[os] ff1 target: enemy slot ${slot} no longer alive — resyncing (LOUD)`)
      this.requestRender()
      return
    }
    if (pa.action === 'fight') this.commitCommand({ char: ch.slot, action: 'fight', target: slot })
    else if (pa.action === 'drink') this.commitCommand({ char: ch.slot, action: 'drink', potion: pa.potion, target: slot })
    else this.commitCommand({ char: ch.slot, action: 'magic', level: pa.level, slot: pa.slot, target: slot })
  }

  private goConfirmSelect(label: string): void {
    if (label === 'Go') { this.fireRound(); return }
    if (label === 'Cancel') {
      const snap = this.snap()
      if (snap) this.beginEntry(snap)
      this.requestRender()
      return
    }
    this.ctx.log(`[os] ff1 go-confirm: unknown verb '${label}' (LOUD)`)
  }

  private battleLogSelect(label: string): void {
    if (label === 'Next') { this.roundPage = Math.min(this.roundPages.length - 1, this.roundPage + 1); this.requestRender(); return }
    if (label === 'Prev') { this.roundPage = Math.max(0, this.roundPage - 1); this.requestRender(); return }
    if (label === 'Continue') {
      this.roundPages = []
      this.roundPage = 0
      const snap = this.snap()
      if (snap?.screen === 'battle' && snap.state.battle && this.roundOutcome === 'continue') {
        this.beginEntry(snap)   // next round's entry
      } else {
        this.entry = null
        this.level = 'root'
      }
      this.roundOutcome = null
      this.requestRender()
      return
    }
    this.ctx.log(`[os] ff1 battle-log: unknown verb '${label}' (LOUD)`)
  }

  private openUndo(): void {
    this.returnLevel = this.level
    this.runOp('undo list', () => ff1.undoList(), (r) => {
      this.undoList = r as Ff1Checkpoint[]
      this.undoOffset = 0
      this.level = 'undo'
    })
  }

  private undoConfirmSelect(label: string): void {
    if (label === 'Confirm') {
      const p = this.pendingUndo
      if (!p) { this.level = 'undo'; this.requestRender(); return }
      // busy pre-guard BEFORE discarding the pick (the fireRound pattern —
      // Ph-F pass-2 find: a busy-rejected Confirm lost the pending pick)
      if (this.opBusy) { this.ctx.log(`[os] ff1: undo Confirm while '${this.opBusy}' runs — pick kept, tap again (LOUD)`); return }
      this.pendingUndo = null
      this.runOp('undo', () => ff1.undo(p.index), () => {
        this.entry = null           // any battle entry is stale after a rewind
        this.roundPages = []
        this.level = 'root'
      })
      return
    }
    if (label === 'Cancel') { this.pendingUndo = null; this.level = 'undo'; this.requestRender(); return }
    this.ctx.log(`[os] ff1 undo-confirm: unknown verb '${label}' (LOUD)`)
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'name-kbd') { this.kbdSelect(index); return }
    if (this.level === 'slots') { this.slotsSelect(index); return }
    const snap = this.snap()
    if (this.level === 'battle-magic') { if (snap) this.magicPick(snap, index); return }
    if (this.level === 'battle-drink') { if (snap) this.drinkPick(snap, index); return }
    if (this.level === 'battle-target') { if (snap) this.targetPick(snap, index); return }
    if (this.level !== 'undo') { this.ctx.log(`[os] ff1: browse select at ${this.level} — ignored (LOUD)`); return }
    const rows = this.undoList.map((c) => `↩ ${c.label} · ${c.at.slice(11, 19)}`)
    const display = rows.length ? rows : ['(no checkpoints yet)']
    const { map, prevOffset, nextOffset } = browsePageItems(display, this.undoOffset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] ff1 undo: index ${index} out of range`); return }
    if (m === -1) { this.undoOffset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.undoOffset = nextOffset; this.requestRender(); return }
    const cp = this.undoList[m]
    if (!cp) { this.ctx.log('[os] ff1 undo: no checkpoint at row — resyncing'); this.requestRender(); return }
    this.pendingUndo = cp
    this.level = 'undo-confirm'
    this.requestRender()
  }

  /** The name keyboard (kbdModel; groups → chars; Run/Done fires the macro). */
  private kbdSelect(index: number): void {
    const cell = this.kbdCells[index]
    if (!cell) { this.ctx.log(`[os] ff1 kbd: index ${index} out of range (LOUD)`); return }
    if (cell.t === 'group') { this.kbdGroup = cell.chars; this.requestRender(); return }
    if (cell.t === 'char') {
      if (this.kbdBuf.length >= 4) { this.ctx.log('[os] ff1 kbd: name is 4 glyphs max — ignored (LOUD)'); return }
      this.kbdBuf += cell.ch
      this.kbdGroup = null
      this.requestRender()
      return
    }
    switch (cell.a) {
      case 'groups': this.kbdGroup = null; this.requestRender(); return
      case 'bksp': this.kbdBuf = this.kbdBuf.slice(0, -1); this.requestRender(); return
      case 'clear': this.kbdBuf = ''; this.requestRender(); return
      case 'shift': this.kbdShift = !this.kbdShift; this.requestRender(); return
      case 'space':
        this.ctx.log('[os] ff1 kbd: the FF1 grid has no space — type 4 glyphs (LOUD)')
        return
      case 'run':
      case 'done': {
        const name = this.kbdBuf
        if (name.length !== 4) {
          this.opError = `"${name}" — the vanilla grid types exactly 4 glyphs`
          this.ctx.log(`[os] ff1 kbd: ${this.opError}`)
          this.requestRender()
          return
        }
        if (this.opBusy) { this.ctx.log(`[os] ff1 kbd: Run while '${this.opBusy}' runs — buffer kept, tap again (LOUD)`); return }
        this.level = 'root'
        this.runOp(`name "${name}"`, () => ff1.nameEntry(name))
        return
      }
    }
  }

  private slotsSelect(index: number): void {
    const rows = this.slots.map((s2) => slotRow(s2))
    const display = rows.length ? rows : ['(no slots saved yet)']
    const { map, prevOffset, nextOffset } = browsePageItems(display, this.slotsOffset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] ff1 slots: index ${index} out of range`); return }
    if (m === -1) { this.slotsOffset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.slotsOffset = nextOffset; this.requestRender(); return }
    const slot = this.slots[m]
    if (!slot) { this.ctx.log('[os] ff1 slots: no slot at row — resyncing'); this.requestRender(); return }
    this.pendingSlot = { id: slot.id, label: slot.label }
    this.level = 'slot-confirm'
    this.requestRender()
  }

  /** Ribbon double-tap routing (windows/types.ts :: wantsBackNav). FF1 is a
   *  hierarchical navigator in every level below root — confirm cards, the
   *  system menu, the battle log, the minimap, the battle entry pane — but
   *  most of those are text/twocol/tile views, which ribbon mode used to park
   *  straight out of the window. That made the whole onBack ladder, including
   *  the documented "double-tap on a confirm = Cancel", unreachable on glass.
   *  At root we deliberately return false so double-tap still parks. */
  wantsBackNav(): boolean { return this.level !== 'root' }

  /** Pop one level. false = at root (GamesWindow pops ff1 → games list). */
  async onBack(): Promise<boolean> {
    this.opError = null   // a pop is the user acknowledging whatever it said
    switch (this.level) {
      case 'reset-confirm': this.pendingReset = false; this.level = 'sys'; this.requestRender(); return true
      case 'undo-confirm': this.pendingUndo = null; this.level = 'undo'; this.requestRender(); return true
      case 'undo': this.level = this.returnLevel; this.requestRender(); return true
      case 'slot-confirm': this.pendingSlot = null; this.level = 'slots'; this.requestRender(); return true
      case 'slots': this.level = 'sys'; this.requestRender(); return true
      case 'sys':
      case 'minimap':
        this.level = 'root'
        this.requestRender()
        return true
      case 'name-kbd':
        if (this.kbdGroup !== null) { this.kbdGroup = null; this.requestRender(); return true }
        this.level = 'root'
        this.requestRender()
        return true
      case 'formation':
        // double-tap on the glance = skip straight to entry
        this.level = 'root'
        this.requestRender()
        return true
      case 'auto-confirm':
        // Double-tap on a confirm = Cancel, never silently fire (§8.4).
        this.level = 'root'
        this.requestRender()
        return true
      case 'battle-magic':
      case 'battle-drink':
      case 'battle-target':
        if (this.entry) this.entry.pendingAction = null
        this.level = 'root'
        this.requestRender()
        return true
      case 'battle-confirm': {
        // Double-tap on the Go step = Cancel (never silently fire). While the
        // round is IN FLIGHT there is nothing to cancel — hold the card.
        if (this.runningCmds) { this.requestRender(); return true }
        const snap = this.snap()
        if (snap) this.beginEntry(snap)
        this.requestRender()
        return true
      }
      case 'battle-log':
        this.battleLogSelect('Continue')
        return true
      default:
        // Root: the house rule wins — double-tap is exit (the music stuck-trap
        // lesson). The engine is process-lifetime, so re-entering resumes.
        return false
    }
  }

  async onReload(): Promise<void> {
    const st = ff1.status()
    if (!st.running) {
      void ff1.ensureStarted(this.cfg()).then(async () => {
        await ff1.state()
        this.requestRender()
      }).catch((e: unknown) => {
        this.ctx.log(`[os] ff1: Reload restart failed: ${e instanceof Error ? e.message : String(e)}`)
        this.requestRender()
      })
      return
    }
    // The minimap's refresh (the WM owns the 'Reload' label — review find:
    // a level-local handler for it was unreachable).
    if (this.level === 'minimap') { this.openMinimap(); return }
    // Fresh classify (also clears a stale transition verdict).
    this.runOp('reload state', () => ff1.state())
  }
}
