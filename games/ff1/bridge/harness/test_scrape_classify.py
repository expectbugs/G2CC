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
FIXTURES = Path(__file__).resolve().parent / 'fixtures'

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
    # all-alias tokens fold only on a line that has a real number (2026-08-13)
    check('lone O folds on a numeric line',
          scrape.fold_line('INT.    10    ABSORB     O') == 'INT.    10    ABSORB     0')
    check('alias run folds on a numeric line',
          scrape.fold_line('2/O/O/O/  O/O/O/O') == '2/0/0/0/  0/0/0/0')
    check('prose keeps its capital O', scrape.fold_line('GO TO THE INN') == 'GO TO THE INN')

    # --- the game's OWN full-screen sub-menus (2026-08-13 regression) ---
    # Fixtures generated from menu_open.npy: Down×N + A on the field menu
    # (0 = ITEM, 2 = WEAPON). Both used to classify as 'dialog', which gives
    # the window an A/B-only verb set and a rows-1..10 scrape — the equip grid
    # showed only party slot 0 and its cursor could not be moved at all, so
    # equipping and item use were impossible from the glasses.
    for fx, must in (('menu_item.npy', 'ITEM'), ('menu_weapon.npy', 'EQUIP')):
        emu.load(np.load(FIXTURES / fx))
        emu.settle(budget=900)
        c = screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs, emu.uniform_frame())
        joined = '\n'.join(c.text)
        check(f'{fx} classifies gamemenu (cursor verbs)', c.screen == 'gamemenu', c.screen)
        check(f'{fx} scrapes {must}', must in joined, joined)
    emu.load(np.load(FIXTURES / 'menu_weapon.npy'))
    emu.settle(budget=900)
    c = screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs, emu.uniform_frame())
    check('equip grid shows ALL FOUR party rows',
          '\n'.join(c.text).count('AAAA') == 4, '\n'.join(c.text))

    # --- the TENT/rest prompt is a DIALOG, not a map (2026-08-13) ---
    # Using a tent leaves FF1 showing a party-HP box and an A/B prompt drawn
    # LOW on the screen. REGION_DIALOG covers rows 1-10 only, so both frames
    # classified 'ow' — and a map screen renders as image tiles with NO text
    # region, so the prompt was invisible while every arrow reported
    # "can't go … — blocked" and the game sat waiting on it. Captured outside
    # the Temple of Fiends during the Garland run.
    for fx, must in (('tent_prompt.npy', 'SAVE?'), ('tent_saving.npy', 'saving')):
        emu.load(np.load(FIXTURES / fx))
        emu.settle(budget=900, allow_animated=True)
        c = screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs, emu.uniform_frame())
        joined = '\n'.join(c.text)
        check(f'{fx} classifies dialog (A/B reachable)', c.screen == 'dialog', c.screen)
        check(f'{fx} scrapes the prompt ({must})', must in joined, joined)
    emu.load(np.load(FIXTURES / 'tent_prompt.npy'))
    emu.settle(budget=900, allow_animated=True)
    c = screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs, emu.uniform_frame())
    joined = '\n'.join(c.text)
    check('tent prompt offers both answers', 'YES' in joined and 'NO' in joined, joined)
    # and the plain map must NOT be dragged into 'dialog' by the new low-box rule
    for fx in ('town_entry.npy', 'town_after_shop.npy'):
        emu.load(np.load(FIXTURES / fx))
        emu.settle(budget=900)
        c = screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs, emu.uniform_frame())
        check(f'{fx} is still a map screen', c.screen in ('sm', 'ow'), c.screen)
    check('map graphics are not a box', not screens._boxish(['', '  ', ' · ·  ·']))
    check('a real prompt IS a box', screens._boxish([' HP recovered. SAVE?']))

    # --- shop anchor needs a NUMERAL by the G (2026-08-13) ---
    # A bare 'G' also matches the status page's 'AGL.' label, which classified
    # STATUS as a shop.
    check('AGL. is not a price', not screens._priced(['STR.    10', 'AGL.    10']))
    check('80 G is a price', screens._priced(['                       80 G']))
    check('8O G is a price too (font O/0)', screens._priced(['                       8O G']))
    check('status page anchored', screens._statusish('EXP. POINTS\nFOR LEV UP  33\nSTR. 10\nLUCK 5'))
    check('equip grid anchored', screens._equipish('EQUIP  TRADE  DROP'))

    print(f'test_scrape_classify: ALL OK ({PASS} checks)')


if __name__ == '__main__':
    main()
