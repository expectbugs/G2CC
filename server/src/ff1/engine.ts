// ff1/engine.ts — the FF1 game engine host (PLAN §3): a PROCESS-LIFETIME
// singleton owning the Ff1Bridge daemon client, the persisted savestate, and
// the watchdog respawn. Lifecycle = paperclips.ts: ws-close does NOT tear it
// down (the daemon idles PAUSED — zero frames advance between ops, nothing is
// lost); persistence is a cadence (after every advancing op) plus explicit
// flush on deactivate/leave/dispose.
//
// PERSISTENCE (PLAN §9): ff1_save row 'latest' = savestate bytea + snapshot
// jsonb + the undo-ring TAIL (last 5 labeled states) so a server crash
// preserves undo depth, not just the latest state. Writes ride a serialized
// persistChain (reader pattern); the loadOk clobber-guard (blackjack lesson)
// blocks any persist until a restore has actually LOADED — a fresh engine must
// never upsert its empty state over the real save.
//
// WATCHDOG (PLAN §3): daemon death → LOUD notice + automatic respawn + boot
// with the last in-memory savestate (falling back to the PG row). Never silent.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { query, registerMigration } from '../store.js'
import { Ff1Bridge, FF1_DIR } from './bridge.js'
import type {
  Ff1BattleRound, Ff1CharCommand, Ff1Checkpoint, Ff1Snapshot, Ff1Status,
} from './types.js'

registerMigration('2026-08-12-ff1-save', `CREATE TABLE IF NOT EXISTS ff1_save (
  id text PRIMARY KEY,
  state bytea NOT NULL,
  snapshot jsonb NOT NULL,
  undo_tail jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
)`)

const SAVE_ID = 'latest'
/** Undo-ring tail depth mirrored to PG (PLAN §8.4: "last 5"). */
const UNDO_TAIL_DEPTH = 5

export interface Ff1EngineConfig {
  rngJitter: boolean
  undoDepth: number
}

interface UndoTailEntry { label: string; at: string; state: string }

class Ff1Engine {
  private bridge: Ff1Bridge | null = null
  private starting: Promise<void> | null = null
  private loadError: string | null = null
  private saveError: string | null = null
  private daemonNotice: string | null = null
  /** Clobber-guard (blackjack loadOk): true once the PG restore RESOLVED
   *  (including the fresh-install null row) — persists are refused before. */
  private loadOk = false
  /** The last savestate b64 seen (from any op's auto-persist save) — the
   *  watchdog respawn's restore source when PG is unreachable. */
  private lastStateB64: string | null = null
  /** The last full snapshot (cheap in-memory reads for preview/summary). */
  private lastSnap: Ff1Snapshot | null = null
  private cfg: Ff1EngineConfig = { rngJitter: true, undoDepth: 30 }
  private persistChain: Promise<void> = Promise.resolve()
  /** Serializes ops: the daemon is single-inflight anyway, but engine-level
   *  serialization keeps auto-persist (save + undo_list after each op) atomic
   *  with its op — no interleaved op can slip between them. */
  private opChain: Promise<unknown> = Promise.resolve()

  // ---------------------------------------------------------------- lifecycle

  /** Lazily boot: spawn the daemon, restore the PG save (or fresh-boot the
   *  ROM). Single-flight; a failure clears the latch so Reload retries. */
  ensureStarted(cfg: Ff1EngineConfig): Promise<void> {
    this.cfg = cfg
    if (this.bridge?.alive() && this.loadOk) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.start().catch((e: unknown) => {
        this.loadError = e instanceof Error ? e.message : String(e)
        this.starting = null
        throw e
      })
    }
    return this.starting
  }

  private romPath(): string { return join(FF1_DIR, 'rom', 'Final Fantasy.nes') }

  private async start(): Promise<void> {
    if (!existsSync(this.romPath())) {
      throw new Error(`ROM not found at ${this.romPath()} — the FF1 window needs the cartridge dump in place`)
    }
    // Restore BEFORE boot so a transient DB-down THROWS (paperclips C-F1):
    // we must not silently fresh-boot and then autosave over the real save.
    const saved = await this.restore()
    const bridge = new Ff1Bridge()
    bridge.onDeath = (err) => this.handleDaemonDeath(err)
    this.bridge = bridge
    const req: Record<string, unknown> = {
      rngJitter: this.cfg.rngJitter,
      undoDepth: this.cfg.undoDepth,
    }
    if (saved) req['state'] = saved
    const snap = await bridge.request('boot', req) as unknown as Ff1Snapshot
    this.lastSnap = snap
    this.loadOk = true
    this.loadError = null
    if (saved) this.lastStateB64 = saved
    console.log(`[ff1] engine started (${saved ? 'resumed savestate' : 'fresh boot'}; screen=${snap.screen})`)
  }

  /** WATCHDOG (PLAN §3): the daemon died. Respawn + restore the last known
   *  savestate, loudly. The notice rides status() into the window/statusLine
   *  until the next successful op clears it. */
  private handleDaemonDeath(err: Error): void {
    this.daemonNotice = `daemon died (${err.message}) — respawned + restored last savestate`
    console.error(`[ff1] WATCHDOG: ${err.message} — respawning with last savestate (${this.lastStateB64 ? 'in-memory' : 'PG row'})`)
    this.bridge = null
    this.starting = null
    // Lazy respawn: the next op (or Reload) runs ensureStarted → start() →
    // restore() prefers the in-memory copy via restore()'s fallback below.
  }

  status(): Ff1Status {
    const running = this.bridge?.alive() === true && this.loadOk
    return {
      running,
      starting: !!this.starting && !running,
      loadError: this.loadError,
      saveError: this.saveError,
      daemonNotice: this.daemonNotice,
    }
  }

  /** The window saw the notice (rendered it once) — clear it. */
  consumeDaemonNotice(): string | null {
    const n = this.daemonNotice
    this.daemonNotice = null
    return n
  }

  /** Cheap in-memory snapshot for preview/summary (NEVER an op). */
  cachedSnapshot(): Ff1Snapshot | null { return this.lastSnap }

  // ---------------------------------------------------------------- ops

  /** Run one daemon op through the serialized chain, auto-persisting after
   *  advancing ops. Updates the cached snapshot for every state-carrying
   *  response. Errors reject through to the caller (LOUD there). */
  private op<T>(fn: (b: Ff1Bridge) => Promise<T>, opts: { persist?: boolean } = {}): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ensureStarted(this.cfg)
      const bridge = this.bridge
      if (!bridge) throw new Error('ff1 daemon unavailable (spawn failed)')
      const out = await fn(bridge)
      const snap = out as unknown as Ff1Snapshot
      if (snap && typeof snap === 'object' && 'state' in snap) this.lastSnap = snap
      this.daemonNotice = null   // a successful op proves the respawn worked
      if (opts.persist) await this.capturePersist(bridge)
      return out
    }
    const p = this.opChain.then(run, run)
    // The chain must survive rejections (they still propagate to the caller).
    this.opChain = p.catch(() => undefined)
    return p
  }

  /** Grab savestate + undo tail from the daemon, then mirror to PG on the
   *  serialized persistChain (fire-and-forget; saveError surfaces on status). */
  private async capturePersist(bridge: Ff1Bridge): Promise<void> {
    try {
      const saveResp = await bridge.request('save')
      const stateB64 = String(saveResp['state'] ?? '')
      if (!stateB64) throw new Error('save op returned no state')
      this.lastStateB64 = stateB64
      const listResp = await bridge.request('undo_list')
      const checkpoints = (listResp['checkpoints'] as Ff1Checkpoint[] | undefined) ?? []
      const tail: UndoTailEntry[] = []
      for (const c of checkpoints.slice(0, UNDO_TAIL_DEPTH)) {
        const u = await bridge.request('undo_state', { index: c.index }).catch(() => null)
        if (u && typeof u['state'] === 'string') tail.push({ label: c.label, at: c.at, state: u['state'] })
      }
      this.persist(stateB64, this.lastSnap, tail)
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : String(e)
      console.error(`[ff1] capture-for-persist failed: ${this.saveError}`)
    }
  }

  private persist(stateB64: string, snap: Ff1Snapshot | null, tail: UndoTailEntry[]): void {
    if (!this.loadOk) {
      console.error('[ff1] persist skipped — the save never loaded this process (protects the stored game)')
      return
    }
    const buf = Buffer.from(stateB64, 'base64')
    const snapJson = JSON.stringify(snap ? { screen: snap.screen, state: snap.state } : {})
    this.persistChain = this.persistChain
      .then(() => query(
        `INSERT INTO ff1_save (id, state, snapshot, undo_tail, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE
           SET state = EXCLUDED.state, snapshot = EXCLUDED.snapshot,
               undo_tail = EXCLUDED.undo_tail, updated_at = now()`,
        [SAVE_ID, buf, snapJson, JSON.stringify(tail)],
      ))
      .then(() => { this.saveError = null })
      .catch((e: unknown) => {
        this.saveError = e instanceof Error ? e.message : String(e)
        console.error(`[ff1] save failed (retries next cadence): ${this.saveError}`)
      })
  }

  /** Read the saved state b64 from PG — or the in-memory copy after a daemon
   *  death (fresher than the last PG mirror). A DB error THROWS (C-F1) unless
   *  the in-memory copy exists to respawn from. */
  private async restore(): Promise<string | null> {
    if (this.lastStateB64) return this.lastStateB64
    const r = await query<{ state: Buffer }>('SELECT state FROM ff1_save WHERE id = $1', [SAVE_ID])
    const row = r.rows[0]
    if (!row || !row.state?.length) return null
    return Buffer.from(row.state).toString('base64')
  }

  /** Persist now (deactivate/leave/dispose). Fire-and-forget-able; awaits the
   *  capture AND the PG write so smoke tests get a clean write. */
  async flush(): Promise<void> {
    if (this.bridge?.alive() && this.loadOk) {
      // op({persist:true}) with a no-op body = capture + mirror, serialized.
      try { await this.op(async () => undefined, { persist: true }) }
      catch (e) { console.error(`[ff1] flush failed: ${e instanceof Error ? e.message : String(e)}`) }
    }
    await this.persistChain
  }

  // ---------------------------------------------------------------- game API

  state(): Promise<Ff1Snapshot> {
    return this.op(async (b) => await b.request('state') as unknown as Ff1Snapshot)
  }

  press(buttons: string[], label?: string): Promise<Ff1Snapshot> {
    return this.op(async (b) =>
      await b.request('press', { buttons, ...(label ? { label } : {}) }) as unknown as Ff1Snapshot,
    { persist: true })
  }

  steps(dir: string, count: number): Promise<Ff1Snapshot> {
    return this.op(async (b) =>
      await b.request('steps', { dir, count }) as unknown as Ff1Snapshot,
    { persist: true })
  }

  battleRound(commands: Ff1CharCommand[]): Promise<Ff1Snapshot & { battleRound: Ff1BattleRound }> {
    return this.op(async (b) =>
      await b.request('battle_round', { commands }) as unknown as Ff1Snapshot & { battleRound: Ff1BattleRound },
    { persist: true })
  }

  undoList(): Promise<Ff1Checkpoint[]> {
    return this.op(async (b) => {
      const r = await b.request('undo_list')
      return (r['checkpoints'] as Ff1Checkpoint[] | undefined) ?? []
    })
  }

  undo(index: number): Promise<Ff1Snapshot> {
    return this.op(async (b) =>
      await b.request('undo', { index }) as unknown as Ff1Snapshot,
    { persist: true })
  }

  checkpoint(label: string): Promise<void> {
    return this.op(async (b) => { await b.request('checkpoint', { label }) })
  }

  /** One gray4 map crop (raw u16w/u16h/pixels payload, b64) — the Ph-D
   *  two-tile pipeline (PLAN §7.2). Read-only: no checkpoint, no persist. */
  frameGray4(crop: 'map-top' | 'map-bottom' | 'formation'): Promise<{ gray4: string; w: number; h: number; frameHash: string }> {
    return this.op(async (b) => {
      const r = await b.request('frame', { crop, format: 'gray4' })
      if (typeof r['gray4'] !== 'string') throw new Error(`frame ${crop}: daemon returned no gray4 payload`)
      return { gray4: r['gray4'], w: Number(r['w']), h: Number(r['h']), frameHash: String(r['frameHash']) }
    })
  }

  // ------------------------------------------------------------ Ph-E macros

  /** Ring-driven name entry (PLAN §7.4): 4 grid glyphs on an OPEN grid. */
  nameEntry(name: string): Promise<Ff1Snapshot & { entered?: string }> {
    return this.op(async (b) =>
      await b.request('name_entry', { name }) as unknown as Ff1Snapshot & { entered?: string },
    { persist: true })
  }

  /** Cosmetic rename of a committed party member (the vanilla grid's 4-glyph
   *  constraint makes short names unreachable by input — daemon op docs). */
  rename(slot: number, name: string): Promise<Ff1Snapshot> {
    return this.op(async (b) =>
      await b.request('rename', { slot, name }) as unknown as Ff1Snapshot,
    { persist: true })
  }

  /** The Battle pace macro (PLAN §8.2): alternate steps until an encounter. */
  pace(maxPaces = 200): Promise<Ff1Snapshot & { pace?: { paces: number; stopped: string; battlestep0: number; battlestep1: number } }> {
    return this.op(async (b) =>
      await b.request('pace', { maxPaces }) as unknown as Ff1Snapshot & { pace?: { paces: number; stopped: string; battlestep0: number; battlestep1: number } },
    { persist: true })
  }

  /** The fight-until grind loop (PLAN §8.2). */
  battleAuto(commands: Ff1CharCommand[], opts: { minHpPct?: number; maxRounds?: number } = {}):
      Promise<Ff1Snapshot & { battleAuto?: { rounds: number; outcome: string; stopped: string; log: string[] } }> {
    return this.op(async (b) =>
      await b.request('battle_auto', {
        commands, minHpPct: opts.minHpPct ?? 0, maxRounds: opts.maxRounds ?? 30,
      }) as unknown as Ff1Snapshot & { battleAuto?: { rounds: number; outcome: string; stopped: string; log: string[] } },
    { persist: true })
  }

  /** .sav export (PLAN §9) — the daemon refuses LOUDLY off a save point. */
  savExport(): Promise<{ path: string; bytes: number }> {
    return this.op(async (b) => {
      const r = await b.request('sav_export')
      return { path: String(r['path']), bytes: Number(r['bytes']) }
    })
  }

  /** Trail-minimap data (PLAN §7 minimap v1 = breadcrumbs). Read-only. */
  minimap(): Promise<{ standardMap: boolean; mapId: number; player: [number, number]; tiles: [number, number][] }> {
    return this.op(async (b) =>
      await b.request('minimap') as unknown as { standardMap: boolean; mapId: number; player: [number, number]; tiles: [number, number][] })
  }

  // ------------------------------------------------------------ labeled slots

  /** Save the CURRENT state into a labeled PG slot (PLAN §9 Slots UI). */
  async saveSlot(label: string): Promise<void> {
    return this.op(async (b) => {
      const saveResp = await b.request('save')
      const stateB64 = String(saveResp['state'] ?? '')
      if (!stateB64) throw new Error('save op returned no state')
      const snapJson = JSON.stringify(this.lastSnap ? { screen: this.lastSnap.screen, state: this.lastSnap.state } : {})
      const id = `slot:${Date.now()}`
      await query(
        `INSERT INTO ff1_save (id, state, snapshot, undo_tail, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [id, Buffer.from(stateB64, 'base64'), snapJson, JSON.stringify([{ label }])],
      )
      console.log(`[ff1] slot saved: ${id} ("${label}")`)
    })
  }

  /** List labeled slots, newest first. */
  async listSlots(): Promise<{ id: string; label: string; screen: string; at: string }[]> {
    const r = await query<{ id: string; snapshot: { screen?: string }; undo_tail: { label?: string }[]; updated_at: Date }>(
      `SELECT id, snapshot, undo_tail, updated_at FROM ff1_save
       WHERE id LIKE 'slot:%' ORDER BY updated_at DESC LIMIT 30`)
    return r.rows.map((row) => ({
      id: row.id,
      label: row.undo_tail?.[0]?.label ?? row.id,
      screen: row.snapshot?.screen ?? '?',
      at: row.updated_at.toISOString(),
    }))
  }

  /** Load a labeled slot into the live game (persists — it IS the new latest). */
  loadSlot(id: string): Promise<Ff1Snapshot> {
    return this.op(async (b) => {
      const r = await query<{ state: Buffer }>('SELECT state FROM ff1_save WHERE id = $1', [id])
      const row = r.rows[0]
      if (!row?.state?.length) throw new Error(`slot ${id} not found`)
      const snap = await b.request('load', { state: Buffer.from(row.state).toString('base64') }) as unknown as Ff1Snapshot
      await this.capturePersist(b)
      return snap
    })
  }

  /** Load a raw savestate (smoke fixtures; Ph-E slots). Persists — the loaded
   *  state IS the new latest. */
  loadState(stateB64: string): Promise<Ff1Snapshot> {
    return this.op(async (b) =>
      await b.request('load', { state: stateB64 }) as unknown as Ff1Snapshot,
    { persist: true })
  }

  setConfig(cfg: Ff1EngineConfig): Promise<void> {
    this.cfg = cfg
    if (!this.bridge?.alive()) return Promise.resolve()
    return this.op(async (b) => {
      await b.request('set_config', { rngJitter: cfg.rngJitter, undoDepth: cfg.undoDepth })
    })
  }

  /** TEST-ONLY (the smoke's watchdog drill, paperclips poke() precedent):
   *  SIGKILL the daemon so onDeath → notice + lazy respawn exercises the REAL
   *  recovery path. Production never calls this. */
  debugKillDaemon(): void { this.bridge?.kill() }

  /** Hard teardown (smoke cleanup only — production keeps the singleton). */
  async shutdown(reason: string): Promise<void> {
    console.log(`[ff1] shutdown (${reason})`)
    if (this.starting) { try { await this.starting } catch { /* never came up */ } }
    const b = this.bridge
    this.bridge = null
    this.starting = null
    if (b?.alive()) {
      b.onDeath = null   // an intentional kill is not a watchdog event
      try { await b.request('shutdown') } catch { b.kill() }
    }
  }
}

/** Process-lifetime singleton (paperclips rule). */
export const ff1 = new Ff1Engine()
