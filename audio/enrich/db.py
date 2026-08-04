# Postgres access for the enrichment runner (g2cc DB, unix-socket peer auth —
# the same DB the server owns).
#
# ENSURE_DDL is a byte-for-byte MIRROR of server/src/music.ts migration
# 'music-meta-1' (idempotent IF NOT EXISTS blocks) so Phase A runs without a
# server restart; the server's migration runner records/no-ops it later. Any
# change MUST land in both places.
#
# Failure policy (house rules): a down Postgres raises loudly and kills the
# run — never a silent skip. Per-track pass failures are recorded in
# pass_status and the batch continues.

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Iterable

import psycopg
from psycopg.rows import dict_row

ENSURE_DDL = """
  CREATE TABLE IF NOT EXISTS track_meta (
    track_id integer PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    genres text[],
    styles text[],
    moods text[],
    energy integer,
    bpm real,
    year integer,
    vocals text,
    language text,
    themes text[],
    description text,
    dupe_cluster integer,
    sources jsonb NOT NULL DEFAULT '{}',
    pass_status jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS play_history (
    id bigserial PRIMARY KEY,
    track_id integer NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    completed boolean NOT NULL DEFAULT false,
    skipped boolean NOT NULL DEFAULT false,
    source text NOT NULL DEFAULT 'unknown'
  );
  CREATE INDEX IF NOT EXISTS play_history_track_idx ON play_history (track_id, started_at);
  CREATE TABLE IF NOT EXISTS playlists (
    id serial PRIMARY KEY,
    name text NOT NULL,
    origin text NOT NULL DEFAULT 'manual',
    request text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS playlists_name_key ON playlists (lower(name));
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id integer NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position integer NOT NULL,
    track_id integer NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    PRIMARY KEY (playlist_id, position)
  );
  CREATE TABLE IF NOT EXISTS player_state (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    queue jsonb NOT NULL DEFAULT '[]',
    idx integer NOT NULL DEFAULT 0,
    pos_ms integer NOT NULL DEFAULT 0,
    radio boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
"""


def connect() -> psycopg.Connection:
    conn = psycopg.connect("dbname=g2cc", autocommit=True, row_factory=dict_row)
    return conn


def ensure_schema(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.tracks') AS t")
        if cur.fetchone()["t"] is None:
            raise RuntimeError(
                "tracks table missing from g2cc — the server has never indexed; "
                "refusing to invent the base schema (that's music.ts's job)")
        cur.execute(ENSURE_DDL)
    # One meta row per track; new tracks (videosweep/consistency inserts) call
    # this again.
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO track_meta (track_id) SELECT id FROM tracks "
            "ON CONFLICT (track_id) DO NOTHING")


def all_tracks(conn: psycopg.Connection) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT t.id, t.path, t.title, t.artist, t.album, t.dur_ms, t.mtime_ms "
            "FROM tracks t ORDER BY t.id")
        return cur.fetchall()


def tracks_needing(
    conn: psycopg.Connection, pass_name: str,
    force: bool = False, limit: int | None = None, track_id: int | None = None,
) -> list[dict[str, Any]]:
    """Tracks whose pass_status[pass_name].ok is not true (or everything under
    --force). Joined with meta so passes can read prior sources."""
    sql = (
        "SELECT t.id, t.path, t.title, t.artist, t.album, t.dur_ms, t.mtime_ms, "
        "m.sources, m.pass_status, m.bpm, m.description "
        "FROM tracks t JOIN track_meta m ON m.track_id = t.id")
    conds, params = [], []
    if track_id is not None:
        conds.append("t.id = %s")
        params.append(track_id)
    elif not force:
        conds.append("COALESCE(m.pass_status -> %s ->> 'ok', 'false') <> 'true'")
        params.append(pass_name)
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY t.id"
    if limit is not None:
        sql += " LIMIT %s"
        params.append(limit)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def set_pass_status(
    conn: psycopg.Connection, track_id: int, pass_name: str,
    ok: bool, err: str | None = None, extra: dict[str, Any] | None = None,
) -> None:
    entry: dict[str, Any] = {"ok": ok, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    if err is not None:
        entry["err"] = err[:500]
    if extra:
        entry.update(extra)
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE track_meta SET pass_status = pass_status || %s::jsonb, "
            "updated_at = now() WHERE track_id = %s",
            (json.dumps({pass_name: entry}), track_id))


def merge_sources(conn: psycopg.Connection, track_id: int, key: str, payload: Any) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE track_meta SET sources = sources || %s::jsonb, "
            "updated_at = now() WHERE track_id = %s",
            (json.dumps({key: payload}), track_id))


def update_meta(conn: psycopg.Connection, track_id: int, fields: dict[str, Any]) -> None:
    """Set final track_meta columns (profile/audio/dedupe writers)."""
    if not fields:
        return
    cols = ", ".join(f"{k} = %s" for k in fields)
    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE track_meta SET {cols}, updated_at = now() WHERE track_id = %s",
            [*fields.values(), track_id])


def counts_by_pass(conn: psycopg.Connection, passes: Iterable[str]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    with conn.cursor() as cur:
        for p in passes:
            cur.execute(
                "SELECT "
                " count(*) FILTER (WHERE pass_status -> %s ->> 'ok' = 'true') AS ok,"
                " count(*) FILTER (WHERE pass_status -> %s ->> 'ok' = 'false') AS failed,"
                " count(*) FILTER (WHERE pass_status -> %s IS NULL) AS pending,"
                " count(*) AS total "
                "FROM track_meta", (p, p, p))
            out[p] = {k: int(v) for k, v in cur.fetchone().items()}
    return out
