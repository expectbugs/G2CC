"""battle.py — Ph-B battle-round executor: verified command entry + resolution
(PLAN §7.1 / §12 P2).

Command entry drives the game's OWN battle menus with emulated-controller
presses; every step is verified against the documented menu-state RAM
(btlcmd_curchar / btlcurs / btlcmd_target — reference/variables.inc), with
btl_charcmdbuf as the byte-exact pre-resolution check that the queued
commands are EXACTLY what was picked. A mismatch raises BattleDesync (LOUD,
state intact — the daemon checkpoints before every round, so undo recovers).

INPUT DISCIPLINE (probed session 2 — the battle engine is NOT the overworld
engine): bank_0C's menus poll input per frame-ish with EDGE detection
(MenuSelection_2x4: DoFrame_WithInput vs btlinput_prevstate). A held button
that spans a submenu transition is re-sampled by the NEXT menu as a fresh
edge — an 8-frame A hold on the spell menu instantly auto-confirmed the
ally-target menu at its home position (default target = slot 0). Hence
SHORT holds (4 f) + released gaps here, every press effect-verified with
bounded retries (a 4 f press can still be eaten by the ~5-frame magic-draw
sample cadence — retries cover it; the verify conditions are transitions,
so a retry can never double-apply).

Menu model (reference/bank_0C.asm, fetched 2026-08-12 — see reference/README):
  command menu   2×4: (0,0)=FIGHT (0,1)=MAGIC (0,2)=DRINK (0,3)=ITEM col1=RUN
  fight          A → SelectEnemyTarget (btlcmd_target live) → A confirms
  magic          A → MenuSelection_Magic page0 rows=L1-4 x=slot; Down@row3
                 flips to page 1 (L5-8); empty slot / 0 MP → "Nothing" box
  spell targets  MAGDATA_TARGET: one-enemy → enemy picker; one-ally →
                 SelectPlayerTarget (btlcurs_y&3 = party slot at confirm);
                 caster/all-enemies/whole-party → no picker. The cmdbuf row
                 is written ONLY at picker confirm (SetCharacterBattleCommand
                 — bank_0C.asm :: BattleSubMenu_Magic @Target_10), never at
                 spell select; the picker-confirm A IS the completing press.
  picker-open    A LIVE ally picker reads btlcurs=(0,0) — MenuSelection_2x4
  signatures     zeroes x/y at entry, indistinguishable from the spell menu's
                 home. (Session-2's "(16,0) = picker" was post-confirm scratch
                 — it detected the FAILURE case.) The real signature is the
                 cursor SPRITE (btlcursspr_x/y, rewritten every menu-loop
                 iteration from per-menu pixel luts, disjoint areas):
                   ally picker   x ∈ {$90,$98,$A0}, y ∈ {$34,$4C,$64,$7C}
                   enemy picker  x ≤ $50, y ∈ [$30,$70]
                   magic menu    x ∈ {$20,$48,$70}, y ∈ [$A6,$D6]
                   command menu  x ∈ [$58,$90], y ∈ [$9E,$CE]
                 Enemy pickers also write btlcurs_max($6AAB) ∈ {3,7,8} at
                 prep. btlcursspr stays STALE after a menu exits — "picker
                 reached" (sprite) + "row not freshly written" (cmdbuf guard)
                 together prove "picker live".
  cmdbuf         4 B/char: cmd, effect, target, pad. cmd: 04 fight / 40 magic
                 / 20 run / 08 drink / 10 item. target: 0x = enemy slot,
                 8x = party slot, FF = all enemies, FE = whole party.
                 Fight effect byte = 0x10 (observed constant, Ph-B probes).
  round end      btlcmd_curchar returns to 0 + btlcurs home + roster box
                 scrapes (the command menu is back); battle end = btl_result
                 nonzero (1 dead / 2 won / 3 ran). cmdbuf is NOT cleared
                 between rounds — verification keys on transitions, not bytes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

import ramspec
import scrape
import screens
from macros import BUTTONS, Emu

BPRESS_HOLD = 4         # short: must NOT span a submenu transition (see docstring)
PICKER_HOLD = 2         # shorter still, for presses that OPEN a target picker:
                        # the one-ally picker (SelectPlayerTarget) opens fast
                        # enough that even a 4 f held A is re-sampled by it as a
                        # fresh edge → instant auto-confirm at the home slot
                        # (probed session 2; 2 f A was PROVEN to open it live).
BPRESS_GAP = 20         # released frames after every press (clean edges)
PRESS_BUDGET = 150      # frames to wait for a press's verified effect
PRESS_ATTEMPTS = 4      # eaten-press retries (magic-draw cadence eats 4 f presses)
MENU_WAIT = 400         # frames for a char's command menu to appear
RESOLUTION_BUDGET = 30000   # frames for one round's resolution (respond-rate slow)
OUTRO_BUDGET = 6000     # frames for the victory/defeat/flee outro to leave battle
STABLE_FRAMES = 12      # combat-box text stable this long = a message (dwell ≥ ~80 f)

FIGHT_EFFECT_BYTE = 0x10    # observed constant in every fight cmdbuf write (Ph-B)

CMD_POS = {'fight': (0, 0), 'magic': (0, 1), 'drink': (0, 2), 'item': (0, 3),
           'run': (1, 0)}


class BattleDesync(RuntimeError):
    """Command entry diverged from the game's menu state — LOUD halt, state
    intact; the pre-round undo checkpoint is the recovery path (§8.4)."""


@dataclass
class CharCommand:
    char: int               # party slot 0-3
    action: str             # 'fight' | 'magic' | 'run'
    target: Optional[int] = None   # fight: enemy slot; magic one-ally: party slot
    level: int = 0          # magic: spell level 1-8 (page 1 levels 5-8 deferred)
    slot: int = 0           # magic: slot within the level, 0-3


@dataclass
class RoundResult:
    log: List[str]          # stable combat-box messages, in order
    result: int             # btl_result when the round settled
    outcome: str            # 'continue' | 'won' | 'party-dead' | 'ran'
    frames: int             # resolution length


OUTCOMES = {0: 'continue', 1: 'party-dead', 2: 'won', 3: 'ran'}


class BattleExecutor:
    def __init__(self, emu: Emu, spells: List[dict]) -> None:
        self.emu = emu
        self.spells = spells    # data/spells.json 'spells' list (target types)
        # test hook for the §12 P2 desync drill: names of press labels whose
        # controller writes are suppressed (the press "happens" but no button
        # reaches the pad — a fully-eaten input). Never set in production.
        self.drop_presses: set = set()

    # ------------------------------------------------------------- low level
    def _r(self, addr: int) -> int:
        return self.emu.read(addr)

    def curs(self) -> Tuple[int, int]:
        return self._r(ramspec.BTLCURS_X), self._r(ramspec.BTLCURS_Y)

    def sprite_pos(self) -> Tuple[int, int]:
        return self._r(ramspec.BTLCURSSPR_X), self._r(ramspec.BTLCURSSPR_Y)

    def _ally_picker_reached(self) -> bool:
        # lut_PlayerTargetCursorPos x=$A0 (dead −8, current char −16 → ≥$90),
        # y ∈ {$34,$4C,$64,$7C} — disjoint from every other battle menu's lut
        x, y = self.sprite_pos()
        return x >= 0x90 and y <= 0x7C

    def _enemy_picker_reached(self) -> bool:
        # lut_Target{9Small,4Large,Mix}CursorPos: x ≤ $50, y ∈ [$30,$70]
        x, y = self.sprite_pos()
        return x <= 0x50 and 0x30 <= y <= 0x70

    def curchar(self) -> int:
        return self._r(ramspec.BTLCMD_CURCHAR)

    def cmdbuf(self, char: int) -> Tuple[int, int, int, int]:
        base = ramspec.BTL_CHARCMDBUF + char * 4
        return tuple(self._r(base + i) for i in range(4))

    def _bpress(self, button: str, label: str, hold: int = BPRESS_HOLD) -> None:
        if label in self.drop_presses:
            self.emu.step(hold)             # the drill: frames pass, no button
        else:
            self.emu.nes.controller = BUTTONS[button]
            self.emu.step(hold)
            self.emu.nes.controller = 0
        self.emu.step(BPRESS_GAP)

    def bpress_verified(self, button: str, cond: Callable[[], bool], what: str,
                        attempts: int = PRESS_ATTEMPTS, budget: int = PRESS_BUDGET,
                        hold: int = BPRESS_HOLD) -> None:
        if cond():
            raise BattleDesync(f'{what}: condition already true before the press — caller drift')
        for _ in range(attempts):
            self._bpress(button, what, hold=hold)
            for _ in range(budget):
                if cond():
                    return
                self.emu.step(1)
        raise BattleDesync(f'{what}: no effect after {attempts} presses × {budget}f')

    def combat_text(self) -> Tuple[str, ...]:
        res = scrape.scrape_region(self.emu.patterns(), self.emu.glyphs,
                                   *screens.REGION_BTL_COMBATBOX)
        return tuple(ln for ln in res.lines if ln.strip())

    def roster_text(self) -> Tuple[str, ...]:
        res = scrape.scrape_region(self.emu.patterns(), self.emu.glyphs,
                                   *screens.REGION_BTL_ROSTER)
        return tuple(ln for ln in res.lines if ln.strip())

    def at_command_menu(self, char: int) -> bool:
        return (self.emu.in_battle() and self.curchar() == char
                and self.curs() == (0, 0) and len(self.roster_text()) > 0)

    # ------------------------------------------------------------- entry
    def living_slots(self) -> List[int]:
        return [i for i in range(4)
                if ramspec.read_char(self._r, i, lambda b: '').alive()]

    def spell_meta(self, level: int, slot: int, char: int) -> dict:
        """Resolve the spell sitting in ch_spells[level][slot] via spells.json."""
        val = self._r(ramspec.CH_MAGIC + char * ramspec.CH_STRIDE
                      + ramspec.CH_SPELLS + (level - 1) * 4 + slot)
        if val == 0:
            raise BattleDesync(f'char {char} has no spell at L{level} slot {slot}')
        spell_id = (level - 1) * 8 + (val - 1)
        # ch_spells values are 1-8 within the level; ids run 8/level (4W+4B)
        return self.spells[spell_id]

    def enter_round(self, commands: List[CharCommand]) -> List[Tuple[int, ...]]:
        """Drive the game's menus to enter `commands`. Returns the expected
        cmdbuf rows for the final byte-exact check (also asserted here)."""
        by_char = {c.char: c for c in commands}
        living = self.living_slots()
        missing = [ch for ch in living if ch not in by_char]
        if missing:
            raise BattleDesync(f'no command supplied for living char(s) {missing}')
        expected: dict = {}
        for idx, ch in enumerate(living):
            cmd = by_char[ch]
            last = idx == len(living) - 1
            self.emu.wait_until(lambda c=ch: self.at_command_menu(c), MENU_WAIT,
                                f'char {ch} command menu')
            expected[ch] = self._enter_one(ch, cmd, last)
            row = self.cmdbuf(ch)
            if row != expected[ch]:
                raise BattleDesync(
                    f'char {ch} cmdbuf {[f"{b:02x}" for b in row]} != expected '
                    f'{[f"{b:02x}" for b in expected[ch]]} — halting before resolution')
        return [expected[ch] for ch in living]

    def _nav_command(self, ch: int, action: str) -> None:
        x, y = CMD_POS[action]
        for want in range(1, y + 1):
            self.bpress_verified('Down', lambda w=want: self.curs() == (0, w),
                                 f'char {ch} menu down→{want}')
        if x == 1:
            self.bpress_verified('Right', lambda: self.curs()[0] == 1,
                                 f'char {ch} menu right (RUN)')

    def _enter_one(self, ch: int, cmd: CharCommand, last: bool) -> Tuple[int, int, int, int]:
        if cmd.action == 'fight':
            if cmd.target is None:
                raise BattleDesync(f'char {ch}: fight needs an enemy target slot')
            row_before = self.cmdbuf(ch)
            self._nav_command(ch, 'fight')
            # PICKER_HOLD: same auto-confirm shape as the spell pickers — this
            # path happened to pass at 4 f (SelectEnemyTarget preps longer) but
            # the resume-note verdict is "do not rely on that".
            self.bpress_verified('A', self._enemy_picker_reached,
                                 f'char {ch} fight→enemy picker', hold=PICKER_HOLD)
            self._assert_picker_live(ch, row_before, 0x04, f'char {ch} enemy picker')
            self._pick_enemy(ch, cmd.target)
            self._confirm(ch, last, f'char {ch} fight confirm')
            return (0x04, FIGHT_EFFECT_BYTE, cmd.target, 0x00)

        if cmd.action == 'magic':
            if not (1 <= cmd.level <= 4):
                raise BattleDesync(
                    f'char {ch}: magic level {cmd.level} — page-1 levels (5-8) are '
                    'deferred until a leveled fixture exists (BUILD_LOG Ph-B note)')
            meta = self.spell_meta(cmd.level, cmd.slot, ch)
            self._nav_command(ch, 'magic')
            self.bpress_verified('A', lambda: self._spell_menu_open(),
                                 f'char {ch} magic submenu')
            for want in range(1, cmd.level):
                self.bpress_verified('Down', lambda w=want: self.curs()[1] == w,
                                     f'char {ch} spell row→{want}')
            for want in range(1, cmd.slot + 1):
                self.bpress_verified('Right', lambda w=want: self.curs()[0] == w,
                                     f'char {ch} spell col→{want}')
            tgt_byte = self._enter_spell_target(ch, meta, cmd)
            # for picker spells this confirms the target; for no-picker types
            # (caster / all-enemies / whole-party) this IS the spell-select A
            self._confirm(ch, last, f'char {ch} magic confirm')
            return (0x40, meta['id'], tgt_byte, 0x00)

        if cmd.action == 'run':
            self._nav_command(ch, 'run')
            self._confirm(ch, last, f'char {ch} run')
            row = self.cmdbuf(ch)
            return (0x20, row[1], row[2], row[3])   # run's aux bytes are the game's

        raise BattleDesync(f'char {ch}: action {cmd.action!r} not in Ph-B scope '
                           '(drink/item need a potion fixture — BUILD_LOG deferral)')

    def _confirm(self, ch: int, last: bool, what: str) -> None:
        """The completing A press, verified by a TRANSITION (cmdbuf persists
        across rounds, so byte comparison alone cannot prove the press
        landed): next char's menu for chars before the last, resolution
        start (combat-box change captured AT confirm time — the submenus
        draw into that region during navigation) for the last living char."""
        if not last:
            self.bpress_verified('A', lambda: self.curchar() > ch, what)
        else:
            before = self.combat_text()
            self.bpress_verified('A', lambda: (self.combat_text() != before
                                 or self._r(ramspec.BTL_RESULT) != 0), what)

    def _spell_menu_open(self) -> bool:
        # the magic submenu redraws the box with L1..L4 rows (standard font)
        full = scrape.scrape_full(self.emu.patterns(), self.emu.glyphs)
        return any(ln.strip().startswith('L2') for ln in full.lines)

    def _pick_enemy(self, ch: int, target: int) -> None:
        alive = {e.slot for e in ramspec.read_enemy_slots(self._r) if e.alive()}
        if target not in alive:
            raise BattleDesync(f'char {ch}: enemy slot {target} not alive ({sorted(alive)})')
        for _ in range(12):
            if self._r(ramspec.BTLCMD_TARGET) == target:
                return
            t0 = self._r(ramspec.BTLCMD_TARGET)
            self.bpress_verified('Down', lambda: self._r(ramspec.BTLCMD_TARGET) != t0,
                                 f'char {ch} enemy cycle')
        raise BattleDesync(f'char {ch}: enemy target {target} unreachable by cycling')

    def _assert_picker_live(self, ch: int, row_before: Tuple[int, ...],
                            cmd_byte: int, what: str) -> None:
        """Double-consume guard (P2-R): the picker-open cursor position reads
        identically whether the picker is LIVE or the opening A was re-sampled
        by it as a fresh edge (instant auto-confirm at the home slot). The
        reliable disambiguator is the cmdbuf row: still as-before ⇒ picker
        live; freshly written with this command's byte ⇒ double-consumed.
        (Compared against the PRE-press row, not against 'unwritten': cmdbuf
        persists across rounds, so a stale row from a previous round must not
        trip this.) Recovery is the pre-round checkpoint — never un-enter."""
        row = self.cmdbuf(ch)
        if row != row_before and row[0] == cmd_byte:
            raise BattleDesync(
                f'{what}: cmdbuf row freshly written {[f"{b:02x}" for b in row]} — '
                'the opening A was double-consumed (auto-confirm at home slot); '
                'undo the pre-round checkpoint to recover')

    def _enter_spell_target(self, ch: int, meta: dict, cmd: CharCommand) -> int:
        """Press A on the spell; drive whatever target picker its type opens.
        Returns the expected cmdbuf target byte. The opening A uses
        PICKER_HOLD (2 f): at 4 f the one-ally picker opens fast enough to
        re-sample the held A as its own confirm — see _assert_picker_live."""
        ttype = meta['target']
        row_before = self.cmdbuf(ch)
        if ttype == 'one-enemy':
            self.bpress_verified('A', self._enemy_picker_reached,
                                 f'char {ch} spell→enemy picker', hold=PICKER_HOLD)
            self._assert_picker_live(ch, row_before, 0x40, f'char {ch} spell enemy picker')
            if cmd.target is None:
                raise BattleDesync(f'char {ch}: {meta["name"]} needs an enemy target')
            self._pick_enemy(ch, cmd.target)
            return cmd.target
        if ttype == 'one-ally':
            if cmd.target is None:
                raise BattleDesync(f'char {ch}: {meta["name"]} needs an ally target')
            self.bpress_verified('A', self._ally_picker_reached,
                                 f'char {ch} spell→ally picker', hold=PICKER_HOLD)
            self._assert_picker_live(ch, row_before, 0x40, f'char {ch} ally picker')
            for _ in range(8):
                if self.curs()[1] & 0x03 == cmd.target:
                    return 0x80 | cmd.target
                y0 = self.curs()[1]
                self.bpress_verified('Down', lambda: self.curs()[1] != y0,
                                     f'char {ch} ally cycle')
            raise BattleDesync(f'char {ch}: ally target {cmd.target} unreachable')
        if ttype in ('caster', 'all-enemies', 'whole-party'):
            # no picker opens; the confirm A (caller's) completes the command
            return {'caster': 0x80 | ch, 'all-enemies': 0xFF,
                    'whole-party': 0xFE}[ttype]
        raise BattleDesync(f'char {ch}: unknown spell target type {ttype!r}')

    # ------------------------------------------------------------- resolution
    def run_resolution(self) -> RoundResult:
        """Advance until the round ends (command menu back) or the battle ends
        (btl_result). Collects stable combat-box messages. On battle end,
        runs the outro (mashing A through EXP/GOLD boxes like a player would)
        until the battle screen is gone."""
        log: List[str] = []
        cur = self.combat_text()
        run = 0
        stable_home = 0
        for f in range(RESOLUTION_BUDGET):
            self.emu.step(1)
            t = self.combat_text()
            run = run + 1 if t == cur else 1
            cur = t
            if run == STABLE_FRAMES and t:
                msg = ' · '.join(t)
                if not log or log[-1] != msg:
                    log.append(msg)
            result = self._r(ramspec.BTL_RESULT)
            if result != 0:
                if result in (2, 3):
                    self._run_outro(log)   # won/ran → back to the map
                # party-dead (1): the game-over screen is terminal — no outro
                return RoundResult(log, result, OUTCOMES.get(result, f'result-{result}'), f)
            # next round's menu prompts the FIRST LIVING char (char 0 can die)
            first_living = next((i for i in range(4) if ramspec.read_char(
                self._r, i, lambda b: '').alive()), 0)
            if self.curchar() == first_living and self.curs() == (0, 0) and f > 30:
                stable_home += 1
                if stable_home >= 10 and len(self.roster_text()) > 0:
                    return RoundResult(log, 0, 'continue', f)
            else:
                stable_home = 0
        raise BattleDesync(f'resolution: no round end within {RESOLUTION_BUDGET} frames')

    def _run_outro(self, log: List[str]) -> None:
        """Won/ran: collect the outro messages ("Monsters perished", EXP/gold
        boxes) pressing B through the any-key waits UNTIL THE MAP IS BACK.
        $81 flips away from the battle value BEFORE the victory boxes finish
        (probed at the Ph-B harness: in_battle() false with "Monsters
        perished" still up, and the victory screen's own party pane
        misclassifies as 'dialog') — so the exit signal is the classifier
        reaching an actual map screen, nothing weaker. B (not A): a press
        that carries onto the map is a no-op, where A opens "Nothing here."."""
        cur = self.combat_text()
        run = 0
        for f in range(OUTRO_BUDGET):
            self.emu.step(1)
            t = self.combat_text()
            run = run + 1 if t == cur else 1
            cur = t
            if run == STABLE_FRAMES and t:
                msg = ' · '.join(t)
                if not log or log[-1] != msg:
                    log.append(msg)
            if not self.emu.in_battle() and f % 10 == 0:
                cls = screens.classify(self.emu.read, self.emu.frame,
                                       self.emu.patterns(), self.emu.glyphs,
                                       self.emu.uniform_frame())
                if cls.screen in ('ow', 'sm'):
                    self.emu.settle(budget=900, allow_animated=True)
                    return
            if run > 0 and run % 90 == 0:
                # any-key boxes wait for input; a spaced B advances them
                self.emu.nes.controller = BUTTONS['B']
                self.emu.step(BPRESS_HOLD)
                self.emu.nes.controller = 0
        raise BattleDesync(f'outro: no map screen within {OUTRO_BUDGET} frames')
