// Universal Paperclips engine host — runs the REAL, unmodified game headlessly
// inside jsdom (no browser, no subprocess) and exposes a tiny read/drive API to
// the Games window. Design validated 2026-06-27 (the jsdom spike): the game's
// own `window.setInterval` economy loops tick on Node timers in real time, all
// ~165 state globals are readable, and every action is a directly-callable
// global function. The vendored game + provenance live in
// `/home/user/G2CC/games/paperclips/` (see SOURCE.md) — we never fork the
// balance, we read globals and call functions.
//
// THE ONE LOAD-BEARING FIX (spike): jsdom needs a real `url:` or `localStorage`
// is an opaque-origin throw at the game's top-level save check — which aborts
// the rest of main.js, including the economy-loop registration (the game froze
// at ticks:0). With a url it runs clean.
//
// LIFECYCLE (load-bearing): the engine is a PROCESS-LIFETIME singleton, NOT a
// per-connection resource. It is an idle game — autoclippers/drones/probes must
// keep ticking while Adam is away and across phone reconnects. So a ws-close
// (WM.dispose) must NOT tear it down; it only flushes a save. The game is torn
// down only at process exit. One game, one save (single-player).
//
// FAILURE POLICY: loud and proud (the Three Absolute Rules). A jsdom load
// failure, a missing action function, a thrown effect, or a dead Postgres all
// surface — never a silent swallow. The save chain is fire-and-forget but its
// last error is exposed via status() so the window can show '⚠ unsaved'. NO
// timeouts anywhere (the pacer is a periodic task, like Main's dashboardPacer —
// not a time-bounded wait).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom'
import { query, registerMigration } from './store.js'

/** Vendored game dir (pinned upstream + cleaned scaffold). Env override for the
 *  smoke suite, mirroring the rest of the codebase. */
const GAME_DIR = process.env.G2CC_PAPERCLIPS_DIR ?? '/home/user/G2CC/games/paperclips'
/** Single-player save row. */
const SAVE_ID = 'default'
/** Upstream load order (combat defines battle helpers main.js references). */
const GAME_FILES = ['combat.js', 'globals.js', 'projects.js', 'main.js'] as const
/** A real origin so localStorage is not opaque (the load-bearing fix). */
const GAME_URL = 'https://www.decisionproblem.com/paperclips/'

/** Pacer cadence. Auto-quantum is polled every tick; the save mirror runs every
 *  SAVE_EVERY_TICKS. 150 ms × 200 ≈ 30 s between Postgres mirrors (the game
 *  auto-saves to localStorage far more often; we only mirror that to disk). */
const PACER_MS = 150
const SAVE_EVERY_TICKS = 200

registerMigration('2026-06-27-paperclips-save', `CREATE TABLE IF NOT EXISTS paperclips_save (
  id text PRIMARY KEY,
  blob jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`)

export type PcPhase = 'business' | 'space' | 'end'

/** One available project (the "growing UI" array — activeProjects). */
export interface PcProject {
  id: string
  title: string
  price: string
  description: string
  affordable: boolean
}

/** The curated state the window renders. Numbers are raw game globals (the
 *  window formats them); a few murky display strings are read straight from the
 *  game's own DOM so we show exactly what the game shows (demand, the latest
 *  message) instead of re-deriving a formula. */
export interface PcSnapshot {
  running: boolean
  phase: PcPhase
  ticks: number
  message: string            // the game's latest readout line
  // --- business / clips ---
  clips: number
  unsoldClips: number
  clipRate: number           // clipmakerRate (clips/sec)
  funds: number
  avgRev: number
  margin: number             // price per clip
  demandPct: string          // the game's own "Public Demand %" display string
  wire: number
  wireCost: number
  wireBuyerOn: boolean
  wireBuyerUnlocked: boolean
  marketingLvl: number
  adCost: number
  autoClippers: number       // clipmakerLevel
  clipperCost: number
  autoClipperUnlocked: boolean
  megaClippers: number       // megaClipperLevel
  megaClipperCost: number
  megaClipperUnlocked: boolean
  // --- compute ---
  compUnlocked: boolean
  trust: number
  nextTrust: number
  processors: number
  memory: number
  operations: number
  opMax: number              // memory * 1000
  creativity: number
  creativityOn: boolean
  // strategic modeling (tournaments → yomi)
  stratUnlocked: boolean
  yomi: number
  tourneyInProgress: boolean
  autoTourneyOn: boolean
  autoTourneyUnlocked: boolean
  // investment
  investUnlocked: boolean
  investBankroll: number
  investStocks: number       // portValue
  investLevel: number
  investRisk: string         // the risk selector: 'low' | 'med' | 'hi'
  // quantum
  qUnlocked: boolean
  qChipsActive: number
  qSum: number               // current Σ chip value (the auto-fire signal)
  autoQuantum: boolean
  // --- space ---
  spaceUnlocked: boolean
  availableMatter: number
  acquiredMatter: number
  wireSpace: number          // nanoWire (wire stock in space)
  factories: number
  factoryCost: number
  harvesters: number
  harvesterCost: number
  wireDrones: number
  wireDroneCost: number
  farms: number
  farmCost: number
  batteries: number
  batteryCost: number
  storedPower: number
  swarmUnlocked: boolean
  swarmGifts: number
  swarmStatus: number
  // probes
  probesUnlocked: boolean
  probes: number             // probeCount
  probesLaunched: number
  probesBorn: number
  probeCost: number
  colonizedPct: number       // 100 * foundMatter / totalMatter
  drifters: number
  driftersKilled: number
  // probe-trust allocation
  probeTrust: number
  probeUsedTrust: number
  probe: { Speed: number; Nav: number; Rep: number; Haz: number; Fac: number; Harv: number; Wire: number; Combat: number }
  // combat
  combatUnlocked: boolean
  honor: number
  maxTrust: number
  // endgame
  dismantle: number
  // review additions (2026-06-27)
  humanEra: boolean          // humanFlag===1 (the clip-market era; false from HypnoDrones onward)
  powMod: number             // power "performance" fraction (1 = full; <1 = power-starved, throttles matter)
  swarmStatusLabel: string   // the game's own swarm word (Active/Hungry/Bored/Disorganized/Sleeping/…)
  sliderPos: number          // swarm Work(0)↔Think(200) slider position
}

/** Status for the window's statusLine + Main summary. */
export interface PcStatus {
  running: boolean
  loadError: string | null
  saveError: string | null
  ticks: number
}

type Win = Record<string, unknown> & { document: Document }

class PaperclipsEngine {
  private jsdom: JSDOM | null = null
  private win: Win | null = null
  private starting: Promise<void> | null = null
  private loadError: string | null = null
  private saveError: string | null = null
  private autoQuantum = false
  private pacer: ReturnType<typeof setInterval> | null = null
  private pacerTicks = 0
  /** Serialized fire-and-forget save chain (the Reader persist-chain pattern):
   *  rapid saves run in order, last-write-wins, never awaited in a render path. */
  private saveChain: Promise<void> = Promise.resolve()

  // ---------------------------------------------------------------- lifecycle

  /** Lazily boot the game; single-flight so concurrent opens share one boot.
   *  Resolves once the game is running (or rejects loudly with the load error). */
  ensureStarted(): Promise<void> {
    if (this.win) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.start().catch((e: unknown) => {
        this.loadError = e instanceof Error ? e.message : String(e)
        this.starting = null   // allow a later retry (Reload)
        throw e
      })
    }
    return this.starting
  }

  private async start(): Promise<void> {
    // 1) restore the save into a plain map BEFORE the DOM exists, so we can seed
    //    localStorage before main.js runs its top-level load() check.
    const saved = await this.restore()

    // 2) build the DOM from the cleaned scaffold (no <script> tags — we inject).
    const html = readFileSync(join(GAME_DIR, 'index.html'), 'utf8')
    const vc = new VirtualConsole()
    // The game logs to console; route to our log, drop nothing silently.
    // A jsdomError BEFORE the game finishes loading (this.win still null) is a
    // fatal load error; one AFTER boot is a transient runtime throw from a game
    // timer — log it, but don't let it permanently poison loadError/statusLine
    // (review 2026-06-27, O1).
    vc.on('jsdomError', (e: Error) => {
      if (!this.win) this.loadError = e.message
      console.error(`[paperclips] jsdom: ${e.message}`)
    })
    const dom = new JSDOM(html, {
      url: GAME_URL,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse: (window) => this.installShims(window),
    })
    const win = window2win(dom.window)

    // 3) seed localStorage from the save (the game auto-loads it on init).
    try {
      for (const [k, v] of Object.entries(saved)) dom.window.localStorage.setItem(k, v)
    } catch (e) {
      throw new Error(`seeding localStorage failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 4) inject the four game files in upstream order; a throw here is fatal+loud.
    for (const f of GAME_FILES) {
      const code = readFileSync(join(GAME_DIR, f), 'utf8')
      const script = dom.window.document.createElement('script')
      script.textContent = code
      dom.window.document.body.appendChild(script)
    }

    // 5) sanity: the economy must actually be wired (the spike's frozen-tick trap).
    if (typeof win['clipClick'] !== 'function' || typeof win['ticks'] !== 'number') {
      throw new Error('game loaded but clipClick/ticks missing — the engine did not initialize')
    }

    this.jsdom = dom
    this.win = win
    this.loadError = null
    this.startPacer()
    console.log(`[paperclips] engine started (${saved && Object.keys(saved).length ? 'resumed save' : 'new game'})`)
  }

  private installShims(window: DOMWindow): void {
    // These are deliberately-untyped browser-shim pokes (replacing constructors /
    // a prototype method / a document method), so we narrow to just what we set.
    const w = window as unknown as {
      Audio: unknown
      HTMLCanvasElement: { prototype: { getContext: unknown } }
    }
    // Audio: globals.js does `new Audio()` at load (the threnody easter-egg).
    w.Audio = class { src = ''; addEventListener(): void {} play(): Promise<void> { return Promise.resolve() } pause(): void {} load(): void {} }
    // canvas 2d context — combat.js draws the probe battle; cosmetic on glass.
    const noop: unknown = new Proxy(function () { /* no-op */ }, { get: () => noop, apply: () => undefined })
    w.HTMLCanvasElement.prototype.getContext = () => noop
    // confirm/alert/prompt — the endgame restart calls confirm() (projects.js:2389);
    // jsdom's default emits a "Not implemented" jsdomError AND returns false, which
    // both blocks the in-game restart and poisons loadError. The G2CC Projects flow
    // already gates every spend with its own Cancel-first confirm, so auto-yes here.
    const dlg = window as unknown as { confirm: () => boolean; alert: () => void; prompt: () => null }
    dlg.confirm = () => true
    dlg.alert = () => {}
    dlg.prompt = () => null
    // getElementById fallback: main.js caches many ids at load and writes them
    // every tick; any id the scaffold lacks gets a real, attached stub so a
    // `.innerHTML=`/`.style` never null-derefs (and project buttons get a real
    // parentNode for effect()'s removeChild).
    const doc = window.document
    const real = doc.getElementById.bind(doc)
    const stubs = new Map<string, HTMLElement>()
    doc.getElementById = (id: string): HTMLElement | null => {
      const found = real(id)
      if (found) return found
      const cached = stubs.get(id)
      if (cached) return cached
      const el = doc.createElement(id === 'canvas' ? 'canvas' : 'div')
      el.id = id
      doc.body.appendChild(el)
      stubs.set(id, el)
      return el
    }
  }

  // ---------------------------------------------------------------- the pacer

  private startPacer(): void {
    if (this.pacer) return
    this.pacer = setInterval(() => this.onPacerTick(), PACER_MS)
    if (typeof this.pacer.unref === 'function') this.pacer.unref()   // don't keep the process alive on our account
  }

  private onPacerTick(): void {
    const win = this.win
    if (!win) return
    // Whole body guarded: a setInterval callback that throws is an
    // uncaughtException that could kill the server (review 2026-06-27, O4).
    try {
      if (this.autoQuantum) this.autoFireQuantum(win)
      this.pacerTicks++
      if (this.pacerTicks % SAVE_EVERY_TICKS === 0) this.save()
    } catch (e) {
      console.error(`[paperclips] pacer tick error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Auto-quantum (Adam 2026-06-27): the real game needs twitch-timing — watch
   *  the oscillating photonic chips and click only when their sum is positive.
   *  Unplayable over BLE, so when the toggle is on we do it: fire qComp() iff the
   *  live Σ chip value > 0. The chips read 0 until photonics exist, so this is a
   *  natural no-op pre-quantum. */
  private autoFireQuantum(win: Win): void {
    const chips = win['qChips'] as { value: number; active: number }[] | undefined
    if (!Array.isArray(chips) || chips.length === 0) return
    if (!chips[0] || chips[0].active === 0) return
    let sum = 0
    for (const c of chips) sum += c.value
    if (sum > 0) (win['qComp'] as () => void)()
  }

  // ---------------------------------------------------------------- driving

  /** Call a game action global by name. Loud on a missing/non-function name or a
   *  thrown body — never a silent no-op. */
  call(fn: string, ...args: unknown[]): void {
    const win = this.win
    if (!win) { console.error(`[paperclips] call('${fn}') before start — ignored (LOUD)`); return }
    const f = win[fn]
    if (typeof f !== 'function') { console.error(`[paperclips] call('${fn}'): not a function (LOUD)`); return }
    try {
      (f as (...a: unknown[]) => unknown).apply(win, args)
    } catch (e) {
      console.error(`[paperclips] call('${fn}') threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Make up to 1000 paperclips this tap (Adam 2026-06-27: one-clip taps are
   *  useless at BLE latency). clipClick(n) self-clamps to available wire — makes
   *  min(1000, wire), or nothing if wire < 1. */
  bulkClip(): void { this.call('clipClick', 1000) }

  /** The available projects (activeProjects), each with its current
   *  affordability (cost() evaluated now). The "growing UI" array, read live. */
  listProjects(): PcProject[] {
    const win = this.win
    if (!win) return []
    const active = win['activeProjects'] as ProjectObj[] | undefined
    if (!Array.isArray(active)) return []
    const out: PcProject[] = []
    for (const p of active) {
      if (!p || typeof p.id !== 'string') continue
      let affordable = false
      try { affordable = !!(typeof p.cost === 'function' ? p.cost() : false) } catch (e) { affordable = false; console.error(`[paperclips] project ${p.id} cost() threw: ${e instanceof Error ? e.message : String(e)}`) }
      out.push({
        id: p.id,
        title: String(p.title ?? p.id).trim(),
        price: String(p.priceTag ?? '').trim(),
        description: String(p.description ?? '').trim(),
        affordable,
      })
    }
    return out
  }

  /** Fire a project's effect (exactly what its button onclick does). Refuses
   *  loudly if it's not currently affordable, so a stale tap can't force an
   *  unaffordable buy. Returns true iff the effect ran. */
  applyProject(id: string): boolean {
    const win = this.win
    if (!win) { console.error(`[paperclips] applyProject('${id}') before start — ignored (LOUD)`); return false }
    const active = win['activeProjects'] as ProjectObj[] | undefined
    const p = Array.isArray(active) ? active.find((x) => x && x.id === id) : undefined
    if (!p) { console.error(`[paperclips] applyProject('${id}'): not in activeProjects (LOUD)`); return false }
    let affordable = false
    try { affordable = !!(typeof p.cost === 'function' ? p.cost() : false) } catch (e) { affordable = false; console.error(`[paperclips] project ${p.id} cost() threw: ${e instanceof Error ? e.message : String(e)}`) }
    if (!affordable) { console.error(`[paperclips] applyProject('${id}'): not affordable yet (LOUD)`); return false }
    try {
      if (typeof p.effect !== 'function') { console.error(`[paperclips] applyProject('${id}'): no effect() (LOUD)`); return false }
      p.effect()
      return true
    } catch (e) {
      console.error(`[paperclips] applyProject('${id}') threw: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  setAutoQuantum(on: boolean): void { this.autoQuantum = on }
  isAutoQuantum(): boolean { return this.autoQuantum }

  /** DEBUG/TEST: set a game global directly (loud). Not used by the UI — it
   *  exists for the smoke test (forcing a phase deterministically) and for
   *  ad-hoc debugging of the live game. */
  poke(name: string, value: number): void {
    if (!this.win) { console.error(`[paperclips] poke('${name}') before start — ignored (LOUD)`); return }
    this.win[name] = value
  }

  /** Swarm Work↔Think slider (Adam wants the gift economy reachable). The game
   *  reads `sliderElement.value` each swarm tick, so we set the DOM element (not
   *  the global, which gets overwritten). 0 = full Work (max production, no
   *  gifts); 200 = full Think (gifts, no matter processing). */
  setSlider(value: number): void {
    const el = this.win?.document.getElementById('slider') as HTMLInputElement | null
    if (!el) { console.error('[paperclips] setSlider: no #slider element — ignored (LOUD)'); return }
    el.value = String(Math.max(0, Math.min(200, Math.round(value))))
  }

  /** Investment risk selector (low/med/hi) — DOM-backed; the game reads
   *  investStratElement.value each tick (line 1619). Exposes a real lever that
   *  was otherwise pinned at Low Risk. */
  setInvestRisk(value: string): void {
    const el = this.win?.document.getElementById('investStrat') as HTMLSelectElement | null
    if (!el) { console.error('[paperclips] setInvestRisk: no #investStrat — ignored (LOUD)'); return }
    el.value = value
  }

  // ---------------------------------------------------------------- snapshot

  private num(name: string): number {
    const v = this.win?.[name]
    return typeof v === 'number' && isFinite(v) ? v : 0
  }
  private flag(name: string): boolean { return this.num(name) === 1 }
  /** Read a display-only string straight from the game's DOM (faithful to what
   *  the game shows, no formula re-derivation). */
  private dom(id: string): string {
    try { return (this.win?.document.getElementById(id)?.innerHTML ?? '').trim() } catch (e) { console.error(`[paperclips] dom('${id}') read failed: ${e instanceof Error ? e.message : String(e)}`); return '' }
  }
  /** Read a <select> element's current value (for the DOM-backed levers). */
  private selVal(id: string): string {
    const el = this.win?.document.getElementById(id) as HTMLSelectElement | null
    return el?.value ?? ''
  }

  snapshot(): PcSnapshot {
    if (!this.win) {
      return { ...EMPTY_SNAPSHOT, running: false }
    }
    const totalMatter = this.num('totalMatter')
    const foundMatter = this.num('foundMatter')
    const qChips = this.win['qChips'] as { value: number; active: number }[] | undefined
    const qActive = Array.isArray(qChips) ? qChips.filter((c) => c && c.active !== 0).length : 0
    const qSum = Array.isArray(qChips) ? qChips.reduce((s, c) => s + (c?.value ?? 0), 0) : 0
    const dismantle = this.num('dismantle')
    // The Earth-disassembly sub-phase (humanFlag=0 BEFORE spaceFlag=1) needs the
    // factory/drone/power UI too — classify it as 'space', or the player soft-locks
    // with the clip-market dashboard and no Build access (review 2026-06-27, E-F1).
    const phase: PcPhase = dismantle >= 1 ? 'end' : (this.flag('spaceFlag') || !this.flag('humanFlag')) ? 'space' : 'business'
    return {
      running: true,
      phase,
      ticks: this.num('ticks'),
      message: stripTags(this.dom('readout1')),
      clips: this.num('clips'),
      unsoldClips: this.num('unsoldClips'),
      clipRate: this.num('clipmakerRate'),
      funds: this.num('funds'),
      avgRev: this.num('avgRev'),
      margin: this.num('margin'),
      demandPct: stripTags(this.dom('demand')) || String(this.num('demand')),
      wire: this.num('wire'),
      wireCost: this.num('wireCost'),
      wireBuyerOn: this.num('wireBuyerStatus') === 1,
      wireBuyerUnlocked: this.flag('wireBuyerFlag'),
      marketingLvl: this.num('marketingLvl'),
      adCost: this.num('adCost'),
      autoClippers: this.num('clipmakerLevel'),
      clipperCost: this.num('clipperCost'),
      autoClipperUnlocked: this.flag('autoClipperFlag'),
      megaClippers: this.num('megaClipperLevel'),
      megaClipperCost: this.num('megaClipperCost'),
      megaClipperUnlocked: this.flag('megaClipperFlag'),
      compUnlocked: this.flag('compFlag'),
      trust: this.num('trust'),
      nextTrust: this.num('nextTrust'),
      processors: this.num('processors'),
      memory: this.num('memory'),
      operations: this.num('operations'),
      opMax: this.num('memory') * 1000,
      creativity: this.num('creativity'),
      creativityOn: this.win['creativityOn'] === true,
      stratUnlocked: this.flag('strategyEngineFlag'),
      yomi: this.num('yomi'),
      tourneyInProgress: this.num('tourneyInProg') === 1,
      autoTourneyOn: this.num('autoTourneyStatus') === 1,
      autoTourneyUnlocked: this.flag('autoTourneyFlag'),
      investUnlocked: this.flag('investmentEngineFlag'),
      investBankroll: this.num('bankroll'),
      investStocks: this.num('portTotal'),
      investLevel: this.num('investLevel'),   // NOT investmentLevel (that's only a DOM id)
      investRisk: this.selVal('investStrat') || 'low',
      qUnlocked: this.flag('qFlag'),
      qChipsActive: qActive,
      qSum,
      autoQuantum: this.autoQuantum,
      spaceUnlocked: this.flag('spaceFlag'),
      availableMatter: this.num('availableMatter'),
      acquiredMatter: this.num('acquiredMatter'),
      wireSpace: this.num('nanoWire'),
      factories: this.num('factoryLevel'),
      factoryCost: this.num('factoryCost'),
      harvesters: this.num('harvesterLevel'),
      harvesterCost: this.num('harvesterCost'),
      wireDrones: this.num('wireDroneLevel'),
      wireDroneCost: this.num('wireDroneCost'),
      farms: this.num('farmLevel'),
      farmCost: this.num('farmCost'),
      batteries: this.num('batteryLevel'),
      batteryCost: this.num('batteryCost'),
      storedPower: this.num('storedPower'),
      swarmUnlocked: this.flag('swarmFlag'),
      swarmGifts: this.num('swarmGifts'),
      swarmStatus: this.num('swarmStatus'),
      probesUnlocked: this.num('probeCount') > 0 || this.flag('spaceFlag'),
      probes: this.num('probeCount'),
      probesLaunched: this.num('probeLaunchLevel'),   // real global (probesLaunched is only a DOM id)
      probesBorn: this.num('probeDescendents'),       // real global (probesBorn is only a DOM id)
      probeCost: this.num('probeCost'),
      colonizedPct: totalMatter > 0 ? (100 * foundMatter) / totalMatter : 0,
      drifters: this.num('drifterCount'),
      driftersKilled: this.num('driftersKilled'),
      probeTrust: this.num('probeTrust'),
      probeUsedTrust: this.num('probeUsedTrust'),
      probe: {
        Speed: this.num('probeSpeed'), Nav: this.num('probeNav'), Rep: this.num('probeRep'), Haz: this.num('probeHaz'),
        Fac: this.num('probeFac'), Harv: this.num('probeHarv'), Wire: this.num('probeWire'), Combat: this.num('probeCombat'),
      },
      combatUnlocked: this.flag('battleFlag'),
      honor: this.num('honor'),
      maxTrust: this.num('maxTrust'),
      dismantle,
      humanEra: this.flag('humanFlag'),
      powMod: this.num('powMod'),   // power performance fraction; only meaningful post-humanFlag (controller gates the warning)
      swarmStatusLabel: stripTags(this.dom('swarmStatus')),
      sliderPos: this.num('sliderPos'),
    }
  }

  status(): PcStatus {
    return { running: !!this.win, loadError: this.loadError, saveError: this.saveError, ticks: this.num('ticks') }
  }

  // ---------------------------------------------------------------- persistence

  /** Mirror the WHOLE localStorage (the game's save blob — saveGame +
   *  projects/strats/prestige + manual slots) to Postgres. Fire-and-forget on a
   *  serialized chain; the last error is exposed via status() so the window can
   *  show '⚠ unsaved'. Called on the pacer cadence and on flush(). */
  save(): void {
    const j = this.jsdom
    const win = this.win
    if (!j || !win) return
    // Force the game to flush its CURRENT state to localStorage first — it only
    // autosaves on its own saveTimer interval, so without this we'd mirror a
    // stale (or, right after boot, empty) blob to Postgres and a resume would
    // start a fresh game (caught 2026-06-27 in the persistence round-trip test).
    if (typeof win['save'] === 'function') {
      try { (win['save'] as () => void)() } catch (e) {
        console.error(`[paperclips] game save() threw (mirroring whatever localStorage has): ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    let blob: Record<string, string>
    try {
      blob = {}
      const ls = j.window.localStorage
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i)
        if (k != null) blob[k] = ls.getItem(k) ?? ''
      }
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : String(e)
      console.error(`[paperclips] save: reading localStorage failed: ${this.saveError}`)
      return
    }
    this.saveChain = this.saveChain
      .then(() => query(
        `INSERT INTO paperclips_save (id, blob, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET blob = EXCLUDED.blob, updated_at = now()`,
        [SAVE_ID, JSON.stringify(blob)],
      ))
      .then(() => { this.saveError = null })
      .catch((e: unknown) => {
        this.saveError = e instanceof Error ? e.message : String(e)
        console.error(`[paperclips] save failed (will retry next cadence): ${this.saveError}`)
      })
  }

  /** Read the saved localStorage map from Postgres. A DB error THROWS (→ start()
   *  → ensureStarted → loadError → the error card + Reload retry): we must NOT
   *  silently start a fresh game on a transient DB-down, because the 30 s autosave
   *  would then CLOBBER the real save (review 2026-06-27, C-F1). Only a
   *  genuinely-absent row → {} → a fresh game. */
  private async restore(): Promise<Record<string, string>> {
    const r = await query<{ blob: Record<string, string> }>('SELECT blob FROM paperclips_save WHERE id = $1', [SAVE_ID])
    const blob = r.rows[0]?.blob
    return blob && typeof blob === 'object' ? blob : {}
  }

  /** Persist now (window deactivate / explicit). Returns the save chain so a
   *  caller MAY await a clean stop, but render paths never do. */
  flush(): Promise<void> {
    this.save()
    return this.saveChain
  }
}

interface ProjectObj { id: string; title?: string; priceTag?: string; description?: string; cost?: () => unknown; effect?: () => void }

/** jsdom's DOMWindow is typed as the browser Window; we read arbitrary game
 *  globals off it, so narrow to an indexable record (with document kept). */
function window2win(w: unknown): Win { return w as Win }

function stripTags(s: string): string { return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() }

/** A not-running snapshot — every field defaulted so the window can render a
 *  "starting…" state without optional-chaining everywhere. */
const EMPTY_SNAPSHOT: PcSnapshot = {
  running: false, phase: 'business', ticks: 0, message: '',
  clips: 0, unsoldClips: 0, clipRate: 0, funds: 0, avgRev: 0, margin: 0, demandPct: '0',
  wire: 0, wireCost: 0, wireBuyerOn: false, wireBuyerUnlocked: false, marketingLvl: 0, adCost: 0,
  autoClippers: 0, clipperCost: 0, autoClipperUnlocked: false, megaClippers: 0, megaClipperCost: 0, megaClipperUnlocked: false,
  compUnlocked: false, trust: 0, nextTrust: 0, processors: 0, memory: 0, operations: 0, opMax: 0, creativity: 0, creativityOn: false,
  stratUnlocked: false, yomi: 0, tourneyInProgress: false, autoTourneyOn: false, autoTourneyUnlocked: false,
  investUnlocked: false, investBankroll: 0, investStocks: 0, investLevel: 0, investRisk: 'low',
  qUnlocked: false, qChipsActive: 0, qSum: 0, autoQuantum: false,
  spaceUnlocked: false, availableMatter: 0, acquiredMatter: 0, wireSpace: 0,
  factories: 0, factoryCost: 0, harvesters: 0, harvesterCost: 0, wireDrones: 0, wireDroneCost: 0,
  farms: 0, farmCost: 0, batteries: 0, batteryCost: 0, storedPower: 0,
  swarmUnlocked: false, swarmGifts: 0, swarmStatus: 0,
  probesUnlocked: false, probes: 0, probesLaunched: 0, probesBorn: 0, probeCost: 0, colonizedPct: 0, drifters: 0, driftersKilled: 0,
  probeTrust: 0, probeUsedTrust: 0,
  probe: { Speed: 0, Nav: 0, Rep: 0, Haz: 0, Fac: 0, Harv: 0, Wire: 0, Combat: 0 },
  combatUnlocked: false, honor: 0, maxTrust: 0, dismantle: 0,
  humanEra: true, powMod: 1, swarmStatusLabel: '', sliderPos: 0,
}

/** Process-lifetime singleton (see the LIFECYCLE note up top). */
export const paperclips = new PaperclipsEngine()
