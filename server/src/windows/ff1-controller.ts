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
import { paginateText, fwTextWidth } from '../os-compose.js'
import { browsePageItems } from './_browse.js'
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
  | 'battle-target'   // enemy/ally pick for the pending action
  | 'battle-confirm'  // Cancel-first Go over the collected round
  | 'battle-log'      // post-round paginated log
  | 'undo'            // checkpoint browse list
  | 'undo-confirm'    // Cancel-first restore confirm

const STEP_COUNTS = [1, 2, 3, 5, 8] as const

/** Battle-entry collection state (native menus — the game hasn't moved). */
interface EntryState {
  living: number[]                  // party slots, entry order
  idx: number                       // index into living
  commands: Ff1CharCommand[]
  /** A pending action awaiting its target pick (battle-target level). */
  pendingAction: { action: 'fight' | 'magic'; level?: number; slot?: number; spell?: SpellMeta } | null
}

function col(s: string, maxPx = 222): string {
  if (fwTextWidth(s) <= maxPx) return s
  let out = ''
  for (const ch of s) { if (fwTextWidth(out + ch) > maxPx) break; out += ch }
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

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  private cfg(): Ff1EngineConfig {
    const g = this.ctx.config.games?.ff1
    return { rngJitter: g?.rngJitter ?? true, undoDepth: g?.undoDepth ?? 30 }
  }
  private showEnemyHp(): boolean { return this.ctx.config.games?.ff1?.showEnemyHp ?? false }

  // ------------------------------------------------ lifecycle (from GamesWindow)

  enter(): void {
    this.level = 'root'
    this.entry = null
    this.opError = null
    void ff1.ensureStarted(this.cfg()).then(async () => {
      await ff1.state()   // fresh classify for the root view
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
    if (st.daemonNotice) return '⚠ ff1 daemon respawned'
    if (st.loadError) return `⚠ ${st.loadError}`.slice(0, 46)
    if (st.saveError) return '⚠ unsaved'
    if (this.opBusy) return `ff1 · ${this.opBusy}…`
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

  /** Run one engine op with the busy-guard + LOUD error surfacing. */
  private runOp(label: string, fn: () => Promise<unknown>, after?: (r: unknown) => void): void {
    if (this.opBusy) { this.ctx.log(`[os] ff1: '${label}' while '${this.opBusy}' runs — ignored (LOUD)`); return }
    this.opBusy = label
    this.opError = null
    this.requestRender()
    void fn().then((r) => {
      this.opBusy = null
      if (after) after(r)
      this.requestRender()
    }).catch((e: unknown) => {
      this.opBusy = null
      this.opError = e instanceof Error ? e.message : String(e)
      this.ctx.log(`[os] ff1: ${label} FAILED: ${this.opError}`)
      this.requestRender()
    })
  }

  private press(buttons: string[], label: string): void {
    this.runOp(label, () => ff1.press(buttons, label))
  }

  // ------------------------------------------------ battle entry helpers

  private snap(): Ff1Snapshot | null { return ff1.cachedSnapshot() }

  private beginEntry(snap: Ff1Snapshot): void {
    const living = snap.state.party.filter((c) => c.alive).map((c) => c.slot)
    this.entry = { living, idx: 0, commands: [], pendingAction: null }
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

  /** A char's known spells at LEVELS 1-4 (the Ph-B executor page-0 limit;
   *  L5-8 need the page flip — lands with a leveled party in Ph-E). */
  private knownSpells(c: Ff1Char): { meta: SpellMeta; charges: number; level: number; slotIdx: number }[] {
    const out: { meta: SpellMeta; charges: number; level: number; slotIdx: number }[] = []
    for (let lv = 1; lv <= 4; lv++) {
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
    const cmds = e.commands
    this.entry = null
    this.runOp('battle round', () => ff1.battleRound(cmds), (r) => {
      const resp = r as Ff1Snapshot & { battleRound?: { log: string[]; outcome: string } }
      const br = resp.battleRound
      if (!br) { this.opError = 'battle_round returned no round data'; this.level = 'root'; return }
      this.roundOutcome = br.outcome
      const body = br.log.length ? br.log.join('\n') : '(no combat messages scraped)'
      this.roundPages = paginateText(`Outcome: ${br.outcome}\n\n${body}`)
      this.roundPage = 0
      this.level = 'battle-log'
    })
  }

  // ------------------------------------------------ views

  async view(): Promise<WinView> {
    const st = ff1.status()
    if (!st.running) {
      const body = st.loadError
        ? `Failed to start:\n${st.loadError}\n\nReload to retry.`
        : '⏳ starting FF1 (cynes daemon)…'
      return { mode: 'text', title: 'FF1', menu: ['Reload', 'Main'], text: body }
    }
    const snap = this.snap()
    if (!snap) return { mode: 'text', title: 'FF1', menu: ['Reload', 'Main'], text: '⏳ first snapshot…' }
    const err = this.opError ? `⚠ ${this.opError}\n\n` : ''
    const busy = this.opBusy ? ` · ${this.opBusy}…` : ''

    if (this.level === 'undo') return this.undoView()
    if (this.level === 'undo-confirm') return this.undoConfirmView()
    if (this.level === 'battle-log') {
      const suffix = this.roundPages.length > 1 ? ` · ${this.roundPage + 1}/${this.roundPages.length}` : ''
      return {
        mode: 'text',
        title: `FF1 · round — ${this.roundOutcome ?? '?'}${suffix}`,
        menu: ['Continue', 'Next', 'Prev', 'Undo', 'Main'],
        text: this.roundPages[this.roundPage] ?? '',
      }
    }
    if (snap.screen === 'battle' && snap.state.battle) {
      if (this.level === 'battle-magic') return this.magicView(snap, err)
      if (this.level === 'battle-target') return this.targetView(snap, err)
      if (this.level === 'battle-confirm') return this.goConfirmView(snap, err)
      return this.entryView(snap, err, busy)
    }
    return this.screenView(snap, err, busy)
  }

  /** The screen-adaptive non-battle root. */
  private screenView(snap: Ff1Snapshot, err: string, busy: string): WinView {
    const s = snap.state
    const partyLine = s.party.filter((c) => c.alive).map((c) => `${c.name} ${c.hp}/${c.maxhp}`).join(' · ')
    switch (snap.screen) {
      case 'ow':
      case 'sm': {
        const where = snap.screen === 'ow' ? 'Overworld' : `Map ${s.pos.mapId}`
        return {
          mode: 'text',
          title: `FF1 · ${where} (${s.pos.x},${s.pos.y}) ×${STEP_COUNTS[this.stepIdx]}${busy}`,
          menu: ['↑', '↓', '←', '→', '×N', 'A', 'B', 'Menu', 'Undo', 'Main'],
          text: `${err}${partyLine}\n${s.gold} G · ${s.pos.vehicle} · facing ${s.pos.facing}\n\n(map tiles land in Ph-D — text placeholder)\nsteps ×${STEP_COUNTS[this.stepIdx]} per direction tap`,
        }
      }
      case 'dialog':
        return {
          mode: 'text',
          title: `FF1 · dialog${busy}`,
          menu: ['A', 'B', 'Undo', 'Main'],
          text: `${err}${(snap.text ?? []).join('\n') || '(empty dialog box)'}\n\nA advances · B closes`,
        }
      case 'shop':
      case 'gamemenu':
      case 'mainmenu':
      case 'partyselect':
      case 'nameentry': {
        const labels: Record<string, string> = {
          shop: 'shop', gamemenu: 'menu', mainmenu: 'title menu',
          partyselect: 'party select', nameentry: 'name entry',
        }
        return {
          mode: 'text',
          title: `FF1 · ${labels[snap.screen]}${busy}`,
          menu: ['↑', '↓', '←', '→', 'A', 'B', 'Undo', 'Main'],
          text: `${err}${(snap.text ?? []).join('\n') || '(no scraped text)'}\n\ncursor mode: arrows move, A confirms, B backs`,
        }
      }
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
    if (!this.entry) this.beginEntry(snap)
    const e = this.entry!
    const ch = this.entryChar(snap)
    const left: string[] = [col(this.formation(snap))]
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
    return {
      mode: 'twocol',
      title: `FF1 · ${ch?.name ?? '?'} (${e.idx + 1}/${e.living.length})${busy}`,
      menu: ['Fight', 'Magic', 'Drink', 'Item', 'Run', 'RunAll', 'Undo', 'Main'],
      textLeft: `${err}${left.join('\n')}`,
      textRight: right.join('\n'),
    }
  }

  private describeCommand(snap: Ff1Snapshot, c: Ff1CharCommand): string {
    const name = snap.state.party.find((p) => p.slot === c.char)?.name ?? `#${c.char}`
    if (c.action === 'fight') {
      const en = snap.state.battle?.enemies.find((x) => x.slot === c.target)
      return `${name}: FIGHT ${en?.name ?? '?'} s${c.target}`
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

  /** Spell pick (charges live from RAM — §7.1 "L3 FIR2 ×2/3"). */
  private magicView(snap: Ff1Snapshot, err: string): WinView {
    const ch = this.entryChar(snap)
    if (!ch) return this.entryView(snap, err, '')
    const rows = this.knownSpells(ch).map((s2) =>
      `L${s2.level} ${s2.meta.name} ${s2.charges}/${ch.maxmp[s2.level - 1] ?? 0}`)
    return {
      mode: 'text',
      title: `FF1 · ${ch.name} magic`,
      menu: [...rows, 'Back', 'Main'],
      text: `${err}Pick a spell (charges shown cur/max).\nEmpty-charge picks are refused loudly.\nL5-8 pages land in Ph-E.`,
    }
  }

  /** Target pick for the pending fight/magic action. */
  private targetView(snap: Ff1Snapshot, err: string): WinView {
    const e = this.entry
    const ch = this.entryChar(snap)
    const pa = e?.pendingAction
    if (!e || !ch || !pa) return this.entryView(snap, err, '')
    const targetsEnemies = pa.action === 'fight' || pa.spell?.target === 'one-enemy'
    const rows = targetsEnemies
      ? this.aliveEnemies(snap).map((en) => `${en.name} s${en.slot}${this.showEnemyHp() ? ` ${en.hp}hp` : ''}`)
      : snap.state.party.map((c) => `${c.alive ? '' : '✝'}${c.name} ${c.hp}/${c.maxhp}`)
    const what = pa.action === 'fight' ? 'FIGHT' : pa.spell?.name ?? 'spell'
    return {
      mode: 'text',
      title: `FF1 · ${ch.name} ${what} → target`,
      menu: [...rows, 'Back', 'Main'],
      text: `${err}Pick the target for ${what}.\n(slots stay authentic — a dead slot whiffs "Ineffective", 1987 rules)`,
    }
  }

  /** Cancel-first Go (the last pick FIRES the round — §8.4 insurance). */
  private goConfirmView(snap: Ff1Snapshot, err: string): WinView {
    const e = this.entry
    const lines = (e?.commands ?? []).map((c) => col(this.describeCommand(snap, c)))
    return {
      mode: 'text',
      title: 'FF1 · round ready',
      menu: ['Cancel', 'Go', 'Undo', 'Main'],
      text: `${err}${lines.join('\n')}\n\nGo runs the round through the real battle menus.\nCancel re-picks from the first character.`,
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
    return {
      mode: 'text',
      title: 'FF1 · confirm rewind',
      menu: ['Cancel', 'Confirm', 'Main'],
      text: p
        ? `Rewind to:\n${p.label}\n(${p.at})\n\nNewer checkpoints stay until trimmed — redo is possible.\nConfirm restores · Cancel keeps playing.`
        : '(nothing pending)',
    }
  }

  // ------------------------------------------------ input

  async onMenuSelect(label: string): Promise<void> {
    const st = ff1.status()
    if (!st.running) return
    const snap = this.snap()
    if (!snap) return

    // Standing verbs first (§8.4).
    if (label === 'Undo') { this.openUndo(); return }

    if (this.level === 'undo-confirm') { this.undoConfirmSelect(label); return }
    if (this.level === 'battle-log') { this.battleLogSelect(label); return }
    if (this.level === 'battle-confirm') { this.goConfirmSelect(label); return }
    if (this.level === 'battle-magic') { this.magicSelect(snap, label); return }
    if (this.level === 'battle-target') { this.targetSelect(snap, label); return }
    if (snap.screen === 'battle' && snap.state.battle) { this.entrySelect(snap, label); return }
    this.screenSelect(snap, label)
  }

  private screenSelect(snap: Ff1Snapshot, label: string): void {
    const dirs: Record<string, string> = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' }
    if (snap.screen === 'ow' || snap.screen === 'sm') {
      if (dirs[label]) { this.runOp(`step ${dirs[label]}`, () => ff1.steps(dirs[label], STEP_COUNTS[this.stepIdx])); return }
      if (label === '×N') { this.stepIdx = (this.stepIdx + 1) % STEP_COUNTS.length; this.requestRender(); return }
      if (label === 'A') { this.press(['A'], 'A (talk/search)'); return }
      if (label === 'B') { this.press(['B'], 'B'); return }
      if (label === 'Menu') { this.press(['Start'], 'open game menu'); return }
    } else {
      // Cursor mode (dialog/shop/gamemenu/title/party/name screens).
      const cursor: Record<string, string> = { ...dirs, A: 'A', B: 'B' }
      const btn = cursor[label] ? { '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right', A: 'A', B: 'B' }[label] : null
      if (btn) { this.press([btn], `${snap.screen} ${btn}`); return }
    }
    this.ctx.log(`[os] ff1 ${snap.screen}: menu '${label}' — not a verb here (LOUD)`)
  }

  private entrySelect(snap: Ff1Snapshot, label: string): void {
    if (!this.entry) this.beginEntry(snap)
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
      case 'Drink':
      case 'Item':
        // Ph-B deferral: the executor needs a potion/item fixture (Ph-E).
        this.opError = `${label} lands in Ph-E (needs inventory fixtures) — pick Fight/Magic/Run`
        this.ctx.log(`[os] ff1: ${label} deferred to Ph-E — refused LOUDLY`)
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
      default:
        this.ctx.log(`[os] ff1 battle-entry: unknown verb '${label}' (LOUD)`)
    }
  }

  private magicSelect(snap: Ff1Snapshot, label: string): void {
    const ch = this.entryChar(snap)
    const e = this.entry
    if (!ch || !e) { this.level = 'root'; this.requestRender(); return }
    const known = this.knownSpells(ch)
    const hit = known.find((s2) => `L${s2.level} ${s2.meta.name} ${s2.charges}/${ch.maxmp[s2.level - 1] ?? 0}` === label)
    if (!hit) { this.ctx.log(`[os] ff1 magic: unknown row '${label}' (LOUD)`); return }
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

  private targetSelect(snap: Ff1Snapshot, label: string): void {
    const e = this.entry
    const ch = this.entryChar(snap)
    const pa = e?.pendingAction
    if (!e || !ch || !pa) { this.level = 'root'; this.requestRender(); return }
    const targetsEnemies = pa.action === 'fight' || pa.spell?.target === 'one-enemy'
    if (targetsEnemies) {
      const hit = this.aliveEnemies(snap).find((en) =>
        `${en.name} s${en.slot}${this.showEnemyHp() ? ` ${en.hp}hp` : ''}` === label)
      if (!hit) { this.ctx.log(`[os] ff1 target: unknown enemy row '${label}' (LOUD)`); return }
      if (pa.action === 'fight') this.commitCommand({ char: ch.slot, action: 'fight', target: hit.slot })
      else this.commitCommand({ char: ch.slot, action: 'magic', level: pa.level, slot: pa.slot, target: hit.slot })
      return
    }
    const hit = snap.state.party.find((c) => `${c.alive ? '' : '✝'}${c.name} ${c.hp}/${c.maxhp}` === label)
    if (!hit) { this.ctx.log(`[os] ff1 target: unknown ally row '${label}' (LOUD)`); return }
    this.commitCommand({ char: ch.slot, action: 'magic', level: pa.level, slot: pa.slot, target: hit.slot })
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

  /** Pop one level. false = at root (GamesWindow pops ff1 → games list). */
  async onBack(): Promise<boolean> {
    switch (this.level) {
      case 'undo-confirm': this.pendingUndo = null; this.level = 'undo'; this.requestRender(); return true
      case 'undo': this.level = this.returnLevel; this.requestRender(); return true
      case 'battle-magic':
      case 'battle-target':
        if (this.entry) this.entry.pendingAction = null
        this.level = 'root'
        this.requestRender()
        return true
      case 'battle-confirm': {
        // Double-tap on the Go step = Cancel (never silently fire).
        const snap = this.snap()
        if (snap) this.beginEntry(snap)
        this.requestRender()
        return true
      }
      case 'battle-log':
        this.battleLogSelect('Continue')
        return true
      default:
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
    // Fresh classify (also clears a stale transition verdict).
    this.runOp('reload state', () => ff1.state())
  }
}
