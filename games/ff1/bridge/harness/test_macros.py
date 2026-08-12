#!/usr/bin/env python
"""Ph-E harness: name-entry / pace / fight-until / .sav export / minimap trail
(PLAN §7.4, §8.2, §9). Deterministic: rng_jitter=False.

Fixture sources: committed fixtures for battle/town; the on-disk spike
checkpoints (bridge/spike_out/, same box) for the overworld + party-select
states, exactly as test_daemon already does.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

BRIDGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BRIDGE))

import battle as battlemod  # noqa: E402
import macros  # noqa: E402
import ramspec  # noqa: E402
import screens  # noqa: E402
from battle import BattleExecutor, CharCommand  # noqa: E402
from macros import Emu  # noqa: E402

FF1 = BRIDGE.parent
ROM = str(FF1 / 'rom' / 'Final Fantasy.nes')
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
SPIKE = BRIDGE / 'spike_out'
SPELLS = json.loads((FF1 / 'data' / 'spells.json').read_text())['spells']

PASS = 0


def check(name: str, cond: bool, detail: str = '') -> None:
    global PASS
    if not cond:
        raise AssertionError(f'FAIL {name}: {detail}')
    PASS += 1
    print(f'  ok {name}')


def load(emu: Emu, path: Path) -> None:
    emu.load(np.load(path))
    emu.settle(budget=900, allow_animated=True)


def classify(emu: Emu):
    return screens.classify(emu.read, emu.frame, emu.patterns(), emu.glyphs,
                            emu.uniform_frame())


def main() -> None:
    emu = Emu(ROM, rng_jitter=False)

    # --- name entry: 'ROUX' (mixed rows/cols, the acceptance lead) on slot 1 ---
    load(emu, SPIKE / 'ckpt_partysel.npy')
    check('party-select fixture classifies', classify(emu).screen == 'partyselect',
          classify(emu).screen)
    emu.press_verified('A', lambda: classify(emu).screen == 'nameentry',
                       'open slot-1 name grid')
    entered = macros.name_entry(emu, 'ROUX')
    check('name_entry returns the name', entered == 'ROUX')
    check('grid closed after the 4th glyph (back at party select)',
          classify(emu).screen == 'partyselect', classify(emu).screen)
    nm = [emu.read(ramspec.PTYGEN_NAME + i) for i in range(4)]   # slot 0 (absolute addr)
    # charmap: 'R'=$9B 'O'=$98 'U'=$9E 'X'=$A1 (data/charmap.json)
    check('ptygen_name holds ROUX', nm == [0x9B, 0x98, 0x9E, 0xA1],
          ' '.join(f'{b:02x}' for b in nm))
    # short names are a documented vanilla impossibility → LOUD refusal
    try:
        macros.name_entry(emu, 'NOX')
        raise AssertionError('FAIL: 3-glyph name_entry did not raise')
    except ValueError as e:
        check('3-glyph name refused LOUD (rename is the path)', 'exactly 4' in str(e), str(e))

    # --- pace: town streets never tick (battlestep frozen, honest report) ---
    # ('blocked' is a legitimate outcome here — Coneria NPCs wander into the
    # pacing lane; the macro stops LOUD instead of re-routing.)
    load(emu, FIXTURES / 'town_after_shop.npy')
    po = macros.pace(emu, max_paces=6)
    check('town pace ends without an encounter (cap or NPC block)',
          po.stopped in ('no-encounter', 'blocked') and po.paces >= 1,
          f'{po.stopped} {po.paces}')
    check('town pace battlestep frozen (non-ticking tiles VISIBLE)',
          po.battlestep0 == po.battlestep1, f'{po.battlestep0}->{po.battlestep1}')

    # --- pace: the overworld ticking tile fires a real encounter ---
    load(emu, SPIKE / 'ckpt_overworld.npy')
    out = emu.steps('down', 5)   # (153,165) → (153,170), the first ticking tile
    check('walked to the ticking tile', out.stopped in ('done', 'battle'), out.stopped)
    if out.stopped != 'battle':
        po = macros.pace(emu, max_paces=80)
        check('overworld pace found a battle', po.stopped == 'battle',
              f'{po.stopped} after {po.paces} paces (step {po.battlestep0}->{po.battlestep1})')
        check('pace battlestep ticked', po.battlestep1 != po.battlestep0)
        print(f'    encounter after {po.paces} paces')
    check('in battle now', emu.in_battle())

    # --- fight-until: guard stop first, then grind the 5-IMP fixture to a WIN ---
    load(emu, FIXTURES / 'battle_start.npy')
    ex = BattleExecutor(emu, SPELLS)
    fights = [CharCommand(char=i, action='fight', target=i) for i in range(4)]
    r = ex.fight_until(fights, min_hp_pct=100, max_rounds=5)
    check('fight_until hp guard stops on the first scratch (party starts full)',
          r['outcome'] == 'continue' and 'hp' in r['stopped'] and r['rounds'] < 5,
          f"{r['stopped']} after {r['rounds']} rounds")
    r = ex.fight_until(fights, min_hp_pct=0, max_rounds=15)
    check('fight_until grinds to the WIN', r['outcome'] == 'won', str(r))
    check('fight_until accumulated the full log', len(r['log']) >= 8, str(len(r['log'])))
    check('battle over, back on a map', not emu.in_battle())

    # --- minimap trail: the pace walk left breadcrumbs on the overworld ---
    # (trail tracking lives in the daemon snapshot; at the macros layer we
    # just prove the primitives it needs read sane values here)
    x, y = ramspec.player_tile(emu.read)
    check('post-battle position readable', 0 <= x < 256 and 0 <= y < 256, f'{x},{y}')

    # --- .sav export gate (daemon-level): refusal without an SRAM save ---
    import base64
    import subprocess
    PY = FF1 / 'venv' / 'bin' / 'python'
    proc = subprocess.Popen(
        [str(PY), '-u', str(BRIDGE / 'ff1_daemon.py')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        cwd=str(FF1), text=True, bufsize=1)

    def call(op, **kw):
        proc.stdin.write(json.dumps({'op': op, 'seq': 1, **kw}) + '\n')
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError(f'daemon died (op={op})')
        return json.loads(line)

    state_b64 = base64.b64encode(np.load(FIXTURES / 'town_after_shop.npy').tobytes()).decode()
    r = call('boot', state=state_b64, rngJitter=False)
    check('daemon boots the town state', r['screen'] == 'sm', r.get('screen'))
    r = call('sav_export')
    check('sav export REFUSED without an inn save (loud)',
          'error' in r and 'no in-game save' in r['error'], str(r)[:120])
    # poke the SRAM assert bytes → the gate opens (the export itself is a raw
    # dump; the REAL inn-save export runs in the Ph-F acceptance)
    r = call('minimap')
    check('minimap op returns the current tile in its trail',
          r['player'] in r['tiles'], str(r)[:120])
    r = call('rename', slot=0, name='NOX')
    check('rename slot 0 → NOX ($FF-padded, cosmetic)',
          r.get('ok') is True and r['state']['party'][0]['name'] == 'NOX', str(r)[:160])
    r = call('rename', slot=1, name='A B')
    check('rename refuses a space glyph LOUD', 'error' in r, str(r)[:120])
    r = call('name_entry', name='XYZW')   # wrong screen → the macro must fail LOUD
    check('name_entry off the grid fails LOUD', 'error' in r, str(r)[:120])
    r = call('pace', maxPaces=4)
    check('daemon pace op runs (town: cap or NPC block, battlestep frozen)',
          r.get('pace', {}).get('stopped') in ('no-encounter', 'blocked')
          and r['pace']['battlestep0'] == r['pace']['battlestep1'], str(r.get('pace')))
    r = call('undo_list')
    check('pace auto-checkpointed', any('Pace' in c['label'] for c in r['checkpoints']),
          str(r['checkpoints'][:3]))
    call('shutdown')
    proc.wait()

    print(f'test_macros: ALL OK ({PASS} checks)')


if __name__ == '__main__':
    main()
