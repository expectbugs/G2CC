"""screens.py — screen classifier v1 (PLAN §5.3 + §12 P1).

RAM-first (battle = $81==$68, map = mapflags bit0 — both P0-R-verified), with
scrape anchors for the screens RAM can't name (pre-game menus, dialog boxes,
shops, the Start menu). Text regions are PROBED tile rects (probe_layout.py /
live scrape dumps, 2026-08-12) — extraction is interior-only so borders and
sprites never count as scrape misses (BUILD_LOG Ph-A design note 3).

A uniform frame is ALWAYS 'transition' (settle-v2 rule) — never classified.
"""
from __future__ import annotations

import re
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
REGION_LOWBOX = (11, 28, 1, 31)        # lower half: shop bodies AND the tent/rest prompt
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
            # wire/display boundary: numeric tokens fold the shared O/0 glyph
            # back to digits ("3OO G" → "300 G" — Ph-F review find). The raw
            # .text stays unfolded for harness byte-exact scrape checks.
            out['text'] = [scrape.fold_line(ln) for ln in self.text]
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
    # party select: class headers in their boxes. Pre-game is decided by the
    # party NOT existing yet (slot-0 maxhp 0 — a live game always has HP), so
    # a MONO-class pick (headers==1) can't fall through to the shop branch
    # (Ph-F pass-2 find).
    headers = sum(1 for h in ('FIGHTER', 'THIEF', 'Bl.BELT', 'RedMAGE', 'Wh.MAGE', 'Bl.MAGE')
                  if h in joined)
    pregame = ramspec.rd16(read, ramspec.CH_STATS + ramspec.CH_MAXHP) == 0
    if headers >= (1 if pregame else 2) and read(ramspec.MAPFLAGS) & 1 == 0 \
            and not ramspec.in_battle(read):
        return Classification('partyselect', full.lines, [])
    if pregame:
        # No live party and no pre-game anchor matched: the title/story flow
        # (Ph-F review find: it used to fall through and classify 'ow', so
        # the controller pushed title pixels as map tiles). 'title' covers
        # the whole pre-game attract/prologue family.
        return Classification('title', full.lines, [])

    # --- on-map states ---
    on_sm = bool(read(ramspec.MAPFLAGS) & 1)
    # game-menu family FIRST (open item 3): the menu's own name/HP text sits in
    # the dialog rows and its gold line contains 'G' — evaluated after the
    # dialog branch it misreads as 'shop' (verified on fix_menu.npy).
    #
    # The FULL-SCREEN sub-menus reached FROM that menu belong to the same
    # family and are anchored here too (2026-08-13 review). They carry none of
    # the ITEM/MAGIC/ARMOR trio, so they used to fall through to 'dialog' —
    # which hands the window an A/B-only verb set and a rows-1..10 scrape:
    # the equip grid's IRIS/NOX/ZOT rows (13/19/25) were invisible and the
    # cursor could not be moved at all, i.e. equipping and item use were
    # impossible from the glasses.
    if _equipish(joined) or _statusish(joined) or _menuish(joined, full.lines):
        return Classification('gamemenu', full.lines, [])
    # shop: entering_shop/shop_id are transient/latched — the reliable live
    # anchor is shop text (box headers/prices) while a shop screen is up.
    # The shop screen replaces the map view (probed in the Ph-A CURE run).
    dlg = _lines(patterns, glyphs, REGION_DIALOG)
    if _boxish(dlg.lines):
        # a text box is open over the map — dialog or shop; shops set shop_id
        # and draw price/GP text. Classify shop when the shop screen owns the
        # whole display (no map visible): heuristic = also text in rows 11-27.
        lower = _lines(patterns, glyphs, REGION_LOWBOX)
        # NOTE (Ph-F review): the latched entering_shop OR-term is GONE — the
        # branch's own comment calls $50 transient/latched-unreliable; the
        # live anchors (price/GP text in the lower rows, WELCOME) carried the
        # whole journey suite on their own.
        # The price anchor now needs a DIGIT next to the G (2026-08-13 review):
        # a bare 'G' also matches the stat label 'AGL.', which classified the
        # STATUS screen as a shop.
        if _priced(lower.lines) or _shopish(lower.lines):
            return Classification('shop', dlg.lines + lower.lines, dlg.unknown)
        # The field ITEM screen (bare 'ITEM' header, an item grid, NO prices
        # and no Welcome) is a game-menu screen, not a dialog box — checked
        # AFTER the shop test so an ITEM SHOP, which shows the same header
        # plus prices, still classifies as a shop.
        if _item_screenish(full.lines):
            return Classification('gamemenu', full.lines, [])
        return Classification('dialog', dlg.lines, dlg.unknown)

    # A box drawn LOW with the dialogue rows empty: the rest prompt a
    # TENT/CABIN/HOUSE opens ("HP recovered. SAVE? / Push A··YES / Push B··NO",
    # then "Now saving··!"). REGION_DIALOG is rows 1-10 only, so these used to
    # classify 'ow'/'sm' — and a map screen renders as IMAGE TILES with no text
    # region, so the prompt was INVISIBLE: the window offered ↑↓←→ and every one
    # of them answered "can't go … — blocked" while the game sat waiting on an
    # A/B it never showed you. Found by using a tent outside the Temple of
    # Fiends (2026-08-13); `facing ?` in the text fallback was the tell.
    low = _lines(patterns, glyphs, REGION_LOWBOX)
    if _boxish(low.lines) and not (_priced(low.lines) or _shopish(low.lines)):
        return Classification('dialog', low.lines, low.unknown)

    return Classification('sm' if on_sm else 'ow')


def _boxish(lines: List[str]) -> bool:
    """Is a real text box open in this region? One line of ≥4 glyphs AND a
    ≥4-glyph contiguous run — the pair that calibration showed raw map
    graphics can never satisfy."""
    return (sum(1 for ln in lines if len(ln.replace(' ', '')) >= 4) >= 1
            and _has_word_run(lines))


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


# A NUMERAL immediately before G/GP. 'O' is in the class because the FF1 font
# draws 0 and O with the same 8x8 bitmap (scrape.AMBIGUOUS_PAIRS) and classify
# runs on RAW, unfolded lines — a shop's '8O G' is a price too.
_PRICE_RE = re.compile(r'[0-9O]\s*GP?\b')


def _priced(lines: List[str]) -> bool:
    """A real gold/price readout: a numeral next to G/GP. A bare 'G' anywhere
    also matched the status screen's 'AGL.' label, which put STATUS in the
    shop class (2026-08-13 review find)."""
    return any(_PRICE_RE.search(ln) for ln in lines)


def _equipish(joined: str) -> bool:
    """The WEAPON/ARMOR equip grids — their own header is drawn in the
    condensed CHR-RAM font and never scrapes, but the verb row always does
    (probed 2026-08-13: 'EQUIP  TRADE  DROP' at row 3)."""
    return 'EQUIP' in joined and 'TRADE' in joined and 'DROP' in joined


def _statusish(joined: str) -> bool:
    """The per-character STATUS page (probed 2026-08-13: 'FOR LEV UP' plus the
    STR./AGL./INT./VIT./LUCK block)."""
    return 'FOR LEV UP' in joined or ('LUCK' in joined and 'STR.' in joined)


def _item_screenish(lines: List[str]) -> bool:
    """The field ITEM screen: a line that is EXACTLY the 'ITEM' header (probed
    2026-08-13 at row 3, with the item grid at rows 6-8 and no gold line).
    Deliberately strict — an NPC saying the word must not match, and the
    caller has already ruled out shops."""
    return any(ln.strip() == 'ITEM' for ln in lines)


def _menuish(joined: str, lines: List[str]) -> bool:
    """Game-menu family anchor (open item 3). Main menu: the STANDARD-font
    header trio ITEM/MAGIC/ARMOR — WEAPON and STATUS are composed in the
    condensed CHR-RAM font and NEVER scrape (P1-R), so the old ≥3-of-5 rule
    passed only because exactly these three matched. ≥2 of 3 tolerates one
    overlapped header. The per-char MAGIC page shows none of the trio; its
    anchor is the L1..L8 per-level charge table (probed fix_magicpage.npy)."""
    hits = sum(1 for w in ('ITEM', 'MAGIC', 'ARMOR') if w in joined)
    if hits >= 2:
        return True
    charge_rows = 0
    for ln in lines:
        s = ln.strip()
        if len(s) >= 2 and s[0] == 'L' and s[1].isdigit():
            charge_rows += 1
    return charge_rows >= 4
