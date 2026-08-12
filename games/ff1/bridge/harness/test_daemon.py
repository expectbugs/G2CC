#!/usr/bin/env python
"""Ph-A harness: the daemon protocol end-to-end over real stdio — boot,
snapshot, press, position-verified steps, save/load, undo ring, SRAM dump,
kill -9 → respawn → savestate restore (PLAN P1 exit: daemon survives
kill→respawn→restore)."""
from __future__ import annotations

import base64
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import numpy as np

BRIDGE = Path(__file__).resolve().parent.parent
FF1 = BRIDGE.parent
PY = FF1 / 'venv' / 'bin' / 'python'
OUT = BRIDGE / 'spike_out'

PASS = 0


def check(name: str, cond: bool, detail: str = '') -> None:
    global PASS
    if not cond:
        raise AssertionError(f'FAIL {name}: {detail}')
    PASS += 1
    print(f'  ok {name}')


class Client:
    """Minimal line client (the TS Ff1Bridge shape: one inflight, seq-tagged)."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [str(PY), '-u', str(BRIDGE / 'ff1_daemon.py')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=str(FF1), text=True, bufsize=1,
        )
        self.seq = 0

    def call(self, op: str, **kw) -> dict:
        self.seq += 1
        req = {'op': op, 'seq': self.seq, **kw}
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(req) + '\n')
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f'daemon died mid-call (op={op})')
        resp = json.loads(line)
        if resp.get('seq') != self.seq:
            raise RuntimeError(f'seq mismatch: sent {self.seq} got {resp.get("seq")}')
        return resp

    def kill9(self) -> None:
        os.kill(self.proc.pid, signal.SIGKILL)
        self.proc.wait()


def b64_of_ckpt(name: str) -> str:
    return base64.b64encode(np.load(OUT / name).tobytes()).decode()


def main() -> None:
    c = Client()

    r = c.call('ping')
    check('ping', r.get('pong') is True and r.get('booted') is False)

    # boot straight into the overworld checkpoint (deterministic tests: jitter off)
    r = c.call('boot', state=b64_of_ckpt('ckpt_overworld.npy'), rngJitter=False)
    check('boot restores overworld', r['screen'] == 'ow', r.get('screen'))
    check('party AAAA', r['state']['party'][0]['name'] == 'AAAA', r['state']['party'][0])
    check('gold 400 LE', r['state']['gold'] == 400, r['state']['gold'])
    check('walking', r['state']['pos']['vehicle'] == 'walk')
    pos0 = (r['state']['pos']['x'], r['state']['pos']['y'])

    # unknown op → loud error, daemon alive
    r = c.call('definitely_not_an_op')
    check('unknown op errors loudly', 'error' in r, r)
    r = c.call('ping')
    check('daemon alive after error', r.get('pong') is True)

    # position-verified step (up on the overworld from the spike spot is walkable)
    r = c.call('steps', dir='up', count=1)
    check('step committed', r['committed'] == 1 and r['stopped'] in ('done', 'battle'), r)
    if r['stopped'] == 'done':
        pos1 = (r['state']['pos']['x'], r['state']['pos']['y'])
        check('position changed', pos1 != pos0, f'{pos0} -> {pos1}')

    # undo ring: the step auto-checkpointed; undo(0) must restore pos0
    r = c.call('undo_list')
    check('undo list has entries', len(r['checkpoints']) >= 1, r)
    check('undo label meaningful', 'Step up' in r['checkpoints'][0]['label']
          or 'battle start' in r['checkpoints'][0]['label'], r['checkpoints'][0])
    idx = next(e['index'] for e in r['checkpoints'] if 'Step up' in e['label'])
    r = c.call('undo', index=idx)
    check('undo restores position', (r['state']['pos']['x'], r['state']['pos']['y']) == pos0,
          r['state']['pos'])

    # save/load roundtrip through the protocol
    r = c.call('save')
    check('savestate size sane', 20000 < r['bytes'] < 30000, r['bytes'])
    state_b64 = r['state']
    r = c.call('steps', dir='up', count=1)
    r = c.call('load', state=state_b64)
    check('load restores', (r['state']['pos']['x'], r['state']['pos']['y']) == pos0)

    # sram dump: 8 KB, no in-game save yet on this fresh file
    r = c.call('sram')
    check('sram 8KB', len(base64.b64decode(r['sram'])) == 8192)
    check('no inn save yet', r['savePresent'] is False, r)

    # frame op: PNG halves (diagnostics) + the Ph-D gray4 map crops
    r = c.call('frame', crop='top')
    check('frame top 256x112', r['w'] == 256 and r['h'] == 112)
    png = base64.b64decode(r['png'])
    check('png magic', png[:8] == b'\x89PNG\r\n\x1a\n')
    r = c.call('frame', crop='map-top', format='gray4')
    raw = base64.b64decode(r['gray4'])
    check('gray4 map-top 256x110 payload',
          r['w'] == 256 and r['h'] == 110 and len(raw) == 4 + 256 * 110
          and int.from_bytes(raw[0:2], 'little') == 256
          and int.from_bytes(raw[2:4], 'little') == 110)
    check('gray4 pixels are nibbles', max(raw[4:]) <= 15)
    r = c.call('frame', crop='map-bottom', format='gray4')
    check('gray4 map-bottom 256x112', r['w'] == 256 and r['h'] == 112
          and len(base64.b64decode(r['gray4'])) == 4 + 256 * 112)

    # battle checkpoint label from the battle ckpt
    r = c.call('boot', state=b64_of_ckpt('ckpt_battle.npy'), rngJitter=False)
    check('battle screen', r['screen'] == 'battle', r.get('screen'))
    check('5 IMPs alive', sum(1 for e in r['state']['battle']['enemies'] if e['alive']) == 5,
          r['state']['battle']['enemies'])
    check('IMP named', r['state']['battle']['enemies'][0]['name'] == 'IMP')
    check('roster IMP', r['state']['battle']['roster'] == ['IMP'], r['state']['battle']['roster'])

    # --- kill -9 → fresh spawn → restore (the P1 exit criterion) ---
    r = c.call('save')
    saved = r['state']
    c.kill9()
    c2 = Client()
    r = c2.call('boot', state=saved, rngJitter=False)
    check('post-kill restore: battle intact', r['screen'] == 'battle'
          and sum(1 for e in r['state']['battle']['enemies'] if e['alive']) == 5, r.get('screen'))
    r = c2.call('shutdown')
    check('clean shutdown', r.get('bye') is True)
    c2.proc.wait()

    print(f'test_daemon: ALL OK ({PASS} checks)')


if __name__ == '__main__':
    main()
