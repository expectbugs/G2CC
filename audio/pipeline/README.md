# `audio/pipeline/`

Offline / server-side audio processing modules.

## Order

```
DJI stereo .wav (TX1=ref, TX2=speech)
       │
       ▼
  nlms.py  →  cleaned mono
       │
       ▼
  dfn_polish.py  →  polished mono
       │
       ▼
  parakeet_engine.py  →  transcript     ← Phase 8 ONLY
       │
       ▼
  eval.py / tune.py  →  SNR + WER metrics    ← needs real captures
```

## Modules

### `nlms.py` (Phase 3B — written; tuning deferred to Phase 8)

Public API:

```python
from pipeline.nlms import nlms_clean
cleaned_mono = nlms_clean(stereo_float32, sample_rate=48000, mu=0.025, taps=1024, hp_cutoff=60.0)
```

Defaults from spec §B2. Hand-rolled NumPy (~30 lines core loop). High-pass on
ref channel strips magnet-vibration rumble. Bad input shape raises `ValueError`
loudly.

Math sanity: `python -m pipeline.nlms --self-test`. The synthetic test confirms
the math doesn't blow up but is **not a substitute for tuning on real captures**
— per the discipline rule.

### `dfn_polish.py` (Phase 3B — written; model load deferred to Phase 8)

Public API:

```python
from pipeline.dfn_polish import polish
polished_mono = polish(cleaned_mono, sample_rate=48000)
```

Lazy-loads DeepFilterNet (DFN3) on first call inside `threading.Lock` —
mirrors `/home/user/aria/whisper_engine.py:121-181` exactly. CUDA-default
(falls back to CPU if torch decides). Bad input shape raises `ValueError`.

Class shape check: `python -m pipeline.dfn_polish --import-check`. Does NOT
load the model (which takes ~15s the first time).

### `parakeet_engine.py` (Phase 8 ONLY — not yet written)

Will mirror `dfn_polish.py`'s lazy-load + lock pattern, with internals replaced
by `from nemo.collections.asr.models import EncDecRNNTBPEModel` (verify exact
class against the Parakeet model card BEFORE writing — do not guess). Input
shape validated against a clean LibriSpeech sample with known WER (1.69%) before
plugging into the live pipeline.

### `eval.py`, `tune.py` (Phase 3B placeholder; Phase 8 active)

Refuse to run when captures are missing. Raise `NotEnoughCapturesYet` loudly
so a Phase 8 developer can't accidentally tune against an empty directory.

```bash
python -m pipeline.eval         # raises NotEnoughCapturesYet today
python -m pipeline.tune         # raises NotEnoughCapturesYet today
```

## Discipline

From `CLAUDE.md`:

- **Tune NLMS parameters on real DJI captures, not synthetic audio.** Step
  size μ in 0.01–0.05; filter length 1024 taps at 48 kHz; high-pass on
  reference channel below 60 Hz.
- **Never mute or scrub the reference channel.** TX1's job is to be a
  high-SNR-of-noise pickup. The DJI's onboard NC corrupting it is the single
  most common failure mode for ANC.
- **The Parakeet swap is independent from the ANC work.** Validate the ANC +
  DeepFilterNet pipeline on the OLD faster-whisper first to isolate the
  noise-reduction win. Then swap ASR.
- **Clip stereo audio at 32-bit float boundaries when shipping to the server.**
  No clipping headroom loss between the DJI's 32-bit float internal recording
  and the server's NLMS input.

## Three absolute rules in code

- **NO TIMEOUTS.** No `wait_for`, no `timeout=` on file I/O, no clock-bound
  killing of long transcribes. Long audio legitimately takes minutes.
- **NO SILENT FAILURES.** Every failure path raises a typed exception with
  explicit text. No `except: pass`. No `except Exception: pass`.
- **NO TRUNCATION.** Transcripts are emitted in full. Pagination (server-side
  scrollback) handles HUD display, never `…`-cut.

CI grep gates run after each phase boundary:

```bash
rg "wait_for|timeout=" audio/                    # must be empty
rg "except.*:\s*pass|except\s*:" audio/          # must be empty
rg "\.{3}|…" audio/pipeline/ -t py               # only allowed in docstrings
```
