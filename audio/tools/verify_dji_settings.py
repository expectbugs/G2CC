#!/usr/bin/env python3
"""verify_dji_settings.py — six-toggle hard-fail checklist for DJI Mic 3 setup.

The most common ANC failure mode is the DJI's onboard Two-Level Noise Cancelling
silently scrubbing the machine sound from TX1 (the reference channel) before
the recording hits disk. If that happens, NLMS has nothing to subtract and the
whole pipeline fails — but the captures look fine on a quick listen. This
script makes the toggles explicit and refuses to proceed with any wrong.

Usage:
  python verify_dji_settings.py            interactive checklist
  python verify_dji_settings.py --dry-run  exercise the loud-failure paths with mock answers
  python verify_dji_settings.py --json <path>  read answers from a JSON file (CI / scripted)

Output:
  /home/user/G2CC/audio/samples/<timestamp>-settings.json (alongside captures)

Discipline reference: g2_custom_app_spec.md §B2 + CLAUDE.md "Audio Pipeline Discipline".
NEVER push audio to Adam's phone in tests.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

CHECKLIST: list[tuple[str, str, str]] = [
    # (key, description, required_answer)
    ('mode_stereo',
     'Receiver in Stereo (dual-channel) mode (NOT mono mix)?',
     'yes'),
    ('dual_file_32f',
     'Internal recording set to Dual-File 32-bit float?',
     'yes'),
    ('nc_off_tx1',
     'Two-Level Noise Cancelling DISABLED on TX1 (machine reference)?',
     'yes'),
    ('nc_off_tx2',
     'Two-Level Noise Cancelling DISABLED on TX2 (collar speech)?',
     'yes'),
    ('autogain_off',
     'Auto-gain / compression OFF on BOTH TX1 and TX2?',
     'yes'),
    ('tx1_magneted',
     'TX1 magnet-mounted in direct contact with machine metal housing, facing into noise?',
     'yes'),
    ('tx2_collar',
     'TX2 clipped to collar in normal close-talk position?',
     'yes'),
]


def prompt_user(checklist: list[tuple[str, str, str]]) -> dict[str, str]:
    """Prompt interactively for each checklist item; allow free-text notes."""
    answers: dict[str, str] = {}
    print('--- DJI Mic 3 setup verification ---')
    print('For each item, answer "yes" or "no" (or paste machine cycle notes).\n')
    for key, desc, _ in checklist:
        ans = input(f'{desc}\n  > ').strip().lower()
        answers[key] = ans
        if ans in ('y', 'yes'):
            print()
        else:
            print(f'  ↑ recorded as "{ans}"\n')
    notes = input('Optional notes about machine cycle / room / distance:\n  > ').strip()
    if notes:
        answers['notes'] = notes
    return answers


def load_dry_run() -> dict[str, str]:
    """Return mock answers that exercise the loud-failure paths.

    The dry-run intentionally has TWO wrong answers so we can confirm the
    'reject and exit' branch fires, not the success branch."""
    return {
        'mode_stereo': 'yes',
        'dual_file_32f': 'yes',
        'nc_off_tx1': 'no',          # ← wrong: NC ON would corrupt the reference
        'nc_off_tx2': 'yes',
        'autogain_off': 'yes',
        'tx1_magneted': 'yes',
        'tx2_collar': 'no',          # ← wrong: TX2 not in close-talk
        'notes': 'dry-run synthetic answers — not a real capture',
    }


def normalize_yes(ans) -> bool:
    # str() first (review 2026-07-05): --json mode hands us real JSON booleans,
    # and .lower() on bool crashed with AttributeError. True -> 'true' (accepted).
    return str(ans).strip().lower() in ('y', 'yes', 'true', '1')


def verify(answers: dict[str, str]) -> list[str]:
    """Return the list of FAILED checks. Empty list = all pass."""
    failures: list[str] = []
    for key, desc, required in CHECKLIST:
        ans = answers.get(key, '')
        ok = (required == 'yes' and normalize_yes(ans))
        if not ok:
            failures.append(f'{key}: {desc} (got {ans!r})')
    return failures


def write_settings_json(answers: dict[str, str], outdir: Path) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%dT%H%M%S')
    out = outdir / f'{ts}-settings.json'
    payload = {
        'timestamp': ts,
        'verified': True,
        'answers': answers,
        'checklist_version': 1,
    }
    out.write_text(json.dumps(payload, indent=2))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description='Verify DJI Mic 3 settings before capture.')
    parser.add_argument('--dry-run', action='store_true', help='Run with mock answers.')
    parser.add_argument('--json', type=Path, default=None, help='Path to a JSON file with answers.')
    parser.add_argument('--out', type=Path,
                        default=Path('/home/user/G2CC/audio/samples'),
                        help='Output directory for settings JSON.')
    args = parser.parse_args()

    if args.dry_run:
        answers = load_dry_run()
        print('--- DRY RUN: synthetic answers ---')
        print(json.dumps(answers, indent=2))
        print()
    elif args.json is not None:
        answers = json.loads(args.json.read_text())
    else:
        answers = prompt_user(CHECKLIST)

    failures = verify(answers)
    if failures:
        # LOUD failure — exits non-zero, lists every wrong toggle.
        print('--- DJI SETUP VERIFICATION FAILED ---', file=sys.stderr)
        for f in failures:
            print(f'  ✗ {f}', file=sys.stderr)
        print(file=sys.stderr)
        print('Fix the listed toggles BEFORE capturing — or any captures', file=sys.stderr)
        print('made now will silently corrupt NLMS reference channel and', file=sys.stderr)
        print('the whole audio pipeline tunes against bad data.', file=sys.stderr)
        print('See g2_custom_app_spec.md §B2 for the rationale.', file=sys.stderr)
        return 1

    out_path = write_settings_json(answers, args.out)
    print(f'--- DJI verification PASSED ---')
    print(f'    settings recorded at {out_path}')
    print('Now run capture.py for each of:')
    print('  1. machine_alone        (machine running, you silent and away)')
    print('  2. voice_plus_machine   (machine running, you reading paragraph at collar)')
    print('  3. voice_alone          (away from machine, same paragraph)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
