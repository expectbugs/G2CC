# One-shot query embedder (MUSIC_SPEC D4 lane 3, 2026-08-05 Phase C).
#
# stdin: the raw request text (utf-8). stdout: a JSON array — the 384-dim
# L2-normalized bge-small-en-v1.5 vector, SAME model + pooling as the library
# embeddings (enrich/passes/embed.py — the pinned-model rule: query and
# collection must share the model or cosine ranks are garbage).
#
# Cold cost ~3.5 s (model load dominates; measured 2026-08-05). The server
# treats this as the seconds-class fallback lane, never the hot path. Any
# failure exits non-zero with the error on stderr — the caller's deterministic
# fallback owns recovery (a dead embedder must never mean dead music).
#
# Run from audio/:  ./venv/bin/python -m enrich.embed_query <<< "hard metal"

import contextlib
import json
import sys

from enrich.passes.embed import embed_texts


def main() -> int:
    text = sys.stdin.read().strip()
    if not text:
        print("embed_query: empty stdin", file=sys.stderr)
        return 2
    # embed.py's model-load progress prints to stdout — divert it to stderr so
    # stdout carries ONLY the JSON vector (the server JSON.parses it whole).
    with contextlib.redirect_stdout(sys.stderr):
        vec = embed_texts([text])[0]
    json.dump(vec, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
