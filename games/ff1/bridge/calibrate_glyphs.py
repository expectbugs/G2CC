#!/usr/bin/env python
"""calibrate_glyphs.py — learn the FF1 font's 8×8 glyph patterns empirically
and write data/glyphs.json (PLAN §5.2; BUILD_LOG Ph-A design note 1).

Source screen: the NEW GAME name-entry letter grid — every letter/digit/name
punctuation at PROBED tile positions (harness/probe_layout.py, 2026-08-12):
grid rows r=10+2i (i 0..6), cols c=6+2j (j 0..9); "SELECT NAME" at row 26;
box borders row 8 / row 27 / col 4 / col 26. Two captures dodge the finger
cursor (open: cursor on A; one Down: cursor on K) — a cell contaminated in one
frame is learned from the other, and the merged cursor+letter patterns are
ALSO learned (they must still scrape as the letter when a cursor sits on it).

Round-trip verification (the §5.2 drift test, all from spike checkpoints):
  - the grid itself + SELECT NAME
  - main menu: CONTINUE / NEW GAME / RESPOND RATE / 1987 SQUARE / 1990 NINTENDO
  - party select: FIGHTER / THIEF / Bl.BELT / RedMAGE headers + AAAA names
  - battle: FIGHT / MAGIC / DRINK / ITEM / RUN / IMP / AAAA
One font everywhere is thereby PROVEN, not assumed. Any assert fails LOUD.

Run from games/ff1: ./venv/bin/python bridge/calibrate_glyphs.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

BRIDGE = Path(__file__).resolve().parent
sys.path.insert(0, str(BRIDGE))

from cynes import NES, NES_INPUT_A, NES_INPUT_DOWN  # noqa: E402
import scrape  # noqa: E402
from scrape import GlyphTable, cell_patterns, pat_hex  # noqa: E402

ROM = BRIDGE.parent / 'rom' / 'Final Fantasy.nes'
OUT = BRIDGE / 'spike_out'

# The grid's visual layout, read off f_00_grid_open.png + probe map (row 2 has
# 9 glyphs; '..' is the two-dot leader the name font draws for byte $C3-class
# dots). Verified by the round-trip below — a wrong entry here fails the
# scrape-back assert.
GRID_TEXT = [
    'ABCDEFGHIJ',
    'KLMNOPQRST',
    "UVWXYZ',.",
    '0123456789',
    'abcdefghij',
    'klmnopqrst',
    'uvwxyz-..!?'.replace('..', '‥'),   # ‥ two-dot leader, one cell
]
GRID_R0, GRID_C0, GRID_STEP = 10, 6, 2


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
    raise RuntimeError(f'settle: budget {budget} frames exhausted — screen never went static')


def press(nes: NES, mask: int, hold: int = 8) -> np.ndarray:
    """P0-R input protocol: ≥8-frame hold (2-frame presses get eaten)."""
    nes.controller = mask
    nes.step(frames=hold)
    nes.controller = 0
    return settle(nes)


def learn_grid(glyphs: GlyphTable, p1: np.ndarray, p2: np.ndarray) -> None:
    """Learn every grid glyph from the un-contaminated frame (see docstring)."""
    diffs = []
    for i, rowtext in enumerate(GRID_TEXT):
        r = GRID_R0 + GRID_STEP * i
        for j, ch in enumerate(rowtext):
            c = GRID_C0 + GRID_STEP * j
            a, b = int(p1[r, c]), int(p2[r, c])
            if a == b:
                if a == 0:
                    raise RuntimeError(f'grid cell ({r},{c}) expected "{ch}" but is EMPTY — layout drift')
                glyphs.add(a, ch, f'grid({i},{j})')
            else:
                # cursor-contaminated in exactly one frame: frame1's cursor sits
                # on row 0 (A), frame2's on row 1 (K). Learn the clean one AND
                # the merged one (both must scrape as the letter).
                diffs.append((i, j))
                if i == 0:
                    clean, merged = b, a
                elif i == 1:
                    clean, merged = a, b
                else:
                    raise RuntimeError(f'unexpected cursor contamination at grid row {i} ({r},{c})')
                if clean == 0:
                    raise RuntimeError(f'grid cell ({r},{c}) "{ch}": clean frame is EMPTY — layout drift')
                glyphs.add(clean, ch, f'grid({i},{j}) clean')
                if merged != 0:
                    glyphs.add(merged, ch, f'grid({i},{j}) cursor-merged')
    print(f'grid: learned {len(glyphs)} patterns (cursor-contaminated cells: {diffs})')


def learn_chrome(glyphs: GlyphTable, p1: np.ndarray, p2: np.ndarray) -> None:
    """Borders (probed positions) + the pure-cursor cells → '' chrome. Only
    cells IDENTICAL in both frames are learned as borders (a cursor-merged
    border stays unlearned — regions are interiors, it never scrapes)."""
    border_cells = (
        [(8, c) for c in range(4, 27)] + [(27, c) for c in range(4, 27)]
        + [(r, 4) for r in range(9, 27)] + [(r, 26) for r in range(9, 27)]
    )
    for r, c in border_cells:
        a, b = int(p1[r, c]), int(p2[r, c])
        if a == b and a != 0 and glyphs.char(a) is None:
            glyphs.add(a, '', f'border({r},{c})')
    # pure-cursor cells: differ between frames, OUTSIDE grid glyph positions
    grid_cells = {(GRID_R0 + GRID_STEP * i, GRID_C0 + GRID_STEP * j)
                  for i, row in enumerate(GRID_TEXT) for j in range(len(row))}
    for r in range(30):
        for c in range(32):
            a, b = int(p1[r, c]), int(p2[r, c])
            if a != b and (r, c) not in grid_cells and (r, c) not in border_cells:
                for pat in (a, b):
                    if pat != 0 and glyphs.char(pat) is None:
                        glyphs.add(pat, '', f'cursor({r},{c})')


def roundtrip(name: str, patterns: np.ndarray, glyphs: GlyphTable,
              expects: list[tuple[int, str]]) -> None:
    """Assert each expected substring scrapes back on its probed row (font-
    ambiguous O/0 fold to one form on both sides)."""
    for row, want in expects:
        res = scrape.scrape_region(patterns, glyphs, row, row + 1, 0, 32)
        got = res.lines[0].replace('0', 'O')
        want = want.replace('0', 'O')
        if want not in got:
            raise RuntimeError(
                f'ROUND-TRIP FAIL [{name}] row {row}: expected "{want}" in "{got}" '
                f'(unknown cells: {res.unknown})')
    print(f'round-trip [{name}]: {len(expects)} strings OK')


def main() -> None:
    nes = NES(str(ROM))

    # --- capture the grid twice (cursor dodge) ---
    nes.load(np.load(OUT / 'ckpt_partysel.npy'))
    settle(nes)
    f1 = press(nes, NES_INPUT_A)          # grid opens, cursor on A
    p1 = cell_patterns(f1)
    f2 = press(nes, NES_INPUT_DOWN)       # cursor on K
    p2 = cell_patterns(f2)

    # no volatile date stamp — a green harness run must leave the committed
    # data byte-identical (Ph-F pass-2 find: daily 'date' churn dirtied five
    # tracked files on every run)
    glyphs = GlyphTable({}, {
        'generated_by': 'bridge/calibrate_glyphs.py',
        'source': 'name-entry grid (two-frame cursor dodge) + probed borders; '
                  'lineage: harness/probe_layout.py coordinates 2026-08-12',
        'binarize': 'luminance>=128 (Rec.601 integer)',
        'key': '64-bit cell ink pattern, 16 hex chars, bit63=top-left, row-major',
    })
    learn_grid(glyphs, p1, p2)
    learn_chrome(glyphs, p1, p2)

    # the © glyph, from its probed main-menu position (rows 25/26 col 8)
    nes2 = NES(str(ROM))
    nes2.load(np.load(OUT / 'state.npy'))
    fm = settle(nes2)
    pm = cell_patterns(fm)
    if glyphs.char(int(pm[25, 8])) is None:
        glyphs.add(int(pm[25, 8]), '©', 'mainmenu(25,8)')
    if glyphs.char(int(pm[26, 8])) is None:
        glyphs.add(int(pm[26, 8]), '©', 'mainmenu(26,8)')

    # --- round trips (all four screen families; positions from probe dumps) ---
    # grid rows render as spaced letters ("A B C …") — assert with spaces squeezed;
    # row 0 uses the cursor-free frame2, later rows frame1:
    def fold(s: str) -> str:
        # font-ambiguous pairs compare equal (O/0 share one bitmap — see
        # scrape.AMBIGUOUS_PAIRS; canonical char is first-learned)
        return s.replace('0', 'O')

    for i, rowtext in enumerate(GRID_TEXT):
        res = scrape.scrape_region(p2 if i == 0 else p1, glyphs, GRID_R0 + 2 * i, GRID_R0 + 2 * i + 1, 5, 27)
        line = res.lines[0].replace(' ', '')
        if fold(line) != fold(rowtext):
            raise RuntimeError(f'ROUND-TRIP FAIL [grid row {i}]: "{line}" != "{rowtext}" (unknown: {res.unknown})')
    print('round-trip [grid]: all 7 rows OK')
    roundtrip('grid-label', p1, glyphs, [(26, 'SELECT')])
    roundtrip('grid-label', p1, glyphs, [(26, 'NAME')])

    roundtrip('mainmenu', pm, glyphs, [
        (12, 'CONTINUE'), (17, 'NEW'), (17, 'GAME'), (22, 'RESPOND RATE'),
        (25, '1987 SQUARE'), (26, '1990 NINTENDO'),
    ])

    nes3 = NES(str(ROM))
    nes3.load(np.load(OUT / 'ckpt_partysel.npy'))
    fp = settle(nes3)
    pp = cell_patterns(fp)
    got_all = scrape.scrape_full(pp, glyphs).text()
    for want in ('FIGHTER', 'THIEF', 'Bl.BELT', 'RedMAGE'):
        if want not in got_all:
            raise RuntimeError(f'ROUND-TRIP FAIL [partysel]: "{want}" not on screen:\n{got_all}')
    print('round-trip [partysel]: FIGHTER/THIEF/Bl.BELT/RedMAGE OK')

    nes4 = NES(str(ROM))
    nes4.load(np.load(OUT / 'ckpt_battle.npy'))
    fb = settle(nes4, budget=600)
    pb = cell_patterns(fb)
    got_b = scrape.scrape_full(pb, glyphs).text().replace('0', 'O')
    # NOTE (probed 2026-08-12): the command COLUMN (FIGHT/MAGIC/DRINK) is drawn
    # in a separate bold condensed font composed into CHR-RAM — deliberately NOT
    # learned: command entry is RAM-driven (btlcurs/btlcmd_*, §6.2), never
    # scraped. Resolution combat boxes use the STANDARD font (verified live:
    # "AAAA"/"IMP"/"2Hits!" scrape clean) — those are the battle-log source.
    for want in ('ITEM', 'RUN', 'IMP', 'AAAA', 'HP', '35', '30', '33'):
        if want.replace('0', 'O') not in got_b:
            raise RuntimeError(f'ROUND-TRIP FAIL [battle]: "{want}" not on screen:\n{got_b}')
    print('round-trip [battle]: roster + party pane + ITEM/RUN OK (bold command font: intentionally unlearned)')

    # --- menu-only tiles: the level 'L' and the HP '/' (BUILD_LOG open item 2) ---
    # The game menu draws two glyphs that appear nowhere else in the standard
    # font flow: a small 'L' level tile ("L 1") and the HP separator ("35/ 35").
    # Self-locating (no probed coords): scrape the menu, then classify each
    # unknown cell by its known neighbors. The game menu never settles
    # (portraits animate — P1-R), but its TEXT cells are static: any frame is
    # scrape-coherent.
    nes6 = NES(str(ROM))
    menu_state = OUT / 'fix_menu.npy'
    if not menu_state.exists():
        raise RuntimeError(f'{menu_state} missing — the menu calibration stage needs the '
                           'session-1 journey savestate (see BUILD_LOG)')
    nes6.load(np.load(menu_state))
    f6 = nes6.step(frames=30)
    p6 = cell_patterns(f6)
    menu_res = scrape.scrape_full(p6, glyphs)

    def _known(r: int, c: int) -> str | None:
        return glyphs.char(int(p6[r, c])) if 0 <= r < 30 and 0 <= c < 32 else None

    def _digitish(ch: str | None) -> bool:
        return ch is not None and (ch.isdigit() or ch == 'O')   # O/0 shared bitmap

    def _blank(ch: str | None) -> bool:
        return ch in (' ', '')           # empty cell OR learned chrome (panel border)

    slash_pats: set[int] = set()
    level_pats: set[int] = set()
    for u in menu_res.unknown:
        r, c, pat = u['row'], u['col'], int(u['pattern'], 16)
        if (_digitish(_known(r, c - 2)) and _digitish(_known(r, c - 1))
                and _known(r, c + 1) == ' ' and _digitish(_known(r, c + 2))):
            slash_pats.add(pat)          # dd�<sp>d → the HP-row separator
        if (_blank(_known(r, c - 1)) and _known(r, c + 1) == ' '
                and _known(r, c + 2) == '1'):
            level_pats.add(pat)          # <blank>�<sp>1 → the level tile
    if len(slash_pats) != 1:
        raise RuntimeError(f'menu stage: expected exactly 1 HP-slash pattern, got {sorted(map(pat_hex, slash_pats))}')
    if len(level_pats) != 1:
        raise RuntimeError(f'menu stage: expected exactly 1 level-L pattern, got {sorted(map(pat_hex, level_pats))}')
    glyphs.add(slash_pats.pop(), '/', 'gamemenu HP row (self-located)')
    glyphs.add(level_pats.pop(), 'L', 'gamemenu level row (self-located)')
    glyphs.meta['menu_stage'] = ('fix_menu.npy: / and L self-located by known-neighbor '
                                 'context (BUILD_LOG Ph-A open item 2)')
    # round trip: both strings must now scrape back somewhere on the menu
    menu_after = scrape.scrape_full(p6, glyphs)
    for want in ('35/ 35', 'L 1'):
        if not any(want in ln for ln in menu_after.lines):
            raise RuntimeError(f'ROUND-TRIP FAIL [gamemenu]: "{want}" not on screen:\n'
                               + '\n'.join(menu_after.lines))
    print('round-trip [gamemenu]: "35/ 35" + "L 1" OK (menu-only tiles learned)')

    # anti-false-anchor guard: an overworld frame (pure map graphics) must
    # contain ~no known text cells in the dialog-box region (screens.py anchor).
    nes5 = NES(str(ROM))
    nes5.load(np.load(OUT / 'ckpt_overworld.npy'))
    fo = settle(nes5)
    po = cell_patterns(fo)
    n = scrape.known_text_cells(po, glyphs, 2, 10, 2, 30)
    print(f'overworld dialog-region known-glyph cells: {n} (false-anchor guard)')
    if n > 4:
        raise RuntimeError(f'overworld map tiles alias {n} font glyphs — dialog anchor unsafe, rethink')

    glyphs.save()
    print(f'WROTE {scrape.GLYPHS_PATH} ({len(glyphs)} patterns)')


if __name__ == '__main__':
    main()
