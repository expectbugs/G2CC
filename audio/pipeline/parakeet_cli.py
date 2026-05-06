"""parakeet_cli — invoked by server/src/stt.ts via execFile().

Reads a WAV path from argv[1] and prints the transcript to stdout. Mirrors
the existing faster-whisper subprocess pattern in stt.ts so swapping engines
is one line in config.

Usage (manual):
  audio/venv/bin/python -m pipeline.parakeet_cli /tmp/input.wav

Phase 8 — gated on NeMo install. Until installed, the import will fail loudly.
"""
from __future__ import annotations

import sys

from .parakeet_engine import get_engine


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: parakeet_cli <wav-path>", file=sys.stderr)
        return 2
    engine = get_engine()
    result = engine.transcribe(sys.argv[1])
    print(result.text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
