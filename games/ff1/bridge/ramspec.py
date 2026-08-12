"""ramspec.py — every RAM/ROM address the FF1 bridge touches, with lineage.

Authority: games/ff1/reference/variables.inc + Constants.inc (Disch's
reassemblable US disassembly — see reference/README.md). Data Crystal
(reference/ff1_ram_map.txt) corroborates; on conflict the disassembly wins.
Empirical P0 confirmations are marked "P0-R" (PLAN.md §12 P0-R, 2026-08-12).

Nothing in here advances the emulator; pure address constants + tiny decoders
over a `read(addr) -> int` callable so daemon/harness share one decode path.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional

Read = Callable[[int], int]

# ---------------------------------------------------------------- zero page
JOY = 0x20                 # reference/variables.inc :: joy
OW_SCROLL_X = 0x27         # reference/variables.inc :: ow_scroll_x (player tile = scroll+7, bank_0F "ADC #7")
OW_SCROLL_Y = 0x28         # reference/variables.inc :: ow_scroll_y
SM_SCROLL_X = 0x29         # reference/variables.inc :: sm_scroll_x
SM_SCROLL_Y = 0x2A         # reference/variables.inc :: sm_scroll_y
MAPFLAGS = 0x2D            # reference/variables.inc :: mapflags (bit0 = in standard map)
FACING = 0x33              # reference/variables.inc :: facing (1=R 2=L 4=D 8=U; P0-R confirmed)
MOVE_CTR_X = 0x35          # reference/variables.inc :: move_ctr_x (pixels between tiles, 00-0F)
MOVE_CTR_Y = 0x36          # reference/variables.inc :: move_ctr_y
MENUSTALL = 0x37           # reference/variables.inc :: menustall
VEHICLE = 0x42             # reference/variables.inc :: vehicle (1=walk 2=canoe 4=ship 8=airship; P0-R)
VEHICLE_NEXT = 0x46        # reference/variables.inc :: vehicle_next
CUR_MAP = 0x48             # reference/variables.inc :: cur_map
CUR_TILESET = 0x49         # reference/variables.inc :: cur_tileset
MUSIC_TRACK = 0x4B         # reference/variables.inc :: music_track — TRANSIENT request byte (P0-R:
                           #   00 at steady state; NEVER a state flag)
ENTERING_SHOP = 0x50       # reference/variables.inc :: entering_shop (nonzero = about to enter shop)
SHOP_ID = 0x51             # reference/variables.inc :: shop_id
DLG_REENTERMAP = 0x56      # reference/variables.inc :: dlgflg_reentermap
CURSOR = 0x62              # reference/variables.inc :: cursor (OB menu cursor)
CURSOR_MAX = 0x63          # reference/variables.inc :: cursor_max
NAMECURS_X = 0x64          # reference/variables.inc :: namecurs_x (name-entry grid cursor)
NAMECURS_Y = 0x65          # reference/variables.inc :: namecurs_y
SM_PLAYER_X = 0x68         # reference/variables.inc :: sm_player_x — ⚠ STALE after menu/shop
                           #   screens (P1-R); player_tile() uses (sm_scroll+7)&$3F instead
SM_PLAYER_Y = 0x69         # reference/variables.inc :: sm_player_y
BTLFORMATION = 0x6A        # reference/variables.inc :: btlformation (pending formation id)
DESCBOXOPEN = 0x7F         # reference/variables.inc :: descboxopen
IN_BATTLE_PTR_HI = 0x81    # reference/variables.inc :: btlptr+1 — P0-R RESOLVED in-battle boolean:
                           #   $81 == $68 while a battle runs (fires the frame the encounter
                           #   triggers, mid-step-hold); $63 on-map-after. Data Crystal proxy,
                           #   live-confirmed at the P0 spike.
IN_BATTLE_VALUE = 0x68     # the in-fight value of $81 (see above)
BATTLESTEP = 0xF5          # reference/variables.inc :: battlestep (per-step encounter counter)
BATTLESTEP_SIGN = 0xF6     # reference/variables.inc :: battlestep_sign
BATTLECOUNTER = 0xF7       # reference/variables.inc :: battlecounter (next-encounter index)
BATTLERATE = 0xF8          # reference/variables.inc :: battlerate (X/256 chance, SM only)

# ---------------------------------------------------------------- party gen (RAM, transient)
PTYGEN = 0x0300            # reference/variables.inc :: ptygen ($40 bytes, party-select/name screens)
PTYGEN_CLASS = PTYGEN + 0  # reference/variables.inc :: ptygen_class (per-slot stride $10)
PTYGEN_NAME = PTYGEN + 2   # reference/variables.inc :: ptygen_name (4 bytes, game charset)
PTYGEN_STRIDE = 0x10       # ptygen_* fields repeat per slot at +$10 (bank_0E party gen)

# ---------------------------------------------------------------- unsram ($6000-$63FF working save)
UNSRAM = 0x6000            # reference/variables.inc :: unsram ($400 bytes)
SRAM = 0x6400              # reference/variables.inc :: sram ($400 bytes — the checksummed inn-save copy)
SRAM_CHECKSUM = SRAM + 0xFD    # reference/variables.inc :: sram_checksum
SRAM_ASSERT_55 = SRAM + 0xFE   # reference/variables.inc :: sram_assert_55 (must read $55)
SRAM_ASSERT_AA = SRAM + 0xFF   # reference/variables.inc :: sram_assert_AA (must read $AA)
SRAM_SIZE = 0x2000         # full battery region $6000-$7FFF (cynes-safe documented range)

SHIP_VIS = UNSRAM + 0x00   # reference/variables.inc :: ship_vis
AIRSHIP_VIS = UNSRAM + 0x04  # reference/variables.inc :: airship_vis
HAS_CANOE = UNSRAM + 0x12  # reference/variables.inc :: has_canoe
GOLD = UNSRAM + 0x1C       # reference/variables.inc :: gold (3 bytes; P0-R: little-endian, 400 at boot)
ITEMS = UNSRAM + 0x20      # reference/variables.inc :: items (fixed slots)
ITEM_ORB_START = ITEMS + 0x12  # reference/variables.inc :: item_orb_start (4 orbs)
ITEM_TENT = ITEMS + 0x16   # reference/variables.inc :: item_tent
ITEM_CABIN = ITEMS + 0x17  # reference/variables.inc :: item_cabin
ITEM_HOUSE = ITEMS + 0x18  # reference/variables.inc :: item_house
ITEM_HEAL = ITEMS + 0x19   # reference/variables.inc :: item_heal
ITEM_PURE = ITEMS + 0x1A   # reference/variables.inc :: item_pure
ITEM_SOFT = ITEMS + 0x1B   # reference/variables.inc :: item_soft

CH_STATS = UNSRAM + 0x0100  # reference/variables.inc :: ch_stats ($40/char: $6100/6140/6180/61C0)
CH_STRIDE = 0x40
CH_CLASS = 0x00            # reference/variables.inc :: ch_class (CLS_* in Constants.inc)
CH_AILMENTS = 0x01         # reference/variables.inc :: ch_ailments (AIL_* bits)
CH_NAME = 0x02             # reference/variables.inc :: ch_name (4 bytes, game charset)
CH_EXP = 0x07              # reference/variables.inc :: ch_exp (3 bytes; byte order = P1 item, see PLAN §6.3)
CH_CURHP = 0x0A            # reference/variables.inc :: ch_curhp (16-bit LE)
CH_MAXHP = 0x0C            # reference/variables.inc :: ch_maxhp
CH_STR = 0x10              # reference/variables.inc :: ch_str … ch_luck (+$10-$14)
CH_EXPTONEXT = 0x16        # reference/variables.inc :: ch_exptonext (2 bytes, display-only)
CH_WEAPONS = 0x18          # reference/variables.inc :: ch_weapons (4; +$80 = equipped)
CH_ARMOR = 0x1C            # reference/variables.inc :: ch_armor (4; +$80 = equipped)
CH_SUBSTATS = 0x20         # reference/variables.inc :: ch_substats (dmg/hitrate/absorb/evade/resist/magdef)
CH_LEVEL = 0x26            # reference/variables.inc :: ch_level (0-based out of battle)

CH_MAGIC = UNSRAM + 0x0300  # reference/variables.inc :: ch_magicdata ($40/char)
CH_SPELLS = 0x00           # reference/variables.inc :: ch_spells (8 levels × 3 slots + pad, values 0-8 OB)
CH_CURMP = 0x20            # reference/variables.inc :: ch_curmp ($6320+$40/char) — disassembly order;
                           #   Data Crystal claims the reverse; DISAMBIGUATION = P1 item (spend a charge)
CH_MAXMP = 0x28            # reference/variables.inc :: ch_maxmp ($6328+$40/char)

GAME_FLAGS = UNSRAM + 0x0200  # reference/variables.inc :: game_flags

# ---------------------------------------------------------------- battle block
BTL_TURNORDER = 0x6848     # reference/variables.inc :: btl_turnorder ($D entries)
BTL_RNGSTATE = 0x688A      # reference/variables.inc :: btl_rngstate (persists in save range — RNG honesty §6.2)
BTL_CURTURN = 0x688E       # reference/variables.inc :: btl_curturn
BTL_CHARCMDBUF = 0x688F    # reference/variables.inc :: btl_charcmdbuf (4 bytes/char: cmd, effectID, target, pad)
BTL_CHARCMDITEM = 0x689F   # reference/variables.inc :: btl_charcmditem (1/char)
BTL_CHARCMD_CONSUMETYPE = 0x68A3  # reference/variables.inc :: btl_charcmdconsumetype (01 magic, 02 drink)
BTL_CHARCMD_CONSUMEID = 0x68A7    # reference/variables.inc :: btl_charcmdconsumeid (potion idx / spell level)
# btl_charcmdbuf byte-0 command values (variables.inc block comment):
CMD_NONE_SURPRISED = 0x00
CMD_NONE_DEAD = 0x01
CMD_NONE_STONE = 0x02
CMD_ATTACK = 0x04
CMD_DRINK = 0x08
CMD_ITEM = 0x10
CMD_RUN = 0x20
CMD_MAGIC = 0x40

BTLCURS_X = 0x6AAA         # reference/variables.inc :: btlcurs_x (menu coords, not pixels)
BTLCURS_Y = 0x6AAB         # reference/variables.inc :: btlcurs_y
# $6AAA/$6AAB are OVERLOADED (variables.inc :: btlcurs / btlcurs_max = same
# addresses): the enemy-target picker stores its slot index in $6AAA and the
# formation's slot max in $6AAB (bank_0C.asm :: EnemyTargetMenu), while the
# 2x4 menus (command menu, ally picker) store x/y here and ZERO both at entry
# (bank_0C.asm :: MenuSelection_2x4 / MenuSelection_Magic). Never read these
# without knowing which menu is live — see btlcursspr below for that.
BTLCURSSPR_X = 0x6AE3      # reference/variables.inc :: btlcursspr_x (cursor SPRITE pixel pos —
BTLCURSSPR_Y = 0x6AE4      # reference/variables.inc :: btlcursspr_y   rewritten every menu-loop
                           #   iteration from per-menu pixel luts; bank_0C.asm ::
                           #   lut_MagicCursorPos / lut_PlayerTargetCursorPos /
                           #   lut_Target{9Small,4Large,Mix}CursorPos. The luts occupy
                           #   DISJOINT screen areas, so this pair identifies WHICH menu
                           #   is (or was last) live. Stays stale after a menu exits.)
BTLCMD_CURCHAR = 0x6B7A    # reference/variables.inc :: btlcmd_curchar (whose command, 0-3)
BTLCMD_TARGET = 0x6B7B     # reference/variables.inc :: btlcmd_target (current enemy slot targetted)
BTL_RESULT = 0x6B86        # reference/variables.inc :: btl_result (0 fighting / 1 party dead / 2 won /
                           #   3 ran / $FF chaos-wait) — the battle-end detector
BTL_SMALLSLOTS = 0x6BB2    # reference/variables.inc :: btl_smallslots
BTL_ENEMY_IDS = 0x6BB7     # reference/variables.inc :: btl_enemyIDs (9 slots, $FF empty)
BTL_ENEMYGFXPLT = 0x6BC0   # reference/variables.inc :: btl_enemygfxplt
BTL_ENEMYROSTER = 0x6BC9   # reference/variables.inc :: btl_enemyroster (the ≤4 IDs the battle menu prints)
BTL_ENEMYSTATS = 0x6BD3    # reference/variables.inc :: btl_enemystats ($14/enemy; P0-R: IMP block canon)
EN_STRIDE = 0x14
EN_HP = 0x02               # reference/variables.inc :: en_hp (2 bytes)
EN_AILMENTS = 0x06         # reference/variables.inc :: en_ailments (AIL_DEAD bit = dead)
EN_EXP = 0x0D              # reference/variables.inc :: en_exp (2 bytes)
EN_GP = 0x0F               # reference/variables.inc :: en_gp (2 bytes)
EN_ENEMYID = 0x11          # reference/variables.inc :: en_enemyid
BTL_BATTLETYPE = 0x6C92    # reference/variables.inc :: btl_battletype (0=9small 1=4large 2=mix 3=fiend 4=chaos)
BTL_ENEMYCOUNT = 0x6C93    # reference/variables.inc :: btl_enemycount
BTL_FORMDATA = 0x6D84      # reference/variables.inc :: btl_formdata ($10 bytes, ROM formation copy)
BTLFORM_ENIDS = BTL_FORMDATA + 0x2   # reference/variables.inc :: btlform_enids (4)
BTLFORM_ENQTY = BTL_FORMDATA + 0x6   # reference/variables.inc :: btlform_enqty (4)
BTLFORM_SURPRISE = BTL_FORMDATA + 0xC  # reference/variables.inc :: btlform_surprise
BTLFORM_NORUN = BTL_FORMDATA + 0xD     # reference/variables.inc :: btlform_norun (low bit)
BTLFORM_ENQTYB = BTL_FORMDATA + 0xE    # reference/variables.inc :: btlform_enqtyB (2)

EOB_GP_REWARD = 0x6876     # reference/variables.inc :: eob_gp_reward (end-of-battle, shares btl math space)
EOB_EXP_REWARD = 0x6878    # reference/variables.inc :: eob_exp_reward

# ---------------------------------------------------------------- constants (Constants.inc)
AIL_DEAD = 0x01            # reference/Constants.inc :: AIL_DEAD
AIL_STONE = 0x02           # reference/Constants.inc :: AIL_STONE
AIL_POISON = 0x04          # reference/Constants.inc :: AIL_POISON
AIL_DARK = 0x08            # reference/Constants.inc :: AIL_DARK
AIL_STUN = 0x10            # reference/Constants.inc :: AIL_STUN
AIL_SLEEP = 0x20           # reference/Constants.inc :: AIL_SLEEP
AIL_MUTE = 0x40            # reference/Constants.inc :: AIL_MUTE
AIL_CONF = 0x80            # reference/Constants.inc :: AIL_CONF

CLASS_NAMES = {            # reference/Constants.inc :: CLS_* ($00-$0B)
    0x00: 'FIGHTER', 0x01: 'THIEF', 0x02: 'Bl.BELT', 0x03: 'RedMAGE',
    0x04: 'Wh.MAGE', 0x05: 'Bl.MAGE', 0x06: 'KNIGHT', 0x07: 'NINJA',
    0x08: 'MASTER', 0x09: 'Rd.WIZ', 0x0A: 'Wh.WIZ', 0x0B: 'Bl.WIZ',
}
CLS_FT, CLS_TH, CLS_BB, CLS_RM, CLS_WM, CLS_BM = 0, 1, 2, 3, 4, 5

FACING_NAME = {1: 'R', 2: 'L', 4: 'D', 8: 'U'}   # reference/Constants.inc :: RIGHT/LEFT/DOWN/UP
VEHICLE_NAME = {1: 'walk', 2: 'canoe', 4: 'ship', 8: 'airship'}  # variables.inc :: vehicle

MG_START = 0xB0            # reference/Constants.inc :: MG_START (spell item-ids $B0-$EF)

# ---------------------------------------------------------------- ROM layout (for gen_data.py)
# iNES: 16-byte header, PRG 16 KB banks 0..15 (MMC1, 256 KB — PLAN §1 header verify).
ROM_HEADER = 16
ROM_BANK = 0x4000

def rom_offset(bank: int, cpu_addr: int) -> int:
    """File offset of `cpu_addr` as seen through PRG `bank` at $8000-$BFFF
    (bank $0F is also the fixed $C000-$FFFF bank on MMC1)."""
    if 0x8000 <= cpu_addr <= 0xBFFF:
        return ROM_HEADER + bank * ROM_BANK + (cpu_addr - 0x8000)
    if 0xC000 <= cpu_addr <= 0xFFFF and bank == 0x0F:
        return ROM_HEADER + bank * ROM_BANK + (cpu_addr - 0xC000)
    raise ValueError(f'cpu_addr {cpu_addr:#x} not a switchable-bank address')

BANK_ITEMS = 0x0A          # reference/Constants.inc :: BANK_ITEMS (= BANK_DIALOGUE)
LUT_ITEM_NAME_PTR = 0xB700  # reference/Constants.inc :: lut_ItemNamePtrTbl ($B700, BANK_ITEMS)
BANK_ITEMPRICES = 0x0D     # reference/Constants.inc :: BANK_ITEMPRICES
LUT_ITEM_PRICES = 0xBC00   # reference/Constants.inc :: lut_ItemPrices ($BC00 - page)
BANK_EQUIPSTATS = 0x0C     # reference/Constants.inc :: BANK_EQUIPSTATS
LUT_WEAPONS = 0x8000       # reference/Constants.inc :: lut_Weapons (8 bytes/weapon)
LUT_ARMOR = 0x8140         # reference/Constants.inc :: lut_Armor (4 bytes/armor)
LUT_MAGIC = 0x81E0         # PLAN §7.3 magic data 0C:$81E0 (8 bytes/spell, MAGDATA_* layout)
BANK_ENEMYNAMES = 0x0B     # reference/Constants.inc :: BANK_ENEMYNAMES
LUT_ENEMY_NAMES = 0x94E0   # PLAN §7.3 enemy names 0B:$94E0 (128 × 2-byte ptrs)
BANK_ENEMYSTATS = 0x0C     # PLAN §7.3 enemy ROM stats 0C:$8520
LUT_ENEMY_STATS = 0x8520   # 20 bytes/enemy, ENROMSTAT_* layout (Constants.inc)
# reference/Constants.inc :: ENROMSTAT_* (enemy ROM stat layout, 20 bytes)
ENROMSTAT = {
    'exp': (0x00, 2), 'gp': (0x02, 2), 'hpmax': (0x04, 2), 'morale': (0x06, 1),
    'ai': (0x07, 1), 'evade': (0x08, 1), 'absorb': (0x09, 1), 'numhits': (0x0A, 1),
    'hitrate': (0x0B, 1), 'damage': (0x0C, 1), 'critrate': (0x0D, 1),
    'attackail': (0x0F, 1), 'category': (0x10, 1), 'magdef': (0x11, 1),
    'elemweak': (0x12, 1), 'elemresist': (0x13, 1),
}
# Item-id spaces (reference/Constants.inc :: TCITYPE_* + PLAN §7.3):
# items $00-$1B, weapons $1C-$43 (weapon id 1-40 → name entry $1B+id),
# armor $44-$6B (armor id 1-40 → name entry $43+id), GP entries $6C+,
# spells at MG_START ($B0) + spell index.
WEAPON_NAME_BASE = 0x1B
ARMOR_NAME_BASE = 0x43

# ---------------------------------------------------------------- decoders

def rd16(read: Read, addr: int) -> int:
    return read(addr) | (read(addr + 1) << 8)


def rd24(read: Read, addr: int) -> int:
    # gold byte order little-endian P0-R-confirmed (400 = 90 01 00)
    return read(addr) | (read(addr + 1) << 8) | (read(addr + 2) << 16)


@dataclass
class CharSnapshot:
    slot: int
    cls: int
    cls_name: str
    ailments: int
    name_bytes: List[int]
    name: str
    exp: int
    curhp: int
    maxhp: int
    level0: int            # 0-based (variables.inc: OB 0-based)
    weapons: List[int]     # raw bytes, +$80 = equipped
    armor: List[int]
    spells: List[List[int]]   # 8 levels × 3 slot values (0=empty, 1-8 spell-in-level OB)
    curmp: List[int]       # 8 per-level charges
    maxmp: List[int]

    def alive(self) -> bool:
        return (self.ailments & (AIL_DEAD | AIL_STONE)) == 0


def read_char(read: Read, slot: int, decode_name) -> CharSnapshot:
    base = CH_STATS + slot * CH_STRIDE
    mbase = CH_MAGIC + slot * CH_STRIDE
    name_bytes = [read(base + CH_NAME + i) for i in range(4)]
    cls = read(base + CH_CLASS)
    # ch_exp byte order: low-first implied by lvlup ptr use; P1 re-check documented in PLAN §6.3
    exp = read(base + CH_EXP) | (read(base + CH_EXP + 1) << 8) | (read(base + CH_EXP + 2) << 16)
    return CharSnapshot(
        slot=slot,
        cls=cls,
        cls_name=CLASS_NAMES.get(cls, f'class#{cls}'),
        ailments=read(base + CH_AILMENTS),
        name_bytes=name_bytes,
        name=decode_name(name_bytes),
        exp=exp,
        curhp=rd16(read, base + CH_CURHP),
        maxhp=rd16(read, base + CH_MAXHP),
        level0=read(base + CH_LEVEL),
        weapons=[read(base + CH_WEAPONS + i) for i in range(4)],
        armor=[read(base + CH_ARMOR + i) for i in range(4)],
        spells=[[read(mbase + CH_SPELLS + lv * 4 + s) for s in range(3)] for lv in range(8)],
        curmp=[read(mbase + CH_CURMP + i) for i in range(8)],
        maxmp=[read(mbase + CH_MAXMP + i) for i in range(8)],
    )


@dataclass
class EnemySlot:
    slot: int
    enemy_id: int
    hp: int
    ailments: int
    exp: int
    gp: int

    def alive(self) -> bool:
        return self.hp > 0 and (self.ailments & AIL_DEAD) == 0


def read_enemy_slots(read: Read) -> List[EnemySlot]:
    """The 9 in-battle enemy slots ($6BB7 ids + $6BD3 stat blocks, P0-R-verified)."""
    out: List[EnemySlot] = []
    for i in range(9):
        eid = read(BTL_ENEMY_IDS + i)
        if eid == 0xFF:
            continue
        base = BTL_ENEMYSTATS + i * EN_STRIDE
        out.append(EnemySlot(
            slot=i,
            enemy_id=eid,
            hp=rd16(read, base + EN_HP),
            ailments=read(base + EN_AILMENTS),
            exp=rd16(read, base + EN_EXP),
            gp=rd16(read, base + EN_GP),
        ))
    return out


def in_battle(read: Read) -> bool:
    """P0-R-resolved in-battle boolean: $81 == $68 (see IN_BATTLE_PTR_HI)."""
    return read(IN_BATTLE_PTR_HI) == IN_BATTLE_VALUE


def player_tile(read: Read) -> tuple[int, int]:
    """Player map tile from the scroll registers + 7 (bank_0F 'ADC #7 ; +7 to
    get player's coord' — P0-R verified). Overworld wraps 256×256 → &$FF;
    standard maps wrap 64×64 → &$3F. sm_player_x/y ($68/$69) is deliberately
    NOT used: it goes STALE after menu/shop screens and refreshes only on
    movement (P1-R: post-shop it read (7,68) while (sm_scroll+7)&$3F matched
    the post-move sm_player exactly)."""
    if read(MAPFLAGS) & 0x01:
        return (read(SM_SCROLL_X) + 7) & 0x3F, (read(SM_SCROLL_Y) + 7) & 0x3F
    return (read(OW_SCROLL_X) + 7) & 0xFF, (read(OW_SCROLL_Y) + 7) & 0xFF


def sram_save_present(read: Read) -> bool:
    """True when the checksummed inn-save copy exists (sram_assert bytes —
    variables.inc :: sram_assert_55/AA). Cheap coherency gate for .sav export."""
    return read(SRAM_ASSERT_55) == 0x55 and read(SRAM_ASSERT_AA) == 0xAA
