#!/usr/bin/env python3
"""capture.py — record 32-bit float WAV from the DJI Mic 3 USB receiver.

Two capture modes (queue D7, 2026-07-05 — matches CLAUDE.md's pipeline split):
  --channels 1   single-mic TX2 mono — the DEFAULT PIPELINE's capture shape
  --channels 2   stereo TX1+TX2 (sample-synchronized) — the NLMS fallback
                 (default here for continuity with the existing sample set)

Three intended runs (per g2_custom_app_spec.md §B2):
  python capture.py machine_alone
  python capture.py voice_plus_machine
  python capture.py voice_alone

Each writes /home/user/G2CC/audio/samples/<name>-<timestamp>.wav and (if
present) copies the most recent settings.json from verify_dji_settings.py
alongside.

Discovery:
  python capture.py --list-devices

Sample rate / format:
  - 48 kHz, 32-bit float
  - DEFAULT capture duration: 30 seconds (override with --duration)
  - DEFAULT input device: auto-pick first device with 'DJI' or 'WIRELESS'
    in the name; override with --device <id-or-name>. NO DJI candidate found
    → HARD FAIL (D7): recording the box's default mic looked like a capture
    but sampled the wrong capsule — profiles learned from it leave residue
    (capsule + codec MUST match the live capture path, per CLAUDE.md).

NO TIMEOUTS on the recording path — duration is a recording-LENGTH parameter,
not an I/O timeout. If sounddevice itself blocks, the user's Ctrl-C signal
handler is the supervisor (per the no-arbitrary-clock-thresholds rule).

NO SILENT FAILURES — every failure mode logs explicit text.

Discipline: NEVER play back captured audio automatically. This script writes
to disk only.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

DEFAULT_RATE = 48_000
DEFAULT_CHANNELS = 2
DEFAULT_DURATION_S = 30.0
DEFAULT_OUTDIR = Path('/home/user/G2CC/audio/samples')


def list_devices() -> int:
    print(sd.query_devices())
    print()
    print('--- DJI candidates (heuristic) ---')
    for idx, dev in enumerate(sd.query_devices()):
        name = dev['name'].lower()
        if 'dji' in name or 'wireless' in name or 'mic' in name:
            print(f'  [{idx}] {dev["name"]} '
                  f'(in={dev["max_input_channels"]}ch, out={dev["max_output_channels"]}ch, '
                  f'default_sr={dev["default_samplerate"]})')
    return 0


def pick_device(arg: str | None, channels: int) -> int:
    """Resolve a device argument to a sounddevice index.
    None  → auto-pick first DJI candidate with enough input channels;
            HARD-FAIL if none (D7 — never silently record the default mic:
            a wrong-capsule capture poisons every profile learned from it).
    str digit → index.
    str name → first device whose name contains it (case-insensitive)."""
    devices = sd.query_devices()
    if arg is None:
        for idx, dev in enumerate(devices):
            name = dev['name'].lower()
            if dev['max_input_channels'] >= channels and ('dji' in name or 'wireless' in name):
                print(f'[capture] auto-picked device [{idx}] {dev["name"]}')
                return idx
        raise SystemExit(
            f'[capture] FAIL: no DJI/wireless input device with >= {channels} channel(s) found.\n'
            '  Plug in / wake the DJI Mic 3 receiver, or pass --device <id-or-name> explicitly\n'
            '  (use --list-devices to enumerate). Refusing to record the default mic:\n'
            '  a profile learned from the wrong capsule leaves residue on real captures.')
    if arg.isdigit():
        return int(arg)
    needle = arg.lower()
    for idx, dev in enumerate(devices):
        if needle in dev['name'].lower():
            return idx
    raise SystemExit(f'no audio device matches {arg!r}; use --list-devices to enumerate')


def record(name: str, duration: float, device: int, rate: int, channels: int, outdir: Path) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%dT%H%M%S')
    wav_path = outdir / f'{name}-{ts}.wav'

    mode = 'mono TX2 (single-mic)' if channels == 1 else 'stereo TX1+TX2 (NLMS fallback)'
    print(f'[capture] recording {duration:.1f}s of "{name}" [{mode}] → {wav_path}')
    print('[capture] press Ctrl-C to abort cleanly')

    n_frames = int(round(duration * rate))
    # 32-bit float dtype → matches the DJI's internal recording bit depth.
    audio = sd.rec(
        frames=n_frames,
        samplerate=rate,
        channels=channels,
        dtype='float32',
        device=device,
    )
    sd.wait()                            # block until recording finishes (NOT a timeout)
    audio = np.asarray(audio, dtype=np.float32)
    sf.write(str(wav_path), audio, rate, subtype='FLOAT')
    print(f'[capture] saved {wav_path} ({audio.shape[0]} frames × {audio.shape[1]} ch)')
    return wav_path


def link_latest_settings(outdir: Path, wav_path: Path) -> Path | None:
    """Copy the most recent *-settings.json next to the new wav as <wavstem>-settings.json."""
    settings = sorted(outdir.glob('*-settings.json'), key=lambda p: p.stat().st_mtime)
    if not settings:
        print(f'[capture] WARNING: no settings.json in {outdir} — '
              f'run verify_dji_settings.py first', file=sys.stderr)
        return None
    latest = settings[-1]
    target = wav_path.with_name(f'{wav_path.stem}-settings.json')
    target.write_text(latest.read_text())
    print(f'[capture] linked settings → {target.name}')
    return target


def main() -> int:
    p = argparse.ArgumentParser(description='Record stereo 32-bit float WAV from DJI Mic 3.')
    p.add_argument('name', nargs='?',
                   help='Capture name (e.g. machine_alone, voice_plus_machine, voice_alone).')
    p.add_argument('--duration', type=float, default=DEFAULT_DURATION_S,
                   help=f'Recording duration in seconds (default {DEFAULT_DURATION_S}).')
    p.add_argument('--rate', type=int, default=DEFAULT_RATE,
                   help=f'Sample rate (default {DEFAULT_RATE}).')
    p.add_argument('--device', default=None,
                   help='Audio device index or name substring; auto-picks DJI by default '
                        '(HARD-FAILS if no DJI/wireless device is present).')
    p.add_argument('--channels', type=int, choices=(1, 2), default=DEFAULT_CHANNELS,
                   help='1 = mono TX2 (the default single-mic pipeline), '
                        f'2 = stereo TX1+TX2 (NLMS fallback; default {DEFAULT_CHANNELS} '
                        'for continuity with the existing sample set).')
    p.add_argument('--out', type=Path, default=DEFAULT_OUTDIR,
                   help=f'Output directory (default {DEFAULT_OUTDIR}).')
    p.add_argument('--list-devices', action='store_true', help='List audio devices and exit.')
    args = p.parse_args()

    if args.list_devices:
        return list_devices()

    if not args.name:
        p.error('name argument required (e.g. machine_alone) — or use --list-devices')

    device = pick_device(args.device, args.channels)
    wav_path = record(args.name, args.duration, device, args.rate, args.channels, args.out)
    link_latest_settings(args.out, wav_path)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n[capture] aborted', file=sys.stderr)
        sys.exit(130)
