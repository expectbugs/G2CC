# DJI Mic 3 Capture Samples

## Default workflow (single-mic learned-profile path)

After the May 28 noise analysis showed the workplace machine has near-textbook
stationary noise, the default pipeline shifted to single-mic learned-profile
(see `audio/pipeline/README.md`). The captures needed are now:

```
noise-<timestamp>.wav                  ~30-60 s of machine noise alone, no voice (DJI TX2 mono)
voice_plus_machine-<timestamp>.wav     ~30 s of machine + collar speech (DJI TX2 mono)
```

`noise.wav` is used by `audio/tools/learn_noise_profile.py` to produce the
production noise profile at `audio/profiles/machine.npz`.
`voice_plus_machine.wav` is the end-to-end validation capture.

## Fallback workflow (two-mic NLMS)

If the single-mic path underperforms in practice (non-stationary noise,
additional uncorrelated sources), fall back to the original three-set capture
for two-mic NLMS:

```
machine_alone-<timestamp>.wav        machine running, Adam silent and away (STEREO TX1+TX2)
voice_plus_machine-<timestamp>.wav   machine running, Adam reading paragraph at collar (STEREO)
voice_alone-<timestamp>.wav          away from machine, same paragraph (STEREO)
```

Each capture is paired with a `*-settings.json` file from `verify_dji_settings.py`.

**Directory is empty in Phase 1–3.** Captures land at H5 (when Adam is at the
machine), per `docs/HOLDS.md`.

## Capture conditions to record alongside each set

When capturing, document in `<sample-name>-settings.json` (the `verify_dji_settings.py`
output covers most of this).

### Default path (single-mic)

- DJI TX2 only, mono recording
- 32-bit float internal recording (ON)
- Two-Level Noise Cancelling on TX2 (OFF)
- Auto-gain / compression (OFF)
- TX2 mounting on collar, normal close-talk
- Machine cycle timing (e.g., "15-20 cycles per minute, audible cyclical thump")
- Distance from Adam to machine
- Room reverb characteristics (concrete floor, drywall, etc.)

### Fallback path (two-mic NLMS)

Add to the above:

- DJI receiver mode set to Stereo / dual-channel
- 32-bit float Dual-File internal recording
- Two-Level Noise Cancelling on TX1 (OFF)
- Auto-gain / compression on TX1 (OFF)
- TX1 magnet-mounted on machine housing, metal contact

## Why the three-set discipline (NLMS fallback only)

The three-set capture below is for **the NLMS fallback workflow only**. The
default single-mic path needs just two captures: `noise-*.wav` (to learn the
profile) and `voice_plus_machine-*.wav` (to validate the cleaned output).

**Per `g2_custom_app_spec.md` §B8 (Migration Notes):**

1. **machine_alone** — pure noise reference. Used to characterize the machine cycle and tune NLMS filter parameters (μ, taps, high-pass cutoff).
2. **voice_plus_machine** — the workplace reality. NLMS+DFN run against this; SNR improvement on TX2 is the primary metric (target: 15–25 dB per spec §B2).
3. **voice_alone** — ground truth. Same paragraph, no machine. WER on `voice_alone` is the floor; WER on cleaned `voice_plus_machine` should approach it.

If the three are not paired (different paragraphs, different sessions), the offline
evaluation can't isolate NLMS's contribution. **Capture all three back-to-back** when
exercising the fallback.

## Discipline rule (from CLAUDE.md)

> **NEVER push audio to Adam's phone in tests.** Mock the push_audio path or write to disk.

Phase 2B's tools and Phase 3B's evaluation framework write only to this directory.
No mic-output paths trigger automatically.


## 2026-07-22/23 — the dictation-war capture set (tee'd via the LIVE path)

All 16 kHz mono int16, DJI TX2 → BT SCO → phone → server (the real daily path):

```
live-1784755854880.wav         pre-v1.19 chain, TX NC ON  — band-crushed evidence (0.19% >4 kHz)
test2-1784759746333.wav        v1.19, TX NC ON  — the Fresh Prince test (careful voice, sung)
normalvoice-1784760800249.wav  v1.19, TX NC ON  — normal voice GATED to ~nothing (2/10 voicing)
txcheck-1784764253122.wav      v1.19, TX NC OFF — voicing 10/10; the alternating-register demo
nc-off-test-1784764658788.wav  v1.19, TX NC OFF — careful-voice reference clip (known text)
```

The June `exp-/away-/pos-/test-` clips are PANGRAM tests ("the quick brown fox…"
+ "testing one two three…"), TX NC unknowingly ON — usable as references for
model comparison, but they are NOT current-reality (NC-off) audio. The 2026-07-23
ASR shootout + the NR shootouts were scored on this set; verdicts in the
CHANGELOG and `~/.claude/projects/-home-user-G2CC/memory/g2cc-stt-accuracy-pass.md`.
