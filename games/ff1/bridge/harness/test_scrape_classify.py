#!/usr/bin/env python
"""Ph-A harness: scraper + classifier against every spike checkpoint.
Exit criterion (PLAN P1): any menu/dialog screen scrapes to exact text."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

BRIDGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BRIDGE))

import ramspec  # noqa: E402
import screens  # noqa: E402
import scrape  # noqa: E402
from macros import Emu  # noqa: E402

ROM = str(BRIDGE.parent / 'rom' / 'Final Fantasy.nes')
OUT = BRIDGE / 'spike_out'

PASS = 0


def check(name: str, cond: bool, detail: str = '') -> None:
    global PASS
    if not cond:
        raise AssertionError(f'FAIL {name} {detail}')
    PASS += 1
    print(f'  ok {name}')


def classify_ckpt(emu: Emu, ckpt: str) -> screens.Classification:
    emu.load(np.load(OUT / ckpt))
    emu.settle(budget=900)
    return screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs, emu.uniform_frame())


def main() -> None:
    emu = Emu(ROM, rng_jitter=False)

    # --- main menu ---
    c = classify_ckpt(emu, 'state.npy')
    check('mainmenu classified', c.screen == 'mainmenu', c.screen)
    joined = '\n'.join(c.text)
    check('mainmenu text CONTINUE', 'CONTINUE' in joined, joined)
    check('mainmenu text NEW GAME', 'NEW' in joined and 'GAME' in joined)
    check('mainmenu no scrape misses', not c.unknown or all(u['col'] in (9, 10) for u in c.unknown),
          f'unknown={c.unknown}')   # the orb cursor cells are the only tolerated unknowns

    # --- party select ---
    c = classify_ckpt(emu, 'ckpt_partysel.npy')
    check('partyselect classified', c.screen == 'partyselect', c.screen)
    check('partyselect headers', 'FIGHTER' in '\n'.join(c.text))

    # --- name entry grid ---
    emu.load(np.load(OUT / 'ckpt_partysel.npy'))
    emu.settle()
    emu.press('A')
    c = screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs, emu.uniform_frame())
    check('nameentry classified', c.screen == 'nameentry', c.screen)
    grid_txt = '\n'.join(c.text).replace(' ', '')
    check('nameentry grid row', 'ABCDEFGHIJ' in grid_txt, grid_txt[:80])

    # --- overworld ---
    c = classify_ckpt(emu, 'ckpt_overworld.npy')
    check('overworld classified', c.screen == 'ow', c.screen)

    # --- battle ---
    c = classify_ckpt(emu, 'ckpt_battle.npy')
    check('battle classified', c.screen == 'battle', c.screen)
    check('battle roster scrapes IMP', any('IMP' in ln for ln in c.text), c.text)
    check('battle result rides', c.battle_result == 0, c.battle_result)

    # --- battle party pane scrape (names + HP) ---
    emu.load(np.load(OUT / 'ckpt_battle.npy'))
    emu.settle(budget=900)
    pane = scrape.scrape_region(emu.patterns(), emu.glyphs, *screens.REGION_BTL_PARTY)
    pane_txt = '\n'.join(pane.lines)
    check('party pane names', pane_txt.count('AAAA') == 4, pane_txt)
    check('party pane HP', pane_txt.count('HP') == 4)

    # --- fold_digit_token (O/0 ambiguity) ---
    check('digit fold', scrape.fold_digit_token('4OO') == '400')
    check('word passthrough', scrape.fold_digit_token('GOLD') == 'GOLD')

    print(f'test_scrape_classify: ALL OK ({PASS} checks)')


if __name__ == '__main__':
    main()
