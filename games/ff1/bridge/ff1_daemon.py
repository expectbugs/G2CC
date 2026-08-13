#!/usr/bin/env python
"""ff1_daemon.py — JSON-lines stdio daemon hosting the cynes FF1 core
(PLAN §3/§4; stt.ts-pattern client on the Node side).

Protocol: one JSON object per line on stdin → exactly one JSON object per line
on stdout carrying the request's `seq`. Success responses carry op-specific
fields + a full `state` snapshot (unless noted); failures carry
{seq, error, traceback} — NEVER a silent default (§10). All logging goes to
stderr; stdout is protocol-pure. Run with -u (unbuffered), cwd games/ff1.

Undo everywhere (§8.4): every ADVANCING op auto-checkpoints the pre-op
savestate into a labeled ring (depth = config undoDepth, default 30);
{op:"undo_list"} / {op:"undo", index} restore. undo() does NOT pop — newer
entries stay until depth-trimmed by new checkpoints.

The daemon idles PAUSED between ops (we own the clock — §5.3): zero frames
advance unless an op advances them.
"""
from __future__ import annotations

import base64
import io
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

BRIDGE = Path(__file__).resolve().parent
sys.path.insert(0, str(BRIDGE))

import battle as battlemod
import macros
import ramspec
import screens
import scrape
from macros import BudgetExceeded, Desync, Emu

FF1_DIR = BRIDGE.parent
DEFAULT_ROM = FF1_DIR / 'rom' / 'Final Fantasy.nes'
DATA = FF1_DIR / 'data'

VISIBLE_TOP = 8      # §4 frame op: trim 8px overscan top+bottom → 256×224


def log(msg: str) -> None:
    print(f'[ff1-daemon] {msg}', file=sys.stderr, flush=True)


class UndoRing:
    """Labeled savestate ring, newest first (§8.4). ~21.8 KB/state (P0-R)."""

    def __init__(self, depth: int = 30) -> None:
        self.depth = depth
        self.entries: List[Dict[str, Any]] = []

    def push(self, label: str, state: np.ndarray) -> None:
        self.entries.insert(0, {
            'label': label,
            # microseconds, NOT seconds (Ph-F pass-2 find: the server's tail
            # mirror keys on label|at — two same-label checkpoints inside one
            # wall-clock second collided and mirrored the OLDER state under
            # the newer checkpoint's name)
            'at': datetime.now(timezone.utc).isoformat(timespec='microseconds'),
            'state': state,
        })
        while len(self.entries) > self.depth:
            self.entries.pop()

    def listing(self) -> List[dict]:
        return [{'index': i, 'label': e['label'], 'at': e['at']}
                for i, e in enumerate(self.entries)]

    def get(self, index: int) -> Dict[str, Any]:
        if not (0 <= index < len(self.entries)):
            raise IndexError(f'undo index {index} out of range (0..{len(self.entries) - 1})')
        return self.entries[index]


class Daemon:
    def __init__(self) -> None:
        self.emu: Optional[Emu] = None
        self.undo = UndoRing()
        self.rng_jitter = True
        # Ph-E minimap trail (PLAN §7 "explored-layout"): tiles the party has
        # been OBSERVED on, per (standardMap, mapId) — recorded at op-endpoint
        # snapshots (coarse breadcrumbs, ≤8 tiles apart on step macros).
        # Session-lifetime + advisory: a daemon respawn or undo starts the
        # trail fresh/stale respectively — it never claims map authority.
        self.trail: Dict[tuple, set] = {}
        self.enemies = json.loads((DATA / 'enemies.json').read_text())['enemies']
        self.spells = json.loads((DATA / 'spells.json').read_text())['spells']
        self.charmap_std = {int(k, 16): v
                            for k, v in json.loads((DATA / 'charmap.json').read_text())['standard'].items()}
        self.char_encode = {v: k for k, v in self.charmap_std.items() if len(v) == 1 and v != ' '}
        self.char_encode[' '] = 0xFF   # pad-space is the name-entry space byte

    # ------------------------------------------------------------- helpers
    def need_emu(self) -> Emu:
        if self.emu is None:
            raise RuntimeError('no ROM booted — send {op:"boot"} first')
        return self.emu

    def decode_name(self, byts: List[int]) -> str:
        return ''.join(self.charmap_std.get(b, '?') for b in byts).rstrip()

    def enemy_name(self, eid: int) -> str:
        if 0 <= eid < len(self.enemies):
            return self.enemies[eid]['name']
        return f'enemy#{eid}'

    def checkpoint(self, label: str) -> None:
        emu = self.need_emu()
        self.undo.push(label, emu.save())

    def decode_state(self, b64: str) -> np.ndarray:
        """Validate + decode a savestate payload. cynes' load() streams a
        FIXED byte count from the raw pointer with NO bounds check —
        Ph-F pass-2 EMPIRICAL find: a 100-byte buffer segfaults the daemon,
        a 4 KB one returns silent garbage that then overwrites the good PG
        save. Length is checked against a real save of THIS core."""
        emu = self.need_emu()
        raw = np.frombuffer(base64.b64decode(b64), dtype=np.uint8)
        expected = emu.save().nbytes
        if raw.nbytes != expected:
            raise ValueError(f'savestate is {raw.nbytes} bytes, this cynes core '
                             f'expects exactly {expected} — refusing to load')
        return raw

    # ------------------------------------------------------------- snapshot
    def snapshot(self) -> dict:
        emu = self.need_emu()
        read = emu.read
        cls = screens.classify(read, emu.frame, emu.patterns(), emu.glyphs,
                               emu.uniform_frame())
        party = []
        in_btl = ramspec.in_battle(read)
        skip_mask = (ramspec.AIL_DEAD | ramspec.AIL_STONE
                     | ramspec.AIL_STUN | ramspec.AIL_SLEEP)
        for slot in range(4):
            ch = ramspec.read_char(read, slot, self.decode_name)
            # IN-BATTLE RAM flips two encodings in place (variables.inc; Ph-F
            # pass-3 find): ch_level becomes 1-based and ch_spells becomes a
            # GLOBAL 1-based index. The WIRE contract stays the out-of-battle
            # form — normalize here so consumers never see the flip.
            level = ch.level0 + (0 if in_btl else 1)
            spells = ([[(((v - 1) % 8) + 1) if v else 0 for v in lv] for lv in ch.spells]
                      if in_btl else ch.spells)
            party.append({
                'slot': slot, 'name': ch.name, 'class': ch.cls_name, 'classId': ch.cls,
                'ailments': ch.ailments, 'alive': ch.alive(),
                'canInput': (ch.ailments & skip_mask) == 0,
                'hp': ch.curhp, 'maxhp': ch.maxhp, 'level': level,
                'exp': ch.exp, 'mp': ch.curmp, 'maxmp': ch.maxmp,
                'spells': spells, 'weapons': ch.weapons, 'armor': ch.armor,
            })
        x, y = ramspec.player_tile(read)
        if cls.screen in ('ow', 'sm'):
            # trail breadcrumbs only on REAL map screens (Ph-F pass-2 find:
            # title/menu screens read power-on zeros and polluted the
            # overworld trail key with phantom tiles)
            key = (bool(read(ramspec.MAPFLAGS) & 1), read(ramspec.CUR_MAP))
            self.trail.setdefault(key, set()).add((x, y))
        state: dict = {
            'party': party,
            'gold': ramspec.rd24(read, ramspec.GOLD),
            'pos': {
                'x': x, 'y': y,
                'standardMap': bool(read(ramspec.MAPFLAGS) & 1),
                'mapId': read(ramspec.CUR_MAP),
                'vehicle': ramspec.VEHICLE_NAME.get(read(ramspec.VEHICLE), f'#{read(ramspec.VEHICLE)}'),
                'facing': ramspec.FACING_NAME.get(read(ramspec.FACING), '?'),
            },
            'battlestep': read(ramspec.BATTLESTEP),
            'battlecounter': read(ramspec.BATTLECOUNTER),
            'sramSavePresent': ramspec.sram_save_present(read),
        }
        if ramspec.in_battle(read):
            slots = ramspec.read_enemy_slots(read)
            state['battle'] = {
                'result': read(ramspec.BTL_RESULT),
                'enemies': [{
                    'slot': e.slot, 'id': e.enemy_id, 'name': self.enemy_name(e.enemy_id),
                    'hp': e.hp, 'alive': e.alive(), 'exp': e.exp, 'gp': e.gp,
                } for e in slots],
                'roster': [self.enemy_name(read(ramspec.BTL_ENEMYROSTER + i))
                           for i in range(4)
                           if read(ramspec.BTL_ENEMYROSTER + i) != 0xFF],
                'curChar': read(ramspec.BTLCMD_CURCHAR),
                'target': read(ramspec.BTLCMD_TARGET),
                'cursor': [read(ramspec.BTLCURS_X), read(ramspec.BTLCURS_Y)],
                'cmdBuf': [read(ramspec.BTL_CHARCMDBUF + i) for i in range(16)],
                'noRun': bool(read(ramspec.BTLFORM_NORUN) & 1),
                'surprise': read(ramspec.BTLFORM_SURPRISE),
                'battleType': read(ramspec.BTL_BATTLETYPE),
                'enemyCount': read(ramspec.BTL_ENEMYCOUNT),
            }
        out = cls.to_json()
        out['frameHash'] = emu.frame_hash()
        out['state'] = state
        return out

    # ------------------------------------------------------------- ops
    def op_boot(self, req: dict) -> dict:
        rom = req.get('rom', str(DEFAULT_ROM))
        if not Path(rom).exists():
            raise FileNotFoundError(f'ROM not found: {rom}')
        self.rng_jitter = bool(req.get('rngJitter', self.rng_jitter))
        depth = int(req.get('undoDepth', self.undo.depth))
        if depth < 1:
            # mirrors op_set_config's guard (Ph-F review find: UndoRing(0)
            # silently discarded every checkpoint — the whole §8.4 net gone)
            raise ValueError('undoDepth must be ≥ 1')
        self.emu = Emu(rom, rng_jitter=self.rng_jitter)
        self.undo = UndoRing(depth)
        if req.get('state'):
            self.emu.load(self.decode_state(req['state']))
            log(f'boot: ROM + savestate restored ({rom})')
        else:
            # advance through the power-on sequence to the first settled screen
            self.emu.step(30)
            try:
                self.emu.settle(budget=1200)
            except BudgetExceeded:
                log('boot: title sequence still animating after 1200f (expected — title has effects)')
            log(f'boot: fresh ROM ({rom})')
        return self.snapshot()

    def op_state(self, _req: dict) -> dict:
        return self.snapshot()

    def op_press(self, req: dict) -> dict:
        emu = self.need_emu()
        if emu.in_battle():
            # The overworld 8-frame hold profile AUTO-CONFIRMS battle menus at
            # their home slot (battle.py header; Ph-F pass-3 find) — a raw
            # press in battle would enter a WRONG command with no desync
            # raised, the exact failure verified entry exists to prevent.
            raise RuntimeError('press: raw presses are disabled in battle — '
                               'use battle_round (verified entry)')
        buttons = req.get('buttons', [])
        if not isinstance(buttons, list) or not buttons:
            raise ValueError('press: buttons must be a non-empty list')
        label = req.get('label') or f'before {"+".join(buttons)}'
        self.checkpoint(label)
        stopped = None
        for b in buttons:
            emu.press(b, hold=int(req.get('hold', macros.PRESS_HOLD)))
            if emu.in_battle():
                stopped = 'battle'
                break
        out = self.snapshot()
        if stopped:
            out['stopped'] = stopped
        return out

    def op_steps(self, req: dict) -> dict:
        emu = self.need_emu()
        direction = req['dir']
        count = int(req.get('count', 1))
        if count < 1:
            raise ValueError('steps: count must be ≥ 1')
        self.checkpoint(f'before Step {direction} ×{count}')
        outcome = emu.steps(direction, count)
        out = self.snapshot()
        out['stopped'] = outcome.stopped
        out['committed'] = outcome.committed
        if outcome.stopped == 'battle':
            self.checkpoint('battle start ' + self._formation_label())
        return out

    def _formation_label(self) -> str:
        emu = self.need_emu()
        if not emu.in_battle():
            return ''
        slots = ramspec.read_enemy_slots(emu.read)
        names: Dict[str, int] = {}
        for e in slots:
            if e.alive():
                names[self.enemy_name(e.enemy_id)] = names.get(self.enemy_name(e.enemy_id), 0) + 1
        return '(' + ' '.join(f'{n}×{c}' if c > 1 else n for n, c in names.items()) + ')'

    def op_save(self, _req: dict) -> dict:
        emu = self.need_emu()
        buf = emu.save()
        return {'state': base64.b64encode(buf.tobytes()).decode(), 'bytes': int(buf.nbytes)}

    def op_load(self, req: dict) -> dict:
        emu = self.need_emu()
        state = self.decode_state(req['state'])   # validate FIRST (pass-3 find:
        # a rejected retry used to push a junk checkpoint per attempt,
        # flushing real recovery entries out of the ring)
        self.checkpoint('before load')   # §8.4: state replacement is undoable
        emu.load(state)
        return self.snapshot()

    def op_sram(self, req: dict) -> dict:
        emu = self.need_emu()
        if req.get('set'):
            raw = base64.b64decode(req['set'])
            if len(raw) != ramspec.SRAM_SIZE:
                raise ValueError(f'sram set: expected {ramspec.SRAM_SIZE} bytes, got {len(raw)}')
            self.checkpoint('before .sav import')   # §8.4: undoable
            for i, b in enumerate(raw):
                emu.nes[ramspec.UNSRAM + i] = b
            # a .sav import is only coherent from power-on: reset (RAM persists
            # through cynes reset — verified .pyi) so the game re-reads it.
            emu.nes.reset()
            emu.step(30)
            log('sram: imported 8 KB + reset')
            return self.snapshot()
        data = bytes(emu.read(ramspec.UNSRAM + i) for i in range(ramspec.SRAM_SIZE))
        return {'sram': base64.b64encode(data).decode(),
                'savePresent': ramspec.sram_save_present(emu.read)}

    def op_frame(self, req: dict) -> dict:
        emu = self.need_emu()
        crop = req.get('crop', 'full')
        fmt = req.get('format', 'png')
        if crop in ('map-top', 'map-bottom'):
            # §7.2 two-tile map layout: 222 visible rows (9 px overscan trim
            # top+bottom — one MORE row than the PNG crops each side, because
            # the 222 px content pane + the even-BMP-height rule force a
            # 110+112 split; see server FF1_MAP_*_RECT).
            visible = emu.frame[9:231]
            img = visible[:110] if crop == 'map-top' else visible[110:]
        elif crop == 'formation':
            # Ph-E formation glance (default-off toggle): the battle tableau —
            # enemy pane + character strip at 1:1, sized for 'tile' mode
            # (200×100; picked off m_00_battle.png).
            img = emu.frame[24:124, 4:204]
        elif crop in ('top', 'bottom', 'full'):
            visible = emu.frame[VISIBLE_TOP:240 - VISIBLE_TOP]   # 224 rows
            img = {'top': visible[:112], 'bottom': visible[112:],
                   'full': visible}[crop]
        else:
            raise ValueError(f'frame: unknown crop {crop!r}')
        out = {'w': int(img.shape[1]), 'h': int(img.shape[0]),
               'frameHash': emu.frame_hash()}
        if fmt == 'gray4':
            # ITU-R 601 luma → 4-bit, one byte/pixel, prefixed u16-LE w,h —
            # exactly the server's encodeGray4Single payload contract
            # (os-content.ts; it applies the all-black guard + client caps).
            lum = (0.299 * img[:, :, 0] + 0.587 * img[:, :, 1]
                   + 0.114 * img[:, :, 2]).astype(np.uint8)
            g4 = (lum >> 4).astype(np.uint8)
            h, w = g4.shape
            payload = w.to_bytes(2, 'little') + h.to_bytes(2, 'little') + g4.tobytes()
            out['gray4'] = base64.b64encode(payload).decode()
        elif fmt == 'png':
            from PIL import Image
            buf = io.BytesIO()
            Image.fromarray(np.ascontiguousarray(img)).save(buf, format='PNG')
            out['png'] = base64.b64encode(buf.getvalue()).decode()
        else:
            raise ValueError(f'frame: unknown format {fmt!r}')
        return out

    def op_battle_round(self, req: dict) -> dict:
        """One battle round: verified command entry + resolution (§7.1).
        commands: [{char, action: fight|magic|run, target?, level?, slot?}]."""
        emu = self.need_emu()
        if not emu.in_battle():
            raise RuntimeError('battle_round: not in a battle')
        cmds = [battlemod.CharCommand(
            char=int(c['char']), action=str(c['action']),
            target=(int(c['target']) if c.get('target') is not None else None),
            level=int(c.get('level', 0)), slot=int(c.get('slot', 0)))
            for c in req.get('commands', [])]
        if not cmds:
            raise ValueError('battle_round: commands must be non-empty')
        self.checkpoint('battle round ' + self._formation_label())
        ex = battlemod.BattleExecutor(emu, self.spells)
        ex.enter_round(cmds)
        rr = ex.run_resolution()
        out = self.snapshot()
        out['battleRound'] = {'log': rr.log, 'result': rr.result,
                              'outcome': rr.outcome, 'frames': rr.frames}
        return out

    # ------------------------------------------------------------- Ph-E macros
    def op_name_entry(self, req: dict) -> dict:
        """Ring-driven name entry (PLAN §7.4): from an OPEN letter grid,
        enter req['name'] (1-4 chars; shorter names space-pad via the grid's
        blank cell). Auto-checkpoints first — a mis-tap is one Undo away."""
        emu = self.need_emu()
        name = str(req['name'])
        self.checkpoint(f'before naming "{name}"')
        entered = macros.name_entry(emu, name)
        out = self.snapshot()
        out['entered'] = entered
        return out

    def op_pace(self, req: dict) -> dict:
        """The Battle pace macro (PLAN §8.2): alternate steps until an
        encounter. Auto-checkpoints; reports battlestep so a non-ticking
        pacing spot is visible, never a mystery."""
        emu = self.need_emu()
        self.checkpoint('before Pace')
        po = macros.pace(emu, int(req.get('maxPaces', 200)))
        if po.stopped == 'battle':
            self.checkpoint('battle start ' + self._formation_label())
        out = self.snapshot()
        out['pace'] = {'paces': po.paces, 'stopped': po.stopped,
                       'battlestep0': po.battlestep0, 'battlestep1': po.battlestep1}
        return out

    def op_battle_auto(self, req: dict) -> dict:
        """The fight-until grind loop (PLAN §8.2): repeat `commands` each
        round; stop on battle end / any-ally-HP-below-% / charges out /
        round cap. Auto-checkpoints the pre-loop state."""
        emu = self.need_emu()
        if not emu.in_battle():
            raise RuntimeError('battle_auto: not in a battle')
        cmds = [battlemod.CharCommand(
            char=int(c['char']), action=str(c['action']),
            target=(int(c['target']) if c.get('target') is not None else None),
            level=int(c.get('level', 0)), slot=int(c.get('slot', 0)))
            for c in req.get('commands', [])]
        if not cmds:
            raise ValueError('battle_auto: commands must be non-empty')
        self.checkpoint('battle auto ' + self._formation_label())
        ex = battlemod.BattleExecutor(emu, self.spells)
        result = ex.fight_until(cmds, min_hp_pct=int(req.get('minHpPct', 0)),
                                max_rounds=int(req.get('maxRounds', 30)))
        out = self.snapshot()
        out['battleAuto'] = result
        return out

    def op_rename(self, req: dict) -> dict:
        """Cosmetic name edit on a COMMITTED party member (PLAN §7.4 note):
        the vanilla-US grid types exactly 4 glyphs (its END key was removed;
        live-probed), so 3-letter names like NOX/ZOT are unreachable by
        input. This writes ch_name directly — 1-4 grid glyphs, $FF-padded,
        the byte the game itself renders blank everywhere. Cosmetic ONLY
        (names have zero gameplay effect); auto-checkpoints first."""
        emu = self.need_emu()
        slot = int(req['slot'])
        name = str(req['name'])
        if not (0 <= slot <= 3):
            raise ValueError(f'rename: slot {slot} out of 0..3')
        if not (1 <= len(name) <= 4):
            raise ValueError(f'rename: {name!r} must be 1-4 characters')
        byts = []
        for ch in name:
            b = self.char_encode.get(ch)
            if b is None or ch == ' ':
                raise ValueError(f'rename: {ch!r} is not a name glyph')
            byts.append(b)
        while len(byts) < 4:
            byts.append(0xFF)   # charmap pad-space — renders blank in-game
        cur = self.decode_name([emu.read(ramspec.CH_STATS + slot * ramspec.CH_STRIDE
                                         + ramspec.CH_NAME + i) for i in range(4)])
        self.checkpoint(f'before renaming {cur or f"slot {slot}"} → "{name}"')
        for i, b in enumerate(byts):
            emu.nes[ramspec.CH_STATS + slot * ramspec.CH_STRIDE + ramspec.CH_NAME + i] = b
        log(f'rename: slot {slot} "{cur}" → "{name}"')
        return self.snapshot()

    def op_sav_export(self, req: dict) -> dict:
        """.sav export (PLAN §9): dump $6000-$7FFF to games/ff1/saves/.
        Only coherent with an in-game save present and no battle in
        progress — refused LOUDLY otherwise."""
        emu = self.need_emu()
        if not ramspec.sram_save_present(emu.read):
            raise RuntimeError('sav export refused: no in-game save in SRAM — '
                               'sleep at an inn (or save at title) first')
        if emu.in_battle():
            raise RuntimeError('sav export refused: battle in progress')
        data = bytes(emu.read(ramspec.UNSRAM + i) for i in range(ramspec.SRAM_SIZE))
        saves = FF1_DIR / 'saves'
        saves.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
        path = saves / f'ff1-{stamp}.sav'
        path.write_bytes(data)
        log(f'sav export: {path} ({len(data)} B)')
        return {'path': str(path), 'bytes': len(data)}

    def op_minimap(self, req: dict) -> dict:
        """Trail minimap data (PLAN §7 dungeon minimap, v1 = breadcrumbs):
        the visited tiles of the CURRENT map + the player position. The
        server renders the small tile; re-push on growth is its job."""
        emu = self.need_emu()
        read = emu.read
        key = (bool(read(ramspec.MAPFLAGS) & 1), read(ramspec.CUR_MAP))
        x, y = ramspec.player_tile(read)
        tiles = sorted(self.trail.get(key, set()))
        return {'standardMap': key[0], 'mapId': key[1], 'player': [x, y],
                'tiles': [[tx, ty] for tx, ty in tiles]}

    def op_undo_list(self, _req: dict) -> dict:
        return {'checkpoints': self.undo.listing()}

    def op_undo_state(self, req: dict) -> dict:
        """Read a checkpoint's savestate WITHOUT loading it — the §8.4 PG
        undo-tail mirror (server engine.capturePersist) fetches the last few
        labeled states this way on the autosave cadence."""
        entry = self.undo.get(int(req['index']))
        return {'label': entry['label'], 'at': entry['at'],
                'state': base64.b64encode(entry['state'].tobytes()).decode()}

    def op_undo_seed(self, req: dict) -> dict:
        """Rehydrate the undo ring from the PG tail after a boot (§8.4 "a
        crash preserves undo depth" — Ph-F review find: the mirror was
        write-only). entries arrive NEWEST-FIRST (the mirror's order)."""
        entries = req.get('entries', [])
        if self.undo.entries:
            raise RuntimeError('undo_seed: ring is not empty — seed only right after boot')
        for e in entries:
            state = self.decode_state(e['state'])
            self.undo.entries.append({'label': str(e['label']), 'at': str(e['at']),
                                      'state': state})
        while len(self.undo.entries) > self.undo.depth:
            self.undo.entries.pop()
        log(f'undo_seed: ring rehydrated with {len(self.undo.entries)} checkpoint(s)')
        return {'checkpoints': self.undo.listing()}

    def op_undo(self, req: dict) -> dict:
        emu = self.need_emu()
        entry = self.undo.get(int(req['index']))   # resolve BEFORE the push below shifts indices
        # §8.4 "nothing is unrecoverable" cuts BOTH ways (Ph-F review find):
        # the CURRENT state (e.g. a just-won battle) gets its own checkpoint
        # before the rewind, so an undo can itself be undone.
        self.checkpoint(f'before undo → "{entry["label"]}"')
        emu.load(entry['state'])
        try:
            emu.settle()
        except BudgetExceeded:
            log('undo: restored state not static (mid-animation checkpoint) — proceeding')
        log(f'undo: restored "{entry["label"]}" ({entry["at"]})')
        out = self.snapshot()
        out['restored'] = entry['label']
        return out

    def op_checkpoint(self, req: dict) -> dict:
        self.checkpoint(str(req.get('label', 'manual checkpoint')))
        return {'checkpoints': self.undo.listing()}

    def op_set_config(self, req: dict) -> dict:
        if 'rngJitter' in req:
            self.rng_jitter = bool(req['rngJitter'])
            if self.emu:
                self.emu.rng_jitter = self.rng_jitter
        if 'undoDepth' in req:
            depth = int(req['undoDepth'])
            if depth < 1:
                raise ValueError('undoDepth must be ≥ 1')
            self.undo.depth = depth
            while len(self.undo.entries) > depth:
                self.undo.entries.pop()
        return {'rngJitter': self.rng_jitter, 'undoDepth': self.undo.depth}

    def op_scrape(self, req: dict) -> dict:
        """Scrape an arbitrary region (harness/diagnostics + engine text views)."""
        emu = self.need_emu()
        r0, r1 = int(req.get('row0', 0)), int(req.get('row1', 30))
        c0, c1 = int(req.get('col0', 0)), int(req.get('col1', 32))
        res = scrape.scrape_region(emu.patterns(), emu.glyphs, r0, r1, c0, c1)
        return {'lines': res.lines, 'unknownTiles': res.unknown}

    def op_peek(self, req: dict) -> dict:
        """Read-only RAM peek (harness/acceptance verification — e.g. the
        party-select ptygen fields no snapshot carries). Never writes,
        never advances a frame."""
        emu = self.need_emu()
        addr = int(req['addr'])
        n = int(req.get('n', 1))
        ok_range = ((0x0000 <= addr and addr + n <= 0x0800)
                    or (0x6000 <= addr and addr + n <= 0x8000))
        if not (1 <= n <= 256 and ok_range):
            # RAM/battery only — PPU/APU registers have READ side effects in
            # the live core (cynes .pyi warns; the op contract says none)
            raise ValueError(f'peek: addr {addr:#x} n {n} outside side-effect-free '
                             'ranges ($0000-$07FF, $6000-$7FFF)')
        return {'bytes': [emu.read(addr + i) for i in range(n)]}

    def op_ping(self, _req: dict) -> dict:
        return {'pong': True, 'booted': self.emu is not None}

    # ------------------------------------------------------------- loop
    def handle(self, req: dict) -> dict:
        op = req.get('op')
        fn = getattr(self, f'op_{op}', None)
        if fn is None:
            raise ValueError(f'unknown op {op!r}')
        return fn(req)

    def run(self) -> None:
        log(f'ready (rom default: {DEFAULT_ROM.name}, undo depth {self.undo.depth})')
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            seq = None
            try:
                req = json.loads(line)
                seq = req.get('seq')
                if req.get('op') == 'shutdown':
                    print(json.dumps({'seq': seq, 'ok': True, 'bye': True}), flush=True)
                    log('shutdown requested')
                    return
                resp = self.handle(req)
                resp['seq'] = seq
                resp.setdefault('ok', True)
                print(json.dumps(resp), flush=True)
            except Exception as e:   # noqa: BLE001 — protocol boundary: EVERY failure
                # becomes a loud error response (+ stderr trace); never a swallow.
                err = {'seq': seq, 'error': f'{type(e).__name__}: {e}',
                       'traceback': traceback.format_exc()}
                print(json.dumps(err), flush=True)
                log(f'op failed: {err["error"]}')


if __name__ == '__main__':
    Daemon().run()
