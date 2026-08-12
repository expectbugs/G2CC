"""macros.py — the verified input executor (PLAN §8.2 + P0-R input protocol).

Every primitive honors the P0-R findings:
  - menu presses hold ≥8 frames (2-frame presses get eaten); ~24-frame gaps
    between presses are reliable → press() settles before returning.
  - overworld steps are POSITION-VERIFIED holds: hold the direction until the
    player tile commits (~24 f/tile) under a frame budget — fixed short holds
    never commit. $81 is polled EVERY frame mid-hold (battles fire mid-step).
  - settle-v2: K consecutive identical frames = settled, but a UNIFORM-color
    frame is never accepted (fades pass through sustained black).

No wall-clock timeouts anywhere — every wait is frame-budgeted and a budget
overrun raises BudgetExceeded (LOUD), state intact, caller decides.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
from cynes import (
    NES, NES_INPUT_A, NES_INPUT_B, NES_INPUT_SELECT, NES_INPUT_START,
    NES_INPUT_UP, NES_INPUT_DOWN, NES_INPUT_LEFT, NES_INPUT_RIGHT,
)

import ramspec
import scrape

BUTTONS = {
    'A': NES_INPUT_A, 'B': NES_INPUT_B, 'Start': NES_INPUT_START,
    'Select': NES_INPUT_SELECT, 'Up': NES_INPUT_UP, 'Down': NES_INPUT_DOWN,
    'Left': NES_INPUT_LEFT, 'Right': NES_INPUT_RIGHT,
}
DIRS = {'up': NES_INPUT_UP, 'down': NES_INPUT_DOWN, 'left': NES_INPUT_LEFT, 'right': NES_INPUT_RIGHT}

PRESS_HOLD = 8          # P0-R: ≥8-frame holds
PRESS_GAP = 24          # P0-R: ~24-frame gap reliable
SETTLE_K = 12           # §5.3: K consecutive identical frames. 12, not 4: FF1
                        # fade-ins hold each palette level for several frames, and
                        # K=4 accepted a MID-FADE town as settled (Ph-A shop exit —
                        # inputs pressed into a fade get latched/eaten). Fade holds
                        # measured < 12f; the settle-v2 uniform rule still applies.
SETTLE_BUDGET = 600     # frames — generous; fades + battle intros settle < 400
STEP_BUDGET = 90        # frames/tile before 'blocked' (~24 f/tile when moving)


class BudgetExceeded(RuntimeError):
    """A frame budget ran out — surfaced LOUD, never swallowed (§10)."""


class Desync(RuntimeError):
    """A verified press did not produce its expected RAM effect (§7.1)."""


@dataclass
class StepOutcome:
    committed: int          # tiles actually committed
    stopped: str            # 'done' | 'battle' | 'mapchange' | 'blocked'
    pos: tuple[int, int]


class Emu:
    """Owns the cynes core + glyph table; every advance goes through here so
    frame bookkeeping (last frame, patterns cache) stays coherent."""

    def __init__(self, rom_path: str, rng_jitter: bool = False) -> None:
        self.nes = NES(rom_path)
        self.rom_path = rom_path
        self.rng_jitter = rng_jitter
        self.frame: np.ndarray = self.nes.step(frames=1)
        self._patterns: Optional[np.ndarray] = None
        glyphs_path = Path(rom_path).resolve().parent.parent / 'data' / 'glyphs.json'
        self.glyphs = scrape.GlyphTable.load(glyphs_path)
        # False when the last press landed on a perpetually-animating screen
        # (game menu) — rides daemon responses so nothing is silently unstable.
        self.last_settled = True

    # ---------------------------------------------------------------- core
    def read(self, addr: int) -> int:
        return self.nes[addr]

    def step(self, frames: int = 1) -> None:
        self.frame = self.nes.step(frames=frames)
        self._patterns = None
        if self.nes.has_crashed:
            raise RuntimeError('cynes CPU crash flag set (invalid opcode) — core wedged')

    def patterns(self) -> np.ndarray:
        if self._patterns is None:
            self._patterns = scrape.cell_patterns(self.frame)
        return self._patterns

    def frame_hash(self) -> str:
        return scrape.frame_hash(self.frame)

    def uniform_frame(self) -> bool:
        f = self.frame
        return bool((f == f[0, 0]).all())

    def save(self) -> np.ndarray:
        return self.nes.save()

    def load(self, buf: np.ndarray) -> None:
        # cynes rejects read-only arrays (np.frombuffer / np.load mmap) — copy.
        self.nes.load(buf if buf.flags.writeable else buf.copy())
        self.step(1)   # re-derive a coherent current frame

    def in_battle(self) -> bool:
        return ramspec.in_battle(self.read)

    # ---------------------------------------------------------------- waits
    def settle(self, budget: int = SETTLE_BUDGET, k: int = SETTLE_K,
               allow_animated: bool = False) -> bool:
        """Advance until k consecutive identical NON-UNIFORM frames (settle-v2).
        Returns True when static. Some screens NEVER settle (the game menu's
        character portraits animate perpetually — found at Ph-A): callers that
        may land on one pass allow_animated=True and get False back (the
        'screen still animating' fact rides the daemon response — LOUD, not
        swallowed). Otherwise a budget overrun raises BudgetExceeded."""
        self.nes.controller = 0
        last: Optional[str] = None
        run = 0
        for _ in range(budget):
            h = self.frame_hash()
            if not self.uniform_frame():
                run = run + 1 if h == last else 1
                last = h
                if run >= k:
                    return True
            else:
                run, last = 0, None
            self.step(1)
        if allow_animated:
            return False
        raise BudgetExceeded(f'settle: {budget} frames without a static non-uniform screen')

    def wait_until(self, cond: Callable[[], bool], budget: int, what: str) -> None:
        """Frame-budgeted condition wait (the no-timeouts rule: frames, LOUD)."""
        for _ in range(budget):
            if cond():
                return
            self.step(1)
        raise BudgetExceeded(f'wait_until({what}): {budget} frames exhausted')

    # ---------------------------------------------------------------- input
    def _hold_frames(self, base: int) -> int:
        # §8.3 RNG honesty: pad injected presses 0-9 frames so battle outcomes
        # aren't frame-replayable. Tests run rng_jitter=False.
        return base + (random.randint(0, 9) if self.rng_jitter else 0)

    def press(self, button: str, hold: int = PRESS_HOLD, settle: bool = True) -> None:
        """One verified-timing press (≥8-frame hold), then settle. Screens that
        never go static (game menu portraits) set last_settled=False instead of
        raising — the daemon surfaces that on the response."""
        mask = BUTTONS.get(button)
        if mask is None:
            raise ValueError(f'unknown button {button!r}')
        self.nes.controller = mask
        self.step(self._hold_frames(hold))
        self.nes.controller = 0
        if settle:
            self.last_settled = self.settle(allow_animated=True)
        else:
            self.step(PRESS_GAP)
            self.last_settled = True

    def press_verified(self, button: str, cond: Callable[[], bool], what: str,
                       budget: int = 240, attempts: int = 3) -> None:
        """Press until `cond` holds. The NES polls input once per frame loop —
        a press landing outside a poll window is EATEN (observed at P0 and in
        the Ph-A battle probe: some A-presses no-op). Each attempt is one press
        + a budgeted wait; attempts exhausted ⇒ Desync (LOUD, state intact).
        `cond` must be a REAL RAM/screen effect so a retry can never double-
        apply silently."""
        if cond():
            raise Desync(f'press_verified({what}): condition ALREADY true before the press — '
                         'caller drift, refusing to inject')
        for attempt in range(1, attempts + 1):
            self.press(button, settle=False)
            for _ in range(budget):
                if cond():
                    return
                self.step(1)
        raise Desync(f'press_verified({what}): no effect after {attempts} presses × {budget}f')

    # ---------------------------------------------------------------- steps
    def pos(self) -> tuple[int, int]:
        return ramspec.player_tile(self.read)

    def steps(self, direction: str, count: int, stop_battle: bool = True) -> StepOutcome:
        """Position-verified walk: hold `direction`, verify each tile commit via
        the player-tile RAM (ow scroll+7 / sm_player), poll $81 every frame.
        Stops: count done / battle / map change / blocked (budget, e.g. wall).

        The stop reason is re-evaluated AFTER every settle: an encounter or a
        map transition (town/teleport fade) can fire on the tile that just
        committed, i.e. DURING the settle — returning 'done' there mislabeled
        the state (found by the Ph-A entrance BFS walking into Coneria and
        never seeing 'mapchange')."""
        mask = DIRS.get(direction)
        if mask is None:
            raise ValueError(f'unknown direction {direction!r}')
        committed = 0
        start_map = (self.read(ramspec.MAPFLAGS) & 1, self.read(ramspec.CUR_MAP))

        def in_motion() -> bool:
            # variables.inc :: move_ctr_x/y — pixels between tiles (00-0F);
            # nonzero exactly while a tile animation runs.
            return self.read(ramspec.MOVE_CTR_X) != 0 or self.read(ramspec.MOVE_CTR_Y) != 0

        def finish(reason: str) -> StepOutcome:
            self.nes.controller = 0
            self.settle(budget=900)
            if stop_battle and self.in_battle():
                reason = 'battle'
            elif (self.read(ramspec.MAPFLAGS) & 1, self.read(ramspec.CUR_MAP)) != start_map:
                reason = 'mapchange'
            return StepOutcome(committed, reason, self.pos())

        while committed < count:
            before = self.pos()
            # Phase 1: hold the direction until MOTION STARTS (move_ctr leaves 0
            # or the tile commits). Releasing on motion-start prevents the game
            # latching a second step while the ~16-frame animation runs — a held
            # button through the animation double-moved southward steps (the
            # scroll-y commit lands LATE for 'down'; found at the Ph-A gate probe).
            self.nes.controller = mask
            started = False
            for _ in range(STEP_BUDGET):
                self.step(1)
                if stop_battle and self.in_battle():
                    return finish('battle')
                if (self.read(ramspec.MAPFLAGS) & 1, self.read(ramspec.CUR_MAP)) != start_map:
                    return finish('mapchange')
                if in_motion() or self.pos() != before:
                    started = True
                    break
            self.nes.controller = 0
            if not started:
                return finish('blocked')
            # Phase 2: button released — run the animation out (battle/transition
            # can still fire on this tile: checked every frame).
            for _ in range(STEP_BUDGET):
                self.step(1)
                if stop_battle and self.in_battle():
                    return finish('battle')
                if (self.read(ramspec.MAPFLAGS) & 1, self.read(ramspec.CUR_MAP)) != start_map:
                    return finish('mapchange')
                if not in_motion() and self.pos() != before:
                    break
                if not in_motion() and self.pos() == before:
                    # motion ended without a tile commit (bumped animation?) —
                    # treat as blocked, LOUD via reason
                    return finish('blocked')
            if self.pos() == before:
                return finish('blocked')
            committed += 1
        return finish('done')
