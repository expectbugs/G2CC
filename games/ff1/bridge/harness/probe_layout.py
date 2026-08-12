#!/usr/bin/env python
"""probe_layout.py — dev/diagnostic: dump the ink-cell map of a checkpoint (or
a scripted screen) so screen-region tables in screens.py carry PROBED tile
coordinates, not guesses (verify-before-execute applied to layout).

Usage (from games/ff1):
  ./venv/bin/python bridge/harness/probe_layout.py <ckpt|state.npy> [--grid]
  --grid: from ckpt_partysel, press A to open the name-entry grid first.

Prints a 30×32 map: '.'=empty, '#'=ink cell, with row/col rulers.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

BRIDGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BRIDGE))

from cynes import NES, NES_INPUT_A, NES_INPUT_DOWN  # noqa: E402
import scrape  # noqa: E402

ROM = BRIDGE.parent / 'rom' / 'Final Fantasy.nes'
OUT = BRIDGE / 'spike_out'


def settle(nes: NES, budget: int = 240, k: int = 4) -> np.ndarray:
    nes.controller = 0
    last, run = None, 0
    f = nes.step(frames=1)
    for _ in range(budget):
        h = scrape.frame_hash(f)
        run = run + 1 if h == last else 1
        last = h
        if run >= k:
            return f
        f = nes.step(frames=1)
    print(f'LOUD: settle budget {budget} exhausted')
    return f


def press(nes: NES, mask: int, hold: int = 8) -> np.ndarray:
    nes.controller = mask
    nes.step(frames=hold)
    nes.controller = 0
    return settle(nes)


def dump(frame: np.ndarray, label: str) -> None:
    pats = scrape.cell_patterns(frame)
    print(f'--- {label} ---')
    print('    ' + ''.join(str(c % 10) for c in range(32)))
    for r in range(30):
        row = ''.join('#' if pats[r, c] != 0 else '.' for c in range(32))
        print(f'{r:3d} {row}')


def main() -> None:
    name = sys.argv[1]
    nes = NES(str(ROM))
    nes.load(np.load(OUT / name))
    f = settle(nes)
    if '--grid' in sys.argv:
        f = press(nes, NES_INPUT_A)
        dump(f, f'{name} + A (grid open, cursor@A)')
        f = press(nes, NES_INPUT_DOWN)
        dump(f, 'after Down (cursor@K)')
    else:
        dump(f, name)


if __name__ == '__main__':
    main()
