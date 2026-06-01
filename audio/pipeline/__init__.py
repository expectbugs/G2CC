"""G2CC audio pipeline package.

Default single-mic path (per the May-recording analysis: machine noise is
highly stationary at ~3-second cycle, broadband + a few sharp tonals):

  noise-only recording (DJI TX2 or phone mic)
       │
       ▼
  learn_noise_profile.py  →  profiles/<name>.npz  (PSD + tonal-peak list)

  ─── inference time ──────────────────────────────────────────────────────

  speech recording (DJI TX2 mono)
       │
       ▼
  notch_filter.apply_notches(audio, sr, profile['peak_freqs'])  ← if peaks
       │
       ▼
  spectral_subtract.wiener_subtract(audio, sr, profile['noise_psd'])
       │
       ▼
  dfn_polish.polish(audio, sr)
       │
       ▼
  parakeet_engine.transcribe(audio, sr)            ← Phase 8

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
