// Blackjack engine (Games, graphics-first build — Adam 2026-06-29) — a PURE,
// I/O-free rules engine: no AI opponent (the dealer is fixed-rule), so unlike
// chess/poker there is no subprocess. The GamesWindow controller holds one
// instance, renders the hands as two small image tiles, and persists the
// bankroll; this file is just the rules + the shoe + hand evaluation, so it's
// trivially unit-testable (a seeded RNG makes a whole hand deterministic).
//
// House rules (v1 defaults, all configurable): 6-deck shoe, reshuffle at ~25%
// penetration, dealer STANDS on soft 17 (S17), blackjack pays 3:2, no
// surrender. Split / Double / Insurance are intentionally OUT of v1 — the
// first build proves the card-rendering UI; those ride on top once the
// on-glass redraw cost is verified (gamelist.md §Blackjack).
//
// LOUD AND PROUD: misuse (acting in the wrong phase, betting more than the
// bankroll, drawing from an empty shoe) THROWS rather than silently no-opping
// — the controller guards the menu so these can't happen from the UI, and a
// throw that slips through surfaces as a visible error, never a wrong payout.

export type Suit = 'S' | 'H' | 'D' | 'C'
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'

export interface Card { rank: Rank; suit: Suit }

/** betting = between hands (table clear-able, bankroll shown); player = Adam's
 *  turn (Hit/Stand); dealer = the house drawing to its rule; settled = paid. */
export type Phase = 'betting' | 'player' | 'dealer' | 'settled'

/** null until settled. 'blackjack' is a player NATURAL win (pays 3:2); 'win' is
 *  any other player win (pays 1:1); 'push' returns the bet. */
export type Outcome = 'win' | 'lose' | 'push' | 'blackjack' | null

export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C']
export const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

/** Blackjack value of a hand + whether it's SOFT (an ace still counted as 11).
 *  Aces start at 11 and demote to 1 one at a time only while busting — the
 *  standard best-total rule. */
export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0
  let aces = 0
  for (const c of cards) {
    if (c.rank === 'A') { aces++; total += 11 }
    else if (c.rank === 'K' || c.rank === 'Q' || c.rank === 'J' || c.rank === '10') total += 10
    else total += Number(c.rank)
  }
  while (total > 21 && aces > 0) { total -= 10; aces-- }
  return { total, soft: aces > 0 }
}

export function isBust(cards: Card[]): boolean { return handValue(cards).total > 21 }

/** A NATURAL: exactly two cards totalling 21 (Ace + ten-value). A 21 made from
 *  three+ cards is NOT a blackjack — it pushes against a dealer 21, loses to a
 *  dealer natural. */
export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21
}

export interface BlackjackConfig {
  decks?: number            // shoe size in 52-card decks (default 6)
  startingBankroll?: number // default 1000
  minBet?: number           // default 5
  blackjackPays?: number    // natural payout RATIO (default 1.5 = 3:2)
  dealerHitsSoft17?: boolean // default false (S17 — dealer stands on soft 17)
  penetration?: number      // reshuffle when remaining/full < this (default 0.25)
}

/** A flat, JSON-safe snapshot — the controller mirrors this to Postgres so a
 *  reconnect resumes mid-hand, and reads it each tick to render. */
export interface BlackjackState {
  player: Card[]
  dealer: Card[]
  phase: Phase
  outcome: Outcome
  bankroll: number
  bet: number
  /** Bankroll change applied by the last settle (+win / −loss / 0 push). */
  lastDelta: number
  /** Dealer hole card shown? false while the player decides AND on a player
   *  bust (the house doesn't play out an already-won hand). */
  dealerRevealed: boolean
  /** Cards left in the shoe and the full shoe size — drives the "shoe ~N%"
   *  text readout (no image needed for the deck in v1). */
  shoeRemaining: number
  shoeFull: number
}

export class Blackjack {
  private readonly decks: number
  private readonly minBetV: number
  private readonly blackjackPays: number
  private readonly hitSoft17: boolean
  private readonly penetration: number
  private readonly rng: () => number

  private shoe: Card[] = []
  private readonly fullShoe: number
  private _player: Card[] = []
  private _dealer: Card[] = []
  private _phase: Phase = 'betting'
  private _outcome: Outcome = null
  private _bankroll: number
  private _bet: number
  private _lastDelta = 0
  private _revealed = false

  /** rng is injectable so a seeded PRNG makes hands deterministic in the smoke
   *  test; production uses Math.random (this is plain server code — the
   *  Math.random ban is workflow-scripts-only). */
  constructor(cfg: BlackjackConfig = {}, rng: () => number = Math.random) {
    this.decks = Math.max(1, Math.floor(cfg.decks ?? 6))
    this.minBetV = Math.max(1, Math.floor(cfg.minBet ?? 5))
    this.blackjackPays = cfg.blackjackPays ?? 1.5
    this.hitSoft17 = cfg.dealerHitsSoft17 ?? false
    this.penetration = cfg.penetration ?? 0.25
    this.rng = rng
    this._bankroll = Math.max(0, cfg.startingBankroll ?? 1000)
    this._bet = Math.min(this.minBetV, this._bankroll)
    this.fullShoe = this.decks * 52
    this.buildShoe()
  }

  // ---------------------------------------------------------------- shoe

  private buildShoe(): void {
    const shoe: Card[] = []
    for (let d = 0; d < this.decks; d++) {
      for (const suit of SUITS) for (const rank of RANKS) shoe.push({ rank, suit })
    }
    this.shoe = shoe
    this.shuffle()
  }

  /** Fisher–Yates over the injected rng. */
  private shuffle(): void {
    for (let i = this.shoe.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      const tmp = this.shoe[i]; this.shoe[i] = this.shoe[j]; this.shoe[j] = tmp
    }
  }

  /** Rebuild + reshuffle the whole shoe when worn past the cut card. Called
   *  ONLY between hands (in deal), never mid-hand — a real cut card stops a
   *  hand, it doesn't reshuffle inside one. */
  private maybeReshuffle(): void {
    if (this.shoe.length < this.fullShoe * this.penetration) this.buildShoe()
  }

  private draw(): Card {
    const c = this.shoe.pop()
    if (!c) throw new Error('blackjack: shoe empty (reshuffle gate failed)')
    return c
  }

  // ---------------------------------------------------------------- play

  /** Commit `bet` and deal a fresh hand. Detects naturals (either side) and
   *  settles immediately. Throws if not between hands or the bet is out of
   *  range — the controller validates first, so a throw here is a real bug. */
  deal(bet: number): void {
    if (this._phase !== 'betting' && this._phase !== 'settled') {
      throw new Error(`blackjack: deal() in phase '${this._phase}' (must be between hands)`)
    }
    const b = Math.floor(bet)
    if (!Number.isFinite(b) || b < this.minBetV) throw new Error(`blackjack: bet ${bet} below min ${this.minBetV}`)
    if (b > this._bankroll) throw new Error(`blackjack: bet ${b} exceeds bankroll ${this._bankroll}`)

    this.maybeReshuffle()
    this._bet = b
    this._player = []
    this._dealer = []
    this._outcome = null
    this._lastDelta = 0
    this._revealed = false

    // Standard deal order: player, dealer, player, dealer (hole = dealer[1]).
    this._player.push(this.draw())
    this._dealer.push(this.draw())
    this._player.push(this.draw())
    this._dealer.push(this.draw())

    if (isBlackjack(this._player) || isBlackjack(this._dealer)) {
      this._revealed = true   // a natural ends the hand face-up
      this._phase = 'settled'
      this.settle()
    } else {
      this._phase = 'player'
    }
  }

  /** Set the default bet between hands (the controller's bet cycle). Clamped to
   *  the bankroll; throws mid-hand or below the table minimum. */
  setBet(amount: number): void {
    if (this._phase === 'player' || this._phase === 'dealer') {
      throw new Error(`blackjack: setBet() in phase '${this._phase}' (can't change a live bet)`)
    }
    const b = Math.floor(amount)
    if (!Number.isFinite(b) || b < this.minBetV) throw new Error(`blackjack: bet ${amount} below min ${this.minBetV}`)
    this._bet = Math.min(b, this._bankroll)
  }

  /** Player draws. Bust → immediate loss (dealer does NOT play). A made 21
   *  auto-stands (you'd never hit it — saves a pointless tap). */
  hit(): void {
    if (this._phase !== 'player') throw new Error(`blackjack: hit() in phase '${this._phase}'`)
    this._player.push(this.draw())
    if (isBust(this._player)) {
      this._phase = 'settled'   // _revealed stays false: house doesn't expose its hole
      this.settle()
    } else if (handValue(this._player).total === 21) {
      this.stand()
    }
  }

  /** Player stands → dealer reveals and plays to its rule → settle. */
  stand(): void {
    if (this._phase !== 'player') throw new Error(`blackjack: stand() in phase '${this._phase}'`)
    this._phase = 'dealer'
    this._revealed = true
    this.dealerPlay()
    this._phase = 'settled'
    this.settle()
  }

  /** House rule: hit to 16, stand on hard 17; soft 17 follows the H17/S17 flag. */
  private dealerPlay(): void {
    for (;;) {
      const { total, soft } = handValue(this._dealer)
      if (total < 17) { this._dealer.push(this.draw()); continue }
      if (total === 17 && soft && this.hitSoft17) { this._dealer.push(this.draw()); continue }
      break
    }
  }

  private settle(): void {
    const playerBJ = isBlackjack(this._player)
    const dealerBJ = isBlackjack(this._dealer)
    const pv = handValue(this._player).total
    const dv = handValue(this._dealer).total
    let outcome: Outcome
    if (isBust(this._player)) outcome = 'lose'
    else if (playerBJ && dealerBJ) outcome = 'push'
    else if (playerBJ) outcome = 'blackjack'
    else if (dealerBJ) outcome = 'lose'
    else if (isBust(this._dealer)) outcome = 'win'
    else if (pv > dv) outcome = 'win'
    else if (pv < dv) outcome = 'lose'
    else outcome = 'push'

    let delta = 0
    if (outcome === 'blackjack') delta = round2(this._bet * this.blackjackPays)
    else if (outcome === 'win') delta = this._bet
    else if (outcome === 'lose') delta = -this._bet
    this._bankroll = round2(this._bankroll + delta)
    this._lastDelta = delta
    this._outcome = outcome
  }

  /** Clear a settled hand back to betting (the controller calls this to start a
   *  new round; the bet persists as the default rebet). */
  clearTable(): void {
    this._player = []
    this._dealer = []
    this._outcome = null
    this._lastDelta = 0
    this._revealed = false
    this._phase = 'betting'
  }

  /** Rebuy when busted broke. */
  rebuy(amount: number): void {
    const a = Math.floor(amount)
    if (a <= 0) throw new Error(`blackjack: rebuy ${amount} must be positive`)
    this._bankroll = round2(this._bankroll + a)
  }

  // ---------------------------------------------------------------- reads

  get minBet(): number { return this.minBetV }
  player(): Card[] { return this._player.slice() }
  dealer(): Card[] { return this._dealer.slice() }
  phase(): Phase { return this._phase }
  outcome(): Outcome { return this._outcome }
  bankroll(): number { return this._bankroll }
  bet(): number { return this._bet }
  lastDelta(): number { return this._lastDelta }
  dealerRevealed(): boolean { return this._revealed }
  shoeRemaining(): number { return this.shoe.length }
  shoeFull(): number { return this.fullShoe }

  /** Player total (best). */
  playerTotal(): number { return handValue(this._player).total }
  /** Dealer total — the VISIBLE total while the hole is down (up-card only),
   *  the full total once revealed. Drives the HUD readout honestly. */
  dealerShownTotal(): number {
    if (this._revealed) return handValue(this._dealer).total
    return handValue(this._dealer.slice(0, 1)).total
  }

  snapshot(): BlackjackState {
    return {
      player: this.player(),
      dealer: this.dealer(),
      phase: this._phase,
      outcome: this._outcome,
      bankroll: this._bankroll,
      bet: this._bet,
      lastDelta: this._lastDelta,
      dealerRevealed: this._revealed,
      shoeRemaining: this.shoe.length,
      shoeFull: this.fullShoe,
    }
  }

  /** Restore everything EXCEPT the shoe order (a reconnect reshuffles — card
   *  counting across a server restart isn't a goal, and the in-progress hand's
   *  cards are restored exactly so totals/render are faithful). */
  restore(s: BlackjackState): void {
    this._player = s.player.slice()
    this._dealer = s.dealer.slice()
    this._phase = s.phase
    this._outcome = s.outcome
    this._bankroll = s.bankroll
    this._bet = s.bet
    this._lastDelta = s.lastDelta
    this._revealed = s.dealerRevealed
  }
}

/** Round to cents — 3:2 on an odd bet is e.g. 37.5; keep it exact, drop float
 *  fuzz. */
function round2(n: number): number { return Math.round(n * 100) / 100 }
