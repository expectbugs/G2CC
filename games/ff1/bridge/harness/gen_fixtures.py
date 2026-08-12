#!/usr/bin/env python
"""gen_fixtures.py — regenerate the committed journey fixtures
(bridge/harness/fixtures/*.npy) by REPLAYING the session-1 Coneria journey
live from the P0 spike checkpoint (BUILD_LOG Ph-A open item 4; flows decoded
in PLAN §12 P1-R). Every stage is verified as it happens — a drifted flow
fails LOUD here, never silently bakes a wrong fixture.

Chain (each stage saves a fixture, ≈22 KB savestate each — PLAN §13 open
decision 4 DECIDED: commit the binaries):
  ckpt_overworld (spike, gitignored)                       gold 400, AAAA×4
    → up×4 right×1        town_entry.npy   sm map 0 (16,23)
    → BFS walk to (7,4)   shop_open.npy    white-magic shop, char select
    → buy CURE for slot 3 shop_bought.npy  gold 300, RM ch_spells L1[0]=1
    → B (exit shop)       town_after_shop.npy  back on map at (7,4)
    → Start (menu swirl)  menu_open.npy    ITEM/MAGIC/ARMOR anchors
    → MAGIC → RM panel    magic_page.npy   L1 2/2 + CURE row
    → cast CURE           after_cast.npy   RM L1 MP 2 → 1
    → B×3, A on map       dialog_open.npy  "Nothing here."
    → exit town, pace     battle_start.npy first deterministic encounter

The town route is not hand-coded: a savestate BFS probes steps outward from
the town spawn (load node → step → observe), caching outcomes, until the
white-magic door at (7,4) opens its shop. Deterministic (rng_jitter=False,
fixed hold frames); NPC wander is part of each node's timeline, so a tile an
NPC happens to block is simply routed around.

Not a run_all stage (it re-walks the whole journey — slow); run manually when
flows change: ./venv/bin/python bridge/harness/gen_fixtures.py
test_journey.py consumes the committed fixtures and IS a run_all stage.
"""
from __future__ import annotations

import sys
from collections import deque
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

import numpy as np

HARNESS = Path(__file__).resolve().parent
BRIDGE = HARNESS.parent
sys.path.insert(0, str(BRIDGE))

import ramspec  # noqa: E402
import scrape  # noqa: E402
import screens  # noqa: E402
from macros import Emu  # noqa: E402

FF1 = BRIDGE.parent
ROM = str(FF1 / 'rom' / 'Final Fantasy.nes')
SPIKE = BRIDGE / 'spike_out'
FIXTURES = HARNESS / 'fixtures'

RM_SLOT = 3                 # session-1 party: FIGHTER/THIEF/Bl.BELT/RedMAGE (AAAA×4)
WHITE_SHOP_DOOR = (7, 4)    # P1-R Coneria shop map: (7,4) = white magic, shop_id 21
TOWN_SPAWN = (16, 23)


def classify(emu: Emu) -> screens.Classification:
    return screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs,
                            emu.uniform_frame())


def full_text(emu: Emu) -> str:
    return scrape.scrape_full(emu.patterns(), emu.glyphs).text()


def save_fixture(emu: Emu, name: str, note: str) -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    path = FIXTURES / f'{name}.npy'
    np.save(path, emu.save())
    print(f'  wrote {path.name:22s} {note}')


def expect(cond: bool, what: str, detail: str = '') -> None:
    if not cond:
        raise RuntimeError(f'JOURNEY DRIFT: {what} {detail}')


def cursor_to(emu: Emu, target: int, what: str) -> None:
    """Walk the OB menu cursor ($62) down to `target`, one verified press per
    increment (P1-R: press-eating is real — never trust a bare press)."""
    cur = emu.read(ramspec.CURSOR)
    expect(cur <= target, f'{what}: cursor past target', f'{cur} > {target}')
    for want in range(cur + 1, target + 1):
        emu.press_verified('Down', lambda w=want: emu.read(ramspec.CURSOR) == w,
                           f'{what}: cursor→{want}')
    emu.settle(allow_animated=True)


def wait_text(emu: Emu, needle: str, what: str, budget: int = 900) -> None:
    """Advance until `needle` scrapes anywhere on screen (frame-budgeted, LOUD)."""
    emu.wait_until(lambda: needle in full_text(emu), budget, f'{what}: text "{needle}"')


# ---------------------------------------------------------------- town BFS

def bfs_to_shop(emu: Emu) -> None:
    """From the town spawn, breadth-first probe steps (savestate per node)
    until stepping onto WHITE_SHOP_DOOR opens the white-magic shop. Leaves
    `emu` INSIDE the shop (char-select screen)."""
    start_pos = emu.pos()
    expect(start_pos == TOWN_SPAWN, 'BFS start pos', f'{start_pos} != {TOWN_SPAWN}')
    nodes: Dict[Tuple[int, int], np.ndarray] = {start_pos: emu.save()}
    q: deque[Tuple[int, int]] = deque([start_pos])
    probes = 0
    while q:
        pos = q.popleft()
        for direction in ('up', 'left', 'down', 'right'):
            probes += 1
            if probes > 3000:
                raise RuntimeError('BFS: 3000 probes without reaching the shop — layout drift?')
            emu.load(nodes[pos])
            out = emu.steps(direction, 1)
            if out.stopped == 'battle':
                raise RuntimeError(f'BFS: encounter inside town at {pos} {direction} — impossible')
            if out.stopped in ('blocked', 'mapchange'):
                continue        # wall/NPC, or walked out a gate — dead end for BFS
            cls = classify(emu)
            if cls.screen == 'shop':
                if out.pos == WHITE_SHOP_DOOR:
                    txt = full_text(emu)
                    expect('learn' in txt, 'white-magic shop text', txt[:200])
                    print(f'  BFS: shop door {WHITE_SHOP_DOOR} reached in {probes} probes '
                          f'({len(nodes)} tiles mapped)')
                    return
                continue        # some other shop door — dead end
            if cls.screen != 'sm':
                continue        # any other overlay — don't expand through it
            if out.pos not in nodes and abs(out.pos[0] - TOWN_SPAWN[0]) + abs(out.pos[1] - TOWN_SPAWN[1]) <= 45:
                nodes[out.pos] = emu.save()
                q.append(out.pos)
    raise RuntimeError(f'BFS exhausted ({len(nodes)} tiles) without opening the white-magic shop')


def route_via_bfs(emu: Emu, target: Tuple[int, int], what: str) -> None:
    """BFS (same probing) to a WALKABLE target tile; leaves emu standing on it."""
    start_pos = emu.pos()
    if start_pos == target:
        return
    nodes: Dict[Tuple[int, int], np.ndarray] = {start_pos: emu.save()}
    q: deque[Tuple[int, int]] = deque([start_pos])
    probes = 0
    while q:
        pos = q.popleft()
        for direction in ('up', 'left', 'down', 'right'):
            probes += 1
            if probes > 3000:
                raise RuntimeError(f'BFS({what}): 3000 probes without reaching {target}')
            emu.load(nodes[pos])
            out = emu.steps(direction, 1)
            if out.stopped != 'done' or classify(emu).screen != 'sm':
                continue
            if out.pos == target:
                print(f'  BFS: {what} reached {target} in {probes} probes')
                return
            if out.pos not in nodes and abs(out.pos[0] - start_pos[0]) + abs(out.pos[1] - start_pos[1]) <= 45:
                nodes[out.pos] = emu.save()
                q.append(out.pos)
    raise RuntimeError(f'BFS({what}) exhausted without reaching {target}')


# ---------------------------------------------------------------- stages

def main() -> None:
    emu = Emu(ROM, rng_jitter=False)

    # --- stage 1: overworld → town ---
    print('stage 1: overworld → Coneria')
    emu.load(np.load(SPIKE / 'ckpt_overworld.npy'))
    emu.settle(budget=900)
    expect(emu.pos() == (153, 165), 'spawn pos', str(emu.pos()))
    expect(ramspec.rd24(emu.read, ramspec.GOLD) == 400, 'starting gold')
    out = emu.steps('up', 4)
    expect(out.stopped == 'done' and out.committed == 4, 'up×4', str(out))
    out = emu.steps('right', 1)
    expect(out.stopped == 'mapchange', 'town entry', str(out))
    expect(emu.read(ramspec.CUR_MAP) == 0, 'map id 0')
    expect(emu.pos() == TOWN_SPAWN, 'town spawn', str(emu.pos()))
    expect(classify(emu).screen == 'sm', 'town classifies sm')
    save_fixture(emu, 'town_entry', f'sm map 0 {TOWN_SPAWN}')

    # --- stage 2: BFS to the white-magic shop ---
    print('stage 2: walk to the white-magic shop (savestate BFS)')
    bfs_to_shop(emu)
    expect(emu.read(ramspec.CURSOR) == 0, 'shop char cursor starts 0')
    expect(emu.read(ramspec.CURSOR_MAX) == 4, 'shop char cursor max 4')
    save_fixture(emu, 'shop_open', 'white-magic shop, char select')

    # --- stage 3: buy CURE for the RedMAGE (slot 3) ---
    print('stage 3: buy CURE (100 G) for slot 3')
    rm_spell_addr = ramspec.CH_MAGIC + RM_SLOT * ramspec.CH_STRIDE + ramspec.CH_SPELLS
    expect(emu.read(rm_spell_addr) == 0, 'RM L1 slot empty pre-buy')
    cursor_to(emu, RM_SLOT, 'shop char select')
    emu.press_verified('A', lambda: 'CURE' in full_text(emu), 'open spell list')
    emu.settle(allow_animated=True)
    txt = full_text(emu)
    expect('CURE' in txt, 'spell list shows CURE', txt[:200])
    # CURE is list index 0 — cursor already there; A → "100 Gold OK?" (Yes/No, max 2)
    emu.press_verified('A', lambda: emu.read(ramspec.CURSOR_MAX) == 2, 'confirm prompt')
    emu.settle(allow_animated=True)
    expect('Gold' in full_text(emu) or 'OK' in full_text(emu), 'gold-OK prompt text',
           full_text(emu)[:200])
    # Yes is cursor 0 (P1-R) — A executes the purchase
    emu.press_verified('A', lambda: ramspec.rd24(emu.read, ramspec.GOLD) == 300, 'purchase (gold 400→300)')
    emu.settle(allow_animated=True)
    expect(emu.read(rm_spell_addr) == 1, 'RM learned CURE (ch_spells L1[0]=1)',
           str(emu.read(rm_spell_addr)))
    save_fixture(emu, 'shop_bought', 'gold 300, RM knows CURE')

    # --- stage 4: exit the shop (ONE B from char select — P1-R) ---
    print('stage 4: exit shop')
    emu.press('B')
    emu.settle(budget=900)
    expect(classify(emu).screen == 'sm', 'back on the town map', classify(emu).screen)
    expect(emu.pos() == WHITE_SHOP_DOOR, 'standing on the shop door', str(emu.pos()))
    save_fixture(emu, 'town_after_shop', f'town at {WHITE_SHOP_DOOR}, gold 300')

    # --- stage 5: open the game menu (Start; swirl ~200f; never settles) ---
    print('stage 5: open the game menu')
    emu.press_verified('Start', lambda: classify(emu).screen == 'gamemenu',
                       'menu open', budget=600)
    save_fixture(emu, 'menu_open', 'game menu (ITEM/MAGIC/ARMOR)')

    # --- stage 6: MAGIC → RM char panel → magic page ---
    print('stage 6: MAGIC page for the RedMAGE')
    cursor_to(emu, 1, 'main menu cursor to MAGIC')
    # the 2×2 char panel reuses $62 but does NOT update cursor_max ($63 stays
    # a stale 5 — probed session 2); the open signal is the cursor RESET 1→0
    emu.press_verified('A', lambda: emu.read(ramspec.CURSOR) == 0, 'char panel opens (cursor resets)')
    # 2×2 char panel: Down=+2, Right=+1 (P1-R) → slot 3 = Down then Right
    emu.press_verified('Down', lambda: emu.read(ramspec.CURSOR) == 2, 'char panel down')
    emu.press_verified('Right', lambda: emu.read(ramspec.CURSOR) == 3, 'char panel right')
    # the magic page is the first screen in this flow that shows a spell NAME
    emu.press_verified('A', lambda: 'CURE' in full_text(emu), 'magic page opens')
    rm_mp_addr = ramspec.CH_MAGIC + RM_SLOT * ramspec.CH_STRIDE + ramspec.CH_CURMP
    expect(emu.read(rm_mp_addr) == 2, 'RM L1 MP is 2', str(emu.read(rm_mp_addr)))
    txt = full_text(emu)
    expect('CURE' in txt, 'magic page lists CURE', txt[:200])
    expect(classify(emu).screen == 'gamemenu', 'magic page classifies gamemenu')
    save_fixture(emu, 'magic_page', 'RM magic page, L1 2/2 CURE')

    # --- stage 7: cast CURE from the menu (MP 2 → 1) ---
    print('stage 7: cast CURE')
    emu.press_verified('A', lambda: 'recover' in full_text(emu), 'cast target prompt')
    emu.press_verified('A', lambda: emu.read(rm_mp_addr) == 1, 'cast spends MP (2→1)')
    # the cast leaves an any-key HP-result strip (condensed small-font box —
    # scrapes NOTHING and misreads as 'sm'; probed session 2, PNG on file).
    # Dismiss back to the magic page so the fixture is a scrape-coherent state.
    emu.press_verified('B', lambda: 'CURE' in full_text(emu), 'dismiss cast-result strip')
    save_fixture(emu, 'after_cast', 'RM magic page, L1 MP 1/2 (CURE cast)')

    # --- stage 8: back to map, "Nothing here." dialog ---
    print('stage 8: exit menu, open a dialog box')
    # Backing out: magic page → char panel → menu → map. Presses can be eaten,
    # AND the menu screens never strictly settle (blinking finger / portraits)
    # while transient half-drawn frames can misread as 'sm' — so only trust
    # 'sm' when the frame is STRICTLY settled (the town map is static; a
    # half-drawn frame can never pass K=12 identical frames).
    for _ in range(12):
        settled = emu.settle(budget=900, allow_animated=True)
        cls_now = classify(emu).screen
        if cls_now == 'sm' and settled:
            break
        if cls_now == 'transition':
            continue   # mid-fade — settle again before deciding anything
        emu.press('B', settle=False)
    else:
        raise RuntimeError('stage 8: never reached a settled town map after 12 B presses')
    emu.press('A')
    emu.settle(budget=900)
    cls = classify(emu)
    expect(cls.screen == 'dialog', 'dialog box open', cls.screen)
    expect(any('Nothing here' in ln for ln in cls.text), 'Nothing here. scraped', str(cls.text))
    save_fixture(emu, 'dialog_open', '"Nothing here." box')
    emu.press('A')   # dismiss
    emu.settle(budget=900)
    expect(classify(emu).screen == 'sm', 'dialog dismissed')

    # --- stage 9: exit town, pace until the first deterministic encounter ---
    print('stage 9: exit town, pace to an encounter')
    route_via_bfs(emu, TOWN_SPAWN, 'return to town gate')
    out = emu.steps('down', 1)
    expect(out.stopped == 'mapchange', 'town exit south', str(out))
    expect(not (emu.read(ramspec.MAPFLAGS) & 1), 'on the overworld')
    # We exit standing ON the town tile (154,161). The tiles around Coneria are
    # ENCOUNTER-FREE — battlestep ($F5) does not tick there (probed session 2:
    # (153,165)..(153,169) never tick; the first ticking tile on the spike
    # column is (153,170), and (153,170) is blocked southward). So: move to
    # column 153, walk down to (153,169), then pace 169↔170 — each entry to
    # the ticking tile advances the counter. Cap = 700 paces ≈ 350 ticks, a
    # full 256-entry encounter-table cycle: an encounter is GUARANTEED before
    # the cap unless the terrain model drifted.
    out = emu.steps('left', 1)
    expect(out.stopped in ('done', 'battle'), 'step to column 153', str(out))
    while out.stopped != 'battle' and emu.pos() != (153, 169):
        out = emu.steps('down', 1)
        expect(out.stopped in ('done', 'battle'), 'walk to ticking terrain', str(out))
    paces = 0
    bs0 = emu.read(ramspec.BATTLESTEP)
    while out.stopped != 'battle':
        paces += 1
        if paces == 40:
            expect(emu.read(ramspec.BATTLESTEP) != bs0,
                   'battlestep ticking during pace', 'counter frozen — wrong terrain')
        if paces > 700:
            raise RuntimeError('700 paces (a full table cycle) without an encounter')
        out = emu.steps('down' if paces % 2 else 'up', 1)
        expect(out.stopped in ('done', 'battle'), 'pace step', str(out))
    cls = classify(emu)
    expect(cls.screen == 'battle', 'battle screen', cls.screen)
    expect(emu.read(ramspec.BTL_RESULT) == 0, 'battle in progress')
    # the battle stop fires the FRAME the encounter triggers; the intro + box
    # draw run longer, and a settle can catch a static pre-draw moment — wait
    # until the roster box actually scrapes so the fixture is the drawn
    # command-entry screen (what Ph-B consumes)
    emu.wait_until(lambda: len(classify(emu).text) > 0, 900, 'battle roster drawn')
    slots = ramspec.read_enemy_slots(emu.read)
    expect(len([e for e in slots if e.alive()]) >= 1, 'enemies present')
    save_fixture(emu, 'battle_start', f'encounter after {paces} paces, '
                 f'{len([e for e in slots if e.alive()])} enemies, roster drawn')

    print(f'gen_fixtures: journey complete, {len(list(FIXTURES.glob("*.npy")))} fixtures written')


if __name__ == '__main__':
    main()
