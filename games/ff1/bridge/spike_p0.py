#!/usr/bin/env python
"""P0 spike — prove cynes on FF1 per games/ff1/PLAN.md §12 P0.

Checks, in order (each prints a PASS/FAIL/MEASURE line; no silent outcomes):
  1. boot + headless step throughput (frames/sec)
  2. framebuffer capture → PNG dumps (visual verification)
  3. input injection (Start on title changes the screen)
  4. CPU-bus reads incl. $6000-$7FFF (gold/party once a file exists)
  5. savestate: in-process roundtrip + size + save/load cost (undo ring math)
  6. savestate: THROUGH DISK IN A FRESH PROCESS (the flagged cynes unknown —
     run with --restore <state.npy> <frames.png> to do the fresh-process half)
  7. static-screen sweep: hash frames over a window at key screens (§5.3)
  8. SRAM region read/write sanity ($6000-$7FFF reachable)

Run from games/ff1: ./venv/bin/python bridge/spike_p0.py
Artifacts land in bridge/spike_out/ (PNGs, state.npy, results printed).
Addresses cite reference/variables.inc (see PLAN.md §6).
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
OUT.mkdir(exist_ok=True)

# reference/variables.inc :: gold = unsram + $1C ; 3 bytes
GOLD = 0x601C
# reference/variables.inc :: ch_stats = unsram + $0100 (0x40/char)
CH0 = 0x6100


def png(nes_frame: np.ndarray, name: str) -> None:
    Image.fromarray(nes_frame).save(OUT / f"{name}.png")


def frame_hash(f: np.ndarray) -> int:
    return hash(f.tobytes())


def read_range(nes: NES, start: int, n: int) -> bytes:
    return bytes(nes[start + i] for i in range(n))


def sweep(nes: NES, label: str, frames: int = 120) -> int:
    """Advance `frames` with no input, count distinct frame hashes (§5.3)."""
    nes.controller = 0
    seen = set()
    for _ in range(frames):
        seen.add(frame_hash(nes.step(frames=1)))
    print(f"MEASURE static-sweep[{label}]: {len(seen)} distinct frames in {frames}")
    return len(seen)


def main() -> None:
    if len(sys.argv) == 4 and sys.argv[1] == "--restore":
        restore_fresh_process(Path(sys.argv[2]), Path(sys.argv[3]))
        return

    nes = NES(str(ROM))
    print(f"PASS boot: {ROM.name}")

    # -- 1. throughput
    t0 = time.perf_counter()
    n = 5000
    for _ in range(n):
        nes.step(frames=1)
    dt = time.perf_counter() - t0
    print(f"MEASURE throughput: {n/dt:,.0f} frames/sec headless ({dt:.2f}s for {n})")

    # -- 2/3. title screen + input injection. FF1 boot sequence is unknown
    # empirically — dump PNGs at checkpoints so a human (or the next script
    # iteration) can see where we are.
    f = nes.step(frames=1)
    png(f, "01_after_boot_5k")
    h_before = frame_hash(f)
    nes.controller = NES_INPUT_START
    nes.step(frames=2)
    nes.controller = 0
    f = nes.step(frames=60)
    png(f, "02_after_start")
    print(f"{'PASS' if frame_hash(f) != h_before else 'FAIL'} input-injection: Start changed the screen")

    # -- 7. static sweep wherever we are now (menu-ish screen)
    sweep(nes, "post-start-screen")

    # -- 5. savestate roundtrip in-process + undo-ring math
    state = nes.save()
    print(f"MEASURE savestate size: {state.nbytes:,} bytes → undo ring x30 = {state.nbytes*30/1e6:.1f} MB")
    t0 = time.perf_counter()
    for _ in range(100):
        s = nes.save()
    t_save = (time.perf_counter() - t0) / 100
    t0 = time.perf_counter()
    for _ in range(100):
        nes.load(s)
    t_load = (time.perf_counter() - t0) / 100
    print(f"MEASURE savestate cost: save {t_save*1000:.2f} ms, load {t_load*1000:.2f} ms")
    ref = nes.step(frames=1)
    nes.step(frames=180)  # drift away
    nes.load(state)
    back = nes.step(frames=1)
    ok = np.array_equal(ref, back)
    print(f"{'PASS' if ok else 'FAIL'} savestate in-process roundtrip: frame identical after load")

    # -- 6. persist for the fresh-process check
    np.save(OUT / "state.npy", state)
    png(ref, "03_state_reference_frame")
    print(f"SAVED state.npy + reference frame — now run:\n  ./venv/bin/python bridge/spike_p0.py --restore bridge/spike_out/state.npy bridge/spike_out/03_state_reference_frame.png")

    # -- 4/8. CPU bus + SRAM range sanity (no save file exists yet, so just
    # prove the range reads/writes; real party/gold values come once we script
    # into a New Game — next iteration of this spike).
    sram_head = read_range(nes, 0x6000, 16)
    nes[0x7FFF] = 0xA5
    rw_ok = nes[0x7FFF] == 0xA5
    print(f"{'PASS' if rw_ok else 'FAIL'} SRAM $6000-$7FFF reachable (head={sram_head.hex()}, rw@$7FFF ok={rw_ok})")
    print(f"INFO gold@{hex(GOLD)} raw={read_range(nes, GOLD, 3).hex()} ch0@{hex(CH0)} head={read_range(nes, CH0, 8).hex()}")


def restore_fresh_process(state_path: Path, ref_png: Path) -> None:
    """The other half of check 6: fresh process, load state, compare frame."""
    nes = NES(str(ROM))
    nes.load(np.load(state_path))
    back = nes.step(frames=1)
    ref = np.asarray(Image.open(ref_png))
    ok = np.array_equal(ref, back)
    png(back, "04_fresh_process_restored")
    print(f"{'PASS' if ok else 'FAIL'} savestate FRESH-PROCESS roundtrip: frame identical after cross-process load")
    if not ok:
        diff = int(np.count_nonzero(ref != back))
        print(f"  differing bytes: {diff} (see 04_fresh_process_restored.png)")


if __name__ == "__main__":
    main()
