#!/usr/bin/env python
"""P0 spike part B — script from the main menu into a New Game, then hunt a
battle on the overworld while watching the candidate in-battle indicators.

Iterative explorer: starts from bridge/spike_out/state.npy (the main menu
checkpoint captured by spike_p0.py), presses inputs with settle detection,
dumps numbered PNGs for visual verification, and saves named checkpoints so
each run can start from the deepest known-good point.

Usage: ./venv/bin/python bridge/spike_p0b.py [stage]
  stage 'menu'   — from state.npy: pick NEW GAAME, land on party select
  stage 'party'  — from ckpt named by prior stage … (extended per run)
"""
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from cynes import (
    NES, NES_INPUT_START, NES_INPUT_A, NES_INPUT_B, NES_INPUT_UP,
    NES_INPUT_DOWN, NES_INPUT_LEFT, NES_INPUT_RIGHT, NES_INPUT_SELECT,
)

HERE = Path(__file__).resolve().parent
ROM = HERE.parent / "rom" / "Final Fantasy.nes"
OUT = HERE / "spike_out"

# reference/variables.inc lineage — see PLAN.md §6
GOLD = 0x601C          # gold (3 bytes LE — confirmed: 400 at boot)
CH0 = 0x6100           # ch_stats char 0 (0x40/char)
MUSIC = 0x4B           # music_track ($50 = battle per Data Crystal)
DOLLAR81 = 0x81        # $68 in-fight / $63 on-map-after (Data Crystal proxy)
BTL_RESULT = 0x6B86
BTL_ENEMY_IDS = 0x6BB7  # 9 slots, $FF empty
BTL_ENEMYSTATS = 0x6BD3  # $14/enemy, +$02 HP lo/hi
BTL_ENEMYCOUNT = 0x6C93
VEHICLE = 0x42
OW_SCROLL_X, OW_SCROLL_Y = 0x27, 0x28

BTN = {
    "A": NES_INPUT_A, "B": NES_INPUT_B, "St": NES_INPUT_START,
    "Se": NES_INPUT_SELECT, "U": NES_INPUT_UP, "D": NES_INPUT_DOWN,
    "L": NES_INPUT_LEFT, "R": NES_INPUT_RIGHT,
}

shot_i = 0


def png(f: np.ndarray, name: str) -> None:
    global shot_i
    shot_i += 1
    Image.fromarray(f).save(OUT / f"b{shot_i:02d}_{name}.png")
    print(f"  shot b{shot_i:02d}_{name}.png")


def fh(f: np.ndarray) -> int:
    return hash(f.tobytes())


def settle(nes: NES, budget: int = 240, k: int = 4) -> np.ndarray:
    """Advance until k consecutive identical frames (or budget). LOUD on budget."""
    nes.controller = 0
    last, run, spent = None, 0, 0
    f = nes.step(frames=1)
    while spent < budget:
        h = fh(f)
        run = run + 1 if h == last else 1
        last = h
        if run >= k:
            return f
        f = nes.step(frames=1)
        spent += 1
    print(f"  LOUD: settle budget {budget} exhausted (screen still changing)")
    return f


def press(nes: NES, name: str, hold: int = 2) -> np.ndarray:
    nes.controller = BTN[name]
    nes.step(frames=hold)
    nes.controller = 0
    return settle(nes)


def rd(nes: NES, a: int, n: int = 1) -> bytes:
    return bytes(nes[a + i] for i in range(n))


def party_line(nes: NES) -> str:
    out = []
    for c in range(4):
        b = rd(nes, CH0 + c * 0x40, 0x28)
        cls, ail = b[0], b[1]
        hp = b[0x0A] | (b[0x0B] << 8)
        mx = b[0x0C] | (b[0x0D] << 8)
        out.append(f"c{c}:cls={cls} ail={ail} hp={hp}/{mx}")
    g = rd(nes, GOLD, 3)
    gold = g[0] | (g[1] << 8) | (g[2] << 16)
    return " · ".join(out) + f" · gold={gold}"


def battle_probe(nes: NES) -> str:
    ids = rd(nes, BTL_ENEMY_IDS, 9).hex()
    return (f"$4B={rd(nes, MUSIC).hex()} $81={rd(nes, DOLLAR81).hex()} "
            f"result={rd(nes, BTL_RESULT).hex()} count={rd(nes, BTL_ENEMYCOUNT).hex()} ids={ids}")


def ckpt(nes: NES, name: str) -> None:
    np.save(OUT / f"ckpt_{name}.npy", nes.save())
    print(f"  ckpt_{name}.npy saved")


def load(nes: NES, name: str) -> None:
    nes.load(np.load(OUT / f"ckpt_{name}.npy"))


def stage_menu(nes: NES) -> None:
    nes.load(np.load(OUT / "state.npy"))
    print("stage menu: at CONTINUE/NEW GAME")
    f = press(nes, "D")
    png(f, "cursor_down")
    f = press(nes, "A")
    png(f, "after_A_on_newgame")
    print("  " + party_line(nes))
    ckpt(nes, "postmenu")


def stage_probe(nes: NES) -> None:
    """Look around the post-menu screen: try a few inputs, dump each."""
    load(nes, "postmenu")
    for name in ("A", "D", "R", "St", "Se"):
        load(nes, "postmenu")
        f = press(nes, name)
        png(f, f"postmenu_try_{name}")


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "menu"
    nes = NES(str(ROM))
    t0 = time.perf_counter()
    if stage == "menu":
        stage_menu(nes)
    elif stage == "probe":
        stage_probe(nes)
    else:
        print(f"unknown stage {stage}")
        sys.exit(2)
    print(f"done in {time.perf_counter()-t0:.1f}s")
