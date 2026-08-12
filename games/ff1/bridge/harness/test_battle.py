#!/usr/bin/env python
"""Ph-B harness: the battle vertical slice against battle_start.npy (5 IMPs,
journey party, RM knows CURE with 1 charge).

Covers the P2 exit criteria: a scripted battle plays end-to-end with a
byte-exact command buffer and a stable message log — WON and FLED variants —
plus the CURE (one-ally magic) entry path, the desync drill (a fully-dropped
press must halt LOUD with state intact and the pre-round savestate must
recover), and the exp byte-order resolution (PLAN §6.3). Deterministic:
rng_jitter=False."""
from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

BRIDGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BRIDGE))

import battle  # noqa: E402
import ramspec  # noqa: E402
import screens  # noqa: E402
from battle import BattleDesync, BattleExecutor, CharCommand  # noqa: E402
from macros import Emu  # noqa: E402

FF1 = BRIDGE.parent
ROM = str(FF1 / 'rom' / 'Final Fantasy.nes')
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
SPELLS = json.loads((FF1 / 'data' / 'spells.json').read_text())['spells']

PASS = 0


def check(name: str, cond: bool, detail: str = '') -> None:
    global PASS
    if not cond:
        raise AssertionError(f'FAIL {name}: {detail}')
    PASS += 1
    print(f'  ok {name}')


def fresh_battle(emu: Emu) -> BattleExecutor:
    emu.load(np.load(FIXTURES / 'battle_start.npy'))
    emu.settle(budget=900)
    return BattleExecutor(emu, SPELLS)


def fights(targets) -> list:
    return [CharCommand(char=i, action='fight', target=t) for i, t in enumerate(targets)]


def alive_enemies(emu: Emu):
    return [e for e in ramspec.read_enemy_slots(emu.read) if e.alive()]


def main() -> None:
    emu = Emu(ROM, rng_jitter=False)

    # --- round 1: FIGHT ×4, spread targets, byte-exact buffer ---
    ex = fresh_battle(emu)
    hp0 = sum(e.hp for e in alive_enemies(emu))
    rows = ex.enter_round(fights([0, 1, 2, 3]))
    check('cmdbuf byte-exact (4 × fight)',
          rows == [(0x04, 0x10, 0, 0), (0x04, 0x10, 1, 0),
                   (0x04, 0x10, 2, 0), (0x04, 0x10, 3, 0)],
          str(rows))
    rr = ex.run_resolution()
    check('round 1 continues (5 IMPs survive round 1)', rr.outcome == 'continue', rr.outcome)
    check('round 1 log has messages', len(rr.log) >= 4, str(rr.log))
    check('round 1 log names attacker + damage',
          any('AAAA' in m for m in rr.log) and any('DMG' in m for m in rr.log), str(rr.log))
    hp1 = sum(e.hp for e in alive_enemies(emu))
    check('enemy HP dropped', hp1 < hp0, f'{hp0} -> {hp1}')

    # --- fight until WON (deterministic; finish lowest-HP enemies first) ---
    gold_before = ramspec.rd24(emu.read, ramspec.GOLD)
    exp_before = [ramspec.read_char(emu.read, i, lambda b: '').exp for i in range(4)]
    check('fresh party exp is 0', all(x == 0 for x in exp_before), str(exp_before))
    outcome = 'continue'
    for rnd in range(15):
        if outcome != 'continue':
            break
        targets = sorted(alive_enemies(emu), key=lambda e: e.hp)
        living = ex.living_slots()
        cmds = [CharCommand(char=ch, action='fight',
                            target=targets[min(i, len(targets) - 1)].slot)
                for i, ch in enumerate(living)]
        ex.enter_round(cmds)
        outcome = ex.run_resolution().outcome
    check('battle WON', outcome == 'won', outcome)
    check('battle screen exited after outro', not emu.in_battle())
    cls = screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs,
                           emu.uniform_frame())
    check('back on the overworld', cls.screen == 'ow', cls.screen)

    # --- rewards + exp byte order (PLAN §6.3 open item) ---
    gold_after = ramspec.rd24(emu.read, ramspec.GOLD)
    check('gold reward +30 (5 IMPs × 6 GP)', gold_after == gold_before + 30,
          f'{gold_before} -> {gold_after}')
    survivors = [i for i in range(4)
                 if ramspec.read_char(emu.read, i, lambda b: '').alive()]
    exp_bytes = {}
    for i in survivors:
        base = ramspec.CH_STATS + i * ramspec.CH_STRIDE + ramspec.CH_EXP
        exp_bytes[i] = [emu.read(base + k) for k in range(3)]
    check('exp gained (5 IMPs × 6 = 30 split)', all(b[0] > 0 for b in exp_bytes.values()),
          str(exp_bytes))
    check('exp byte order LITTLE-ENDIAN (value < 256 lives in byte 0)',
          all(b[0] < 256 and b[1] == 0 and b[2] == 0 for b in exp_bytes.values()),
          str(exp_bytes))
    print(f'    exp bytes per survivor: {exp_bytes} (LE confirmed)')

    # --- CURE round: chars 0-2 fight, RM casts CURE on ally 2 ---
    ex = fresh_battle(emu)
    rm_mp = ramspec.CH_MAGIC + 3 * ramspec.CH_STRIDE + ramspec.CH_CURMP
    check('fixture RM has 1 CURE charge', emu.read(rm_mp) == 1, str(emu.read(rm_mp)))
    cmds = fights([0, 1, 2])[:3] + [CharCommand(char=3, action='magic',
                                                level=1, slot=0, target=2)]
    rows = ex.enter_round(cmds)
    check('magic cmdbuf byte-exact (40 00 82 00 = CURE ally slot 2)',
          rows[3] == (0x40, 0x00, 0x82, 0x00), str(rows[3]))
    rr = ex.run_resolution()
    check('CURE round completed', rr.outcome in ('continue', 'won'), rr.outcome)
    check('CURE spent the charge ($6320 side)', emu.read(rm_mp) == 0, str(emu.read(rm_mp)))
    check('CURE round log mentions CURE', any('CURE' in m for m in rr.log), str(rr.log))

    # --- FLED variant: everyone runs until the party escapes ---
    ex = fresh_battle(emu)
    pre_pos = None
    outcome = 'continue'
    for rnd in range(10):
        if outcome != 'continue':
            break
        living = ex.living_slots()
        rows = ex.enter_round([CharCommand(char=ch, action='run') for ch in living])
        check_run = all(r[0] == 0x20 for r in rows)
        if rnd == 0:
            check('run cmdbuf cmd byte 0x20', check_run, str(rows))
        outcome = ex.run_resolution().outcome
    check('battle FLED', outcome == 'ran', outcome)
    check('battle screen exited after flee', not emu.in_battle())
    cls = screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs,
                           emu.uniform_frame())
    check('back on the overworld after flee', cls.screen == 'ow', cls.screen)

    # --- desync drill: a fully-dropped press halts LOUD, undo recovers ---
    ex = fresh_battle(emu)
    pre_round = emu.save()
    pre_buf = ex.cmdbuf(0)
    ex.drop_presses.add('char 0 fight confirm')
    try:
        ex.enter_round(fights([0, 1, 2, 3]))
        raise AssertionError('FAIL desync drill: dropped press did not raise')
    except BattleDesync as e:
        check('dropped press raises BattleDesync', 'char 0 fight confirm' in str(e), str(e))
    check('char 0 cmdbuf untouched by the failed entry', ex.cmdbuf(0) == pre_buf,
          str(ex.cmdbuf(0)))
    emu.load(pre_round)
    emu.settle(budget=900)
    ex.drop_presses.clear()
    check('pre-round savestate recovers to the command menu',
          ex.at_command_menu(0), f'curchar={ex.curchar()} curs={ex.curs()}')
    rows = ex.enter_round(fights([0, 1, 2, 3]))
    check('recovery round enters cleanly', rows[0] == (0x04, 0x10, 0, 0), str(rows))

    # --- daemon integration: one round through the real stdio protocol ---
    PY = FF1 / 'venv' / 'bin' / 'python'
    proc = subprocess.Popen(
        [str(PY), '-u', str(BRIDGE / 'ff1_daemon.py')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        cwd=str(FF1), text=True, bufsize=1)

    def call(op, **kw):
        req = {'op': op, 'seq': 1, **kw}
        proc.stdin.write(json.dumps(req) + '\n')
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError(f'daemon died (op={op})')
        return json.loads(line)

    state_b64 = base64.b64encode(np.load(FIXTURES / 'battle_start.npy').tobytes()).decode()
    r = call('boot', state=state_b64, rngJitter=False)
    check('daemon boots into the battle', r['screen'] == 'battle', r.get('screen'))
    r = call('battle_round', commands=[
        {'char': 0, 'action': 'fight', 'target': 0},
        {'char': 1, 'action': 'fight', 'target': 1},
        {'char': 2, 'action': 'fight', 'target': 2},
        {'char': 3, 'action': 'fight', 'target': 3}])
    check('daemon battle_round ok', r.get('ok') is True and 'battleRound' in r, str(r)[:200])
    check('daemon round log + outcome', r['battleRound']['outcome'] == 'continue'
          and len(r['battleRound']['log']) >= 4, str(r.get('battleRound'))[:200])
    r = call('undo_list')
    check('battle round auto-checkpointed',
          any('battle round' in c['label'] for c in r['checkpoints']), str(r['checkpoints'][:3]))
    idx = next(c['index'] for c in r['checkpoints'] if 'battle round' in c['label'])
    r = call('undo', index=idx)
    check('undo restores the pre-round battle',
          r['screen'] == 'battle'
          and sum(1 for e in r['state']['battle']['enemies'] if e['alive']) == 5,
          str(r.get('screen')))
    call('shutdown')
    proc.wait()

    print(f'test_battle: ALL OK ({PASS} checks)')


if __name__ == '__main__':
    main()
