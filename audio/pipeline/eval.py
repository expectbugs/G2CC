"""eval.py — offline NLMS+DFN evaluation against the captured three-set.

Phase 3B: this script is a placeholder that REFUSES to run when no captures
exist. Loud failure (`NotEnoughCapturesYet`), not silent no-op. Per the
no-silent-failure rule.

Phase 8: real captures land, this runs the full pipeline:
  1. Load voice_plus_machine.wav (stereo)
  2. Run NLMS → mono cleaned
  3. Run DeepFilterNet polish → mono polished
  4. Run faster-whisper or Parakeet on the polished output → transcript
  5. Compare WER against voice_alone.wav transcript (the ground-truth floor)
  6. Compute SNR improvement on TX2 vs polished output

Until then, just enumerate what the captures directory contains so a quick
`python -m pipeline.eval` confirms what's missing.

Usage:
  python -m pipeline.eval                    list captures, raise if none
  python -m pipeline.eval --samples <dir>    use a specific directory
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_SAMPLES = Path('/home/user/G2CC/audio/samples')


class NotEnoughCapturesYet(Exception):
    """Raised loudly when the captures directory is empty/insufficient.

    The discipline rule forbids tuning on synthetic audio. Phase 3B intentionally
    cannot do anything useful without real captures — this exception makes that
    explicit instead of silently producing meaningless numbers.
    """


REQUIRED_PREFIXES = ('machine_alone', 'voice_plus_machine', 'voice_alone')


def find_captures(samples: Path) -> dict[str, Path]:
    """Find one capture per required prefix. Most-recent wins if multiple."""
    if not samples.exists():
        raise NotEnoughCapturesYet(
            f'samples directory does not exist: {samples}\n'
            f'  → run audio/tools/verify_dji_settings.py and audio/tools/capture.py first'
        )

    found: dict[str, Path] = {}
    for prefix in REQUIRED_PREFIXES:
        candidates = sorted(samples.glob(f'{prefix}-*.wav'),
                            key=lambda p: p.stat().st_mtime)
        if candidates:
            found[prefix] = candidates[-1]
    return found


def main() -> int:
    p = argparse.ArgumentParser(description='Offline NLMS+DFN evaluation against three-set captures.')
    p.add_argument('--samples', type=Path, default=DEFAULT_SAMPLES,
                   help='Captures directory (default %(default)s).')
    args = p.parse_args()

    captures = find_captures(args.samples)
    missing = [pfx for pfx in REQUIRED_PREFIXES if pfx not in captures]

    if missing:
        msg = (
            f'{args.samples} is missing required captures: {missing}\n'
            f'  expected one of each prefix: {REQUIRED_PREFIXES}\n'
            f'  → run audio/tools/capture.py for each missing prefix\n'
            f'  → see audio/samples/README.md for the discipline rules'
        )
        raise NotEnoughCapturesYet(msg)

    print('found all required captures:')
    for prefix, path in captures.items():
        print(f'  {prefix}: {path.name}')

    # Phase 8 wires the real pipeline; placeholder for now.
    print()
    print('Phase 8 will run NLMS → DFN → ASR here. For now, captures are')
    print('present and structurally OK to start tuning when authorized.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except NotEnoughCapturesYet as e:
        print(f'NotEnoughCapturesYet: {e}', file=sys.stderr)
        sys.exit(2)
