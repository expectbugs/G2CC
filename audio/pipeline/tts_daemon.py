"""tts_daemon — persistent WARM Kokoro TTS process for G2CC (earbud lane).

Mirror of parakeet_daemon.py on the synthesis side: server/src/tts.ts (the
TtsDaemon manager) spawns this once, the Kokoro ONNX session loads once, and
every utterance after that synthesizes in ~real-time on CPU (82 M params —
deliberately NOT on the GPU; canary-qwen owns the VRAM).

Engine + voice come from ARIA's proven setup (aria/tts.py, kokoro-onnx 0.5.0):
same model files, same af_heart default, same text-prep fixes (the 509-phoneme
silent-truncation guard, paren-artifact strip, newline→pause mapping).

Protocol (line-oriented; run python with -u):
  stdin :  one JSON job per line: {"text": "...", "speed": 1.0}
  stdout:  per job, a STREAM of framed blocks — one per synthesized sentence —
             ___G2CC_RESULT_BEGIN___\n{"seq":0,"pcm_b64":"...","ms":812}\n___G2CC_RESULT_END___\n
           terminated by a final done block —
             ___G2CC_RESULT_BEGIN___\n{"done":true,"sentences":3,"totalMs":2440}\n___G2CC_RESULT_END___\n
           or, if synthesis raised —
             ___G2CC_ERROR_BEGIN___\n<TypeName: message>\n___G2CC_ERROR_END___\n
           (sentences already emitted before an error STAY valid — the server
           speaks what it got and surfaces the error loudly.)
  pcm_b64 is base64 PCM16LE mono at SAMPLE_RATE (24 kHz — shared/constants.ts
  TTS_SAMPLE_RATE must match).

Env (set by server/src/tts.ts from config.tts):
  G2CC_TTS_MODEL_DIR  — dir holding kokoro-v1.0.onnx + voices-v1.0.bin
                        (default: ARIA's /home/user/aria/tts_models/kokoro)
  G2CC_TTS_VOICE      — voice id (default af_heart — Adam's pick 2026-08-04)
  G2CC_TTS_SPEED      — speaking rate multiplier (default 1.0)

Loud failures only. EOF on stdin ends the loop cleanly. No timeouts — the
server owns this process's lifecycle.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import sys

import numpy as np

# Server contract — MUST match the sentinels parsed in server/src/tts.ts
# (same markers as the ASR daemon so the parsing helper is shared).
RESULT_BEGIN = "___G2CC_RESULT_BEGIN___"
RESULT_END = "___G2CC_RESULT_END___"
ERROR_BEGIN = "___G2CC_ERROR_BEGIN___"
ERROR_END = "___G2CC_ERROR_END___"

SAMPLE_RATE = 24000  # Kokoro native; shared TTS_SAMPLE_RATE mirrors this

DEFAULT_MODEL_DIR = "/home/user/aria/tts_models/kokoro"

# Per-sentence synth targets. Kokoro's internal phoneme batcher truncates past
# 509 phonemes (~200 chars worst-case number-heavy text); we split well below
# that so no single create() call can hit the ceiling. The FIRST unit is kept
# small so first-audio latency is one short synth, not the whole reply;
# later units regroup fragments for efficiency.
SENTENCE_FIRST_TARGET_CHARS = 100
SENTENCE_TARGET_CHARS = 250
SENTENCE_HARD_MAX_CHARS = 450


def _ensure_tts_splits(text: str, max_chars: int = 200) -> str:
    """Insert commas in long runs without Kokoro-friendly punctuation.

    Ported from aria/tts.py (2026): Kokoro's phoneme batcher splits only on
    [.,!?;]. Runs without these marks can phonemize past the 509 limit and get
    silently truncated. Insert a comma at the nearest word boundary when any
    run exceeds max_chars.
    """
    pattern = re.compile(r"[^.,!?;]{" + str(max_chars) + r",}")
    while True:
        m = pattern.search(text)
        if not m:
            break
        run = m.group()
        mid = len(run) // 2
        best = None
        for offset in range(mid + 1):
            if mid + offset < len(run) and run[mid + offset] == " ":
                best = mid + offset
                break
            if mid - offset >= 0 and run[mid - offset] == " ":
                best = mid - offset
                break
        if best is None:
            break  # no space in the entire run — can't split
        insert_pos = m.start() + best
        text = text[:insert_pos] + "," + text[insert_pos:]
    return text


def prepare_for_speech(text: str) -> str:
    """Strip markdown for natural TTS. Ported from aria/tts.py (proven), minus
    ARIA's ACTION-block alerting (G2CC CC output has no ACTION blocks).

    NOTE (no-truncation rule): removing code blocks from the SPOKEN rendition
    is a projection policy, not truncation — the full text always lands in the
    Companion scrollback; speech is a secondary rendering of it. A removed
    block is replaced by an audible marker so the listener KNOWS content was
    elided to the glasses.
    """
    # Fenced code blocks → audible marker (never silently vanish)
    text = re.sub(r"```.*?```", " code block on glasses. ", text, flags=re.DOTALL)
    # Bold **text** → text (must precede italic)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    # Italic *text* → text
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    # Inline code `text` → text
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # Headings ## text → text
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # Bullet/list markers
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    # Links [text](url) → text
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Parentheses — Kokoro vocalizes these as audible artifacts (~250 ms burst)
    text = re.sub(r"[()]", "", text)
    # Paragraph breaks → sentence pauses
    text = re.sub(r"\n{2,}", ". ", text)
    # Single newlines → commas for Kokoro split points (data listings);
    # skip if the line already ends with sentence punctuation or colon.
    text = re.sub(r"(?<![.,!?;:])\n", ", ", text)
    text = re.sub(r"\n", " ", text)
    # Safety net: break up long unpunctuated runs (the 509-phoneme guard)
    text = _ensure_tts_splits(text)
    # Normalize whitespace
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def split_sentences(text: str) -> list[str]:
    """Split prepared text into synth units ≤ SENTENCE_HARD_MAX_CHARS.

    Split on sentence enders (keeping them), then greedily regroup small
    fragments up to SENTENCE_TARGET_CHARS so we don't synth per-clause. A
    monster "sentence" past the hard max is word-wrapped — never dropped.
    """
    parts = [p.strip() for p in re.split(r"(?<=[.!?;:])\s+", text) if p.strip()]
    units: list[str] = []
    cur = ""

    def target() -> int:
        # First emitted unit stays small (fast first audio); later ones regroup.
        return SENTENCE_FIRST_TARGET_CHARS if not units else SENTENCE_TARGET_CHARS

    for part in parts:
        while len(part) > SENTENCE_HARD_MAX_CHARS:
            cut = part.rfind(" ", 0, SENTENCE_HARD_MAX_CHARS)
            if cut <= 0:
                cut = SENTENCE_HARD_MAX_CHARS
            if cur:
                units.append(cur)
                cur = ""
            units.append(part[:cut].strip())
            part = part[cut:].strip()
        if not part:
            continue
        if cur and len(cur) + 1 + len(part) > target():
            units.append(cur)
            cur = part
        else:
            cur = f"{cur} {part}".strip()
    if cur:
        units.append(cur)
    return units


_kokoro = None


def _get_kokoro():
    """Load Kokoro once (the warm singleton). Same off-by-one guard as ARIA:
    kokoro-onnx 0.5.0's MAX_PHONEME_LENGTH=510 allows voice[510] into a
    510-row embedding — clamp to 509 to keep indexing in bounds."""
    global _kokoro
    if _kokoro is None:
        import kokoro_onnx

        kokoro_onnx.MAX_PHONEME_LENGTH = 509
        model_dir = os.environ.get("G2CC_TTS_MODEL_DIR", "").strip() or DEFAULT_MODEL_DIR
        model = os.path.join(model_dir, "kokoro-v1.0.onnx")
        voices = os.path.join(model_dir, "voices-v1.0.bin")
        for path in (model, voices):
            if not os.path.exists(path):
                raise FileNotFoundError(
                    f"Kokoro model file missing: {path} (G2CC_TTS_MODEL_DIR={model_dir!r})"
                )
        print(f"tts_daemon: loading Kokoro from {model_dir}", file=sys.stderr)
        _kokoro = kokoro_onnx.Kokoro(model, voices)
    return _kokoro


def _emit(begin: str, body: str, end: str) -> None:
    """One framed block to stdout, flushed. Sentinel-in-body guard mirrors
    parakeet_daemon._emit (AUD-3): refuse a frame the server would mis-slice."""
    for marker in (RESULT_BEGIN, RESULT_END, ERROR_BEGIN, ERROR_END):
        if marker in body:
            raise ValueError(
                f"body contains reserved sentinel {marker!r}; refusing to emit"
            )
    sys.stdout.write(begin + "\n")
    sys.stdout.write(body + "\n")
    sys.stdout.write(end + "\n")
    sys.stdout.flush()


def _synth_job(job_line: str, voice: str, default_speed: float) -> None:
    """Synthesize one job, streaming a RESULT block per sentence + a done block."""
    job = json.loads(job_line)
    raw_text = str(job["text"])
    speed = float(job.get("speed", default_speed))

    text = prepare_for_speech(raw_text)
    units = split_sentences(text)
    kokoro = _get_kokoro()

    total_ms = 0.0
    seq = 0
    for unit in units:
        samples, sr = kokoro.create(unit, voice=voice, speed=speed, lang="en-us")
        if sr != SAMPLE_RATE:
            raise RuntimeError(f"Kokoro returned {sr} Hz, expected {SAMPLE_RATE}")
        if len(samples) == 0:
            # A unit that synthesized to nothing (e.g. punctuation-only) is
            # skipped but COUNTED in stderr — never a silent hole in seq.
            print(f"tts_daemon: unit {seq} produced 0 samples: {unit[:60]!r}", file=sys.stderr)
            continue
        pcm = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
        pcm_i16 = (pcm * 32767.0).astype("<i2")
        ms = len(pcm_i16) * 1000.0 / SAMPLE_RATE
        total_ms += ms
        _emit(
            RESULT_BEGIN,
            json.dumps(
                {"seq": seq, "pcm_b64": base64.b64encode(pcm_i16.tobytes()).decode("ascii"), "ms": round(ms, 1)}
            ),
            RESULT_END,
        )
        seq += 1
    _emit(
        RESULT_BEGIN,
        json.dumps({"done": True, "sentences": seq, "totalMs": round(total_ms, 1)}),
        RESULT_END,
    )


def main() -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)
    voice = os.environ.get("G2CC_TTS_VOICE", "").strip() or "af_heart"
    try:
        default_speed = float(os.environ.get("G2CC_TTS_SPEED", "1.0"))
    except ValueError:
        print("tts_daemon: bad G2CC_TTS_SPEED, using 1.0", file=sys.stderr)
        default_speed = 1.0
    print(f"tts_daemon: voice {voice} speed {default_speed}", file=sys.stderr)

    while True:
        line = sys.stdin.readline()
        if not line:  # EOF — server closed the pipe
            break
        job_line = line.strip()
        if not job_line:
            continue
        try:
            _synth_job(job_line, voice, default_speed)
        except Exception as exc:  # loud + framed — never swallow
            logging.getLogger("g2cc.tts").exception("synthesis failed for %s", job_line[:200])
            detail = f"{type(exc).__name__}: {exc}"
            for marker in (RESULT_BEGIN, RESULT_END, ERROR_BEGIN, ERROR_END):
                detail = detail.replace(marker, marker.strip("_"))
            _emit(ERROR_BEGIN, detail, ERROR_END)

    return 0


if __name__ == "__main__":
    sys.exit(main())
