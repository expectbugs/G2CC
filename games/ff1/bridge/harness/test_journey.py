#!/usr/bin/env python
"""Ph-A harness: the Coneria journey against the COMMITTED fixtures
(bridge/harness/fixtures/*.npy, written by gen_fixtures.py) — the P1 exit
criterion: menu/dialog/shop screens scrape to EXACT text, classifier verdicts
correct at every stage, and the two key flows (shop purchase, menu cast)
replay live with their RAM effects (gold 400→300 + ch_spells write; $6320 MP
drop). Deterministic: rng_jitter=False."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

BRIDGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BRIDGE))

import ramspec  # noqa: E402
import scrape  # noqa: E402
import screens  # noqa: E402
from macros import Emu  # noqa: E402

FF1 = BRIDGE.parent
ROM = str(FF1 / 'rom' / 'Final Fantasy.nes')
FIXTURES = Path(__file__).resolve().parent / 'fixtures'

RM_SLOT = 3
RM_SPELLS = ramspec.CH_MAGIC + RM_SLOT * ramspec.CH_STRIDE + ramspec.CH_SPELLS
RM_CURMP = ramspec.CH_MAGIC + RM_SLOT * ramspec.CH_STRIDE + ramspec.CH_CURMP

PASS = 0


def check(name: str, cond: bool, detail: str = '') -> None:
    global PASS
    if not cond:
        raise AssertionError(f'FAIL {name}: {detail}')
    PASS += 1
    print(f'  ok {name}')


def load(emu: Emu, name: str) -> screens.Classification:
    emu.load(np.load(FIXTURES / f'{name}.npy'))
    emu.settle(budget=900, allow_animated=True)
    return screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs,
                            emu.uniform_frame())


def full_text(emu: Emu) -> str:
    return scrape.scrape_full(emu.patterns(), emu.glyphs).text()


def main() -> None:
    emu = Emu(ROM, rng_jitter=False)

    # --- town entry ---
    c = load(emu, 'town_entry')
    check('town_entry classifies sm', c.screen == 'sm', c.screen)
    check('town spawn (16,23) on map 0',
          emu.pos() == (16, 23) and emu.read(ramspec.CUR_MAP) == 0,
          f'{emu.pos()} map {emu.read(ramspec.CUR_MAP)}')
    check('starting gold 400', ramspec.rd24(emu.read, ramspec.GOLD) == 400)

    # --- shop char select + LIVE purchase replay ---
    c = load(emu, 'shop_open')
    check('shop_open classifies shop', c.screen == 'shop', c.screen)
    txt = full_text(emu)
    check('shop header scrapes ("learn" + "spell")', 'learn' in txt and 'spell' in txt,
          txt[:200])
    check('shop char cursor 0 of 4',
          emu.read(ramspec.CURSOR) == 0 and emu.read(ramspec.CURSOR_MAX) == 4)
    check('RM has no spells yet', emu.read(RM_SPELLS) == 0, str(emu.read(RM_SPELLS)))
    for want in range(1, RM_SLOT + 1):
        emu.press_verified('Down', lambda w=want: emu.read(ramspec.CURSOR) == w,
                           f'char cursor→{want}')
    emu.press_verified('A', lambda: 'CURE' in full_text(emu), 'spell list opens')
    emu.settle(allow_animated=True)
    txt = full_text(emu)
    check('spell list rows CURE/HARM/FOG/RUSE',
          all(s in txt for s in ('CURE', 'HARM', 'FOG', 'RUSE')), txt[:300])
    emu.press_verified('A', lambda: emu.read(ramspec.CURSOR_MAX) == 2, 'gold-OK prompt')
    emu.settle(allow_animated=True)
    txt = full_text(emu)
    check('confirm text 1OO/Gold/OK? (O/0 shared bitmap; box wraps one word per line)',
          all(s in txt for s in ('1OO', 'Gold', 'OK?'))
          and scrape.fold_digit_token('1OO') == '100', txt[:300])
    emu.press_verified('A', lambda: ramspec.rd24(emu.read, ramspec.GOLD) == 300,
                       'purchase: gold 400→300')
    emu.settle(allow_animated=True)
    check('purchase writes ch_spells (RM L1[0]=CURE)', emu.read(RM_SPELLS) == 1,
          str(emu.read(RM_SPELLS)))

    # --- post-purchase fixture states ---
    c = load(emu, 'shop_bought')
    check('shop_bought: gold 300 + CURE known',
          ramspec.rd24(emu.read, ramspec.GOLD) == 300 and emu.read(RM_SPELLS) == 1)
    c = load(emu, 'town_after_shop')
    check('town_after_shop classifies sm at the shop door (7,4)',
          c.screen == 'sm' and emu.pos() == (7, 4), f'{c.screen} {emu.pos()}')

    # --- game menu (the open-item-2 tiles + open-item-3 anchor) ---
    c = load(emu, 'menu_open')
    check('menu_open classifies gamemenu', c.screen == 'gamemenu', c.screen)
    txt = full_text(emu)
    check('menu anchor trio ITEM/MAGIC/ARMOR',
          all(w in txt for w in ('ITEM', 'MAGIC', 'ARMOR')), txt[:300])
    check('menu HP row "35/ 35" (learned / tile)', '35/ 35' in txt, txt[:300])
    check('menu level row "L 1" (learned L tile)', 'L 1' in txt, txt[:300])
    check('menu gold line "3OO G"', '3OO G' in txt, txt[:300])

    # --- MAGIC 2×2 cursor path (live) + magic page ---
    emu.press_verified('Down', lambda: emu.read(ramspec.CURSOR) == 1, 'menu cursor→MAGIC')
    emu.press_verified('A', lambda: emu.read(ramspec.CURSOR) == 0,
                       'char panel opens (cursor resets; $63 stays stale 5)')
    emu.press_verified('Down', lambda: emu.read(ramspec.CURSOR) == 2, '2×2 Down=+2')
    emu.press_verified('Right', lambda: emu.read(ramspec.CURSOR) == 3, '2×2 Right=+1')
    emu.press_verified('A', lambda: 'CURE' in full_text(emu), 'magic page opens')
    check('magic page: RM L1 MP 2 pre-cast', emu.read(RM_CURMP) == 2)

    c = load(emu, 'magic_page')
    check('magic_page classifies gamemenu (L1..L8 anchor)', c.screen == 'gamemenu', c.screen)
    txt = full_text(emu)
    check('magic page "L1 2/2" + CURE', 'L1 2/2' in txt and 'CURE' in txt, txt[:300])

    # --- LIVE cast replay: $6320-side MP drop ---
    emu.press_verified('A', lambda: 'recover' in full_text(emu), 'cast target prompt')
    emu.press_verified('A', lambda: emu.read(RM_CURMP) == 1, 'cast drops cur MP ($6320) 2→1')
    check('max MP ($6328) untouched by cast',
          emu.read(ramspec.CH_MAGIC + RM_SLOT * ramspec.CH_STRIDE + ramspec.CH_MAXMP) == 2)

    c = load(emu, 'after_cast')
    check('after_cast: magic page, MP 1/2', c.screen == 'gamemenu'
          and emu.read(RM_CURMP) == 1, f'{c.screen} mp={emu.read(RM_CURMP)}')
    check('after_cast text "L1 1/2"', 'L1 1/2' in full_text(emu), full_text(emu)[:300])

    # --- dialog ---
    c = load(emu, 'dialog_open')
    check('dialog_open classifies dialog', c.screen == 'dialog', c.screen)
    check('dialog exact text "Nothing here."',
          any(ln.strip() == 'Nothing here.' for ln in c.text), str(c.text))

    # --- battle ---
    c = load(emu, 'battle_start')
    check('battle_start classifies battle', c.screen == 'battle', c.screen)
    check('battle in progress (btl_result 0)', emu.read(ramspec.BTL_RESULT) == 0)
    slots = ramspec.read_enemy_slots(emu.read)
    alive = [e for e in slots if e.alive()]
    check('enemies present + ids valid', len(alive) >= 1
          and all(0 <= e.enemy_id < 128 for e in alive), str(slots))
    enemies = json.loads((FF1 / 'data' / 'enemies.json').read_text())['enemies']
    names = {enemies[e.enemy_id]['name'] for e in alive}
    check('enemy names resolve via enemies.json', all(n for n in names), str(names))
    check('battle roster scrapes an enemy name',
          any(any(n in ln for n in names) for ln in c.text), f'{names} vs {c.text}')

    print(f'test_journey: ALL OK ({PASS} checks)')


if __name__ == '__main__':
    main()
