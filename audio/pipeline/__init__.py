"""G2CC audio pipeline package — NLMS ANC + DeepFilterNet polish + Parakeet ASR.

Modules:
  nlms             — NLMS adaptive filter (hand-rolled NumPy, ~30 lines per spec §B2).
  dfn_polish       — DeepFilterNet wrapper (lazy-load + threading.Lock, mirrors whisper_engine.py).
  parakeet_engine  — NeMo Parakeet TDT 0.6B v2 wrapper (Phase 8; not yet shipping).
  eval             — offline evaluation; requires real DJI captures.
  tune             — parameter sweep; requires real DJI captures.
"""
