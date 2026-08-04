# Pass 6 — embeddings → Qdrant `g2cc_music` (new collection on the existing
# aria instance; :6333 HTTP, no client lib). Model: BAAI/bge-small-en-v1.5
# (384-dim, CLS-pool + L2-normalize — the bge convention), CPU on purpose:
# canary-qwen owns the GPU and 1,200 short texts are seconds-class anyway.
# Only tracks WITH a profile description embed; the rest record an honest
# skip. Point id = track id; payload carries artist/title for debuggability.

from __future__ import annotations

import json
from typing import Any

import requests

from .. import db

MODEL_NAME = "BAAI/bge-small-en-v1.5"
DIM = 384
QDRANT = "http://127.0.0.1:6333"
COLLECTION = "g2cc_music"
HTTP_CAP_S = 30   # network resource cap (lyrics.ts class)
UPSERT_BATCH = 128

_model = None
_tokenizer = None


def _load_model():
    global _model, _tokenizer
    if _model is not None:
        return
    import torch  # noqa: F401 — venv-present (NeMo stack)
    from transformers import AutoModel, AutoTokenizer
    print(f"[embed] loading {MODEL_NAME} (CPU)…", flush=True)
    _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    _model = AutoModel.from_pretrained(MODEL_NAME)
    _model.eval()


def embed_texts(texts: list[str]) -> list[list[float]]:
    import torch
    _load_model()
    out: list[list[float]] = []
    for i in range(0, len(texts), 32):
        chunk = texts[i:i + 32]
        enc = _tokenizer(chunk, padding=True, truncation=True, max_length=512, return_tensors="pt")
        with torch.no_grad():
            hidden = _model(**enc).last_hidden_state
        cls = hidden[:, 0]                       # bge: CLS pooling
        cls = torch.nn.functional.normalize(cls, p=2, dim=1)
        out.extend(cls.tolist())
    return out


def _embed_text_for(conn, t: dict[str, Any]) -> str:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT genres, styles, moods, energy, bpm, year, vocals, language, themes, description "
            "FROM track_meta WHERE track_id=%s", (t["id"],))
        m = cur.fetchone()
    bits = [f"{t['title']} — {t['artist'] or 'unknown artist'}"
            + (f" — {t['album']}" if t["album"] else "")]
    facets = []
    for label, v in (("genres", m["genres"]), ("styles", m["styles"]),
                     ("moods", m["moods"]), ("themes", m["themes"])):
        if v:
            facets.append(f"{label}: {', '.join(v)}")
    stats = []
    if m["vocals"]:
        stats.append(m["vocals"])
    if m["energy"]:
        stats.append(f"energy {m['energy']}/10")
    if m["bpm"]:
        stats.append(f"{round(m['bpm'])} bpm")
    if m["year"]:
        stats.append(str(m["year"]))
    if stats:
        facets.append(" · ".join(stats))
    bits.extend(facets)
    if m["description"]:
        bits.append(m["description"])
    return "\n".join(bits)


def ensure_collection() -> None:
    r = requests.get(f"{QDRANT}/collections/{COLLECTION}", timeout=HTTP_CAP_S)
    if r.status_code == 200:
        return
    print(f"[embed] creating Qdrant collection {COLLECTION} (dim {DIM}, cosine)", flush=True)
    r = requests.put(
        f"{QDRANT}/collections/{COLLECTION}",
        json={"vectors": {"size": DIM, "distance": "Cosine"}}, timeout=HTTP_CAP_S)
    r.raise_for_status()


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None) -> None:
    todo = db.tracks_needing(conn, "embed", force, limit, track_id)
    print(f"[embed] {len(todo)} track(s)", flush=True)
    ensure_collection()
    ready = [t for t in todo if t["description"]]
    not_ready = len(todo) - len(ready)
    if not_ready:
        # Deliberately left PENDING (no status write) — they embed on the next
        # run once the profile pass has produced their description.
        print(f"[embed] {not_ready} track(s) have no profile yet — left pending for a later run", flush=True)
    if not ready:
        print("[embed] nothing profile-ready to embed", flush=True)
        return
    ok = failed = 0
    for i in range(0, len(ready), UPSERT_BATCH):
        chunk = ready[i:i + UPSERT_BATCH]
        try:
            texts = [_embed_text_for(conn, t) for t in chunk]
            vecs = embed_texts(texts)
            points = [{
                "id": t["id"],
                "vector": v,
                "payload": {"track_id": t["id"], "artist": t["artist"], "title": t["title"]},
            } for t, v in zip(chunk, vecs)]
            r = requests.put(f"{QDRANT}/collections/{COLLECTION}/points?wait=true",
                             json={"points": points}, timeout=HTTP_CAP_S)
            r.raise_for_status()
            body = r.json()
            if body.get("status") != "ok":
                raise RuntimeError(f"qdrant upsert status: {json.dumps(body)[:200]}")
            for t in chunk:
                db.set_pass_status(conn, t["id"], "embed", True)
            ok += len(chunk)
            print(f"[embed] {ok}/{len(ready)}…", flush=True)
        except Exception as e:  # noqa: BLE001 — recorded, batch continues
            failed += len(chunk)
            print(f"[embed] batch FAILED ({len(chunk)} tracks): {e}", flush=True)
            for t in chunk:
                db.set_pass_status(conn, t["id"], "embed", False, str(e))
    print(f"[embed] done: {ok} ok, {failed} failed "
          f"(model {MODEL_NAME}, collection {COLLECTION})", flush=True)
