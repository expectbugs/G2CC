# G2CC Verified Environment

Captured 2026-05-05. Re-verify before Phase 8 (NeMo install) — driver/toolkit may drift.

## Init system: OpenRC ✓

```
$ rc-status -s | head -3
 hwclock                                                           [  started  ]
 loopback                                                          [  started  ]
 swclock                                                           [  stopped  ]
```

NEVER use `systemctl`. Service management is `rc-service <name> {start|stop|status|restart}` and `rc-update`.

## Package manager: Portage ✓

```
$ emerge --version
Portage 3.0.77 (python 3.13.12-final-0, default/linux/amd64/23.0/split-usr/desktop, gcc-14, glibc-2.42-r5, 6.18.26-gentoo-dist x86_64)
```

NEVER use `apt`/`yum`/`dnf`. System install is `emerge <pkg>`. Project Python deps go via project-scoped venv (`audio/venv/`), NOT Portage.

## Node + npm ✓

```
$ node --version
v24.14.0
$ npm --version
11.9.0
```

## Python 3.13.12 ✓

```
$ python3 --version
Python 3.13.12

$ /home/user/aria/venv/bin/python --version
Python 3.13.12
```

`/home/user/G2CC/audio/venv/` does NOT exist yet — Phase 1 creates it. Do not reuse `/home/user/aria/venv/` for G2CC's audio pipeline (per the user's planning choice — isolates NeMo's heavy dep tree).

## CUDA + GPU ✓ (with toolkit/driver divergence noted)

```
$ nvidia-smi | head -16
NVIDIA-SMI 595.71.05              Driver Version: 595.71.05      CUDA Version: 13.2
GPU 0: NVIDIA GeForce RTX 3090, 24576 MiB total, 5253 MiB in use
```

- Driver: **595.71.05** (driver-supported CUDA: 13.2)
- nvcc-reported toolkit: 12.9 (per prior verification — **re-verify at Phase 8**)
- GPU: RTX 3090, 24 GB VRAM
- CC-only paths (Parakeet via NeMo) are CUDA-mandatory — no realistic CPU fallback.

**Action at Phase 8:** install NeMo against whichever PyTorch CUDA wheel matches the running driver. If a conflict surfaces, the project-scoped venv contains the blast radius — `/home/user/aria/venv/` stays untouched.

## Bluetooth tooling ✓

```
$ which bluetoothctl btmon
/usr/bin/bluetoothctl
/usr/bin/btmon
```

bluez is installed and operational. `btmon -r <file>` is the BTSnoop reader for Phase 1 i-soxi capture analysis.

## PipeWire ✓

```
$ pactl info | head -6
Server String: /run/user/1000/pulse/native
Library Protocol Version: 35
Server Protocol Version: 35
```

PipeWire serves the PulseAudio API (verified earlier as PipeWire 1.4.10). DJI Mic 3 USB-audio routing in Phase 2B will use `sounddevice` over the PulseAudio API.

## Claude CLI flags ✓ (re-verified 2026-05-05)

All flags the spec depends on confirmed present in `claude --help`:

| Flag | Status | Notes |
|------|--------|-------|
| `--print` / `-p` | ✓ | Required for stream-json non-interactive mode |
| `--output-format <text\|json\|stream-json>` | ✓ | Use `stream-json` |
| `--input-format <text\|stream-json>` | ✓ | Use `stream-json`; only valid with `--print` |
| `--include-partial-messages` | ✓ | Only valid with `--print` and `--output-format=stream-json` |
| `--dangerously-skip-permissions` | ✓ | What we use for `bypassPermissions` mode |
| `--allow-dangerously-skip-permissions` | ✓ (separate flag, NOT what we want) | Enables the OPTION; we want the actual bypass |
| `--effort <low\|medium\|high\|xhigh\|max>` | ✓ | Set to `max`. **Spec wants this as CLI flag; g2code currently uses env var only.** |
| `--model <alias\|name>` | ✓ | Use `opus` |
| `--resume` / `-r [value]` | ✓ | For session resume by CC session ID |
| `--system-prompt <prompt>` | ✓ | Optional engineering-oriented prompt |
| `-n, --name <name>` | ✓ | Display name in /resume picker |
| `--permission-mode <acceptEdits\|auto\|bypassPermissions\|default\|dontAsk\|plan>` | ✓ | Used when NOT bypassing |

## Path state checks

- `/home/user/G2CC/`: contains `CLAUDE.md`, `g2_custom_app_spec.md`, and now `docs/`. No source code yet.
- `/home/user/G2 Custom/even-g2-protocol/`: **DOES NOT EXIST** — Phase 1 will clone.
- `/home/user/G2CC/audio/venv/`: **DOES NOT EXIST** — Phase 1 will create.
- `/home/user/G2CC/server/src/`, `/home/user/G2CC/shared/src/`, `/home/user/G2CC/audio/`: **DO NOT EXIST** — Phase 1 creates the skeleton; Phases 2A/3A populate `server/src/`; Phases 2B/3B populate `audio/`.
- `/home/user/g2code/`: untouched, working.
- `/home/user/g2aria/`: untouched, working.
- `/home/user/aria/venv/bin/python`: exists, Python 3.13.12. Reference only.

## Project-scoped venv plan

Per user planning answer: NeMo + Parakeet + DeepFilterNet + numpy/scipy/sounddevice etc. all live in `/home/user/G2CC/audio/venv/`. Disk cost ~3 GB once NeMo lands (Phase 8). Aria's venv stays untouched so the existing system keeps working.

## Re-verify trigger points

- **Before Phase 1 BLE protocol clone.** Confirm `bluetoothctl --version` and `btmon` still present.
- **Before Phase 8 NeMo install.** Re-run `nvidia-smi` and `nvcc --version` to detect any kernel/driver/toolkit drift since 2026-05-05. NeMo's PyTorch wheel must match the running driver's supported CUDA.
- **Before any new phase.** Re-run `claude --help` to detect CLI flag drift.
