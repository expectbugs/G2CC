"""parakeet_daemon — persistent WARM Parakeet STT process for G2CC.

The problem this fixes: `parakeet_cli` runs as a fresh `execFile` process per
request, so the NeMo/Parakeet model is cold-loaded (~10-12 s) on EVERY
transcription. This daemon loads the model ONCE (via the `get_engine()`
singleton) and then transcribes many WAVs read from stdin — so only the first
request pays the load; the rest are ~0.5 s.

Spawned + kept warm by server/src/stt.ts (the ParakeetDaemon manager), which
owns the process lifecycle (no timeout — the server supervises externally).

Protocol (line-oriented; run python with -u so it's unbuffered):
  stdin :  one absolute WAV path per line.
  stdout:  per request, exactly one framed block —
             ___G2CC_RESULT_BEGIN___\n<transcript, may be multi-line>\n___G2CC_RESULT_END___\n
           or, if transcription raised —
             ___G2CC_ERROR_BEGIN___\n<TypeName: message>\n___G2CC_ERROR_END___\n
  NeMo / tqdm chatter goes to stderr (logging → stderr); the server parses by
  sentinel, so any stray stdout noise outside a block is ignored.

Loud failures: a transcribe exception is framed as an ERROR block — never
swallowed. EOF on stdin (server closed the pipe) ends the loop cleanly.
"""
from __future__ import annotations

import logging
import sys

from .parakeet_engine import get_engine

# Server contract — these MUST match the sentinels parsed in stt.ts.
RESULT_BEGIN = "___G2CC_RESULT_BEGIN___"
RESULT_END = "___G2CC_RESULT_END___"
ERROR_BEGIN = "___G2CC_ERROR_BEGIN___"
ERROR_END = "___G2CC_ERROR_END___"


def _emit(begin: str, body: str, end: str) -> None:
    """Write one framed block to stdout and flush (so the server sees it now)."""
    sys.stdout.write(begin + "\n")
    sys.stdout.write(body + "\n")
    sys.stdout.write(end + "\n")
    sys.stdout.flush()


def main() -> int:
    # All Python logging → stderr so NeMo's info chatter never mixes with the
    # transcript on stdout. (tqdm bars may still leak to stdout; the server's
    # sentinel-bracketed parse discards anything outside a block.)
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

    # The singleton lazy-loads the model on the first transcribe() call. The
    # server sends a tiny silence WAV right after spawn to force that load up
    # front (warm-up), so the first REAL voice command is already fast.
    engine = get_engine()

    # Read WAV paths until the server closes stdin. No timeout — the server owns
    # this process's lifecycle and kills it on shutdown.
    while True:
        line = sys.stdin.readline()
        if not line:          # EOF — server closed the pipe
            break
        wav_path = line.strip()
        if not wav_path:
            continue
        try:
            result = engine.transcribe(wav_path)
            _emit(RESULT_BEGIN, result.text, RESULT_END)
        except Exception as exc:  # loud + framed — never swallow
            logging.getLogger("g2cc.parakeet").exception("transcribe failed for %s", wav_path)
            _emit(ERROR_BEGIN, f"{type(exc).__name__}: {exc}", ERROR_END)

    return 0


if __name__ == "__main__":
    sys.exit(main())
