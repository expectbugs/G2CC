// Postgres store foundation (upgrades.md Phase 2) — lazy singleton pg.Pool
// over the unix socket (peer auth as the server's own user; no password, no
// TCP) + a tiny idempotent migration runner.
//
// FAILURE POLICY (load-bearing): a dead/missing Postgres must NEVER crash or
// wedge the server or any render path. Every query rejects LOUDLY and the
// caller decides: UI paths surface the rejection through the normal error
// views; capture/telemetry paths are fire-and-forget with `.catch(console
// .error)`. Nothing in here retries on a clock, blocks the event loop, or
// swallows an error. pg's own no-timeout defaults are left alone (B3).
//
// Migrations: features call registerMigration(id, ddl) at MODULE IMPORT TIME
// (so all registrations exist before the first query). The runner applies
// each DDL once, recorded in the `migrations` table. ensureMigrated() is
// memoized but self-heals: a failed run clears the memo so the next query
// re-attempts once Postgres is back; late registrations (count change) also
// re-run the pending ones.

import pg from 'pg'

const PG_SOCKET_DIR = '/run/postgresql'
const PG_DATABASE = 'g2cc'

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (pool) return pool
  pool = new pg.Pool({ host: PG_SOCKET_DIR, database: PG_DATABASE })
  // Idle-client errors (postgres restarted, socket dropped) surface here —
  // loud log, and the pool replaces the client on next checkout. Without the
  // listener this is an uncaughtException that kills the whole server.
  pool.on('error', (e) => console.error(`[store] pg pool error (idle client): ${e.message}`))
  return pool
}

interface Migration { id: string; ddl: string }
const registered: Migration[] = []

/** Register an idempotent DDL block (CREATE TABLE IF NOT EXISTS …; CREATE
 *  INDEX IF NOT EXISTS …). Call at module import time only. */
export function registerMigration(id: string, ddl: string): void {
  if (registered.some((m) => m.id === id)) {
    throw new Error(`[store] duplicate migration id '${id}'`)
  }
  registered.push({ id, ddl })
}

let migrated: Promise<void> | null = null
/** Registration count the CURRENT memoized run covers — recorded at LAUNCH
 *  (not completion), so concurrent callers during the first in-flight run
 *  reuse it instead of each spawning another run (three parallel CREATE
 *  TABLEs race postgres' catalog — caught by the Phase 4 smoke). */
let migratedForCount = 0

async function runMigrations(): Promise<void> {
  const p = getPool()
  await p.query(`CREATE TABLE IF NOT EXISTS migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`)
  for (const m of registered) {
    const seen = await p.query('SELECT 1 FROM migrations WHERE id = $1', [m.id])
    if (seen.rowCount) continue
    console.log(`[store] applying migration '${m.id}'`)
    await p.query(m.ddl)
    await p.query('INSERT INTO migrations (id) VALUES ($1)', [m.id])
  }
}

/** Memoized migration gate — every query awaits this. Self-healing: a failure
 *  clears the memo (retry when Postgres returns); a registration-count change
 *  re-runs the pending ones (already-applied ids are no-ops). */
export function ensureMigrated(): Promise<void> {
  if (migrated && migratedForCount !== registered.length) migrated = null
  if (!migrated) {
    migratedForCount = registered.length
    migrated = runMigrations().catch((e: unknown) => {
      migrated = null
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[store] migration run failed (will retry on next query): ${msg}`)
      throw new Error(`store unavailable: ${msg}`)
    })
  }
  return migrated
}

/** The one query door. Rejects loudly when Postgres is down — UI callers
 *  render the rejection (error views); capture callers .catch(console.error). */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string, params?: unknown[],
): Promise<pg.QueryResult<R>> {
  await ensureMigrated()
  return getPool().query<R>(text, params)
}

/** Startup pre-warm (index.ts): fire-and-forget so a down DB can't block or
 *  crash startup — features lazily retry through ensureMigrated anyway. */
export function warmStore(): void {
  void ensureMigrated()
    .then(() => console.log(`[store] ready (db=${PG_DATABASE}, ${registered.length} migrations applied/verified)`))
    .catch(() => { /* already logged loudly in ensureMigrated */ })
}
