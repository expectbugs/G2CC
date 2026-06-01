# `audio/pipeline/`

Server-side audio processing for the G2CC build.

## Default pipeline (single-mic + learned-profile)

```
noise-only recording  →  learn_noise_profile.py  →  profiles/<name>.npz
                                                       │
                                                       ▼
DJI TX2 mono speech  →  notch_filter  →  spectral_subtract  →  dfn_polish  →  parakeet_engine  →  transcript
                       (peak_freqs)     (noise_psd)
```

Rationale: the May 28 recording of Adam's machine showed **near-textbook
stationarity** (PSD first-half vs second-half differs by 0.4 dB mean ± 1.4 dB)
and a consistent **2.96 s cycle period**. For noise that stationary, a learned
noise PSD does most of the work that two-mic NLMS would; one mic (DJI TX2
collar) is sufficient. Validated on real holdout: 5-8 dB noise reduction at
α=1.5-3.0 with <0.6 dB loss on a speech-level signal.

NLMS stays in-tree (`nlms.py`) as a fallback for non-stationary noise scenarios
(e.g. a different workplace, additional uncorrelated sources). Not on the
default path.

## Modules

### `notch_filter.py`

Public API:

```python
from pipeline.notch_filter import apply_notches
audio = apply_notches(audio_mono, sample_rate=48000, frequencies=peak_freqs, Q=30.0)
```

IIR notch cascade. Use BEFORE spectral subtraction so the broadband Wiener
stage doesn't have to chase tones a 2-line IIR can carve cleanly. Empty
frequency list returns the input unchanged.

Math sanity: `python -m pipeline.notch_filter --self-test`

### `spectral_subtract.py`

Public API (canonical):

```python
from pipeline.spectral_subtract import wiener_subtract_with_profile, load_profile
profile = load_profile('profiles/machine.npz')
audio = wiener_subtract_with_profile(audio_mono, sample_rate=profile['sample_rate'], profile=profile,
                                     alpha=1.5, floor=0.05)
```

The `_with_profile` wrapper passes the profile's STFT params + sample-rate
expectation in, so an SR mismatch is caught loudly instead of silently
applying wrong-bin gains. Direct calls to `wiener_subtract(audio, sr,
noise_psd, ...)` are allowed for advanced / library use, but the caller is
then responsible for SR-check + STFT-param alignment.

Wiener filter with learned noise PSD: `G(f,t) = max(floor, (|Y|² - α·N)/|Y|²)`.
`α` controls aggressiveness (1.5 conservative, 2.5 typical, 3.0 max-without-
artifacts based on May-recording sweep). `floor` is the spectral floor
preventing musical-noise artifacts (-26 dB default).

The noise PSD MUST be learned with the same STFT params used at inference —
`learn_noise_profile.py` saves them inside the .npz alongside the PSD so this
is automatic.

Math sanity: `python -m pipeline.spectral_subtract --self-test`

### `dfn_polish.py`

Public API:

```python
from pipeline.dfn_polish import polish
polished = polish(audio_mono, sample_rate=48000)
```

DeepFilterNet polish — generic residual denoising after the profile-based
pipeline. Lazy-loads DFN3 on first call inside a `threading.Lock`; mirrors
`/home/user/aria/whisper_engine.py:121-181` exactly.

Class shape check: `python -m pipeline.dfn_polish --import-check`

### `parakeet_engine.py` (Phase 8 ONLY — not yet shipping)

Will mirror `dfn_polish.py`'s lazy-load + lock pattern, internals replaced by
`from nemo.collections.asr.models import EncDecRNNTBPEModel` (verify exact
class against the Parakeet model card BEFORE writing — do not guess). Input
shape validated against a clean LibriSpeech sample with known WER (1.69%)
before plugging into the live pipeline.

### `nlms.py` (FALLBACK — not on default path)

Two-mic adaptive cancellation. Kept in-tree because:
- Workplace noise character may change (different machine, additional sources).
- Non-stationary scenarios (variable RPM, doors slamming, untrained noise
  sources) where the static PSD model degrades.
- Diagnostic A/B against the single-mic path during Phase 8 tuning.

Math sanity: `python -m pipeline.nlms --self-test`

### `eval.py`, `tune.py`

Refuse to run when real captures are missing — raise `NotEnoughCapturesYet`
loudly per the no-silent-failure rule.

```bash
python -m pipeline.eval         # raises NotEnoughCapturesYet today
python -m pipeline.tune         # raises NotEnoughCapturesYet today
```

## Hard rules

- **NO TIMEOUTS.** No `wait_for`, no `timeout=` on file I/O, no clock-bound
  killing of long transcribes. Long audio legitimately takes minutes.
- **NO SILENT FAILURES.** Every failure path raises a typed exception with
  explicit text. No `except: pass`. Bad input shapes raise `ValueError` with
  the offending shape printed.
- **NO TRUNCATION.** Transcripts are emitted in full. Pagination (server-side
  scrollback) handles HUD display.

CI grep gates run at every phase boundary:

```bash
rg "wait_for|timeout=" audio/                    # must be empty
rg "except.*:\s*pass|except\s*:" audio/          # must be empty
```

## Discipline

- **Never tune on synthetic audio.** The self-tests use synthetic signals only
  for math sanity, never for parameter selection. Real-data tuning happens in
  Phase 8 against captured DJI samples.
- **Learn the noise profile with the same mic that will capture speech.** The
  May phone-recording is acceptable for prototyping; production profile should
  be re-recorded with DJI TX2 at the workplace.
- **The Parakeet swap is independent from the ANC work.** Validate
  spectral_subtract + DFN on faster-whisper first to isolate the noise-
  reduction win, then swap ASR.
