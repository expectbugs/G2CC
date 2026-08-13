// ff1/types.ts — the FF1 bridge protocol + snapshot types (games/ff1/PLAN.md §4).
//
// Mirrors what games/ff1/bridge/ff1_daemon.py actually returns (its snapshot()
// builder is the source of truth; field names verified 2026-08-12). Every
// daemon response carries `seq` + either op fields (`ok:true`) or
// `{error, traceback}` — never a silent default.

/** One party member, decoded from RAM by the daemon (ramspec.read_char). */
export interface Ff1Char {
  slot: number
  name: string
  class: string
  classId: number
  ailments: number
  alive: boolean
  /** The game will prompt this char for a battle command (not DEAD|STONE|
   *  STUN|SLEEP — the input loop skips all four; Ph-F pass-3). */
  canInput?: boolean
  hp: number
  maxhp: number
  level: number
  exp: number
  /** Spell charges per level, index 0 = L1 (cur / max from $6320/$6328 side). */
  mp: number[]
  maxmp: number[]
  /** ch_spells layout: 8 levels × 3 slots, values 0-8 (0 = empty). */
  spells: number[][]
  weapons: number[]
  armor: number[]
}

export interface Ff1Pos {
  x: number
  y: number
  standardMap: boolean
  mapId: number
  vehicle: string
  facing: string
}

export interface Ff1EnemySlot {
  slot: number
  id: number
  name: string
  hp: number
  alive: boolean
  exp: number
  gp: number
}

export interface Ff1BattleState {
  result: number
  enemies: Ff1EnemySlot[]
  /** The ≤4 names the battle roster box prints (formation label source). */
  roster: string[]
  curChar: number
  target: number
  cursor: [number, number]
  cmdBuf: number[]
  noRun: boolean
  surprise: number
  battleType: number
  enemyCount: number
}

export interface Ff1State {
  party: Ff1Char[]
  gold: number
  pos: Ff1Pos
  battlestep: number
  battlecounter: number
  sramSavePresent: boolean
  /** HEAL/PURE counts — the IN-BATTLE containers while a battle is up, the
   *  SRAM item counts otherwise (they can diverge; variables.inc). */
  potions?: { heal: number; pure: number }
  /** The game's own out-of-battle menu cursor ($62). It is a sprite, so it is
   *  invisible to the tile scraper — this is how the view says where it is. */
  menuCursor?: number
  battle?: Ff1BattleState
}

/** The daemon's screen classifier verdict (screens.py SCREENS tuple, verified). */
export type Ff1Screen =
  | 'title' | 'mainmenu' | 'partyselect' | 'nameentry' | 'ow' | 'sm'
  | 'battle' | 'dialog' | 'shop' | 'gamemenu' | 'transition' | 'unknown'

/** Every state-carrying daemon response (most ops return this shape;
 *  screens.py Classification.to_json + daemon snapshot() extras). */
export interface Ff1Snapshot {
  seq?: number
  ok?: boolean
  screen: Ff1Screen
  /** Scraped text for text-bearing screens (dialog/shop/menu anchors). */
  text?: string[]
  /** LOUD scrape-miss channel — unknown tile hashes inside text regions. */
  unknownTiles?: unknown[]
  /** Classifier's battle_result when screen === 'battle'. */
  btlResult?: number
  frameHash: string
  state: Ff1State
  /** A press/steps op stopped early ('battle' | 'mapchange' | 'blocked' | …). */
  stopped?: string
  /** steps op: tiles actually committed. */
  committed?: number
  /** undo op: the restored checkpoint's label. */
  restored?: string
  /** battle_round op result. */
  battleRound?: Ff1BattleRound
}

export interface Ff1BattleRound {
  /** Stable combat-box messages, in order (no truncation — full history). */
  log: string[]
  result: number
  outcome: 'continue' | 'won' | 'party-dead' | 'ran' | string
  frames: number
}

export interface Ff1Checkpoint {
  index: number
  label: string
  at: string
}

/** One battle command for battle_round (daemon op_battle_round contract). */
export interface Ff1CharCommand {
  char: number
  action: 'fight' | 'magic' | 'drink' | 'run'
  target?: number
  level?: number
  slot?: number
  /** drink: 0 = HEAL, 1 = PURE (bank_0C.asm :: BattleSubMenu_Drink row order). */
  potion?: number
}

/** Engine status for statusLine/summary (paperclips PcStatus shape). */
export interface Ff1Status {
  running: boolean
  starting: boolean
  loadError: string | null
  saveError: string | null
  /** LOUD notice from the last daemon death + respawn (PLAN §3 watchdog) —
   *  cleared on the next successful op after the user has seen it. */
  daemonNotice: string | null
}
