# The Phase A gate report: per-pass coverage, field fill rates, vocabulary,
# dupe clusters, failures, and a random full-profile sample for Adam's review.

from __future__ import annotations

import json
import os
from datetime import date
from typing import Any

import requests

from . import db
from .g2cc_config import load_music_config
from .passes.embed import COLLECTION, QDRANT

PASSES = ["tags", "musicbrainz", "lyrics", "audio", "profile", "embed",
          "dedupe", "pretranscode"]


def _fill_rates(conn) -> dict[str, str]:
    cols = ["genres", "styles", "moods", "energy", "bpm", "year", "vocals",
            "language", "themes", "description"]
    out: dict[str, str] = {}
    array_cols = {"genres", "styles", "moods", "themes"}
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) AS n FROM track_meta")
        total = cur.fetchone()["n"]
        for c in cols:
            cond = f"{c} IS NULL OR cardinality({c}) = 0" if c in array_cols else f"{c} IS NULL"
            cur.execute(f"SELECT count(*) AS n FROM track_meta WHERE {cond}")
            missing = cur.fetchone()["n"]
            out[c] = f"{total - missing}/{total} ({(total - missing) * 100 // max(1, total)}%)"
    return out


def _vocab(conn, col: str, top: int = 20) -> list[tuple[str, int]]:
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT v AS name, count(*) AS n FROM track_meta, unnest({col}) v "
            f"GROUP BY v ORDER BY n DESC, v LIMIT %s", (top,))
        return [(r["name"], r["n"]) for r in cur.fetchall()]


def _failures(conn) -> list[str]:
    lines: list[str] = []
    with conn.cursor() as cur:
        for p in PASSES:
            cur.execute(
                "SELECT t.id, t.path, m.pass_status -> %s ->> 'err' AS err "
                "FROM track_meta m JOIN tracks t ON t.id = m.track_id "
                "WHERE m.pass_status -> %s ->> 'ok' = 'false' ORDER BY t.id LIMIT 40", (p, p))
            for r in cur.fetchall():
                lines.append(f"- `{p}` #{r['id']} {os.path.basename(r['path'])} — {r['err'] or '?'}")
    return lines


def _sample(conn, n: int = 15) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT t.id, t.title, t.artist, t.album, t.path, m.* FROM track_meta m "
            "JOIN tracks t ON t.id = m.track_id WHERE m.description IS NOT NULL "
            "ORDER BY random() LIMIT %s", (n,))
        return cur.fetchall()


def build_report(conn) -> str:
    cfg = load_music_config()
    counts = db.counts_by_pass(conn, PASSES)
    lines: list[str] = []
    lines.append(f"# Phase A enrichment report — {date.today().isoformat()}")
    lines.append("")
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) AS n FROM tracks")
        lines.append(f"Tracks indexed: **{cur.fetchone()['n']}**")
        cur.execute("SELECT count(DISTINCT dupe_cluster) AS c, count(*) FILTER (WHERE dupe_cluster IS NOT NULL) AS t FROM track_meta")
        r = cur.fetchone()
        lines.append(f"Dupe clusters: **{r['c']}** covering **{r['t']}** tracks")
        cur.execute("SELECT count(*) AS n, count(*) FILTER (WHERE found) AS f FROM lyrics")
        r = cur.fetchone()
        lines.append(f"Lyrics cache rows: {r['n']} ({r['f']} with lyrics)")
    try:
        q = requests.get(f"{QDRANT}/collections/{COLLECTION}", timeout=10).json()
        lines.append(f"Qdrant `{COLLECTION}` points: {q['result']['points_count']}")
    except Exception as e:  # noqa: BLE001
        lines.append(f"Qdrant `{COLLECTION}`: UNREADABLE ({e})")
    cache_files = [f for f in os.listdir(cfg.cache_dir)] if os.path.isdir(cfg.cache_dir) else []
    size = sum(os.path.getsize(os.path.join(cfg.cache_dir, f)) for f in cache_files)
    lines.append(f"Transcode cache: {len(cache_files)} files, {size / 1e9:.2f} GB")
    lines.append("")
    lines.append("## Pass coverage")
    lines.append("")
    lines.append("| pass | ok | failed | pending |")
    lines.append("|---|---|---|---|")
    for p in PASSES:
        c = counts[p]
        lines.append(f"| {p} | {c['ok']} | {c['failed']} | {c['pending']} |")
    lines.append("")
    lines.append("## Field fill rates")
    lines.append("")
    for k, v in _fill_rates(conn).items():
        lines.append(f"- **{k}**: {v}")
    lines.append("")
    for col in ("genres", "moods", "styles"):
        lines.append(f"## Top {col}")
        lines.append("")
        lines.append(", ".join(f"{name} ({n})" for name, n in _vocab(conn, col)))
        lines.append("")
    fails = _failures(conn)
    lines.append(f"## Failures ({len(fails)} shown, 40/pass cap)")
    lines.append("")
    lines.extend(fails or ["(none)"])
    lines.append("")
    lines.append("## Random sample profiles")
    lines.append("")
    for s in _sample(conn):
        lines.append(f"### #{s['id']} {s['title']} — {s['artist'] or '?'} ({s['album'] or 'no album'})")
        lines.append("")
        lines.append(f"- genres: {s['genres']} · styles: {s['styles']}")
        lines.append(f"- moods: {s['moods']} · themes: {s['themes']}")
        lines.append(f"- energy {s['energy']}/10 · bpm {s['bpm']} · year {s['year']} · "
                     f"vocals {s['vocals']} · lang {s['language']}")
        lines.append(f"- {s['description']}")
        lines.append("")
    return "\n".join(lines)


def run(conn, out_path: str) -> None:
    text = build_report(conn)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"[report] written → {out_path} ({len(text)} chars)", flush=True)
