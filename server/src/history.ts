// Session history (upgrades.md Phase 3) — durable conversation/turn capture
// for the CC + Aria session windows, plus the read-only query API behind the
// on-glass History browser.
//
// Retention: UNLIMITED — no caps, no pruning (Adam: "do not curtail
// capability"). Storage is the Phase-2 store; every function here rejects
// loudly when Postgres is down. Capture callers are fire-and-forget
// (SessionLevel chains + .catch); UI callers let the rejection reach the
// window view() → errorView.
//
// Conversation identity: one row per CC conversation. The row is created on
// the first captured turn (cc_session_id may still be unknown for the very
// first prompt — the init event races it); the id is linked in as soon as a
// later capture sees it. A respawn-with-resume keeps the same cc_session_id
// → same conversation row; the backfill importer reuses rows by
// cc_session_id the same way (UNIQUE on conversations.cc_session_id).

import { query, registerMigration } from './store.js'

registerMigration('history-v1', `
  CREATE TABLE IF NOT EXISTS conversations (
    id bigserial PRIMARY KEY,
    window_id text NOT NULL,
    project_path text NOT NULL,
    cc_session_id text UNIQUE,
    started_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS turns (
    id bigserial PRIMARY KEY,
    conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('prompt','response','error','interrupted')),
    text text NOT NULL,
    tool_calls jsonb,
    model text,
    effort text,
    source_uuid text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS turns_conv_created ON turns (conversation_id, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS turns_conv_source ON turns (conversation_id, source_uuid);
  CREATE INDEX IF NOT EXISTS conversations_path_started ON conversations (project_path, started_at DESC);
`)

export type TurnKind = 'prompt' | 'response' | 'error' | 'interrupted'

/** Find-or-create the conversation row for a capture stream. `currentId`
 *  short-circuits (and back-links cc_session_id once it becomes known). */
export async function ensureConversation(opts: {
  currentId: number | null
  windowId: string
  projectPath: string
  ccSessionId: string | null
}): Promise<number> {
  if (opts.currentId !== null) {
    if (opts.ccSessionId) {
      // Link the cc id into a row created before init arrived. A unique
      // violation here means another row already owns the id (shouldn't
      // happen — resume paths reuse via the SELECT below) — log, keep going.
      try {
        await query(
          'UPDATE conversations SET cc_session_id = $1 WHERE id = $2 AND cc_session_id IS NULL',
          [opts.ccSessionId, opts.currentId])
      } catch (e) {
        console.error(`[history] cc_session_id backlink failed (conv ${opts.currentId}): ${(e as Error).message}`)
      }
    }
    return opts.currentId
  }
  if (opts.ccSessionId) {
    const found = await query<{ id: number }>(
      'SELECT id FROM conversations WHERE cc_session_id = $1', [opts.ccSessionId])
    if (found.rowCount) return Number(found.rows[0].id)
  }
  const ins = await query<{ id: number }>(
    `INSERT INTO conversations (window_id, project_path, cc_session_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [opts.windowId, opts.projectPath, opts.ccSessionId])
  return Number(ins.rows[0].id)
}

export async function recordTurn(conversationId: number, t: {
  kind: TurnKind
  text: string
  toolCalls?: string[]
  model?: string
  effort?: string
}): Promise<void> {
  await query(
    `INSERT INTO turns (conversation_id, kind, text, tool_calls, model, effort)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conversationId, t.kind, t.text,
      t.toolCalls && t.toolCalls.length ? JSON.stringify(t.toolCalls) : null,
      t.model ?? null, t.effort ?? null])
}

// ---- read API (the on-glass History browser) -----------------------------

export interface ConvRow {
  id: number
  startedAt: Date
  firstPrompt: string | null
  turnCount: number
}

export async function listConversations(
  projectPath: string, limit: number, offset: number,
): Promise<{ total: number; rows: ConvRow[] }> {
  const total = await query<{ n: string }>(
    'SELECT count(*) AS n FROM conversations WHERE project_path = $1', [projectPath])
  const rows = await query<{ id: string; started_at: Date; first_prompt: string | null; turn_count: string }>(
    `SELECT c.id, c.started_at,
            (SELECT t.text FROM turns t WHERE t.conversation_id = c.id AND t.kind = 'prompt'
              ORDER BY t.created_at, t.id LIMIT 1) AS first_prompt,
            (SELECT count(*) FROM turns t WHERE t.conversation_id = c.id) AS turn_count
     FROM conversations c
     WHERE c.project_path = $1
     ORDER BY c.started_at DESC, c.id DESC
     LIMIT $2 OFFSET $3`,
    [projectPath, limit, offset])
  return {
    total: Number(total.rows[0].n),
    rows: rows.rows.map((r) => ({
      id: Number(r.id),
      startedAt: r.started_at,
      firstPrompt: r.first_prompt,
      turnCount: Number(r.turn_count),
    })),
  }
}

export interface TurnRow {
  id: number
  kind: TurnKind
  preview: string
  createdAt: Date
}

export async function listTurns(
  conversationId: number, limit: number, offset: number,
): Promise<{ total: number; rows: TurnRow[] }> {
  const total = await query<{ n: string }>(
    'SELECT count(*) AS n FROM turns WHERE conversation_id = $1', [conversationId])
  // left(text, 200) — not 80 (review 2026-06-11b): the on-glass row trims to
  // ~34 chars via oneLine() AFTER whitespace-collapse, and a whitespace-heavy
  // first 80 chars could flatten below the row width, hiding that a cut
  // happened. 200 raw chars always survives collapse past the row clamp, so
  // oneLine's visible '…' is the single trim marker.
  const rows = await query<{ id: string; kind: TurnKind; preview: string; created_at: Date }>(
    `SELECT id, kind, left(text, 200) AS preview, created_at
     FROM turns WHERE conversation_id = $1
     ORDER BY created_at, id
     LIMIT $2 OFFSET $3`,
    [conversationId, limit, offset])
  return {
    total: Number(total.rows[0].n),
    rows: rows.rows.map((r) => ({
      id: Number(r.id), kind: r.kind, preview: r.preview, createdAt: r.created_at,
    })),
  }
}

export interface TurnDetail {
  kind: TurnKind
  text: string
  toolCalls: string[]
  model: string | null
  effort: string | null
  createdAt: Date
}

export async function getTurn(turnId: number): Promise<TurnDetail | null> {
  const r = await query<{ kind: TurnKind; text: string; tool_calls: string[] | null; model: string | null; effort: string | null; created_at: Date }>(
    'SELECT kind, text, tool_calls, model, effort, created_at FROM turns WHERE id = $1', [turnId])
  if (!r.rowCount) return null
  const row = r.rows[0]
  return {
    kind: row.kind,
    text: row.text,
    toolCalls: Array.isArray(row.tool_calls) ? row.tool_calls : [],
    model: row.model,
    effort: row.effort,
    createdAt: row.created_at,
  }
}
