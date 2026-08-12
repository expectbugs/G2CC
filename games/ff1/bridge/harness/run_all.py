#!/usr/bin/env python
"""FF1 bridge harness runner — executes every test_*.py in this directory
(fresh subprocess each, LOUD failures) plus the two generators' self-checking
runs. Exit nonzero on any failure. Run from games/ff1:
  ./venv/bin/python bridge/harness/run_all.py
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

HARNESS = Path(__file__).resolve().parent
FF1 = HARNESS.parent.parent
PY = FF1 / 'venv' / 'bin' / 'python'

# generators re-run first: they self-verify their anchors (calibration round
# trips + data anchors) and keep data/*.json in sync with the code.
STAGES = [
    ('calibrate_glyphs', [str(PY), str(HARNESS.parent / 'calibrate_glyphs.py')]),
    ('gen_data', [str(PY), str(HARNESS.parent / 'gen_data.py')]),
]
STAGES += [(p.stem, [str(PY), str(p)]) for p in sorted(HARNESS.glob('test_*.py'))]


def main() -> int:
    failures = 0
    for name, cmd in STAGES:
        t0 = time.time()
        r = subprocess.run(cmd, cwd=str(FF1), capture_output=True, text=True)
        dt = time.time() - t0
        if r.returncode == 0:
            tail = (r.stdout.strip().splitlines() or ['(no output)'])[-1]
            print(f'✓ {name:28s} {dt:5.1f}s  {tail}')
        else:
            failures += 1
            print(f'✗ {name:28s} {dt:5.1f}s  EXIT {r.returncode}')
            print('--- stdout ---')
            print(r.stdout)
            print('--- stderr ---')
            print(r.stderr)
    total = len(STAGES)
    print(f'ff1 harness: {total - failures}/{total} passed')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
