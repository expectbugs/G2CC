#!/usr/bin/env python3
"""verify_dji_settings.py — hard-fail checklist for DJI Mic 3 setup.

Two checklists (queue D7, 2026-07-05 — matches CLAUDE.md's pipeline split):
  --mode single  TX2-only mono (the DEFAULT pipeline: learned-profile
                 spectral subtraction) — 5 toggles
  --mode nlms    stereo TX1+TX2 (the NLMS fallback) — 7 toggles

The most common failure mode either way is the DJI's onboard Two-Level Noise
Cancelling silently scrubbing the signal before the recording hits disk —
for NLMS that corrupts the TX1 reference; for the single-mic path it leaves
a profile/live mismatch. Captures look fine on a quick listen either way.
This script makes the toggles explicit and refuses to proceed with any wrong.

Usage:
  python verify_dji_settings.py                     interactive (single-mic default)
  python verify_dji_settings.py --mode nlms         interactive NLMS checklist
  python verify_dji_settings.py --dry-run           exercise the loud-failure paths
  python verify_dji_settings.py --json <path>       read answers from JSON (CI / scripted)

Output:
  /home/user/G2CC/audio/samples/<timestamp>-settings.json (alongside captures)

Discipline reference: g2_custom_app_spec.md §B2 (+ the §8 revision note) +
CLAUDE.md "Audio Pipeline Discipline". NEVER push audio to Adam's phone in tests.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# (key, description, required_answer) — the NLMS fallback (two-mic) checklist.
CHECKLIST_NLMS: list[tuple[str, str, str]] = [
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

# The DEFAULT single-mic (mono TX2) checklist — D7. TX1 stays in the case.
CHECKLIST_SINGLE: list[tuple[str, str, str]] = [
    ('mode_mono_tx2',
     'Capture is TX2-only mono (receiver mono / TX2 routing — TX1 not in use)?',
     'yes'),
    ('internal_32f',
     'TX2 internal recording set to 32-bit float?',
     'yes'),
    ('nc_off_tx2',
     'Two-Level Noise Cancelling DISABLED on TX2 (collar speech)?',
     'yes'),
    ('autogain_off_tx2',
     'Auto-gain / compression OFF on TX2?',
     'yes'),
    ('tx2_collar',
     'TX2 clipped to collar in normal close-talk position?',
     'yes'),
]

CHECKLISTS: dict[str, list[tuple[str, str, str]]] = {
    'single': CHECKLIST_SINGLE,
    'nlms': CHECKLIST_NLMS,
}


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


def load_dry_run(mode: str) -> dict[str, str]:
    """Return mock answers that exercise the loud-failure paths.

    The dry-run intentionally has TWO wrong answers so we can confirm the
    'reject and exit' branch fires, not the success branch."""
    if mode == 'single':
        return {
            'mode_mono_tx2': 'yes',
            'internal_32f': 'yes',
            'nc_off_tx2': 'no',          # ← wrong: NC ON leaves a profile/live mismatch
            'autogain_off_tx2': 'yes',
            'tx2_collar': 'no',          # ← wrong: TX2 not in close-talk
            'notes': 'dry-run synthetic answers — not a real capture',
        }
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


def verify(answers: dict[str, str], checklist: list[tuple[str, str, str]]) -> list[str]:
    """Return the list of FAILED checks. Empty list = all pass."""
    failures: list[str] = []
    for key, desc, required in checklist:
        ans = answers.get(key, '')
        ok = (required == 'yes' and normalize_yes(ans))
        if not ok:
            failures.append(f'{key}: {desc} (got {ans!r})')
    return failures


def write_settings_json(answers: dict[str, str], mode: str, outdir: Path) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%dT%H%M%S')
    out = outdir / f'{ts}-settings.json'
    payload = {
        'timestamp': ts,
        'verified': True,
        'mode': mode,                    # D7: which checklist this capture setup passed
        'answers': answers,
        'checklist_version': 2,
    }
    out.write_text(json.dumps(payload, indent=2))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description='Verify DJI Mic 3 settings before capture.')
    parser.add_argument('--mode', choices=('single', 'nlms'), default='single',
                        help='single = mono TX2 (the DEFAULT pipeline, 5 toggles); '
                             'nlms = stereo TX1+TX2 fallback (7 toggles). Default: single.')
    parser.add_argument('--dry-run', action='store_true', help='Run with mock answers.')
    parser.add_argument('--json', type=Path, default=None, help='Path to a JSON file with answers.')
    parser.add_argument('--out', type=Path,
                        default=Path('/home/user/G2CC/audio/samples'),
                        help='Output directory for settings JSON.')
    args = parser.parse_args()

    checklist = CHECKLISTS[args.mode]
    print(f'--- checklist mode: {args.mode} '
          f'({"mono TX2, the default pipeline" if args.mode == "single" else "stereo TX1+TX2, the NLMS fallback"}) ---')

    if args.dry_run:
        answers = load_dry_run(args.mode)
        print('--- DRY RUN: synthetic answers ---')
        print(json.dumps(answers, indent=2))
        print()
    elif args.json is not None:
        answers = json.loads(args.json.read_text())
    else:
        answers = prompt_user(checklist)

    failures = verify(answers, checklist)
    if failures:
        # LOUD failure — exits non-zero, lists every wrong toggle.
        print('--- DJI SETUP VERIFICATION FAILED ---', file=sys.stderr)
        for f in failures:
            print(f'  ✗ {f}', file=sys.stderr)
        print(file=sys.stderr)
        print('Fix the listed toggles BEFORE capturing — a wrong toggle', file=sys.stderr)
        if args.mode == 'nlms':
            print('silently corrupts the NLMS reference channel and the whole', file=sys.stderr)
            print('audio pipeline tunes against bad data.', file=sys.stderr)
        else:
            print('leaves a capsule/processing mismatch between the learned', file=sys.stderr)
            print('profile and live captures — the profile leaves residue.', file=sys.stderr)
        print('See g2_custom_app_spec.md §B2 for the rationale.', file=sys.stderr)
        return 1

    out_path = write_settings_json(answers, args.mode, args.out)
    print(f'--- DJI verification PASSED ({args.mode}) ---')
    print(f'    settings recorded at {out_path}')
    print('Now run capture.py for each of:')
    ch = ' --channels 1' if args.mode == 'single' else ''
    print(f'  1. capture.py machine_alone{ch}        (machine running, you silent and away)')
    print(f'  2. capture.py voice_plus_machine{ch}   (machine running, you reading paragraph at collar)')
    print(f'  3. capture.py voice_alone{ch}          (away from machine, same paragraph)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
