# G2CC Audio Pipeline

Server-side audio + STT pipeline for the G2CC build. Replaces `faster-whisper`
ASR in `g2code-server` / `g2aria-server` with a single-mic noise-reduced path
feeding NVIDIA Parakeet TDT 0.6B v2.

## Default pipeline (single-mic + learned-profile)

Per the May 28 noise analysis (textbook-stationary cycle, 2.96 s period,
broadband + a few tonal harmonics) we don't need two-mic NLMS. A learned
PSD plus Wiener subtraction handles the noise cleanly:

```
noise-only recording        →  learn_noise_profile.py  →  profiles/<name>.npz
(DJI TX2 or prototyping mic)                              (PSD + tonal peaks)

DJI TX2 mono speech         →  notch_filter
                            →  spectral_subtract
                            →  DeepFilterNet polish
                            →  Parakeet TDT 0.6B v2     →  transcript
```

`audio/pipeline/nlms.py` stays in-tree as a fallback for non-stationary noise
scenarios but is not on the default path. See `pipeline/README.md` for the
rationale.

## Setup

The project-scoped venv at `/home/user/G2CC/audio/venv/` (Python 3.13.12).
Created in Phase 1; populated incrementally:

```bash
# Phase 2B — capture infrastructure
audio/venv/bin/pip install -r requirements.txt

# Phase 3B — NLMS+DFN+spectral_subtract modules (no extra pip needed; numpy/scipy/soundfile already there)
# Phase 8 — Parakeet via NeMo (uncomment the line in requirements.txt first)
audio/venv/bin/pip install -r requirements.txt
```

## Single-mic workflow (recommended)

```bash
# Step 1 — record ~30-60 seconds of noise alone (no voice) with DJI TX2 (or
# phone mic for prototyping). Stop the machine? NO — record it doing the
# usual cycle. The profile needs to see the noise we want to subtract.

# Step 2 — learn the noise profile
audio/venv/bin/python audio/tools/learn_noise_profile.py \
  /path/to/noise.wav --output audio/profiles/machine.npz

# Step 3 (at inference time) — server-side pipeline calls:
#   from pipeline.spectral_subtract import load_profile, wiener_subtract
#   from pipeline.notch_filter import apply_notches
#   profile = load_profile('audio/profiles/machine.npz')
#   audio = apply_notches(audio, profile['sample_rate'], profile['peak_freqs'])
#   audio = wiener_subtract(audio, profile['sample_rate'], profile['noise_psd'])
#   audio = polish(audio, profile['sample_rate'])
#   text = transcribe(audio, profile['sample_rate'])
```

## Two-mic NLMS workflow (fallback only)

When the workplace noise is non-stationary or includes uncorrelated sources
the profile can't model, fall back to two-mic NLMS:

```bash
# Step 1 — verify DJI receiver settings
audio/venv/bin/python audio/tools/verify_dji_settings.py

# Step 2 — capture the three-sample set
audio/venv/bin/python audio/tools/capture.py machine_alone        # ~30s machine running, silent
audio/venv/bin/python audio/tools/capture.py voice_plus_machine   # ~30s machine + collar speech
audio/venv/bin/python audio/tools/capture.py voice_alone          # ~30s away from machine, same paragraph

# Step 3 — sanity check
audio/venv/bin/python audio/tools/sanity_listen.py audio/samples/

# Step 4 — offline NLMS+DFN eval against faster-whisper
audio/venv/bin/python -m pipeline.eval

# Step 5 — parameter tuning sweep
audio/venv/bin/python -m pipeline.tune
```

## Profiles

`audio/profiles/` holds learned noise profiles (.npz files). One per noise
environment. Production profile should be re-recorded with the DJI itself
(NOT phone audio) so capsule + codec match the actual capture path.

Profile schema (loaded via `pipeline.spectral_subtract.load_profile()`):

| key | type | meaning |
|-----|------|---------|
| sample_rate | int | the sr the profile was learned at — inference MUST match |
| nperseg | int | STFT window length used for PSD computation |
| noverlap | int | STFT overlap |
| noise_psd | float64 array, (nperseg/2 + 1,) | average |Z|² per bin |
| peak_freqs | float64 array | detected tonal-peak center frequencies (Hz) |
| source_file | str | path of the recording the profile was learned from |
| duration_s | float | length of the source recording in seconds |
| rms | float | RMS of the source recording |

## Discipline rules

From `CLAUDE.md`:

- **NEVER push audio to Adam's phone in tests.** Tools and evaluators write only to disk.
- **No tuning on synthetic audio.** Parameter sweeps run against real DJI captures.
- **Profile must be learned with the same mic that captures the live speech**, or
  spectrum mismatch leaves residue. Phone-recording profiles are acceptable
  for prototyping only.
- **No timeouts** in capture or pipeline code. Long audio legitimately takes
  minutes to transcribe; let it finish.
- **No silent failures.** Every step's failure mode is loud (raised exception,
  explicit log).
