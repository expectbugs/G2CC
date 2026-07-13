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

// 'factory' = the Earth-disassembly phase (humanFlag=0, spaceFlag=0): manual Build +
// power. 'space' = FULL SPACE (spaceFlag=1): probe-driven, Build/power are dead.
export type PcPhase = 'business' | 'factory' | 'space' | 'end'

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
  autoYomi: boolean          // auto-run tournaments at the best strategy
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
  unusedClips: number        // clips banked for probes/factories (space) — probe cost is paid from this
  colonizedPct: number       // 100 * foundMatter / totalMatter
  drifters: number
  driftersKilled: number
  probesLostHaz: number      // probes lost to hazards (Haz trust too low)
  probesLostDrift: number    // probes lost to value drift (→ become drifters)
  probesLostCombat: number   // probes lost in combat
  // probe-trust allocation
  probeTrust: number
  probeUsedTrust: number
  probe: { Speed: number; Nav: number; Rep: number; Haz: number; Fac: number; Harv: number; Wire: number; Combat: number }
  // combat
  combatUnlocked: boolean
  honor: number
  maxTrust: number
  maxTrustCost: number       // honor to raise maxTrust +10 (FIXED 91,117.99 — the game never recomputes it)
  // endgame
  dismantle: number
  // review additions (2026-06-27)
  humanEra: boolean          // humanFlag===1 (the clip-market era; false from HypnoDrones onward)
  powMod: number             // power "performance" fraction (1 = full; <1 = power-starved, throttles matter)
  swarmStatusLabel: string   // the game's own swarm word (Active/Hungry/Bored/Disorganized/Sleeping/…)
  sliderPos: number          // swarm Work(0)↔Think(200) slider position
  shortage: string           // the production bottleneck to buy next ('Farms (pwr)'/'Harvesters'/…), '' outside the chain
  // per-project unlock flags (2026-06-28 audit) — the game reveals each control via a project
  factoryBuildUnlocked: boolean   // factoryFlag (project45) → Build Fact
  harvesterBuildUnlocked: boolean // harvesterFlag (project43) → Build Harv
  wireDroneBuildUnlocked: boolean // wireDroneFlag (project44) → Build Drone
  powerUnlocked: boolean          // project127 Power Grid → Build Farm/Batt
  maxTrustUnlocked: boolean        // project121 "Name the battles" → increaseMaxTrust (honor)
  combatDimUnlocked: boolean       // project131 "Combat" → the Combat probe-trust dim
  projectsAvail: number            // count of available projects (so the dashboard shows it)
  projectsAfford: number           // …of which affordable now
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
  private autoYomi = false
  private pacer: ReturnType<typeof setInterval> | null = null
  private pacerTicks = 0
  /** A prestige/restart project called the game's reset() (which only does a
   *  jsdom-no-op location.reload()); applyProject consumes restartPending to
   *  rebuild the game fresh, and `restarted` then signals the window to jump
   *  back to the dash so the fresh run is visible. */
  private restartPending = false
  private restarted = false
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
    // Restore the save into a plain map BEFORE the DOM exists, so buildDom can
    // seed localStorage before main.js runs its top-level load() check.
    const saved = await this.restore()
    const { dom, win } = this.buildDom(saved)
    this.installRestartHook(win)
    this.jsdom = dom
    this.win = win
    this.loadError = null
    this.startPacer()
    console.log(`[paperclips] engine started (${saved && Object.keys(saved).length ? 'resumed save' : 'new game'})`)
  }

  /** Build a fresh jsdom game: parse the scaffold (no <script> tags — we inject),
   *  seed `seed` into localStorage (the game auto-loads it on init), inject the
   *  four game files in upstream order, and verify the economy actually wired up.
   *  Shared by start() (seed = the full restored save) and reboot() (seed = just
   *  the prestige bonus). Throws loudly on failure; the CALLER owns this.jsdom/win. */
  private buildDom(seed: Record<string, string>): { dom: JSDOM; win: Win } {
    // The game logs to console; route to our log, drop nothing silently. A
    // jsdomError while this.win is still null is a fatal LOAD error; one after
    // boot is a transient runtime throw from a game timer — log it, but don't let
    // it permanently poison loadError/statusLine (review 2026-06-27, O1).
    const vc = new VirtualConsole()
    vc.on('jsdomError', (e: Error) => {
      if (!this.win) this.loadError = e.message
      console.error(`[paperclips] jsdom: ${e.message}`)
    })
    const html = readFileSync(join(GAME_DIR, 'index.html'), 'utf8')
    const dom = new JSDOM(html, {
      url: GAME_URL,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse: (window) => this.installShims(window),
    })
    const win = window2win(dom.window)
    try {
      for (const [k, v] of Object.entries(seed)) dom.window.localStorage.setItem(k, v)
    } catch (e) {
      throw new Error(`seeding localStorage failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    for (const f of GAME_FILES) {
      const code = readFileSync(join(GAME_DIR, f), 'utf8')
      const script = dom.window.document.createElement('script')
      script.textContent = code
      dom.window.document.body.appendChild(script)
    }
    // Sanity: the economy must actually be wired (the spike's frozen-tick trap).
    if (typeof win['clipClick'] !== 'function' || typeof win['ticks'] !== 'number') {
      throw new Error('game loaded but clipClick/ticks missing — the engine did not initialize')
    }
    return { dom, win }
  }

  /** The game's reset() (prestige projects 200 "The Universe Next Door" / 201
   *  "The Universe Within", and 217 "Quantum Temporal Reversion") ends in
   *  location.reload() — a jsdom NO-OP, so without intervention the game would
   *  keep its old in-memory state forever. Replace reset() with a flag that the
   *  applyProject path consumes to rebuild the jsdom fresh. */
  private installRestartHook(win: Win): void {
    win['reset'] = (): void => { this.restartPending = true }
  }

  /** Rebuild the game fresh after a prestige/restart project. Tear down the old
   *  window (stopping its game timers via close()) and boot a new one carrying
   *  ONLY `savePrestige` — exactly what a real reload preserves (reset() clears
   *  every other save key). Synchronous: no PG read, the bonus rides localStorage. */
  private reboot(): void {
    const old = this.jsdom
    const carry: Record<string, string> = {}
    try {
      const sp = old?.window.localStorage.getItem('savePrestige')
      if (sp != null) carry['savePrestige'] = sp
    } catch (e) {
      console.error(`[paperclips] reboot: reading savePrestige failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    // Null this.win FIRST so a load error in the new boot is treated as fatal,
    // then stop the old window's game timers before dropping it.
    this.win = null
    this.jsdom = null
    try { old?.window.close() } catch (e) {
      console.error(`[paperclips] reboot: closing old window threw: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      const { dom, win } = this.buildDom(carry)
      this.installRestartHook(win)
      this.jsdom = dom
      this.win = win
      this.loadError = null
      this.restarted = true
      console.log(`[paperclips] prestige restart — fresh game (carry: ${Object.keys(carry).join(',') || 'none'})`)
      // Mirror the fresh state immediately so a crash right after prestige can't
      // resurrect the old run from the last autosave.
      this.save()
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e)
      // Clear the single-flight latch so the window's Reload re-runs start() from
      // the last good PG save (we never reached save(), so the pre-prestige run is
      // still on disk — recoverable, just minus the prestige purchase). LOUD, not
      // a silent dead engine. (Near-impossible: the identical buildDom just ran at start.)
      this.starting = null
      console.error(`[paperclips] reboot FAILED — game stopped; Reload re-boots from the last save: ${this.loadError}`)
    }
  }

  /** True exactly once after a prestige/restart rebuilt the game — lets the
   *  window jump back to the dashboard so the fresh run is visible. */
  consumeRestarted(): boolean { const r = this.restarted; this.restarted = false; return r }

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
      if (this.autoYomi) this.autoFireYomi(win)
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

  /** Launch up to 1000 Von Neumann probes this tap (Adam 2026-06-27), clamped to
   *  what's affordable. makeProbe pays a flat probeCost (1e17) from unusedClips and
   *  self-guards (unusedClips > probeCost), so this stops when you run out. Loud when
   *  0 launch (so a no-op isn't mysterious). Returns the count launched. */
  bulkProbe(): number {
    if (!this.win) return 0
    const before = this.num('probeLaunchLevel')
    for (let i = 0; i < 1000; i++) {
      if (this.num('unusedClips') <= this.num('probeCost')) break
      this.call('makeProbe')
    }
    const launched = this.num('probeLaunchLevel') - before
    if (launched === 0) console.error(`[paperclips] +Probe launched 0: need >${this.num('probeCost')} unused clips, have ${this.num('unusedClips')} (LOUD)`)
    return launched
  }

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
    } catch (e) {
      console.error(`[paperclips] applyProject('${id}') threw: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
    // A prestige/restart project (200/201/217) called the game's reset() → our
    // hook flagged a restart. Rebuild the jsdom fresh NOW, OUTSIDE the game's
    // effect() (re-entrancy-safe), carrying the prestige bonus. The window reads
    // consumeRestarted() to jump to the fresh dashboard.
    if (this.restartPending) { this.restartPending = false; this.reboot() }
    return true
  }

  setAutoQuantum(on: boolean): void { this.autoQuantum = on }
  isAutoQuantum(): boolean { return this.autoQuantum }

  /** Auto-yomi (Adam 2026-06-27): keep tournaments running at the strongest
   *  unlocked strategy so yomi flows without manual New/Run/picking. Uses the
   *  game's own auto-tourney once unlocked; before that, kicks a tournament
   *  whenever idle + affordable (tourneyCost ops). */
  private autoFireYomi(win: Win): void {
    if (this.num('strategyEngineFlag') !== 1) return
    this.setBestStrat()
    if (this.num('autoTourneyFlag') === 1 && this.num('autoTourneyStatus') !== 1) {
      (win['toggleAutoTourney'] as () => void)()
    }
    // Only run a tournament when strategies actually exist (else newTourney/runTourney
    // would operate on an empty field) and it's idle + affordable.
    const strats = win['strats'] as unknown[] | undefined
    if (Array.isArray(strats) && strats.length > 0 && this.num('tourneyInProg') !== 1 && this.num('operations') >= this.num('tourneyCost')) {
      (win['newTourney'] as () => void)()
      ;(win['runTourney'] as () => void)()
    }
  }
  /** Field the most-advanced unlocked strategy (the last picker option). The game
   *  reads stratPicker.value, which follows selectedIndex. */
  private setBestStrat(): void {
    const el = this.win?.document.getElementById('stratPicker') as HTMLSelectElement | null
    if (el && el.options.length > 0) el.selectedIndex = el.options.length - 1
  }
  setAutoYomi(on: boolean): void {
    this.autoYomi = on
    if (!on && this.win && this.num('autoTourneyStatus') === 1) {
      try { (this.win['toggleAutoTourney'] as () => void)() } catch (e) { console.error(`[paperclips] AutoY off/toggleAutoTourney threw: ${e instanceof Error ? e.message : String(e)}`) }
    }
  }
  isAutoYomi(): boolean { return this.autoYomi }

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

  // investUpgrade / synchSwarm / entertainSwarm spend a resource but the GAME guards
  // ONLY via the button's disabled state — calling them directly (as our menu does)
  // bypasses that and can drive yomi/creativity NEGATIVE (the -57M yomi bug,
  // 2026-06-27). Replicate the button-disable guard; loud refusal when unaffordable.
  investUpgrade(): void {
    if (!this.win) return
    if (this.num('yomi') < this.num('investUpgradeCost')) { console.error('[paperclips] investUpgrade refused: yomi < cost (LOUD)'); return }
    this.call('investUpgrade')
  }
  synchSwarm(): void {
    if (!this.win) return
    if (this.num('yomi') < this.num('synchCost')) { console.error('[paperclips] synchSwarm refused: yomi < cost (LOUD)'); return }
    this.call('synchSwarm')
  }
  entertainSwarm(): void {
    if (!this.win) return
    if (this.num('creativity') < this.num('entertainCost')) { console.error('[paperclips] entertainSwarm refused: creativity < cost (LOUD)'); return }
    this.call('entertainSwarm')
  }
  // addProc/addMem: the game caps these at processors+memory < trust (or a swarm gift) via the
  // disabled BUTTON only; calling directly would exceed the trust allowance (2026-06-28 audit).
  private hasProcAllowance(): boolean { return this.num('processors') + this.num('memory') < this.num('trust') || this.num('swarmGifts') > 0 }
  addProc(): void {
    if (!this.win) return
    if (this.hasProcAllowance()) this.call('addProc'); else console.error('[paperclips] addProc refused: no trust allowance (processors+memory ≥ trust) (LOUD)')
  }
  addMem(): void {
    if (!this.win) return
    if (this.hasProcAllowance()) this.call('addMem'); else console.error('[paperclips] addMem refused: no trust allowance (processors+memory ≥ trust) (LOUD)')
  }
  /** increaseProbeTrust self-guards but no-ops SILENTLY when unaffordable / at maxTrust;
   *  wrap it so a dead tap is loud (the probe screen also shows the trust readout). */
  increaseProbeTrust(): void {
    if (!this.win) return
    if (this.num('probeTrust') >= this.num('maxTrust')) { console.error('[paperclips] PTrust refused: already at maxTrust (raise it with MaxT/honor) (LOUD)'); return }
    if (this.num('yomi') < this.num('probeTrustCost')) { console.error(`[paperclips] PTrust refused: yomi ${this.num('yomi')} < cost ${this.num('probeTrustCost')} (LOUD)`); return }
    this.call('increaseProbeTrust')
  }
  /** increaseMaxTrust self-guards (honor ≥ maxTrustCost) but no-ops SILENTLY when
   *  unaffordable — wrap it so a dead tap is LOUD (the Probe screen also shows the
   *  honor/cost gate). maxTrustCost is a FIXED 91,117.99; the game never recomputes it. */
  increaseMaxTrust(): void {
    if (!this.win) return
    if (!this.projFlag('project121')) { console.error('[paperclips] MaxT refused: locked until the "Name the battles" project (LOUD)'); return }
    const honor = this.num('honor'); const cost = this.num('maxTrustCost')
    if (honor < cost) { console.error(`[paperclips] MaxT refused: honor ${Math.round(honor)} < cost ${Math.round(cost)} (LOUD)`); return }
    this.call('increaseMaxTrust')
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
    const phase: PcPhase = dismantle >= 1 ? 'end'
      : this.flag('spaceFlag') ? 'space'        // full space (probes)
      : !this.flag('humanFlag') ? 'factory'     // Earth disassembly (manual build + power)
      : 'business'
    const pc = this.projectCounts()
    return {
      running: true,
      phase,
      ticks: this.num('ticks'),
      message: stripTags(this.dom('readout1')),
      clips: this.num('clips'),
      unsoldClips: this.num('unsoldClips'),
      clipRate: this.num('clipRate'),   // the LIVE clips/sec (clipmakerRate is a vestigial, always-0 global)
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
      autoYomi: this.autoYomi,
      spaceUnlocked: this.flag('spaceFlag'),
      availableMatter: this.num('availableMatter'),
      acquiredMatter: this.num('acquiredMatter'),
      wireSpace: this.num('wire'),   // the LIVE wire stock in factory/space (nanoWire freezes at the HypnoDrones moment)
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
      unusedClips: this.num('unusedClips'),
      colonizedPct: totalMatter > 0 ? (100 * foundMatter) / totalMatter : 0,
      drifters: this.num('drifterCount'),
      driftersKilled: this.num('driftersKilled'),
      probesLostHaz: this.num('probesLostHaz'),   // real global (probesLostHazards is only a DOM id)
      probesLostDrift: this.num('probesLostDrift'),
      probesLostCombat: this.num('probesLostCombat'),
      probeTrust: this.num('probeTrust'),
      probeUsedTrust: this.num('probeUsedTrust'),
      probe: {
        Speed: this.num('probeSpeed'), Nav: this.num('probeNav'), Rep: this.num('probeRep'), Haz: this.num('probeHaz'),
        Fac: this.num('probeFac'), Harv: this.num('probeHarv'), Wire: this.num('probeWire'), Combat: this.num('probeCombat'),
      },
      combatUnlocked: this.flag('battleFlag'),
      honor: this.num('honor'),
      maxTrust: this.num('maxTrust'),
      maxTrustCost: this.num('maxTrustCost'),
      dismantle,
      humanEra: this.flag('humanFlag'),
      powMod: this.num('powMod'),   // power performance fraction; only meaningful post-humanFlag (controller gates the warning)
      swarmStatusLabel: stripTags(this.dom('swarmStatus')),
      sliderPos: this.num('sliderPos'),
      shortage: this.computeShortage(),
      factoryBuildUnlocked: this.flag('factoryFlag'),
      harvesterBuildUnlocked: this.flag('harvesterFlag'),
      wireDroneBuildUnlocked: this.flag('wireDroneFlag'),
      powerUnlocked: this.projFlag('project127'),
      maxTrustUnlocked: this.projFlag('project121'),
      combatDimUnlocked: this.projFlag('project131'),
      projectsAvail: pc.avail,
      projectsAfford: pc.afford,
    }
  }

  /** A game project object's flag (1 = bought). Used for controls the game reveals
   *  via a specific project (power, max-trust, the combat trust dim). */
  private projFlag(id: string): boolean {
    const p = this.win?.[id] as { flag?: number } | undefined
    return p?.flag === 1
  }
  /** Count available projects (the "growing UI" array) + how many are affordable now. */
  private projectCounts(): { avail: number; afford: number } {
    const active = this.win?.['activeProjects'] as ProjectObj[] | undefined
    if (!Array.isArray(active)) return { avail: 0, afford: 0 }
    let avail = 0, afford = 0
    for (const p of active) {
      if (!p || typeof p.id !== 'string') continue
      avail++
      try { if (typeof p.cost === 'function' && p.cost()) afford++ } catch { /* not affordable */ }
    }
    return { avail, afford }
  }

  /** The production bottleneck to buy next in the factory/space phase (Adam
   *  2026-06-27): power throttles the whole matter→wire→clips chain, so a sub-100%
   *  powMod means Farms; otherwise it's the slowest stage. Throughputs per main.js
   *  (acquireMatter/processMatter/spawnFactories): harvesters & wire drones scale with
   *  level² under droneBoost AND with the Work/Think slider; factories scale linearly
   *  with factoryBoost and ignore the slider. powMod is a common factor (cancels in
   *  the argmin), so it's omitted here. '' outside the production phase. */
  private computeShortage(): string {
    if (!this.win || this.flag('humanFlag')) return ''       // business phase → no chain
    if (this.flag('spaceFlag')) {
      // FULL SPACE: the bottleneck is trust allocation, not buildings (Adam 2026-06-27).
      // Probes need Rep (replicate), Haz (survive), Speed+Nav (explore→matter) or they die.
      const pt = this.num('probeTrust'), used = this.num('probeUsedTrust')
      if (pt <= 0) return 'buy PTrust'                         // no pool → buy with yomi
      // under attack with no combat allocation → urgent (win battles → honor)
      if (this.projFlag('project131') && this.num('drifterCount') > 0 && this.num('probeCombat') < 1) {
        return used < pt ? 'add Cbt' : 'PTrust+Cbt'
      }
      if (used < pt) {                                         // unallocated trust → spend on what's missing
        if (this.num('probeRep') < 1) return 'add Rep'
        if (this.num('probeHaz') < 1) return 'add Haz'
        if (this.num('probeSpeed') < 1 || this.num('probeNav') < 1) return 'add Spd+Nav'
        return 'spend trust'
      }
      if (this.num('probeRep') < 1) return 'PTrust+Rep'        // fully allocated but a key dim is 0 → buy more
      if (this.num('probeHaz') < 1) return 'PTrust+Haz'
      if (this.num('probeSpeed') < 1 || this.num('probeNav') < 1) return 'add Spd/Nav'
      return ''                                                // healthy
    }
    // FACTORY phase: the build bottleneck.
    if (this.num('powMod') < 0.99) return 'Farms (pwr)'      // power-starved: raise supply with farms
    const db = this.num('droneBoost')
    const wf = (200 - this.num('sliderPos')) / 100           // Work/Think — boosts harvesters/drones, not factories
    const hL = Math.floor(this.num('harvesterLevel'))
    const wL = Math.floor(this.num('wireDroneLevel'))
    const fL = Math.floor(this.num('factoryLevel'))
    if (hL <= 0) return 'Harvesters'
    if (wL <= 0) return 'WireDrones'
    if (fL <= 0) return 'Factories'
    const H = wf * (db > 1 ? db * hL * hL : hL) * this.num('harvesterRate')
    const W = wf * (db > 1 ? db * wL * wL : wL) * this.num('wireDroneRate')
    const fb = this.num('factoryBoost')
    const F = (fb > 1 ? fb * fL * fL : fL) * this.num('factoryRate')   // factories ALSO square under boost (spawnFactories)
    const min = Math.min(H, W, F)
    return min === H ? 'Harvesters' : min === W ? 'WireDrones' : 'Factories'
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

  /** Hard Reset (multi-surface 2026-07-13): save, then drop the process-lifetime
   *  jsdom entirely so the NEXT open rebuilds from the persisted save — the
   *  "kill everything cleanly" contract. Loud; safe when never started. */
  async shutdown(reason: string): Promise<void> {
    if (!this.win && !this.jsdom) return
    console.log(`[paperclips] shutdown (${reason}) — flushing save + dropping the jsdom`)
    try { await this.flush() } catch (e) {
      console.error(`[paperclips] shutdown flush failed (continuing teardown): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (this.pacer) { clearInterval(this.pacer); this.pacer = null }
    const old = this.jsdom
    this.win = null
    this.jsdom = null
    this.starting = null   // a later open() boots fresh from the save
    try { old?.window.close() } catch (e) {
      console.error(`[paperclips] shutdown: closing window threw: ${e instanceof Error ? e.message : String(e)}`)
    }
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
  qUnlocked: false, qChipsActive: 0, qSum: 0, autoQuantum: false, autoYomi: false,
  spaceUnlocked: false, availableMatter: 0, acquiredMatter: 0, wireSpace: 0,
  factories: 0, factoryCost: 0, harvesters: 0, harvesterCost: 0, wireDrones: 0, wireDroneCost: 0,
  farms: 0, farmCost: 0, batteries: 0, batteryCost: 0, storedPower: 0,
  swarmUnlocked: false, swarmGifts: 0, swarmStatus: 0,
  probesUnlocked: false, probes: 0, probesLaunched: 0, probesBorn: 0, probeCost: 0, unusedClips: 0, colonizedPct: 0, drifters: 0, driftersKilled: 0,
  probesLostHaz: 0, probesLostDrift: 0, probesLostCombat: 0,
  probeTrust: 0, probeUsedTrust: 0,
  probe: { Speed: 0, Nav: 0, Rep: 0, Haz: 0, Fac: 0, Harv: 0, Wire: 0, Combat: 0 },
  combatUnlocked: false, honor: 0, maxTrust: 0, maxTrustCost: 0, dismantle: 0,
  humanEra: true, powMod: 1, swarmStatusLabel: '', sliderPos: 0, shortage: '',
  factoryBuildUnlocked: false, harvesterBuildUnlocked: false, wireDroneBuildUnlocked: false, powerUnlocked: false,
  maxTrustUnlocked: false, combatDimUnlocked: false, projectsAvail: 0, projectsAfford: 0,
}

/** Process-lifetime singleton (see the LIFECYCLE note up top). */
export const paperclips = new PaperclipsEngine()
