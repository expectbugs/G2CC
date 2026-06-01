"""G2CC audio pipeline package.

Default single-mic path (per the May-recording analysis: machine noise is
highly stationary at ~3-second cycle, broadband + a few sharp tonals):

  noise-only recording (DJI TX2 or phone mic)
       │
       ▼
  learn_noise_profile.py  →  profiles/<name>.npz  (PSD + tonal-peak list)

  ─── inference time ──────────────────────────────────────────────────────

  speech recording (DJI TX2 mono, float32 — caller normalizes int PCM first)
       │
       ▼
  notch_filter.apply_notches(audio, sr, profile['peak_freqs'])  ← if peaks
       │
       ▼
  spectral_subtract.wiener_subtract_with_profile(audio, sr, profile)
       │      ← canonical wrapper; passes expected_sample_rate from profile
       │        so SR mismatch is caught loudly instead of silently
       │        applying wrong-bin gains
       ▼
  dfn_polish.polish(audio, 48_000)            ← DFN3 is 48 kHz-native; loud-fails on mismatch
       │
       ▼
  parakeet_engine.get_engine().transcribe_numpy(audio, sample_rate=...)   ← Phase 8

Modules:
  notch_filter      — IIR notch cascade for tonal harmonics (cheap, surgical).
  spectral_subtract — Wiener filter with learned PSD (broadband suppression).
  dfn_polish        — DeepFilterNet polish layer (residual general noise).
  parakeet_engine   — NeMo Parakeet TDT 0.6B v2 (Phase 8; not yet shipping).
  nlms              — Two-mic NLMS adaptive cancellation. FALLBACK ONLY, kept
                      in-tree for cases where the workplace noise becomes
                      non-stationary or includes uncorrelated sources the
                      profile can't model. Not on the default path.
  eval, tune        — offline evaluation; require real DJI captures.
"""
