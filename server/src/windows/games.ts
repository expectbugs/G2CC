// windows/games.ts — rpg-cli dungeon + chess vs Stockfish + Universal Paperclips (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cycleNext } from './_util.js'
import { DE_CONTENT_W, DE_CONTENT_H } from '@g2cc/shared'
import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems } from './_browse.js'
import { paginateText, fwTextWidth, BJ_DEALER_RECT, BJ_PLAYER_RECT } from '../os-compose.js'
import type { RenderedImage, RenderedTile } from '../os-content.js'
import {
  rpgRun, chessMove, chessPreview, renderBoard, renderHand, saveBlackjack, loadBlackjack,
  DUNGEON_ROOT, type ChessState, type HandCard,
} from '../games.js'
import { Blackjack, isBust, type Phase as BjPhase } from '../blackjack.js'
import { paperclips, type PcSnapshot, type PcPhase } from '../paperclips.js'

const RPG_ACTIONS = ['» stat', '» battle', '» ls (inspect)', '» todo', '» buy (list shop)'] as const
const CHESS_SKILLS = [1, 5, 10, 20] as const

// ============================================================ Paperclips (Universal Paperclips)
//
// The window-side controller for the real game (engine in paperclips.ts). The
// Games window delegates to it when its level is 'pc'. Design (Adam 2026-06-27):
// a phase-aware ONE-PAGE twocol dashboard is home (the engine ticks in the
// background — a 2 s re-render pacer keeps the numbers live while it's on
// screen), the left menu carries the phase's hot verbs (fired directly,
// tap-tap-tap), and parametric / list actions open drill-down levels. Menu
// labels are SHORT (≤~7 chars — the 96 px menu wraps) and CONSTANT (toggle/cycle
// state rides the CONTENT, never the label — the chess "Skill" rule — so a tap
// resolved against the last-rendered view can't miss after a state change).
// Irreversible spends go through a Cancel-first confirm.

type PcLevel = 'dash' | 'buy' | 'opts' | 'projects' | 'confirm' | 'drones' | 'probe' | 'invest' | 'swarm'

interface PcVerb { label: string; run: () => void }

const PHASE_LABEL: Record<PcPhase, string> = { business: 'biz', factory: 'factory', space: 'space', end: 'end' }
const PC_DRONE_QTY = [1, 10, 100, 1000] as const
const PC_SLIDER_POS = [0, 100, 200] as const
const PC_SLIDER_LABEL = ['Work', 'Bal', 'Think'] as const
const PC_TRUST_STEP = [1, 5, 10, 25] as const   // probe-trust allocation step per Up/Dn tap
const PC_PROBE_DIMS = [
  { key: 'Speed', raise: 'raiseProbeSpeed', lower: 'lowerProbeSpeed' },
  { key: 'Nav', raise: 'raiseProbeNav', lower: 'lowerProbeNav' },
  { key: 'Rep', raise: 'raiseProbeRep', lower: 'lowerProbeRep' },
  { key: 'Haz', raise: 'raiseProbeHaz', lower: 'lowerProbeHaz' },
  { key: 'Fac', raise: 'raiseProbeFac', lower: 'lowerProbeFac' },
  { key: 'Harv', raise: 'raiseProbeHarv', lower: 'lowerProbeHarv' },
  { key: 'Wire', raise: 'raiseProbeWire', lower: 'lowerProbeWire' },
  { key: 'Combat', raise: 'raiseProbeCombat', lower: 'lowerProbeCombat' },
] as const

/** Compact number formatter for the tiny display: 1.2k / 3.4M / …T, then
 *  exponential for the game's astronomical late ranges (matter ~1e27+). */
function pcNum(n: number): string {
  if (!isFinite(n)) return n > 0 ? '∞' : '-∞'
  const neg = n < 0
  let a = Math.abs(n)
  let s: string
  if (a < 1000) s = Number.isInteger(a) ? String(a) : a.toFixed(a < 10 ? 1 : 0)
  else if (a < 1e6) s = (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  else if (a < 1e9) s = (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  else if (a < 1e12) s = (a / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  else if (a < 1e15) s = (a / 1e12).toFixed(1).replace(/\.0$/, '') + 'T'
  else s = a.toExponential(1)
  return neg ? '-' + s : s
}

/** Pre-fit a twocol line to the column pixel width (twocol pre-fits; compose
 *  px-clamps as a backstop but logs a warning if it has to — we avoid that). */
function pcCol(s: string, maxPx = 222): string {   // twocol compose clamps to colW-14 ≈ 223; stay just under
  if (fwTextWidth(s) <= maxPx) return s
  let out = ''
  for (const ch of s) { if (fwTextWidth(out + ch) > maxPx) break; out += ch }
  return out
}

class PaperclipsController {
  private level: PcLevel = 'dash'
  private focus: 'content' | 'menu' = 'content'   // projects browse focus-flip (rpg pattern)
  private projOffset = 0
  private shownProjects: { id: string; title: string; price: string; description: string; affordable: boolean }[] = []
  private droneQtyIdx = 0
  private probeDim = 0
  private probeStepIdx = 0   // trust-allocation step (PC_TRUST_STEP)
  private sliderIdx = 0
  private pending: { title: string; body: string; run: () => boolean } | null = null
  private confirmPages: string[] = []
  private confirmPage = 0
  /** 2 s dashboard re-render pacer — runs while the controller is entered (the
   *  requestRender it calls self-gates on the Games window being active, so it's
   *  harmless when switched away; cleared on leave/dispose). A cadence, not a
   *  timeout. */
  private pacer: ReturnType<typeof setInterval> | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  // ------------------------------------------------ lifecycle (from GamesWindow)

  enter(): void {
    this.level = 'dash'
    this.focus = 'content'
    this.projOffset = 0
    this.pending = null
    this.confirmPages = []
    this.confirmPage = 0
    // Boot the engine (lazy, single-flight). A load failure surfaces in view().
    void paperclips.ensureStarted().then(() => this.requestRender()).catch((e: unknown) => {
      this.ctx.log(`[os] paperclips: engine start failed: ${e instanceof Error ? e.message : String(e)}`)
      this.requestRender()
    })
    this.startPacer()
    this.requestRender()   // paint "⏳ starting…" immediately — don't wait for the async boot or the 2 s pacer
  }

  private startPacer(): void {
    if (this.pacer) return
    this.pacer = setInterval(() => { if (this.level === 'dash') this.requestRender() }, 2000)
    if (typeof this.pacer.unref === 'function') this.pacer.unref()
  }
  private stopPacer(): void { if (this.pacer) { clearInterval(this.pacer); this.pacer = null } }

  /** GamesWindow switched away — persist; keep the pacer so a switch-back resumes
   *  (its requestRender no-ops while inactive). The engine keeps ticking. */
  onDeactivate(): void { void paperclips.flush() }
  /** ws close — stop our pacer. The engine is a process singleton; we do NOT
   *  tear it down (idle game keeps running for the next connection). */
  dispose(): void { this.stopPacer(); void paperclips.flush() }
  /** Called when GamesWindow leaves the pc area entirely (back to the games list). */
  leave(): void { this.stopPacer(); void paperclips.flush() }

  summary(): string {
    const st = paperclips.status()
    if (!st.running) return 'paperclips · idle'
    return `paperclips · ${pcNum(paperclips.snapshot().clips)} clips`
  }
  statusLine(): string | null {
    const st = paperclips.status()
    if (st.loadError) return `⚠ ${st.loadError}`.slice(0, 40)
    if (st.saveError) return '⚠ unsaved'
    // Surface the game's latest readout (Adam 2026-06-28) — trust grants, the value-drift
    // warning, combat VICTORY/DEFEAT, story beats — which otherwise had nowhere to show.
    const msg = st.running ? paperclips.snapshot().message : ''
    return msg ? msg.slice(0, 46) : null
  }

  /** Ribbon preview (READ-ONLY): the live snapshot — phase, clips, unused wire,
   *  funds, projects, and the game's latest readout. status()/snapshot() are the
   *  SAME cheap in-memory reads summary()/statusLine() use; nothing ticks here. */
  preview(): string | null {
    const st = paperclips.status()
    if (!st.running) return st.loadError ? `Paperclips\n⚠ ${st.loadError.slice(0, 38)}` : null
    const s = paperclips.snapshot()
    const lines = [
      `Paperclips · ${PHASE_LABEL[s.phase]}`,
      `Clips ${pcNum(s.clips)}`,
      `Wire ${pcNum(s.wire)} @ $${pcNum(s.wireCost)}`,
      `Funds $${pcNum(s.funds)}`,
      `Proj ${pcNum(s.projectsAvail)}${s.projectsAfford ? ` ●${pcNum(s.projectsAfford)}` : ''}`,
    ]
    if (s.message) lines.push(s.message.slice(0, 40))
    return lines.join('\n')
  }

  // ------------------------------------------------ verbs (label↔action, drift-free)

  /** The menu verbs for the CURRENT level. view() renders the labels; onMenuSelect
   *  dispatches by matching them. Labels are constant (state shows in content). */
  private menuVerbs(s: PcSnapshot): PcVerb[] {
    const C = paperclips
    switch (this.level) {
      case 'dash': {
        // 4 stable top-level verbs (Adam 2026-06-27): no Reload/Main — double-tap
        // backs out toward Main. Buy = the shop; Opts = pricing + automations + compute.
        const v: PcVerb[] = []
        if (s.phase === 'space') {
          // FULL SPACE — probe-driven; Build/power are dead here.
          v.push({ label: 'Probe', run: () => this.go('probe') })
          if (s.swarmUnlocked) v.push({ label: 'Swarm', run: () => this.go('swarm') })
          v.push({ label: 'Opts', run: () => this.go('opts') })
          v.push({ label: 'Proj', run: () => this.go('projects') })
        } else if (s.phase === 'factory') {
          // Earth disassembly — manual Build + power. Build appears once a builder unlocks.
          if (s.factoryBuildUnlocked || s.harvesterBuildUnlocked || s.wireDroneBuildUnlocked || s.powerUnlocked) v.push({ label: 'Build', run: () => this.go('drones') })
          if (s.swarmUnlocked) v.push({ label: 'Swarm', run: () => this.go('swarm') })
          v.push({ label: 'Opts', run: () => this.go('opts') })
          v.push({ label: 'Proj', run: () => this.go('projects') })
        } else if (s.phase === 'end') {
          v.push({ label: 'Proj', run: () => this.go('projects') })
          v.push({ label: 'Opts', run: () => this.go('opts') })
        } else {
          v.push({ label: 'Clip', run: () => C.bulkClip() })
          v.push({ label: 'Buy', run: () => this.go('buy') })
          v.push({ label: 'Opts', run: () => this.go('opts') })
          v.push({ label: 'Proj', run: () => this.go('projects') })
        }
        return v
      }
      case 'buy': {
        // The shop — everything funds buy (business era).
        const v: PcVerb[] = [
          { label: 'Market', run: () => C.call('buyAds') },
          { label: 'Wire', run: () => C.call('buyWire') },
        ]
        if (s.wireBuyerUnlocked) v.push({ label: 'WBuyer', run: () => C.call('toggleWireBuyer') })
        if (s.autoClipperUnlocked) v.push({ label: 'AutoC', run: () => C.call('makeClipper') })
        if (s.megaClipperUnlocked) v.push({ label: 'MegaC', run: () => C.call('makeMegaClipper') })
        if (s.investUnlocked) v.push({ label: 'Stocks', run: () => this.go('invest') })
        return v
      }
      case 'opts': {
        // Pricing + automations + compute spends. AutoQ/AutoY are constant-label toggles.
        const v: PcVerb[] = []
        if (s.phase === 'business') { v.push({ label: 'P-', run: () => C.call('lowerPrice') }); v.push({ label: 'P+', run: () => C.call('raisePrice') }) }
        if (s.qUnlocked) v.push({ label: 'AutoQ', run: () => C.setAutoQuantum(!C.isAutoQuantum()) })
        if (s.stratUnlocked) v.push({ label: 'AutoY', run: () => C.setAutoYomi(!C.isAutoYomi()) })
        if (s.compUnlocked) { v.push({ label: 'Proc', run: () => C.addProc() }); v.push({ label: 'Mem', run: () => C.addMem() }) }   // guarded (trust allowance)
        return v
      }
      case 'invest':
        return [
          { label: 'Dep', run: () => C.call('investDeposit') },
          { label: 'Wd', run: () => C.call('investWithdraw') },
          { label: 'Upgr', run: () => C.investUpgrade() },   // guarded (yomi≥cost) — the -57M bug
          { label: 'Risk', run: () => { const o = ['low', 'med', 'hi']; const cur = paperclips.snapshot().investRisk; C.setInvestRisk(o[(o.indexOf(cur) + 1) % o.length] ?? 'low') } },
        ]
      case 'drones': {
        // Each builder unlocks via its own project (2026-06-28 audit) — show only the unlocked ones.
        const v: PcVerb[] = [{ label: 'Qty', run: () => { this.droneQtyIdx = (this.droneQtyIdx + 1) % PC_DRONE_QTY.length } }]
        if (s.factoryBuildUnlocked) v.push({ label: 'Fact', run: () => C.call('makeFactory') })
        if (s.harvesterBuildUnlocked) v.push({ label: 'Harv', run: () => C.call('makeHarvester', this.droneQty()) })
        if (s.wireDroneBuildUnlocked) v.push({ label: 'Drone', run: () => C.call('makeWireDrone', this.droneQty()) })
        if (s.powerUnlocked) { v.push({ label: 'Farm', run: () => C.call('makeFarm', this.droneQty()) }); v.push({ label: 'Batt', run: () => C.call('makeBattery', this.droneQty()) }) }
        return v
      }
      case 'probe': {
        const d = this.selectedDim(s)
        const step = PC_TRUST_STEP[this.probeStepIdx]
        const v: PcVerb[] = [
          { label: '+Probe', run: () => C.bulkProbe() },   // up to 1000/tap, clamped to affordable
          { label: 'Sel', run: () => { this.probeDim = (this.probeDim + 1) % this.activeDims(s).length } },
          { label: 'Up', run: () => { for (let i = 0; i < step; i++) C.call(d.raise) } },   // ×step (Step cycles 1/5/10/25)
          { label: 'Dn', run: () => { for (let i = 0; i < step; i++) C.call(d.lower) } },
          { label: 'Step', run: () => { this.probeStepIdx = (this.probeStepIdx + 1) % PC_TRUST_STEP.length } },
          { label: 'PTrust', run: () => C.increaseProbeTrust() },   // yomi → +probeTrust (all of full space; guarded+loud)
        ]
        if (s.maxTrustUnlocked) v.push({ label: 'MaxT', run: () => C.increaseMaxTrust() })   // honor → +maxTrust (guarded+loud; project121)
        return v
      }
      case 'swarm':
        return [
          { label: 'Synch', run: () => C.synchSwarm() },        // guarded (yomi≥cost)
          { label: 'Entmt', run: () => C.entertainSwarm() },    // guarded (creativity≥cost)
          { label: 'Slider', run: () => { this.sliderIdx = (this.sliderIdx + 1) % PC_SLIDER_POS.length; C.setSlider(PC_SLIDER_POS[this.sliderIdx]) } },
        ]
      case 'confirm': {
        const v: PcVerb[] = [
          { label: 'Cancel', run: () => { this.pending = null; this.go('projects') } },
          { label: 'Confirm', run: () => {
            const p = this.pending
            if (!p) { this.go('projects'); return }
            if (p.run()) {
              this.pending = null
              // A prestige/restart project (The Universe Next Door/Within, Quantum
              // Temporal Reversion) rebuilt the game — show the fresh dashboard, not
              // the now-reset project list.
              if (C.consumeRestarted()) this.go('dash'); else this.go('projects')
            }
            // Resource drained between render and tap — keep the card and say so LOUDLY
            // (review 2026-06-27, B-LOW-MED), instead of silently dropping to the list.
            else { this.confirmPages = paginateText(`${p.body}\n\n⚠ Couldn't buy — nothing was spent (cost no longer met).`); this.confirmPage = 0 }
          } },
        ]
        if (this.confirmPages.length > 1) {
          v.push({ label: 'Next', run: () => { this.confirmPage = Math.min(this.confirmPages.length - 1, this.confirmPage + 1) } })
          v.push({ label: 'Prev', run: () => { this.confirmPage = Math.max(0, this.confirmPage - 1) } })
        }
        return v
      }
      case 'projects':
        return []   // browse level — actions are content-row taps; menu is just Back
    }
  }

  private droneQty(): number { return PC_DRONE_QTY[this.droneQtyIdx] }

  /** Probe-trust dims available now — Combat only after project131 (2026-06-28 audit). */
  private activeDims(s: PcSnapshot): { key: string; raise: string; lower: string }[] {
    return PC_PROBE_DIMS.filter((dim) => dim.key !== 'Combat' || s.combatDimUnlocked)
  }
  private selectedDim(s: PcSnapshot): { key: string; raise: string; lower: string } {
    const dims = this.activeDims(s)
    return dims[this.probeDim % dims.length]
  }

  private go(level: PcLevel): void {
    this.level = level
    if (level === 'projects') { this.projOffset = 0; this.focus = 'content' }
    this.requestRender()
  }

  // ------------------------------------------------ view

  async view(): Promise<WinView> {
    const st = paperclips.status()
    if (!st.running) {
      const body = st.loadError ? `Failed to start:\n${st.loadError}\n\nReload to retry.` : '⏳ starting Universal Paperclips…'
      return { mode: 'text', title: 'Paperclips', menu: ['Reload', 'Main'], text: body }
    }
    const s = paperclips.snapshot()
    if (this.level === 'dash') return this.dashView(s)
    if (this.level === 'projects') return this.projectsView()
    if (this.level === 'confirm') {
      // Paginated so a long project description is never silently clipped past
      // the 6-row window (review 2026-06-27, B-MEDIUM — NO TRUNCATION).
      const pages = this.confirmPages.length ? this.confirmPages : [this.pending?.body ?? '(nothing pending)']
      const page = Math.min(this.confirmPage, pages.length - 1)
      const suffix = pages.length > 1 ? ` · ${page + 1}/${pages.length}` : ''
      const menu = [...this.menuVerbs(s).map((v) => v.label), 'Main']   // Cancel/Confirm (+Next/Prev) + Main
      return { mode: 'text', title: clampMid((this.pending?.title ?? 'Confirm') + suffix), menu, text: pages[page] ?? '' }
    }
    return this.subView(s)
  }

  private dashView(s: PcSnapshot): WinView {
    const verbs = this.menuVerbs(s)
    const menu = [...verbs.map((v) => v.label), 'Main']   // Main back (Adam 2026-06-27) — quick return to the OS dashboard
    const title = `Paperclips · ${PHASE_LABEL[s.phase]} · ${pcNum(s.clips)} clips`
    let left: string[]
    let right: string[]
    // Projects-available counter (Adam 2026-06-28) — on every phase so you needn't open the
    // Projects menu to spot new ones. ● = affordable now.
    const projLine = `Proj ${pcNum(s.projectsAvail)}${s.projectsAfford ? ` ●${pcNum(s.projectsAfford)}` : ''}`
    if (s.phase === 'end') {
      // The dismantle sequence — space stats are zeroing out; show progress, not zeros.
      left = [
        `Clips ${pcNum(s.clips)}`,
        `Dismantle ${s.dismantle}/7`,
        `Matter ${pcNum(s.availableMatter)}`,
        `Probe ${pcNum(s.probes)}`,
        `Explor ${s.colonizedPct.toFixed(1)}%`,
        `Honor ${pcNum(s.honor)}`,
      ]
      right = [
        `Yomi ${pcNum(s.yomi)}`,
        `Creat ${pcNum(s.creativity)}`,
        `Ops ${pcNum(s.operations)}`,
        `Fact ${pcNum(s.factories)} Hrv ${pcNum(s.harvesters)}`,
        `Drone ${pcNum(s.wireDrones)}`,
        projLine,
      ]
    } else if (s.phase === 'space') {
      // FULL SPACE (spaceFlag=1) — probe-driven (Adam 2026-06-27). Build/power are dead;
      // what matters is probe count, trust allocation, exploration %, and what's killing them.
      left = [
        `Clips ${pcNum(s.clips)}`,
        `Probes ${pcNum(s.probes)}`,
        `Descend ${pcNum(s.probesBorn)}`,
        `Fact ${pcNum(s.factories)} Hrv ${pcNum(s.harvesters)}`,   // PROBE-BUILT (Adam 2026-06-28)
        `Drone ${pcNum(s.wireDrones)}`,
        `Explor ${s.colonizedPct.toFixed(1)}%`,
      ]
      right = [
        `Trust ${s.probeUsedTrust}/${s.probeTrust} m${s.maxTrust}`,
        `Yomi ${pcNum(s.yomi)}`,
        `Lost H${pcNum(s.probesLostHaz)} D${pcNum(s.probesLostDrift)}`,
        s.combatDimUnlocked ? `Honor ${pcNum(s.honor)} Dr${pcNum(s.drifters)}` : `Matter ${pcNum(s.availableMatter)}`,
        projLine,
      ]
      if (s.shortage) right.push(`Short: ${s.shortage}`)   // trust hint (e.g. 'buy PTrust')
    } else if (s.phase === 'factory') {
      // Earth disassembly (humanFlag=0, spaceFlag=0): manual Build + power. Power
      // performance + the build bottleneck are surfaced (they throttle everything).
      const perf = s.powMod < 1 ? ` ⚠${Math.round(s.powMod * 100)}%` : ''
      left = [
        `Clips ${pcNum(s.clips)}`,
        `Unused ${pcNum(s.unusedClips)}`,   // the BUILD BUDGET — what factories/drones/farms cost
        `Matter ${pcNum(s.availableMatter)}`,
        `Wire ${pcNum(s.wireSpace)}`,
        `Fact ${pcNum(s.factories)} Hrv ${pcNum(s.harvesters)}`,
        `Drone ${pcNum(s.wireDrones)}`,
      ]
      right = [
        `Farm ${pcNum(s.farms)} Bat ${pcNum(s.batteries)}`,
        `Pwr ${pcNum(s.storedPower)}${perf}`,
        `Acq ${pcNum(s.acquiredMatter)}`,
        projLine,
      ]
      // Dropped the always-zero probe/explore/born lines (2026-06-28) so the bottleneck hint sits visible.
      if (s.shortage) right.push(`Short: ${s.shortage}`)
    } else {
      // Business — dense combined lines (Adam 2026-06-27): the whole state on one page.
      // Left = money/market, right = production/compute/automation. All < column width.
      const opsK = s.operations / 1000
      const opsKs = opsK < 10 ? opsK.toFixed(1).replace(/\.0$/, '') : Math.round(opsK).toString()
      left = [
        `Clips ${pcNum(s.clips)} Uns ${pcNum(s.unsoldClips)}`,
        `Funds $${pcNum(s.funds)} @$${s.margin.toFixed(2)}`,
        `Dem ${s.demandPct}% R/s $${pcNum(s.avgRev)}`,
        `Mkt L${s.marketingLvl} $${pcNum(s.adCost)}`,
      ]
      if (s.investUnlocked) left.push(`Cash $${pcNum(s.investBankroll)} Stk $${pcNum(s.investStocks)}`)
      right = [
        `Wire ${pcNum(s.wire)} $${pcNum(s.wireCost)}`,
        `AutoC ${pcNum(s.autoClippers)}${s.megaClipperUnlocked ? ` Mega ${pcNum(s.megaClippers)}` : ''}`,
      ]
      if (s.compUnlocked) right.push(`T${s.trust} P${s.processors} Ops ${opsKs}/${s.memory}k`)
      if (s.compUnlocked) right.push(`Creat ${pcNum(s.creativity)} Yomi ${pcNum(s.yomi)}`)
      const autos: string[] = []
      if (s.wireBuyerUnlocked) autos.push(`WB${s.wireBuyerOn ? '+' : '-'}`)
      if (s.qUnlocked) autos.push(`AQ${s.autoQuantum ? '+' : '-'}`)
      if (s.stratUnlocked) autos.push(`AY${s.autoYomi ? '+' : '-'}`)
      if (autos.length) right.push(`Auto ${autos.join(' ')}`)
      right.push(projLine)
    }
    return { mode: 'twocol', title, menu, textLeft: left.map((l) => pcCol(l)).join('\n'), textRight: right.map((l) => pcCol(l)).join('\n') }
  }

  private subView(s: PcSnapshot): WinView {
    const verbs = this.menuVerbs(s)
    const menu = [...verbs.map((v) => v.label), 'Back', 'Main']   // Back + Main (no Reload)
    let title = 'Paperclips'
    let text = ''
    switch (this.level) {
      case 'buy':
        title = 'Paperclips · Buy'
        text = [
          `Funds $${pcNum(s.funds)}`,
          `Wire ${pcNum(s.wire)} @ $${pcNum(s.wireCost)}`,
          `Market L${s.marketingLvl} @ $${pcNum(s.adCost)} · Dem ${s.demandPct}%`,
          `AutoC ${pcNum(s.autoClippers)} @ $${pcNum(s.clipperCost)}`,
          s.megaClipperUnlocked ? `MegaC ${pcNum(s.megaClippers)} @ $${pcNum(s.megaClipperCost)}` : '',
          s.wireBuyerUnlocked ? `WireBuyer: ${s.wireBuyerOn ? 'ON' : 'off'} · Stocks→` : '',
        ].filter(Boolean).join('\n')
        break
      case 'opts':
        title = 'Paperclips · Opts'
        text = [
          s.phase === 'business' ? `Price $${s.margin.toFixed(2)} (P-/P+) · Dem ${s.demandPct}%` : '',
          s.compUnlocked ? `Trust ${s.trust} · Proc ${s.processors} · Mem ${s.memory}` : '',
          s.compUnlocked ? `Ops ${pcNum(s.operations)}/${pcNum(s.opMax)} · Creat ${pcNum(s.creativity)}` : '',
          s.qUnlocked ? `AutoQ: ${s.autoQuantum ? 'ON' : 'off'} (qComp on +chip sum)` : '',
          s.stratUnlocked ? `AutoY: ${s.autoYomi ? 'ON' : 'off'} · Yomi ${pcNum(s.yomi)} (auto-tourney @ best)` : '',
        ].filter(Boolean).join('\n')
        break
      case 'invest':
        title = 'Paperclips · Invest'
        text = `Cash $${pcNum(s.investBankroll)}\nStocks $${pcNum(s.investStocks)}\nEngine L${s.investLevel} · Risk ${s.investRisk}\n\nDep deposits, Wd withdraws, Upgr levels up.\nRisk cycles low/med/hi.`
        break
      case 'drones':
        title = `Paperclips · Build ×${this.droneQty()}`
        text = [
          `Qty per tap: ×${this.droneQty()}  (Qty cycles)`,
          `Factory ${pcNum(s.factories)} — $${pcNum(s.factoryCost)} clips`,
          `Harvester ${pcNum(s.harvesters)} — ${pcNum(s.harvesterCost)}`,
          `WireDrone ${pcNum(s.wireDrones)} — ${pcNum(s.wireDroneCost)}`,
          `Farm ${pcNum(s.farms)} — ${pcNum(s.farmCost)} · Batt ${pcNum(s.batteries)}`,
        ].join('\n')
        break
      case 'probe': {
        const dim = this.selectedDim(s)
        const step = PC_TRUST_STEP[this.probeStepIdx]
        title = `Paperclips · Probe [${dim.key}] ×${step}`
        const p = s.probe
        const free = s.probeTrust - s.probeUsedTrust
        const canMake = s.probeCost > 0 ? Math.floor(s.unusedClips / s.probeCost) : 0
        // The full-space loop: PTrust (yomi) grows the pool → Sel+Up/Dn allocates it (Step sets the
        // ±N) → Rep/Haz/Spd/Nav keep probes alive+exploring → +Probe launches; they replicate.
        text = [
          `Probes ${pcNum(s.probes)} alive · ${pcNum(s.probesBorn)} bred`,
          `+Probe ${pcNum(s.probeCost)}/ea, can make ${pcNum(canMake)}`,
          s.maxTrustUnlocked
            ? `Trust ${free}/${s.probeTrust} max${s.maxTrust} · MaxT ${pcNum(s.honor)}/${pcNum(s.maxTrustCost)} h${s.honor >= s.maxTrustCost ? '✓' : ''}`
            : `Trust free ${free}/${s.probeTrust} (max ${s.maxTrust}) · Up/Dn ±${step}`,
          `Spd ${p.Speed} Nav ${p.Nav} Rep ${p.Rep} Haz ${p.Haz}`,
          `Fac ${p.Fac} Hrv ${p.Harv} Wir ${p.Wire} Cbt ${p.Combat}`,
          s.shortage ? `> ${s.shortage}` : `> [${dim.key}] selected — Sel changes it`,
        ].join('\n')
        break
      }
      case 'swarm': {
        // Slider feedback (Adam 2026-06-28): show the current position clearly in the title
        // AND a bracketed bar, so a tap visibly moves it. sliderIdx is what we just set
        // (immediate); the game applies it on the next swarm tick.
        const si = this.sliderIdx
        title = `Paperclips · Swarm · ${PC_SLIDER_LABEL[si]}`
        const bar = PC_SLIDER_LABEL.map((l, i) => (i === si ? `[${l}]` : l)).join(' ')
        text = [
          `Status: ${s.swarmStatusLabel || '—'} · Gifts ${pcNum(s.swarmGifts)}`,
          `Slider: ${bar}`,
          'Work=production, Think=gifts · tap Slider',
          '',
          'Synch fixes Disorganized (yomi).',
          'Entmt fixes Bored/Hungry (creativity).',
        ].join('\n')
        break
      }
      default:
        text = '(?)'
    }
    return { mode: 'text', title, menu, text }
  }

  private projectsView(): WinView {
    this.shownProjects = paperclips.listProjects()
    const rows = this.shownProjects.map((p) => `${p.affordable ? '●' : '○'} ${p.title} ${p.price}`)
    const display = rows.length ? rows : ['(no projects available yet)']
    const paged = browsePageItems(display, this.projOffset)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Paperclips · Projects (${this.shownProjects.length})`,
      menu: ['Back', 'Reload', 'Main'],   // Reload re-reads listProjects() in place (new/affordable projects)
      items: paged.items,
    }
  }

  // ------------------------------------------------ input

  async onMenuSelect(label: string): Promise<void> {
    const st = paperclips.status()
    if (!st.running) return
    const verb = this.menuVerbs(paperclips.snapshot()).find((v) => v.label === label)
    if (verb) { verb.run(); this.requestRender(); return }
    this.ctx.log(`[os] paperclips ${this.level}: menu '${label}' — not a verb (Back/Reload/Main are WM-handled) (LOUD)`)
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'projects' || this.focus !== 'content') return
    const rows = this.shownProjects.map((p) => `${p.affordable ? '●' : '○'} ${p.title} ${p.price}`)
    const display = rows.length ? rows : ['(no projects available yet)']
    const { map } = browsePageItems(display, this.projOffset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] paperclips projects: index ${index} out of range`); return }
    if (m === -1) { const { prevOffset } = browsePageItems(display, this.projOffset); this.projOffset = prevOffset; this.requestRender(); return }
    if (m === -2) { const { nextOffset } = browsePageItems(display, this.projOffset); this.projOffset = nextOffset; this.requestRender(); return }
    const proj = this.shownProjects[m]
    if (!proj) { this.ctx.log('[os] paperclips projects: no project at row — resyncing'); this.requestRender(); return }
    // Cancel-first confirm before spending (body paginated in the view).
    const body = `${proj.price}\n${proj.affordable ? 'Affordable ✓' : '⚠ Not affordable yet'}\n\n${proj.description}\n\nConfirm to buy · Cancel to go back.`
    this.pending = { title: `Buy: ${proj.title}`, body, run: () => paperclips.applyProject(proj.id) }
    this.confirmPages = paginateText(body)
    this.confirmPage = 0
    this.level = 'confirm'
    this.requestRender()
  }

  /** Pop one level. false = at the dash root (GamesWindow then pops pc → games list). */
  async onBack(): Promise<boolean> {
    if (this.level === 'confirm') { this.pending = null; this.level = 'projects'; this.requestRender(); return true }
    if (this.level === 'projects') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'; this.level = 'dash'; this.requestRender(); return true
    }
    // Pop ONE level (DE: double-tap = back). 'invest' (Stocks) is reached via 'buy',
    // so it pops back there; everything else (buy/opts/drones/probe/swarm) → dash.
    if (this.level === 'invest') { this.level = 'buy'; this.requestRender(); return true }
    if (this.level !== 'dash') { this.level = 'dash'; this.requestRender(); return true }
    return false
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
    // A failed engine start retries on Reload.
    if (!paperclips.status().running) {
      void paperclips.ensureStarted().then(() => this.requestRender()).catch((e: unknown) => {
        this.ctx.log(`[os] paperclips: Reload restart failed: ${e instanceof Error ? e.message : String(e)}`)
        this.requestRender()
      })
    }
  }
}

/** Blackjack bet presets — the constant-label cycle (no numpad level). */
const BJ_BETS = [5, 10, 25, 50, 100, 250, 500] as const

/** Integers plain, else 2-dp (a 3:2 payout on an odd bet is e.g. 37.5). */
function bjMoney(n: number): string {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString()
}

/** Blackjack vs the dealer (Adam 2026-06-29, graphics-first build). A
 *  GamesWindow sub-controller mirroring PaperclipsController: it owns one
 *  Blackjack engine (pure rules; the dealer is fixed-rule, so there is NO AI
 *  subprocess) and renders the two hands as two SMALL independent image tiles
 *  (dealer=t0, player=t2) with the live numbers as cheap text. v1's whole point
 *  is proving the card-rendering UI under the G2 image-cost rule — small tiles,
 *  re-pushed ONLY when a hand changes; Hit re-pushes just the player tile,
 *  Stand/reveal just the dealer tile. Split/Double/Insurance are follow-ups.
 *  Bet is a CONSTANT-label cycle (no numpad, no layout churn). Bankroll + the
 *  in-progress hand persist to blackjack_save (re-entering resumes exactly). */
class BlackjackController {
  private readonly game = new Blackjack()
  private loaded = false
  // Per-tile render cache (chess prefetchBoard pattern, ×2). The bmp holds the
  // LAST successful render so a re-render swaps IN PLACE — it never nulls back
  // to a text placeholder mid-hand (that would flip the layout). `key` is the
  // rendered hand's signature; a mismatch kicks one re-render (seq-guarded).
  private dealerBmp: string | null = null
  private dealerKey: string | null = null
  private dealerSeq = 0
  private dealerFailed = false
  private playerBmp: string | null = null
  private playerKey: string | null = null
  private playerSeq = 0
  private playerFailed = false

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  // ----------------------------------------------- lifecycle (from GamesWindow)

  enter(): void {
    if (!this.loaded) {
      this.loaded = true
      void loadBlackjack().then((s) => {
        if (!s) return
        this.game.restore(s)
        this.dealerKey = null
        this.playerKey = null
        this.syncTiles()
        this.requestRender()
      }).catch((e: unknown) => this.ctx.log(`[os] blackjack: load failed: ${e instanceof Error ? e.message : String(e)}`))
    }
    this.syncTiles()
    this.requestRender()
  }
  onDeactivate(): void { this.persist() }
  leave(): void { this.persist() }
  dispose(): void { this.persist() }

  private persist(): void {
    void saveBlackjack(this.game.snapshot()).catch((e: unknown) =>
      this.ctx.log(`[os] blackjack: save failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  // ----------------------------------------------- tile rendering

  /** The cards as the HUD shows them: the dealer's hole (index 1) is face-DOWN
   *  until revealed; the player's are all face-up. */
  private renderCards(): { dealer: HandCard[]; player: HandCard[] } {
    const revealed = this.game.dealerRevealed()
    const dealer = this.game.dealer().map((c, i): HandCard => ({ rank: c.rank, suit: c.suit, down: !revealed && i === 1 }))
    const player = this.game.player().map((c): HandCard => ({ rank: c.rank, suit: c.suit }))
    return { dealer, player }
  }

  /** Re-render any tile whose contents changed. Called after every state change
   *  (NOT from view()), so each change kicks at most one render per tile; a
   *  superseding change drops the older render via the seq guard. */
  private syncTiles(): void {
    const { dealer, player } = this.renderCards()
    const dKey = JSON.stringify(dealer)
    const pKey = JSON.stringify(player)
    if (dealer.length && dKey !== this.dealerKey) {
      const seq = ++this.dealerSeq
      this.dealerFailed = false
      void renderHand(dealer, BJ_DEALER_RECT.w, BJ_DEALER_RECT.h).then((t: RenderedTile) => {
        if (seq !== this.dealerSeq) return
        this.dealerBmp = t.bmpBase64
        this.dealerKey = dKey
        this.requestRender()
      }).catch((e: unknown) => {
        if (seq !== this.dealerSeq) return
        this.dealerFailed = true
        this.ctx.log(`[os] blackjack: dealer render failed: ${e instanceof Error ? e.message : String(e)}`)
        this.requestRender()
      })
    }
    if (player.length && pKey !== this.playerKey) {
      const seq = ++this.playerSeq
      this.playerFailed = false
      void renderHand(player, BJ_PLAYER_RECT.w, BJ_PLAYER_RECT.h).then((t: RenderedTile) => {
        if (seq !== this.playerSeq) return
        this.playerBmp = t.bmpBase64
        this.playerKey = pKey
        this.requestRender()
      }).catch((e: unknown) => {
        if (seq !== this.playerSeq) return
        this.playerFailed = true
        this.ctx.log(`[os] blackjack: player render failed: ${e instanceof Error ? e.message : String(e)}`)
        this.requestRender()
      })
    }
  }

  // ----------------------------------------------- view

  summary(): string { return `blackjack · $${bjMoney(this.game.bankroll())}` }
  statusLine(): string | null {
    const g = this.game
    if (g.phase() === 'settled') return this.resultLine().slice(0, 46)
    if (g.phase() === 'player') return `your move · ${g.playerTotal()}`
    return null
  }

  /** Ribbon preview (READ-ONLY): bankroll, bet, shoe, and the in-progress hand
   *  totals straight from the pure in-memory engine — NO render, NO save (no
   *  renderHand subprocess, no saveBlackjack), NO mutation. */
  preview(): string | null {
    const g = this.game
    const lines = [
      `Blackjack · $${bjMoney(g.bankroll())}`,
      `Bet $${bjMoney(g.bet())} · Shoe ${Math.round(100 * g.shoeRemaining() / g.shoeFull())}%`,
    ]
    if (g.player().length) {
      lines.push(`YOU ${g.playerTotal()}`)
      lines.push(`DEALER ${g.dealerRevealed() ? g.dealerShownTotal() : `${g.dealerShownTotal()}+?`}`)
      if (g.phase() === 'settled') lines.push(this.resultLine())
      else if (g.phase() === 'player') lines.push('your move')
    } else {
      lines.push('no hand — Deal to play')
    }
    return lines.join('\n')
  }

  view(): WinView {
    const g = this.game
    const phase = g.phase()
    const menu = this.menuFor(phase)
    const title = `Blackjack · $${bjMoney(g.bankroll())} · bet $${bjMoney(g.bet())}`
    const text = this.numbersText()
    const hasHand = g.player().length > 0
    // Pre-first-deal intro, or the ONE-TIME wait before the first render lands
    // (after that the bmps persist, so we stay in hands mode — no layout flip
    // on a hit/stand; a stale bmp just shows for the render's ~hundred ms).
    if (!hasHand) return { mode: 'text', title, menu, text }
    if (!this.dealerBmp || !this.playerBmp) {
      const why = (this.dealerFailed || this.playerFailed) ? 'card render FAILED — Reload retries' : 'dealing...'
      return { mode: 'text', title, menu, text: `${why}\n\n${text}` }
    }
    return { mode: 'hands', title, menu, dealerTile: this.dealerBmp, playerTile: this.playerBmp, text }
  }

  private menuFor(phase: BjPhase): string[] {
    if (phase === 'player') return ['Hit', 'Stand', 'Reload', 'Main']
    if (this.game.bankroll() < this.game.minBet) return ['Rebuy', 'Reload', 'Main']
    return ['Deal', 'Bet', 'Reload', 'Main']
  }

  private numbersText(): string {
    const g = this.game
    // ≤6 rows for the content pane — the menu captures, so this text can't scroll
    // (review 2026-06-30: the old divider + blank spacers clipped Shoe% off the
    // bottom). DEALER / YOU / Bet+Bank / Shoe / result-or-hint.
    const lines: string[] = []
    lines.push(g.dealer().length
      ? `DEALER ${g.dealerRevealed() ? g.dealerShownTotal() : `${g.dealerShownTotal()}+?`}`
      : 'DEALER -')
    lines.push(g.player().length ? `YOU    ${g.playerTotal()}` : 'YOU    -')
    lines.push(`Bet $${bjMoney(g.bet())}   Bank $${bjMoney(g.bankroll())}`)
    lines.push(`Shoe ${Math.round(100 * g.shoeRemaining() / g.shoeFull())}%`)
    if (g.phase() === 'settled') lines.push(this.resultLine())
    else if (g.player().length === 0) lines.push('Deal to play.')
    return lines.join('\n')
  }

  private resultLine(): string {
    const g = this.game
    const d = g.lastDelta()
    const money = `${d >= 0 ? '+' : '-'}$${bjMoney(Math.abs(d))}`
    switch (g.outcome()) {
      case 'blackjack': return `BLACKJACK!  ${money}`
      case 'win': return `YOU WIN  ${money}`
      case 'lose': return isBust(g.player()) ? `BUST  ${money}` : `DEALER WINS  ${money}`
      case 'push': return 'PUSH · bet back'
      default: return ''
    }
  }

  // ----------------------------------------------- input

  /** Run a game mutation, then re-render changed tiles + persist. Engine misuse
   *  THROWS — caught + logged loud (the menu already gates by phase). */
  private act(fn: () => void): void {
    try {
      fn()
    } catch (e) {
      this.ctx.log(`[os] blackjack: action failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.syncTiles()
    this.persist()
    this.requestRender()
  }

  async onMenuSelect(label: string): Promise<void> {
    const g = this.game
    switch (label) {
      case 'Hit':
        if (g.phase() === 'player') this.act(() => g.hit())
        else this.ctx.log('[os] blackjack: Hit outside the player turn — ignored (LOUD)')
        return
      case 'Stand':
        if (g.phase() === 'player') this.act(() => g.stand())
        else this.ctx.log('[os] blackjack: Stand outside the player turn — ignored (LOUD)')
        return
      case 'Deal': {
        const bet = Math.min(g.bet() || g.minBet, g.bankroll())
        if (bet < g.minBet) { this.ctx.log('[os] blackjack: too broke to deal — Rebuy first (LOUD)'); return }
        this.act(() => g.deal(bet))
        return
      }
      case 'Bet': this.cycleBet(); return
      case 'Rebuy': this.act(() => g.rebuy(1000)); return
      default: this.ctx.log(`[os] blackjack: unknown menu '${label}' at phase ${g.phase()} — ignored (LOUD)`)
    }
  }

  /** Cycle to the next affordable preset bet (constant label; value rides the
   *  title + text — a cheap text update, NEVER a tile re-push). */
  private cycleBet(): void {
    const g = this.game
    if (g.phase() === 'player' || g.phase() === 'dealer') { this.ctx.log('[os] blackjack: Bet mid-hand — ignored (LOUD)'); return }
    const affordable = BJ_BETS.filter((b) => b <= g.bankroll())
    if (!affordable.length) { this.ctx.log('[os] blackjack: no affordable bet — Rebuy (LOUD)'); return }
    const next = affordable.find((b) => b > g.bet()) ?? affordable[0]
    try { g.setBet(next) } catch (e) { this.ctx.log(`[os] blackjack: setBet failed: ${e instanceof Error ? e.message : String(e)}`); return }
    this.persist()
    this.requestRender()
  }

  async onReload(): Promise<void> {
    // Retry any failed/stale card render (the bmp is kept; clearing the key
    // forces syncTiles to re-render).
    this.dealerKey = null
    this.playerKey = null
    this.syncTiles()
    this.requestRender()
  }

  /** No internal levels (bet is a cycle, not a level) — let GamesWindow exit to
   *  the games list. The bankroll + in-progress hand persist, so re-entering
   *  resumes exactly. */
  async onBack(): Promise<boolean> { return false }
}

/** Games (upgrades Phase 11): rpg-cli (the filesystem dungeon, root pinned to
 *  /home/user — sandbox-verified to never write outside $HOME/.rpg) and chess
 *  vs Stockfish (stateless chess_move.py rounds; the board is an IMAGE page —
 *  page-2-class tile load, placeholder-swapped like Phase 8 charts). Lichess
 *  is DEFERRED until post-testing (Adam, gate A3.2). Blackjack (2026-06-29) is
 *  a third game — the BlackjackController above. */
export class GamesWindow implements OsWindow {
  readonly id = 'games'
  readonly tab = 'Games'
  readonly label = 'Games'
  readonly category = 'Games' as const
  private level: 'menu' | 'rpg' | 'rpg-out' | 'chess' | 'chess-pieces' | 'chess-moves' | 'chess-confirm' | 'pc' | 'bj' = 'menu'
  private focus: 'content' | 'menu' = 'content'
  /** Universal Paperclips (Adam 2026-06-27) — delegated to while level === 'pc'. */
  private readonly pc: PaperclipsController
  /** Blackjack (Adam 2026-06-29) — delegated to while level === 'bj'. */
  private readonly bj: BlackjackController
  // --- rpg state ---
  private cwd = DUNGEON_ROOT
  private rpgDirs: string[] = []
  private rpgOffset = 0
  private rpgPages: string[] = []
  private rpgPage = 0
  private rpgBusy = false
  // --- chess state ---
  private fen: string | null = null
  private legal: string[] = []
  /** Moves flow (Adam 2026-06-12, revised 2026-06-13): the MENU carries piece
   *  groups → that group's SAN moves (paginated under the client's 20-item list
   *  cap) → a Confirm/Cancel step over a PREVIEW board (the move applied, no
   *  engine reply) before anything is committed. Selection levels render TEXT,
   *  not the board (every menu change re-pushed all 4 tiles otherwise — the
   *  Phase-18 redraw fix); the board shows only on chess + chess-confirm. */
  private moveGroup: string | null = null
  private movesOffset = 0
  private pendingMove: string | null = null
  private previewBoard: RenderedImage | null = null
  private previewFailed: string | null = null
  /** Bumped per preview request — a stale render must not paint a newer one. */
  private previewSeq = 0
  private skill: number = 5
  private chessTitle = 'no game'
  private chessInfo = 'New game to start. You play white.'
  private gameOver = false
  private moveInFlight = false
  /** Bumped when an in-flight chessMove is superseded (Reload unstick, New
   *  game) — its late completion checks this and discards (review 2026-06-11b). */
  private chessSeq = 0
  private board: RenderedImage | null = null
  private boardFen: string | null = null
  /** The last board render FAILED (placeholder must not claim "rendering…"
   *  forever; Reload re-requests it — review 2026-06-11b). */
  private boardFailed = false

  constructor(private ctx: WmContext, private requestRender: () => void) {
    this.pc = new PaperclipsController(ctx, requestRender)
    this.bj = new BlackjackController(ctx, requestRender)
  }

  summary(): string {
    if (this.level === 'pc') return this.pc.summary()
    if (this.level === 'bj') return this.bj.summary()
    if (this.fen && !this.gameOver) return `chess · ${this.chessTitle}`
    if (paperclips.status().running) return this.pc.summary()
    return 'rpg · chess · clips · 21'
  }

  statusLine(): string | null {
    if (this.level === 'pc') return this.pc.statusLine()
    if (this.level === 'bj') return this.bj.statusLine()
    return null
  }

  /** Ribbon preview (READ-ONLY, in-memory): delegate to the live controller for
   *  Paperclips/Blackjack, summarize the chess position (skill / title / whose
   *  move / last engine move) or rpg location, or — idle — the games list with
   *  each game's live state. NO subprocess (rpg/chess/render), NO mutation. */
  preview(): string | null {
    if (this.level === 'pc') return this.pc.preview()
    if (this.level === 'bj') return this.bj.preview()
    if (this.level === 'chess' || this.level === 'chess-pieces' || this.level === 'chess-moves' || this.level === 'chess-confirm') {
      const lines = [`Chess · skill ${this.skill}`, this.fen ? this.chessTitle : 'no game — New game to start']
      if (this.moveInFlight) lines.push('Stockfish thinking…')
      else if (this.fen && !this.gameOver) lines.push('your move (white)')
      const info = this.chessInfo.split('\n').map((l) => l.trim()).find(Boolean)
      if (info) lines.push(info.length > 40 ? info.slice(0, 39) + '…' : info)
      return lines.join('\n')
    }
    if (this.level === 'rpg' || this.level === 'rpg-out') {
      const lines = ['rpg-cli', `@ ${clampMid(this.cwd)}`]
      if (this.rpgBusy) lines.push('running…')
      return lines.join('\n')
    }
    // idle (games menu) — the list, annotated with each game's live state.
    return [
      'Games',
      `rpg · ${this.cwd === DUNGEON_ROOT ? 'dungeon root' : clampMid(this.cwd)}`,
      `chess · ${this.fen && !this.gameOver ? this.chessTitle : 'no game'}`,
      this.pc.summary(),
      this.bj.summary(),
    ].join('\n')
  }

  onDeactivate(): void {
    if (this.level === 'pc') this.pc.onDeactivate()
    if (this.level === 'bj') this.bj.onDeactivate()
  }
  /** Foregrounding Games (from Main) ALWAYS lands on the games list — not the
   *  last game played — so you can switch games freely (a chess move while the
   *  paperclips build; Adam 2026-06-28). Every game keeps running/persisting in
   *  the background (the paperclips engine, the chess position, the rpg cwd);
   *  only the VIEW resets. Mirrors the pc→menu Back exit (pc.leave stops the
   *  render-pacer + flushes — the game itself keeps ticking). */
  onActivate(): void {
    if (this.level === 'pc') this.pc.leave()
    if (this.level === 'bj') this.bj.leave()
    this.level = 'menu'
    this.focus = 'content'
  }
  dispose(): void { this.pc.dispose(); this.bj.dispose() }

  // ------------------------------------------------ rpg helpers

  /** Run one rpg-cli action. Returns true when the action actually RAN and
   *  succeeded — callers that mirror game state (the `cd` cwd update) must
   *  gate on it: the busy early-return and the error path both used to be
   *  invisible to callers, which committed `cwd` for a cd that never happened
   *  (review 2026-06-11b). Only forces the rpg-out level if the user is still
   *  in the rpg area — a slow result must not yank them out of chess/menu. */
  private async rpgAction(args: string[]): Promise<boolean> {
    if (this.rpgBusy) { this.ctx.log('[os] games: rpg action while one is running — ignored (LOUD)'); return false }
    this.rpgBusy = true
    this.requestRender()
    let ok = false
    try {
      const out = await rpgRun(args, this.cwd)
      this.rpgPages = paginateText(out)
      ok = true
    } catch (e) {
      this.ctx.log(`[os] games: rpg ${args.join(' ')} failed: ${(e as Error).message}`)
      this.rpgPages = paginateText(`ERROR running rpg-cli ${args.join(' ')}:\n\n${(e as Error).message}`)
    }
    this.rpgBusy = false
    this.rpgPage = 0
    if (this.level === 'rpg' || this.level === 'rpg-out') {
      this.level = 'rpg-out'
    } else {
      this.ctx.log(`[os] games: rpg output ready but the user left the rpg area (level=${this.level}) — stored, not shown`)
    }
    this.requestRender()
    return ok
  }

  private listDungeonDirs(): string[] {
    try {
      return readdirSync(this.cwd, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b))
    } catch (e) {
      this.ctx.log(`[os] games: cannot list ${this.cwd}: ${(e as Error).message}`)
      return []
    }
  }

  // ------------------------------------------------ chess helpers

  private applyChessState(st: ChessState): void {
    this.fen = st.fen
    this.legal = st.legalMoves
    this.movesOffset = 0
    this.gameOver = st.status !== 'ongoing'
    this.chessTitle = this.gameOver
      ? `${st.status}${st.winner ? ` — ${st.winner === 'you' ? 'you WIN' : 'Stockfish wins'}` : ''}`
      : `mv${st.moveNumber}${st.check ? ' +CHECK' : ''}`
    this.chessInfo = [
      st.engineMove ? `Stockfish: ${st.engineMove}` : null,
      st.check && !this.gameOver ? 'You are in CHECK.' : null,
      this.gameOver ? `Game over: ${st.status}${st.winner ? ` (${st.winner === 'you' ? 'you win!' : 'Stockfish wins'})` : ''}` : null,
    ].filter(Boolean).join('\n')
    this.prefetchBoard()
  }

  /** Phase-8 pattern: render async, placeholder until the swap. */
  private prefetchBoard(): void {
    const fen = this.fen
    if (!fen) return
    this.boardFailed = false
    void renderBoard(fen, DE_CONTENT_W, DE_CONTENT_H).then((img) => {
      if (this.fen !== fen) return   // a newer position superseded this render
      this.board = img
      this.boardFen = fen
      this.requestRender()
    }).catch((e: unknown) => {
      if (this.fen !== fen) {
        // A stale render's failure must not clobber the CURRENT position's info.
        this.ctx.log(`[os] games: stale board render failed (superseded): ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      this.ctx.log(`[os] games: board render failed: ${e instanceof Error ? e.message : String(e)}`)
      this.boardFailed = true
      this.chessInfo = `Board render FAILED: ${e instanceof Error ? e.message : String(e)}\n(the game state is intact — Moves still works; Reload retries the board)`
      this.requestRender()
    })
  }

  private async applyChessMove(move: string | null): Promise<void> {
    if (this.moveInFlight) { this.ctx.log('[os] games: move while engine is thinking — ignored (LOUD)'); return }
    this.moveInFlight = true
    // Generation token: onReload's unstick (and New game after it) supersede an
    // in-flight move — its late result must NOT clobber the new game state
    // (the comment in onReload used to CLAIM a fen-identity check that only
    // existed for board images; review 2026-06-11b).
    const seq = ++this.chessSeq
    this.level = 'chess'
    this.requestRender()   // title shows thinking…
    try {
      const st = await chessMove(move ? this.fen : null, move, this.skill)
      if (seq !== this.chessSeq) {
        this.ctx.log(`[os] games: stale chess result for '${move ?? 'new game'}' discarded (superseded by Reload/New game)`)
        return
      }
      this.applyChessState(st)
    } catch (e) {
      if (seq !== this.chessSeq) {
        this.ctx.log(`[os] games: stale chess FAILURE for '${move ?? 'new game'}' discarded: ${(e as Error).message}`)
        return
      }
      this.ctx.log(`[os] games: chess move '${move}' failed: ${(e as Error).message}`)
      this.chessInfo = `Move FAILED: ${(e as Error).message}`
    }
    this.moveInFlight = false
    this.requestRender()
  }

  // -------------------------------------- chess Moves flow (Adam 2026-06-12)

  private static readonly PIECE_ORDER = ['Pawn', 'Knight', 'Bishop', 'Rook', 'Queen', 'King'] as const

  private groupOf(san: string): string {
    if (san.startsWith('O-O')) return 'King'   // castling
    const m: Record<string, string> = { N: 'Knight', B: 'Bishop', R: 'Rook', Q: 'Queen', K: 'King' }
    return m[san[0]] ?? 'Pawn'
  }

  private pieceGroups(): { name: string; moves: string[] }[] {
    const by = new Map<string, string[]>()
    for (const san of this.legal) {
      const g = this.groupOf(san)
      const arr = by.get(g) ?? []
      arr.push(san)
      by.set(g, arr)
    }
    return GamesWindow.PIECE_ORDER.filter((n) => by.has(n)).map((n) => ({ name: n, moves: by.get(n)! }))
  }

  /** The SAN page for the selected group — ≤12 moves + optional » prev/» more
   *  rows keeps the MENU under the client's 20-item native-list cap (a pawn
   *  group can exceed 20 SANs with promotions). */
  private movesMenuPage(): string[] {
    const g = this.pieceGroups().find((x) => x.name === this.moveGroup)
    const moves = g?.moves ?? []
    const page = moves.slice(this.movesOffset, this.movesOffset + 12)
    const menu: string[] = []
    if (this.movesOffset > 0) menu.push('» prev')
    menu.push(...page)
    if (this.movesOffset + 12 < moves.length) menu.push('» more')
    menu.push('Back', 'Reload', 'Main')
    return menu
  }

  /** Kick the preview render (move applied, NO engine reply) for the confirm
   *  step. Stale-guarded: navigation/Cancel bumps previewSeq. */
  private startPreview(san: string): void {
    const fen = this.fen
    if (!fen) return
    const seq = ++this.previewSeq
    this.pendingMove = san
    this.previewBoard = null
    this.previewFailed = null
    this.level = 'chess-confirm'
    this.requestRender()
    void chessPreview(fen, san).then(async (st) => {
      if (seq !== this.previewSeq) return
      const img = await renderBoard(st.fen, DE_CONTENT_W, DE_CONTENT_H)
      if (seq !== this.previewSeq) return
      this.previewBoard = img
      this.requestRender()
    }).catch((e: unknown) => {
      if (seq !== this.previewSeq) return
      const msg = e instanceof Error ? e.message : String(e)
      this.ctx.log(`[os] games: preview '${san}' failed: ${msg}`)
      this.previewFailed = msg
      this.requestRender()
    })
  }

  private clearPreview(): void {
    this.previewSeq++
    this.pendingMove = null
    this.previewBoard = null
    this.previewFailed = null
  }

  /** The board-tiles view for chess-confirm (the move PREVIEW). Text placeholder
   *  while the render is in flight. (As of 2026-06-13 the pieces/moves selection
   *  levels render text, not the board — only confirm + the chess level show
   *  tiles, so this is the confirm/preview path.) */
  private chessBoardView(title: string, menu: string[], preview: boolean): WinView {
    const img = preview ? this.previewBoard : (this.fen && this.boardFen === this.fen ? this.board : null)
    if (img) return { mode: 'tiles', tilesRect: { w: img.w, h: img.h }, title, menu, tiles: img.tiles }
    const text = preview
      ? (this.previewFailed ? `preview FAILED:\n${this.previewFailed}\n\nCancel to go back.` : `⏳ previewing ${this.pendingMove}…`)
      : (this.boardFailed ? this.chessInfo : `⏳ board rendering…\n\n${this.chessInfo}`)
    return { mode: 'text', title, menu, text }
  }

  // ------------------------------------------------ views

  async view(): Promise<WinView> {
    if (this.level === 'pc') return this.pc.view()
    if (this.level === 'bj') return this.bj.view()
    const menuMode = this.focus === 'menu' ? 'capture' as const : 'passive' as const
    if (this.level === 'rpg-out') {
      const pageSuffix = this.rpgPages.length > 1 ? ` · ${this.rpgPage + 1}/${this.rpgPages.length}` : ''
      return {
        mode: 'text',
        title: `rpg · ${clampMid(this.cwd)}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.rpgPages[this.rpgPage] ?? '',
      }
    }
    if (this.level === 'rpg') {
      this.rpgDirs = this.listDungeonDirs()
      const rows = [
        ...RPG_ACTIONS,
        ...(this.cwd !== DUNGEON_ROOT ? ['..'] : []),
        ...this.rpgDirs.map((d) => d + '/'),
      ]
      const paged = browsePageItems(rows, this.rpgOffset)
      return {
        mode: 'browse',
        menuMode,
        title: `rpg · ${clampMid(this.cwd)}${this.rpgBusy ? ' · running…' : ''}`,
        menu: ['Reload', 'Main'],
        items: paged.items,
      }
    }
    if (this.level === 'chess-pieces') {
      // Selection is TEXT-ONLY (Adam 2026-06-13): the board was shown here, but
      // each menu change (pieces→moves) forced an f1=7 layout rebuild that
      // re-pushed all 4 tiles (~4 s) even though the position was unchanged. The
      // board now shows only where the position is NEW — the chess level (live)
      // and chess-confirm (preview). Pick from the menu; the body is context.
      const groups = this.pieceGroups()
      const menu = [...groups.map((g) => `${g.name} (${g.moves.length})`), 'Back', 'Reload', 'Main']
      return { mode: 'text', title: 'Chess · pick a piece', menu, text: `${this.chessInfo}\n\nPick a piece from the menu.` }
    }
    if (this.level === 'chess-moves') {
      const g = this.pieceGroups().find((x) => x.name === this.moveGroup)
      return {
        mode: 'text',
        title: `Chess · ${this.moveGroup ?? '?'} (${g?.moves.length ?? 0})`,
        menu: this.movesMenuPage(),
        text: `${this.chessInfo}\n\nPick ${this.moveGroup ?? 'a'} move from the menu;\nConfirm then shows a board preview.`,
      }
    }
    if (this.level === 'chess-confirm') {
      return this.chessBoardView(`Chess · ${this.pendingMove ?? '?'} — confirm?`,
        ['Confirm', 'Cancel', 'Reload', 'Main'], true)
    }
    if (this.level === 'chess') {
      const thinking = this.moveInFlight ? ' · thinking…' : ''
      // Skill is a CONSTANT menu label (its value rides the TITLE — a cheap text
      // update) so cycling it never changes the menu list, never triggers an
      // f1=7 rebuild, never re-pushes the board (Adam 2026-06-13). Only a
      // genuinely-new FEN pushes tiles; the per-tile client diff then re-sends
      // just the squares that changed.
      const title = `Chess · ${this.chessTitle} · skill ${this.skill}${thinking}`
      const menu = this.fen && !this.gameOver
        ? ['Moves', 'New game', 'Skill', 'Back', 'Reload', 'Main']
        : ['New game', 'Skill', 'Back', 'Reload', 'Main']
      if (this.fen && this.board && this.boardFen === this.fen) {
        return { mode: 'tiles', tilesRect: { w: this.board.w, h: this.board.h }, title, menu, tiles: this.board.tiles }
      }
      // boardFailed: show the failure honestly — the old "⏳ board rendering…"
      // header above a render FAILURE was a permanent lie (review 2026-06-11b).
      const text = this.fen
        ? (this.boardFailed ? this.chessInfo : `⏳ board rendering…\n\n${this.chessInfo}`)
        : `Chess vs Stockfish\n\n${this.chessInfo}`
      return { mode: 'text', title, menu, text }
    }
    // games menu
    return {
      mode: 'browse',
      menuMode,
      title: 'Games',
      menu: ['Reload', 'Main'],
      items: ['rpg-cli — the filesystem dungeon', 'Chess vs Stockfish', 'Universal Paperclips — idle game', 'Blackjack — vs the dealer'],
    }
  }

  // ------------------------------------------------ input

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'pc') { await this.pc.onBrowseSelect(index); return }
    if (this.level === 'menu') {
      if (index === 0) { this.level = 'rpg'; this.rpgOffset = 0; this.focus = 'content'; this.requestRender(); return }
      if (index === 1) { this.level = 'chess'; this.focus = 'content'; this.requestRender(); return }
      if (index === 2) { this.level = 'pc'; this.pc.enter(); return }
      if (index === 3) { this.level = 'bj'; this.focus = 'content'; this.bj.enter(); return }
      this.ctx.log(`[os] games: menu index ${index} out of range`)
      return
    }
    if (this.level === 'rpg') {
      const rows = [
        ...RPG_ACTIONS,
        ...(this.cwd !== DUNGEON_ROOT ? ['..'] : []),
        ...this.rpgDirs.map((d) => d + '/'),
      ]
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.rpgOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] games: rpg index ${index} out of range`); return }
      if (m === -1) { this.rpgOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.rpgOffset = nextOffset; this.requestRender(); return }
      const row = rows[m]
      if (row === undefined) { this.ctx.log(`[os] games: rpg row ${m} resolves to nothing — resyncing`); this.requestRender(); return }
      switch (row) {
        case '» stat': await this.rpgAction(['stat']); return
        case '» battle': await this.rpgAction(['battle']); return
        case '» ls (inspect)': await this.rpgAction(['ls']); return
        case '» todo': await this.rpgAction(['todo']); return
        case '» buy (list shop)': await this.rpgAction(['buy']); return
        case '..': {
          const parent = this.cwd.split('/').slice(0, -1).join('/') || '/'
          if (!parent.startsWith(DUNGEON_ROOT)) { this.ctx.log('[os] games: rpg .. blocked at dungeon root'); return }
          // Advance the window's cwd ONLY when the cd actually ran — a busy-
          // ignored or failed cd used to desync it from the hero's real
          // location (review 2026-06-11b). Re-render so the rpg-out title
          // shows the NEW cwd.
          if (await this.rpgAction(['cd', '..'])) {
            this.cwd = parent
            this.rpgOffset = 0
            this.requestRender()
          }
          return
        }
        default: {
          const dir = row.endsWith('/') ? row.slice(0, -1) : row
          if (await this.rpgAction(['cd', dir])) {   // battles can trigger on the way
            this.cwd = join(this.cwd, dir)
            this.rpgOffset = 0
            this.requestRender()
          }
          return
        }
      }
    }
    this.ctx.log(`[os] games: browse select ${index} at ${this.level} — ignored`)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'pc') { await this.pc.onMenuSelect(label); return }
    if (this.level === 'bj') { await this.bj.onMenuSelect(label); return }
    if (this.level === 'rpg-out') {
      switch (label) {
        case 'Next': if (this.rpgPage < this.rpgPages.length - 1) { this.rpgPage++; this.requestRender() } break
        case 'Prev': if (this.rpgPage > 0) { this.rpgPage--; this.requestRender() } break
        default: this.ctx.log(`[os] games rpg-out: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    if (this.level === 'chess-pieces') {
      const g = this.pieceGroups().find((x) => label === `${x.name} (${x.moves.length})`)
      if (g) {
        this.moveGroup = g.name
        this.movesOffset = 0
        this.level = 'chess-moves'
        this.requestRender()
        return
      }
      this.ctx.log(`[os] games pieces: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'chess-moves') {
      if (label === '» more') { this.movesOffset += 12; this.requestRender(); return }
      if (label === '» prev') { this.movesOffset = Math.max(0, this.movesOffset - 12); this.requestRender(); return }
      const g = this.pieceGroups().find((x) => x.name === this.moveGroup)
      if (g?.moves.includes(label)) {
        this.startPreview(label)   // → chess-confirm with the preview board
        return
      }
      this.ctx.log(`[os] games moves: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'chess-confirm') {
      if (label === 'Confirm') {
        const san = this.pendingMove
        this.clearPreview()
        if (!san) { this.ctx.log('[os] games: Confirm with no pending move — ignored (LOUD)'); this.level = 'chess'; this.requestRender(); return }
        await this.applyChessMove(san)   // the REAL path — engine replies; lands on 'chess'
        return
      }
      if (label === 'Cancel') {
        this.clearPreview()
        this.level = 'chess-moves'   // back to the move list, board reverts (cached)
        this.requestRender()
        return
      }
      this.ctx.log(`[os] games confirm: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'chess') {
      if (label === 'Moves') {
        if (!this.fen || this.gameOver || this.moveInFlight) { this.ctx.log('[os] games: Moves unavailable right now — ignored (LOUD)'); return }
        this.level = 'chess-pieces'
        this.moveGroup = null
        this.movesOffset = 0
        this.requestRender()
        return
      }
      if (label === 'New game') {
        await this.applyChessMove(null)
        return
      }
      if (label === 'Skill') {
        this.skill = cycleNext(CHESS_SKILLS as unknown as readonly number[], this.skill)
        this.ctx.log(`[os] games: chess skill → ${this.skill} (applies to the next engine move)`)
        this.requestRender()   // title updates (text); the board tiles are NOT re-pushed
        return
      }
      this.ctx.log(`[os] games chess: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    this.ctx.log(`[os] games: menu '${label}' at ${this.level} — ignored`)
  }

  async onReload(): Promise<void> {
    if (this.level === 'pc') { await this.pc.onReload(); return }
    if (this.level === 'bj') { await this.bj.onReload(); return }
    this.focus = 'content'
    // Unstick a wedged in-flight flag (the documented Reload contract). The
    // chessSeq bump makes the orphaned subprocess result ACTUALLY drop — the
    // old comment claimed a fen-identity check that only existed for board
    // images (review 2026-06-11b). NOTE: the orphaned rpg-cli/chess process
    // may still be running and mutating its own state; the unstick only
    // detaches the UI from it.
    if (this.moveInFlight) {
      this.ctx.log('[os] games: Reload cleared a stuck chess moveInFlight (orphaned result will be discarded)')
      this.moveInFlight = false
      this.chessSeq++
    }
    if (this.rpgBusy) { this.ctx.log('[os] games: Reload cleared a stuck rpgBusy (the orphaned run may still mutate the dungeon)'); this.rpgBusy = false }
    if (this.level === 'chess-confirm' && this.pendingMove && !this.previewBoard && !this.previewFailed) {
      this.ctx.log('[os] games: Reload retrying the stuck preview')
      const san = this.pendingMove
      this.clearPreview()
      this.startPreview(san)
    }
    // A failed board render retries on Reload (the failure card says so).
    if (this.fen && this.boardFen !== this.fen) {
      this.ctx.log('[os] games: Reload re-requesting the board render')
      this.prefetchBoard()
    }
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'pc') {
      if (await this.pc.onBack()) return true
      this.pc.leave()
      this.level = 'menu'; this.focus = 'content'; this.requestRender(); return true
    }
    if (this.level === 'bj') {
      if (await this.bj.onBack()) return true
      this.bj.leave()
      this.level = 'menu'; this.focus = 'content'; this.requestRender(); return true
    }
    if (this.level === 'rpg-out') { this.level = 'rpg'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'chess-confirm') {
      // Double-tap on the confirm step = Cancel (never silently apply).
      this.clearPreview()
      this.level = 'chess-moves'
      this.requestRender()
      return true
    }
    if (this.level === 'chess-moves') { this.level = 'chess-pieces'; this.requestRender(); return true }
    if (this.level === 'chess-pieces') { this.level = 'chess'; this.requestRender(); return true }
    if (this.level === 'chess' || this.level === 'rpg') {
      if (this.focus === 'content' && (this.level === 'rpg')) { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'menu'
      this.requestRender()
      return true
    }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}

/** Middle-ellipsize a path for a title slot (the compose-side clamp is the
 *  loud backstop; this just keeps the tail readable). */
function clampMid(p: string): string {
  return p.length <= 28 ? p : p.slice(0, 10) + '…' + p.slice(-17)
}
