#!/usr/bin/env python
"""gen_data.py — generate data/charmap.json, items.json, spells.json,
enemies.json from the vendored TBLs + the ROM itself (PLAN §5.2/§7.3).

Every table carries a lineage header; every decode is verified against known
anchors at generation time (LOUD failure — a wrong offset can't ship):
  - enemy 0 = "IMP" with 6 exp / 6 GP / 8 HP (P0-R canon block)
  - spell 0 = "CURE" (Constants.inc :: MG_CURE = MG_START+0)
  - weapon 1 decodes via name entry $1B+id (PLAN §7.3 / bank_0F)
  - "Short Sword" (weapon 2) prices at 550 G (the §7.3 shop example)

Run from games/ff1: ./venv/bin/python bridge/gen_data.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent
sys.path.insert(0, str(BRIDGE))

import ramspec  # noqa: E402

ROM_PATH = BRIDGE.parent / 'rom' / 'Final Fantasy.nes'
REF = BRIDGE.parent / 'reference'
DATA = BRIDGE.parent / 'data'


def load_tbl(path: Path) -> dict[int, str]:
    """Parse a .tbl charmap file (XX=str lines; values may be multi-char)."""
    out: dict[int, str] = {}
    for line in path.read_text().splitlines():
        if not line or '=' not in line:
            continue
        code, _, val = line.partition('=')
        out[int(code, 16)] = val if val else ' '   # 'C1= ' parses as empty → space
    return out


def gen_charmap() -> dict:
    std = load_tbl(REF / 'table_standard.tbl')
    dte = load_tbl(REF / 'table_dte.tbl')
    # sanity anchors straight from the vendored tables (P0-R: 'A'=$8A live-confirmed)
    assert std[0x8A] == 'A' and std[0x80] == '0' and std[0xA4] == 'a', 'standard tbl drift'
    assert dte[0x1C] == 'th' and dte[0x05] == '\\n', 'dte tbl drift'
    return {
        '_meta': {
            'generated_by': 'bridge/gen_data.py',
            'source': 'reference/table_standard.tbl + reference/table_dte.tbl '
                      '(Disch disassembly TBLs, vendored 2026-08-12)',
            'notes': "standard = menu/name single-tile map; dte = dialogue map "
                     "(control <$1A, DTE pairs $1A-$69). $FF = pad/space. "
                     "P0-R live-confirmed 'A'=$8A.",
        },
        'standard': {f'{k:02x}': v for k, v in sorted(std.items())},
        'dte': {f'{k:02x}': v for k, v in sorted(dte.items())},
    }


# The exact dump every table decode + anchor was verified against. A different
# revision/overdump could pass the handful of spot anchors while differing in
# un-anchored entries — and would then silently REWRITE the committed
# data/*.json on the next harness run (Ph-F review find: this CRC was claimed
# in _meta but never computed). Pinned = verified, LOUD on any other dump.
ROM_CRC32 = 0xAB12ECE6


class Rom:
    def __init__(self, path: Path) -> None:
        self.data = path.read_bytes()
        if self.data[:4] != b'NES\x1a':
            raise ValueError('not an iNES ROM')
        import zlib
        crc = zlib.crc32(self.data) & 0xFFFFFFFF
        if crc != ROM_CRC32:
            raise ValueError(
                f'ROM CRC32 {crc:08X} != pinned {ROM_CRC32:08X} — different dump; '
                'refusing to regenerate data/*.json (re-verify every anchor first)')

    def rd(self, bank: int, cpu: int, n: int) -> bytes:
        off = ramspec.rom_offset(bank, cpu)
        return self.data[off:off + n]

    def byte(self, bank: int, cpu: int) -> int:
        return self.rd(bank, cpu, 1)[0]

    def word(self, bank: int, cpu: int) -> int:
        b = self.rd(bank, cpu, 2)
        return b[0] | (b[1] << 8)


def decode_string(rom: Rom, bank: int, cpu: int, charmap: dict[int, str], max_len: int = 32) -> str:
    """Decode a 0-terminated game string (standard single-tile charset —
    item/enemy names don't use DTE; PLAN §5.2)."""
    out: list[str] = []
    for i in range(max_len):
        b = rom.byte(bank, cpu + i)
        if b == 0x00:
            break
        out.append(charmap.get(b, f'\\x{b:02x}'))
    return ''.join(out).rstrip()


def item_name(rom: Rom, std: dict[int, str], entry: int) -> str:
    """Entry in lut_ItemNamePtrTbl (Constants.inc :: lut_ItemNamePtrTbl $B700,
    BANK_ITEMS $0A; pointers are CPU addresses into the same bank)."""
    ptr = rom.word(ramspec.BANK_ITEMS, ramspec.LUT_ITEM_NAME_PTR + 2 * entry)
    return decode_string(rom, ramspec.BANK_ITEMS, ptr, std)


# FF1-US equipment-category icon tiles ($D4-$E1, table_standard.tbl @X codes) →
# the word each icon stands for (empirically confirmed against the full decoded
# list: Wooden@N=Wooden Nunchuck, Wooden@F/Heal@F=Staffs, White@T=Shirt, …).
ICON_WORDS = {
    '@S': 'Sword', '@H': 'Hammer', '@K': 'Knife', '@X': 'Axe', '@F': 'Staff',
    '@N': 'Nunchuck', '@A': 'Armor', '@s': 'Shield', '@h': 'Helmet',
    '@G': 'Gauntlet', '@B': 'Bracelet', '@T': 'Shirt', '@P': 'Potion',
}


def expand_name(name: str) -> tuple[str, str | None]:
    """'Short @S' → ('Short Sword', 'S'); un-iconed names pass through.
    The un-truncated fullName is the §7.3 no-truncation flagship."""
    for icon, word in ICON_WORDS.items():
        if icon in name:
            base = name.replace(icon, '').strip()
            return (f'{base} {word}' if base else word, icon[1:])
    return name, None


def gen_items(rom: Rom, std: dict[int, str]) -> dict:
    """items.json: unified item-id space (Constants.inc :: TCITYPE_*): consumable
    /key items $00-$1B, weapons $1C-$43 (weapon id 1-40), armor $44-$6B (armor
    id 1-40). Prices from lut_ItemPrices (BANK_ITEMPRICES $0D, $BC00, 2-byte LE
    per entry, same id space — anchored below). Weapon/armor stats from
    lut_Weapons/lut_Armor (BANK_EQUIPSTATS $0C: 8 bytes/weapon, 4 bytes/armor —
    Disch bank_0C data layout)."""
    items: list[dict] = []
    for entry in range(0x6C):
        name = item_name(rom, std, entry)
        if entry == 0:
            cat, sub = 'none', 0            # entry 0 is the null item
        elif entry <= 0x1B:
            cat, sub = 'item', entry
        elif entry <= 0x43:
            cat, sub = 'weapon', entry - ramspec.WEAPON_NAME_BASE   # weapon id 1-40
        else:
            cat, sub = 'armor', entry - ramspec.ARMOR_NAME_BASE     # armor id 1-40
        price = rom.word(ramspec.BANK_ITEMPRICES, ramspec.LUT_ITEM_PRICES + 2 * entry)
        full, icon = expand_name(name)
        rec: dict = {'id': entry, 'name': name, 'fullName': full, 'icon': icon,
                     'category': cat, 'catId': sub, 'price': price}
        if cat == 'weapon':
            w = rom.rd(ramspec.BANK_EQUIPSTATS, ramspec.LUT_WEAPONS + 8 * (sub - 1), 8)
            # bank_0C lut_Weapons row: hitrate, damage, crit, [wepgfx, elem, category, wepplt, unused]
            rec['stats'] = {'hitrate': w[0], 'damage': w[1], 'crit': w[2]}
        elif cat == 'armor':
            a = rom.rd(ramspec.BANK_EQUIPSTATS, ramspec.LUT_ARMOR + 4 * (sub - 1), 4)
            # bank_0C lut_Armor row: evade penalty, absorb, elem resist, spell cast
            rec['stats'] = {'evadePenalty': a[0], 'absorb': a[1], 'elemResist': a[2], 'spell': a[3]}
        items.append(rec)
    # --- anchors (FF1 canon, corrected against the first full decode: weapon 6
    # is Short Sword — weapons run Nunchuck/Small Knife/Wooden Staff/Rapier/
    # Iron Hammer/Short Sword) ---
    w6 = next(i for i in items if i['category'] == 'weapon' and i['catId'] == 6)
    if w6['fullName'] != 'Short Sword' or w6['price'] != 550:
        raise RuntimeError(f'items anchor FAIL: weapon 6 = {w6} (expected Short Sword @ 550 G)')
    heal = items[0x19]   # item_heal slot id ↔ HEAL potion (items+$19 ↔ unified id $19)
    if heal['fullName'] != 'HEAL Potion' or heal['price'] != 60:
        raise RuntimeError(f'items anchor FAIL: id $19 = {heal} (expected HEAL Potion @ 60 G)')
    masa = next(i for i in items if i['category'] == 'weapon' and i['catId'] == 40)
    if masa['name'] != 'Masmune':
        raise RuntimeError(f'items anchor FAIL: weapon 40 = {masa} (expected Masmune)')
    return {
        '_meta': {
            'generated_by': 'bridge/gen_data.py',
            'romCrc32': 'AB12ECE6 (computed + pinned at load)', 'source': 'ROM: names lut_ItemNamePtrTbl 0A:$B700, prices '
                      'lut_ItemPrices 0D:$BC00, weapon stats lut_Weapons 0C:$8000, armor '
                      'lut_Armor 0C:$8140 (Constants.inc labels)',
            'idSpace': 'TCITYPE_* unified ids: item $00-$1B, weapon $1C-$43 (catId 1-40), '
                       'armor $44-$6B (catId 1-40); ch_weapons/ch_armor store catId (+$80 = equipped)',
            'anchors': 'weapon 2 "Short Sword" 550 G; item $19 HEAL 60 G',
        },
        'items': items,
    }


def gen_spells(rom: Rom, std: dict[int, str]) -> dict:
    """spells.json: 64 spells. Names from the item name table at entry MG_START
    ($B0) + index (Constants.inc :: MG_CURE = MG_START+0 …). Level = idx//8 + 1,
    school by in-level slot (FF1 canon: slots 0-3 white, 4-7 black per level —
    verified by anchor CURE(white L1) / LIT(black L1, idx 7)). Magic data from
    0C:$81E0, 8 bytes/spell (Constants.inc :: MAGDATA_*)."""
    spells: list[dict] = []
    # target names MUST match battle.py's executor branches (whole-party ↔ the
    # $FE cmdbuf byte; caught at the Ph-F cold read — 'party' desync-raised)
    targets = {0x01: 'all-enemies', 0x02: 'one-enemy', 0x04: 'caster', 0x08: 'whole-party', 0x10: 'one-ally'}
    for idx in range(64):
        name = item_name(rom, std, ramspec.MG_START + idx)
        m = rom.rd(ramspec.BANK_EQUIPSTATS, ramspec.LUT_MAGIC + 8 * idx, 8)
        spells.append({
            'id': idx,
            'name': name,
            'level': idx // 8 + 1,
            'slot': idx % 8,
            'school': 'white' if (idx % 8) < 4 else 'black',
            'target': targets.get(m[3], f'0x{m[3]:02x}'),
            'hitrate': m[0], 'effectivity': m[1], 'element': m[2], 'effect': m[4],
        })
    if spells[0]['name'] != 'CURE':
        raise RuntimeError(f'spells anchor FAIL: spell 0 = {spells[0]["name"]} (expected CURE)')
    if spells[7]['name'] != 'LIT':
        raise RuntimeError(f'spells anchor FAIL: spell 7 = {spells[7]["name"]} (expected LIT)')
    return {
        '_meta': {
            'generated_by': 'bridge/gen_data.py',
            'source': 'ROM: names lut_ItemNamePtrTbl 0A:$B700 entry $B0+idx (Constants.inc '
                      ':: MG_START), data 0C:$81E0 8B/spell (MAGDATA_*)',
            'anchors': 'spell 0 CURE, spell 7 LIT',
            'obNotation': 'ch_spells stores per-level slots 1-8 (0=empty) — slot value v at '
                          'level L ⇒ spell id (L-1)*8 + (v-1) (variables.inc ch_magicdata comment)',
        },
        'spells': spells,
    }


def gen_enemies(rom: Rom, std: dict[int, str]) -> dict:
    """enemies.json: 128 enemies. Names via ptr table at 0B:$94E0 (PLAN §7.3,
    BANK_ENEMYNAMES); ROM stats at 0C:$8520, 20 B/enemy (ENROMSTAT_*)."""
    enemies: list[dict] = []
    for idx in range(128):
        ptr = rom.word(ramspec.BANK_ENEMYNAMES, ramspec.LUT_ENEMY_NAMES + 2 * idx)
        name = decode_string(rom, ramspec.BANK_ENEMYNAMES, ptr, std)
        base = ramspec.LUT_ENEMY_STATS + 20 * idx
        raw = rom.rd(ramspec.BANK_ENEMYSTATS, base, 20)
        st = {}
        for key, (off, size) in ramspec.ENROMSTAT.items():
            st[key] = raw[off] if size == 1 else raw[off] | (raw[off + 1] << 8)
        enemies.append({'id': idx, 'name': name, **st})
    e0 = enemies[0]
    if e0['name'] != 'IMP' or e0['exp'] != 6 or e0['gp'] != 6 or e0['hpmax'] != 8:
        raise RuntimeError(f'enemies anchor FAIL: enemy 0 = {e0} (expected IMP 6exp/6gp/8hp — P0-R canon)')
    return {
        '_meta': {
            'generated_by': 'bridge/gen_data.py',
            'source': 'ROM: names 0B:$94E0 ptr table (BANK_ENEMYNAMES), stats 0C:$8520 '
                      '20B/enemy (Constants.inc :: ENROMSTAT_*)',
            'anchors': 'enemy 0 IMP 6exp/6gp/8hp (P0-R $6BD3 canon)',
        },
        'enemies': enemies,
    }


def main() -> None:
    DATA.mkdir(exist_ok=True)
    rom = Rom(ROM_PATH)
    charmap = gen_charmap()
    std = {int(k, 16): v for k, v in charmap['standard'].items()}

    outputs = {
        'charmap.json': charmap,
        'items.json': gen_items(rom, std),
        'spells.json': gen_spells(rom, std),
        'enemies.json': gen_enemies(rom, std),
    }
    for name, doc in outputs.items():
        p = DATA / name
        p.write_text(json.dumps(doc, indent=1) + '\n')
        body = next(iter([v for k, v in doc.items() if k != '_meta']))
        n = len(body) if isinstance(body, (list, dict)) else '?'
        print(f'WROTE {p} ({n} entries)')


if __name__ == '__main__':
    main()
