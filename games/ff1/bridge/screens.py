"""screens.py — screen classifier v1 (PLAN §5.3 + §12 P1).

RAM-first (battle = $81==$68, map = mapflags bit0 — both P0-R-verified), with
scrape anchors for the screens RAM can't name (pre-game menus, dialog boxes,
shops, the Start menu). Text regions are PROBED tile rects (probe_layout.py /
live scrape dumps, 2026-08-12) — extraction is interior-only so borders and
sprites never count as scrape misses (BUILD_LOG Ph-A design note 3).

A uniform frame is ALWAYS 'transition' (settle-v2 rule) — never classified.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

import ramspec
import scrape
from scrape import GlyphTable

# ------------------------------------------------------------- text regions
# (row0, row1, col0, col1) interiors — probed 2026-08-12:
REGION_MAINMENU = (10, 27, 8, 25)      # CONTINUE/NEW GAME/RESPOND RATE + ©-lines
REGION_NAMEGRID = (9, 27, 5, 26)       # the letter grid box interior
REGION_PARTYSEL = (0, 30, 0, 32)       # class headers live in per-slot boxes; full scan
REGION_DIALOG = (1, 10, 1, 31)         # FF1 dialogue box: top-of-screen rows (on-map)
# battle regions (probed via the live resolution scrape, Ph-A):
REGION_BTL_ROSTER = (19, 27, 2, 10)    # bottom-left enemy roster box interior
REGION_BTL_PARTY = (3, 27, 26, 31)     # right party pane (AAAA / HP / nn)
REGION_BTL_COMBATBOX = (18, 28, 1, 26) # resolution combat boxes (standard font)

SCREENS = ('title', 'mainmenu', 'partyselect', 'nameentry', 'ow', 'sm',
           'battle', 'dialog', 'shop', 'gamemenu', 'transition', 'unknown')


@dataclass
class Classification:
    screen: str
    text: List[str] = field(default_factory=list)
    unknown: List[dict] = field(default_factory=list)   # LOUD scrape-miss channel
    battle_result: Optional[int] = None

    def to_json(self) -> dict:
        out: dict = {'screen': self.screen}
        if self.text:
            out['text'] = self.text
        if self.unknown:
            out['unknownTiles'] = self.unknown
        if self.battle_result is not None:
            out['btlResult'] = self.battle_result
        return out


def _lines(patterns: np.ndarray, glyphs: GlyphTable, region: Tuple[int, int, int, int],
           keep_empty: bool = False) -> scrape.ScrapeResult:
    r = scrape.scrape_region(patterns, glyphs, *region)
    if not keep_empty:
        r.lines = [ln for ln in r.lines if ln.strip()]
    return r


def classify(read, frame: np.ndarray, patterns: np.ndarray, glyphs: GlyphTable,
             uniform: bool) -> Classification:
    """Classify the CURRENT (settled) screen. `read` = RAM reader."""
    if uniform:
        return Classification('transition')

    # --- battle (P0-R RAM boolean beats everything) ---
    if ramspec.in_battle(read):
        c = Classification('battle', battle_result=read(ramspec.BTL_RESULT))
        roster = _lines(patterns, glyphs, REGION_BTL_ROSTER)
        c.text = roster.lines
        c.unknown = []   # battle graphics regions are not scrape misses
        return c

    # --- pre-game / overlay screens by scrape anchor ---
    full = _lines(patterns, glyphs, (0, 30, 0, 32))
    joined = '\n'.join(full.lines)
    if 'CONTINUE' in joined and 'RESPOND RATE' in joined:
        m = _lines(patterns, glyphs, REGION_MAINMENU)
        return Classification('mainmenu', m.lines, m.unknown)
    if 'SELECT' in joined and 'NAME' in joined and 'A B C D E' in joined.replace('  ', ' '):
        g = _lines(patterns, glyphs, REGION_NAMEGRID)
        return Classification('nameentry', g.lines, g.unknown)
    # party select: ≥2 class headers visible in their boxes
    headers = sum(1 for h in ('FIGHTER', 'THIEF', 'Bl.BELT', 'RedMAGE', 'Wh.MAGE', 'Bl.MAGE')
                  if h in joined)
    if headers >= 2 and read(ramspec.MAPFLAGS) & 1 == 0 and not ramspec.in_battle(read):
        return Classification('partyselect', full.lines, [])

    # --- on-map states ---
    on_sm = bool(read(ramspec.MAPFLAGS) & 1)
    # shop: entering_shop/shop_id are transient/latched — the reliable live
    # anchor is shop text (box headers/prices) while a shop screen is up.
    # The shop screen replaces the map view (probed in the Ph-A CURE run).
    dlg = _lines(patterns, glyphs, REGION_DIALOG)
    dialog_words = sum(1 for ln in dlg.lines if len(ln.replace(' ', '')) >= 4)
    if dialog_words >= 1 and _has_word_run(dlg.lines):
        # a text box is open over the map — dialog or shop; shops set shop_id
        # and draw price/GP text. Classify shop when the shop screen owns the
        # whole display (no map visible): heuristic = also text in rows 11-27.
        lower = _lines(patterns, glyphs, (11, 28, 1, 31))
        if any('G' in ln or 'GP' in ln for ln in lower.lines) or read(ramspec.ENTERING_SHOP) or _shopish(lower.lines):
            return Classification('shop', dlg.lines + lower.lines, dlg.unknown)
        return Classification('dialog', dlg.lines, dlg.unknown)

    # the Start menu / status screens (full-screen menus while "on map"):
    # anchor on the OB menu strings (probed in the Ph-A menu run).
    if _menuish(joined):
        return Classification('gamemenu', full.lines, [])

    return Classification('sm' if on_sm else 'ow')


def _has_word_run(lines: List[str]) -> bool:
    """≥4 contiguous known glyphs somewhere — the anti-false-anchor rule
    (calibration proved raw map graphics score 0)."""
    for ln in lines:
        run = 0
        for ch in ln:
            if ch not in (' ', scrape.UNKNOWN_CHAR):
                run += 1
                if run >= 4:
                    return True
            else:
                run = 0
    return False


def _shopish(lines: List[str]) -> bool:
    txt = ' '.join(lines)
    return any(w in txt for w in ('WELCOME', 'welcome', 'Welcome'))


def _menuish(joined: str) -> bool:
    hits = sum(1 for w in ('ITEM', 'MAGIC', 'WEAPON', 'ARMOR', 'STATUS') if w in joined)
    return hits >= 3
