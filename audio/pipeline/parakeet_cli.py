"""parakeet_cli — invoked by server/src/stt.ts via execFile().

Reads a WAV path from argv[1] and prints the transcript to stdout, framed by
sentinels so noisy NeMo / tqdm output on stdout can't get parsed as part of
the transcript on the server side.

Usage (manual):
  audio/venv/bin/python -m pipeline.parakeet_cli /tmp/input.wav

Output shape (stdout):
  ...NeMo and tqdm noise...
  ___G2CC_RESULT_BEGIN___
  <transcript text, may span multiple lines>
  ___G2CC_RESULT_END___

Server parses by sentinel. Anything outside the sentinel block is ignored.
"""
from __future__ import annotations

import logging
import sys

from .parakeet_engine import get_engine

# Server contract: transcript lives between these markers. Match in stt.ts.
RESULT_BEGIN = "___G2CC_RESULT_BEGIN___"
RESULT_END = "___G2CC_RESULT_END___"


def main() -> int:
    # Push every Python log handler to stderr so NeMo's info chatter doesn't
    # mix with the transcript on stdout. tqdm progress bars may still leak
    # to stdout — the sentinel-bracketed parse on the server side handles it.
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

    if len(sys.argv) < 2:
        print("usage: parakeet_cli <wav-path>", file=sys.stderr)
        return 2
    engine = get_engine()
    result = engine.transcribe(sys.argv[1])
    print(RESULT_BEGIN)
    print(result.text)
    print(RESULT_END)
    return 0


if __name__ == "__main__":
    sys.exit(main())
