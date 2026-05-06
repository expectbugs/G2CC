"""tune.py — NLMS parameter sweep against captured three-set.

Phase 3B: placeholder; refuses to run without real captures (loud failure).
Phase 8: sweeps μ and filter length over voice_plus_machine.wav, reports
SNR on TX2 + WER on cleaned vs voice_alone.wav.

Usage:
  python -m pipeline.tune                       refuse if no captures
  python -m pipeline.tune --samples <dir>       use specific captures dir

Discipline (g2_custom_app_spec.md §B8): tune on real DJI captures, never
synthetic. Changing four things at once defeats measurement.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .eval import find_captures, NotEnoughCapturesYet, REQUIRED_PREFIXES, DEFAULT_SAMPLES

SWEEP_MU = (0.01, 0.02, 0.025, 0.03, 0.05)
SWEEP_TAPS = (256, 512, 1024, 2048)
SWEEP_HP_CUTOFF = (40.0, 60.0, 80.0)


def main() -> int:
    p = argparse.ArgumentParser(description='NLMS parameter sweep on real captures.')
    p.add_argument('--samples', type=Path, default=DEFAULT_SAMPLES)
    args = p.parse_args()

    captures = find_captures(args.samples)
    missing = [pfx for pfx in REQUIRED_PREFIXES if pfx not in captures]
    if missing:
        raise NotEnoughCapturesYet(
            f'{args.samples} is missing required captures: {missing}\n'
            f'  → run audio/tools/capture.py for each missing prefix'
        )

    print('Phase 8 will sweep these parameter values:')
    print(f'  mu        = {SWEEP_MU}')
    print(f'  taps      = {SWEEP_TAPS}')
    print(f'  hp_cutoff = {SWEEP_HP_CUTOFF}')
    print(f'against {captures["voice_plus_machine"].name}')
    print()
    print('SNR floor target: ≥ 15 dB improvement on TX2 (per spec §B2).')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except NotEnoughCapturesYet as e:
        print(f'NotEnoughCapturesYet: {e}', file=sys.stderr)
        sys.exit(2)
