"""dfn_polish — DeepFilterNet polish layer (OFFLINE TOOL — not on the live path).

EVALUATED ON REAL CAPTURES 2026-07-22 (DFN3, torch 2.12 CUDA, RTF 0.043) and it
LOST: on the careful-voice capture (test2-1784759746333) the DFN'd transcript
was WORSE than both raw and adaptive-Wiener; on the quiet normal-voice capture
(normalvoice-1784760800249) DFN muted the clip to an empty transcript — that
clip contains almost no voiced speech (2/10 voicing on the loudest frames;
the DJI TX-side gate/NC is the suspected upstream killer). Do NOT wire DFN
into the live BT path without NEW captures showing a win. Kept as an offline
analysis tool.

INSTALL NOTE: deepfilternet==0.5.6 is installed --no-deps (its numpy<2 pin
would DOWNGRADE the venv's numpy 2.4 and break NeMo). df.io imports
torchaudio module paths that were REMOVED in torchaudio 2.1+, so _ensure_model
installs a minimal torchaudio SHIM for the import and removes it after —
NeMo's own lazy torchaudio import must keep seeing a real ImportError.

Lazy-loaded with a threading.Lock — same shape as aria/whisper_engine.py so
GPU access is single-threaded.

Module CLI:
  python -m pipeline.dfn_polish --import-check  verify lazy-load class shape
"""
from __future__ import annotations

import argparse
import logging
import sys
import threading
import time

import numpy as np

log = logging.getLogger('g2cc.dfn')


class DfnPolisher:
    """Lazy-loaded DeepFilterNet wrapper. Single-threaded GPU via instance-level lock."""

    def __init__(self, device: str = 'cuda') -> None:
        self.device = device
        self._lock = threading.Lock()
        self._model: object | None = None        # opaque DF model handle
        self._df_state: object | None = None     # opaque state for streaming use

    def _ensure_model(self) -> None:
        """Load model on first use. Caller MUST hold self._lock."""
        if self._model is not None:
            return
        # Lazy import — DeepFilterNet pulls torch + a CUDA wheel. Keep it out
        # of the hot import path so other tools (capture, sanity_listen) don't
        # pay the load cost. The torchaudio SHIM (see module docstring) exists
        # only for the duration of the df import: df.io binds its references at
        # import time and our tensor path never calls them.
        import sys as _sys
        import types as _types
        if 'df' not in _sys.modules and 'torchaudio' not in _sys.modules:
            def _never(*_a, **_k):  # noqa: ANN002, ANN003
                raise RuntimeError('torchaudio shim: df.io file helpers must never be called')
            _ta = _types.ModuleType('torchaudio'); _ta.__version__ = '0.0-g2cc-shim'; _ta.__path__ = []
            _be = _types.ModuleType('torchaudio.backend'); _be.__path__ = []
            _co = _types.ModuleType('torchaudio.backend.common'); _co.AudioMetaData = type('AudioMetaData', (), {})
            _fu = _types.ModuleType('torchaudio.functional'); _fu.resample = _never
            _ta.backend = _be; _be.common = _co; _ta.functional = _fu
            _ta.load = _never; _ta.save = _never; _ta.info = _never
            _shim = {'torchaudio': _ta, 'torchaudio.backend': _be,
                     'torchaudio.backend.common': _co, 'torchaudio.functional': _fu}
            _sys.modules.update(_shim)
            try:
                import df.enhance  # noqa: F401 — bind df's torchaudio refs under the shim
            finally:
                for _k in _shim:   # NeMo must keep seeing a REAL ImportError for torchaudio
                    _sys.modules.pop(_k, None)
        from df.enhance import enhance, init_df       # type: ignore
        import torch                                  # noqa: WPS433
        log.info('Loading DeepFilterNet on %s ...', self.device)
        start = time.time()
        # 4th-pass review HIGH: previously init_df() ran with no device arg,
        # so DFN auto-detected (often CPU) while self.device claimed 'cuda'.
        # Move the model to self.device explicitly so the field doesn't lie.
        #
        # 4th-pass-final review CRITICAL: DFN's init_df() returns 3 values on
        # v0.5.6 but 4+ values on master / future releases (model, df_state,
        # suffix, epoch). Star-unpack so we tolerate both API shapes.
        model, df_state, *_ = init_df()
        target_device = torch.device(self.device)
        try:
            model = model.to(target_device)
        except Exception as e:
            log.error('DFN model.to(%s) failed: %s — model stays on %s',
                      target_device, e, next(model.parameters()).device)
            raise
        self._model = model
        self._df_state = df_state
        # Stash enhance for use; importing inside _ensure_model keeps it lazy.
        self._enhance = enhance
        actual_device = next(model.parameters()).device
        log.info('DeepFilterNet loaded in %.1fs on %s', time.time() - start, actual_device)

    # DeepFilterNet3 is a 48 kHz-native model; the model card and the
    # `init_df()` defaults bind to 48 kHz internally. Anything else either
    # silently time-distorts (low sample rate stretched out) or aliases.
    EXPECTED_SAMPLE_RATE = 48_000

    def polish(self, mono: np.ndarray, sample_rate: int = 48_000) -> np.ndarray:
        """Polish a mono float32 array. Returns float32 of the same length.

        Raises ValueError on bad input shape OR sample_rate mismatch — DFN3 is
        a 48 kHz-native model and the prior implementation silently corrupted
        non-48k input. Caller must resample upstream if needed.
        """
        if not isinstance(mono, np.ndarray):
            raise ValueError(f'polish expects np.ndarray, got {type(mono).__name__}')
        if mono.ndim != 1:
            raise ValueError(f'polish expects mono 1-D array, got shape {mono.shape}')
        if sample_rate != self.EXPECTED_SAMPLE_RATE:
            raise ValueError(
                f'DeepFilterNet3 is 48 kHz-native; got sample_rate={sample_rate}. '
                f'Resample to {self.EXPECTED_SAMPLE_RATE} Hz first (e.g. via '
                f'scipy.signal.resample_poly), polish, then resample back if '
                f'the downstream ASR expects another rate.'
            )
        if mono.dtype != np.float32:
            mono = mono.astype(np.float32, copy=False)

        with self._lock:
            self._ensure_model()
            assert self._model is not None and self._df_state is not None
            # DeepFilterNet's enhance() expects torch tensors of shape (1, n_samples)
            # ON CPU — verified empirically 2026-07-22 against the installed 0.5.6:
            # enhance() moves data to the model's device itself, and a CUDA input
            # tensor makes its internal df_features() numpy conversion throw
            # ("can't convert cuda:0 device type tensor to numpy"). The earlier
            # review note claiming the tensor must ride the model device was
            # written blind, pre-install — the opposite is true.
            import torch                              # noqa: WPS433 — lazy to avoid hot import
            t = torch.from_numpy(mono).unsqueeze(0)
            out = self._enhance(self._model, self._df_state, t)
            return out.squeeze(0).cpu().numpy().astype(np.float32, copy=False)


# Module-level singleton (matches whisper_engine.py's get_engine() pattern).
_polisher: DfnPolisher | None = None


def get_polisher() -> DfnPolisher:
    global _polisher
    if _polisher is None:
        _polisher = DfnPolisher()
    return _polisher


# Convenience wrapper — Phase 8's eval / tune scripts call this directly.
def polish(mono: np.ndarray, sample_rate: int = 48_000) -> np.ndarray:
    return get_polisher().polish(mono, sample_rate=sample_rate)


def _import_check() -> int:
    """Verify the lazy-load class shape WITHOUT actually loading the model.

    The model load pulls torch + DFN3 weights (~hundreds of MB) and is GPU-bound,
    so this check just confirms the import surface is sane in Phase 3B.
    """
    p = DfnPolisher()
    print(f'DfnPolisher created (model not loaded yet, _lock={p._lock!r}, _model={p._model})')
    print(f'public methods: {[m for m in dir(p) if not m.startswith("_")]}')
    print(f'singleton getter: {get_polisher.__name__}')
    print('shape OK — ready for Phase 8 to instantiate against real audio.')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description='DeepFilterNet polish wrapper.')
    parser.add_argument('--import-check', action='store_true',
                        help='Confirm lazy-load class shape without loading the model.')
    args = parser.parse_args()
    if args.import_check:
        return _import_check()
    parser.print_help()
    return 0


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    sys.exit(main())
