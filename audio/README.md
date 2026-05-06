# G2CC Audio Pipeline

Server-side audio + STT pipeline for the G2CC build. Replaces the existing
`faster-whisper` ASR in `g2code-server` / `g2aria-server` with a noise-reduced
two-mic + NeMo Parakeet path.

Per the canonical spec (`g2_custom_app_spec.md` Part B), the pipeline order is:

```
DJI Mic 3 stereo (TX1 = noise reference, TX2 = collar speech)
     ↓
NLMS adaptive cancellation     (pipeline/nlms.py)
     ↓
DeepFilterNet polish           (pipeline/dfn_polish.py)
     ↓
Parakeet TDT 0.6B v2 ASR       (pipeline/parakeet_engine.py — Phase 8)
```

Phase 0–3 builds capture tooling, NLMS module, and DFN wrapper without tuning
(no real captures yet). Phase 8 tunes against real captures and swaps in
Parakeet.

## Setup

The project-scoped venv is at `/home/user/G2CC/audio/venv/` (Python 3.13.12).
Created in Phase 1; populated incrementally:

```bash
# Phase 2B — capture infrastructure (only sounddevice/soundfile/scipy/numpy/matplotlib)
audio/venv/bin/pip install -r requirements.txt   # default exclusions in place

# Phase 3B — NLMS+DFN modules (adds padasip + deepfilternet)
# (already covered by requirements.txt — re-run pip install after Phase 3B writes its modules)

# Phase 8 — Parakeet via NeMo (uncomment the line in requirements.txt first)
# Re-verify CUDA/driver before this step; NeMo's torch wheel must match.
audio/venv/bin/pip install nemo_toolkit[asr]
```

The venv is project-scoped (per the user's planning answer) so a NeMo install
conflict can't break `/home/user/aria/venv/`.

## At-the-machine workflow (Phase 8 prep)

When Adam is back at the machine with the DJI receiver:

```bash
# Step 1 — verify DJI receiver settings (six toggles must be correct)
audio/venv/bin/python audio/tools/verify_dji_settings.py

# Step 2 — capture the three sample set
audio/venv/bin/python audio/tools/capture.py machine_alone        # ~30s machine running, Adam silent & away
audio/venv/bin/python audio/tools/capture.py voice_plus_machine   # ~30s machine running, Adam reads paragraph at collar
audio/venv/bin/python audio/tools/capture.py voice_alone          # ~30s away from machine, same paragraph

# Step 3 — sanity-check spectrograms + per-channel RMS
audio/venv/bin/python audio/tools/sanity_listen.py audio/samples/

# Step 4 — offline NLMS+DFN eval against faster-whisper
audio/venv/bin/python -m pipeline.eval

# Step 5 — parameter tuning sweep
audio/venv/bin/python -m pipeline.tune

# Step 6 (Phase 8 only) — Parakeet swap evaluation
audio/venv/bin/python -m pipeline.eval --asr parakeet
```

## Discipline rules

From `CLAUDE.md`:

- **NEVER push audio to Adam's phone in tests.** Tools and evaluators write only to disk.
- **No tuning on synthetic audio.** All parameter sweeps run against real DJI captures.
- **NLMS reference channel (TX1) must be untouched by single-mic NC.** DJI's onboard Two-Level NC must be OFF on both TX. Verified by `verify_dji_settings.py`.
- **No timeouts** in capture or pipeline code. Long audio legitimately takes minutes to transcribe; let it finish.
- **No silent failures.** Every step's failure mode is loud (raised exception, explicit log).
