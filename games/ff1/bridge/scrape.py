"""scrape.py — deterministic framebuffer→text tile matching (PLAN §5.1/§5.2).

The NES draws text as 8×8 font tiles on the 32×30 tile grid; cynes frames are
pixel-exact (240×256×3 RGB). Each cell is binarized (luminance ≥ 128 = ink —
FF1 text is always white-on-dark; fades never reach the scraper because
settle-v2 refuses uniform frames) and the 64-bit ink pattern ITSELF, as 16 hex
chars, is the glyph key — no lossy hashing, so a "collision" is impossible and
a miss is a genuinely new tile, surfaced LOUD (never a misread).

Glyph table: data/glyphs.json, learned once by calibrate_glyphs.py from the
name-entry grid + verified round-trip on menu/battle screens (BUILD_LOG Ph-A
design note 1). Keys are the 16-hex patterns; values are the character (or ''
for learned chrome like the finger cursor / border tiles).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

GRID_COLS = 32
GRID_ROWS = 30
CELL = 8

# Unknown-tile marker inside scraped line text; the real hashes ride the
# side-channel (ScrapeResult.unknown) so nothing is silently mangled.
UNKNOWN_CHAR = '�'

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
GLYPHS_PATH = DATA_DIR / 'glyphs.json'


def binarize(frame: np.ndarray) -> np.ndarray:
    """(240,256,3) uint8 RGB → (240,256) bool ink mask (luminance ≥ 128)."""
    if frame.shape != (240, 256, 3):
        raise ValueError(f'expected (240,256,3) frame, got {frame.shape}')
    # integer luma (Rec.601 weights scaled /256) — deterministic, no float drift
    lum = (frame[:, :, 0].astype(np.uint32) * 77
           + frame[:, :, 1].astype(np.uint32) * 150
           + frame[:, :, 2].astype(np.uint32) * 29) >> 8
    return lum >= 128


def cell_patterns(frame: np.ndarray) -> np.ndarray:
    """All 30×32 cell patterns as uint64 (bit 63 = top-left pixel, row-major).
    Vectorized: packbits per 8-px row, then combine 8 rows per cell."""
    ink = binarize(frame)
    # → (30, 8, 32, 8): cell-row, pixel-row, cell-col, pixel-col
    cells = ink.reshape(GRID_ROWS, CELL, GRID_COLS, CELL)
    rowbytes = np.packbits(cells, axis=3)          # (30, 8, 32, 1) uint8
    rowbytes = rowbytes[:, :, :, 0].astype(np.uint64)
    out = np.zeros((GRID_ROWS, GRID_COLS), dtype=np.uint64)
    for r in range(CELL):
        out |= rowbytes[:, r, :] << np.uint64((7 - r) * 8)
    return out


def pat_hex(p: int) -> str:
    return f'{p:016x}'


EMPTY = 0  # all-background cell → space


# Glyph pairs the FF1 font draws with the SAME 8×8 bitmap (found empirically
# at calibration — 'O' vs '0' share 003e63636363633e). The FIRST-learned char
# wins as canonical; the alias is recorded in meta. Numeric display contexts
# fold back via fold_digit_token().
AMBIGUOUS_PAIRS = {frozenset(('O', '0'))}


def fold_digit_token(token: str) -> str:
    """Fold letter-aliases back to digits inside a numeric token: a token made
    only of [0-9O] with at least one real digit is a number the font drew with
    the shared O/0 glyph ("4OO" → "400"). Anything else passes through."""
    if any(ch.isdigit() for ch in token) and all(ch.isdigit() or ch == 'O' for ch in token):
        return token.replace('O', '0')
    return token


class GlyphTable:
    """hex-pattern → char mapping with LOUD load/save + provenance header."""

    def __init__(self, table: Dict[str, str], meta: Optional[dict] = None) -> None:
        self.table = table
        self.meta = meta or {}
        # int-keyed fast path for scraping
        self._by_int: Dict[int, str] = {int(k, 16): v for k, v in table.items()}

    @classmethod
    def load(cls, path: Path = GLYPHS_PATH) -> 'GlyphTable':
        raw = json.loads(path.read_text())
        if '_meta' not in raw or 'glyphs' not in raw:
            raise ValueError(f'{path} is not a glyph table (missing _meta/glyphs)')
        return cls(raw['glyphs'], raw['_meta'])

    def save(self, path: Path = GLYPHS_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        doc = {'_meta': self.meta, 'glyphs': dict(sorted(self.table.items()))}
        path.write_text(json.dumps(doc, indent=1) + '\n')

    def add(self, pattern: int, char: str, source: str) -> None:
        """Add a glyph. A conflicting re-add (same pattern, different char) is a
        calibration bug and raises loudly — UNLESS the pair is a known font
        ambiguity (AMBIGUOUS_PAIRS): then the first-learned char stays canonical
        and the alias is recorded in meta for the record."""
        key = pat_hex(pattern)
        old = self.table.get(key)
        if old is not None and old != char:
            if frozenset((old, char)) in AMBIGUOUS_PAIRS:
                aliases = self.meta.setdefault('aliases', {})
                aliases[key] = sorted([old, char])
                return
            raise ValueError(
                f'glyph conflict: pattern {key} already "{old}", refusing "{char}" ({source})')
        self.table[key] = char
        self._by_int[pattern] = char

    def char(self, pattern: int) -> Optional[str]:
        if pattern == EMPTY:
            return ' '
        return self._by_int.get(pattern)

    def __len__(self) -> int:
        return len(self.table)


class ScrapeResult:
    """One region's scrape: text lines + the unknown tiles inside the region."""

    def __init__(self, lines: List[str], unknown: List[dict]) -> None:
        self.lines = lines
        self.unknown = unknown   # [{'row':r,'col':c,'pattern':hex}] — LOUD channel

    def text(self) -> str:
        return '\n'.join(self.lines)


def scrape_region(patterns: np.ndarray, glyphs: GlyphTable,
                  row0: int, row1: int, col0: int, col1: int) -> ScrapeResult:
    """Scrape rows [row0,row1) × cols [col0,col1) of a cell_patterns() grid.
    Unknown cells render as UNKNOWN_CHAR in the line AND ride the side list."""
    lines: List[str] = []
    unknown: List[dict] = []
    for r in range(row0, row1):
        chars: List[str] = []
        for c in range(col0, col1):
            p = int(patterns[r, c])
            ch = glyphs.char(p)
            if ch is None:
                chars.append(UNKNOWN_CHAR)
                unknown.append({'row': r, 'col': c, 'pattern': pat_hex(p)})
            else:
                chars.append(ch if ch != '' else ' ')   # learned chrome → blank
        lines.append(''.join(chars).rstrip())
    return ScrapeResult(lines, unknown)


def scrape_full(patterns: np.ndarray, glyphs: GlyphTable) -> ScrapeResult:
    return scrape_region(patterns, glyphs, 0, GRID_ROWS, 0, GRID_COLS)


def frame_hash(frame: np.ndarray) -> str:
    """Stable content hash of a frame (settle detection / change detection)."""
    import hashlib
    return hashlib.blake2b(np.ascontiguousarray(frame).tobytes(), digest_size=8).hexdigest()


def known_text_cells(patterns: np.ndarray, glyphs: GlyphTable,
                     row0: int, row1: int, col0: int, col1: int) -> int:
    """Count NON-SPACE known glyph cells in a region (dialog/shop presence
    checks — classifier anchor helper). Chrome ('') does not count."""
    n = 0
    for r in range(row0, row1):
        for c in range(col0, col1):
            ch = glyphs.char(int(patterns[r, c]))
            if ch is not None and ch not in ('', ' '):
                n += 1
    return n
