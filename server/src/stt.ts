// STT — faster-whisper today (Phase 0–7); Parakeet engine swap lands in Phase 8.
//
// Inheritance: g2aria/server/src/stt.ts ported with two changes:
//   1. The `try { unlinkSync(tmpPath) } catch { /* ignore cleanup errors */ }`
//      swallow is replaced with an existsSync guard + logged failure
//      (docs/FORBIDDEN_PATTERN_AUDIT.md §3).
//   2. Engine selection branches on G2CCConfig.stt.engine — Phase 8 adds the
//      'parakeet' branch that calls into pipeline/parakeet_engine.py instead.
//
// No timeouts on the subprocess execution (g2code's `timeout: 30000` was a
// rule violation; g2aria already removed it; we keep g2aria's no-timeout
// shape with maxBuffer 16 MB so a long transcription doesn't overflow stdout).
// Hallucination denylist preserved from g2aria (empirical, not faster-whisper-
// specific — though Phase 8 may extend it for Parakeet's failure modes).

import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { preprocessAudio } from './audio-preprocess.js'
import { pcmToWav } from './pcm-wav.js'
import type { G2CCConfig } from './config.js'

const execFileAsync = promisify(execFile)

/** Phrases faster-whisper loves to hallucinate on silent/noisy clips
 *  (all from YouTube training data). If the entire transcript is one of these,
 *  treat it as "no speech" and surface stt_error so the user re-records. */
const HALLUCINATION_DENYLIST = new Set<string>([
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'thank you for watching!',
  'thank you so much for watching',
  'please like and subscribe',
  "don't forget to subscribe",
  'subscribe to my channel',
  'thank you.',
  'thank you',
  'thanks.',
  'thanks',
  'bye',
  'bye.',
  'goodbye',
  'goodbye.',
  'you',
  '.',
  ',',
])

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function isLikelyHallucination(text: string): boolean {
  return HALLUCINATION_DENYLIST.has(normalize(text))
}

/** Extract the transcript from a Python CLI's stdout when the CLI uses the
 *  ___G2CC_RESULT_BEGIN___ / ___G2CC_RESULT_END___ sentinels. Loud-fails if
 *  the sentinels are missing — caller's catch surfaces it to the client.
 *  NeMo / tqdm noise on stdout outside the sentinels is discarded. */
const RESULT_BEGIN = '___G2CC_RESULT_BEGIN___'
const RESULT_END = '___G2CC_RESULT_END___'
export function extractSentinelResult(stdout: string): string {
  const beginIdx = stdout.indexOf(RESULT_BEGIN)
  const endIdx = stdout.indexOf(RESULT_END)
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    throw new Error(
      `CLI output missing transcript sentinels (begin=${beginIdx}, end=${endIdx}); ` +
      `stdout tail: ${JSON.stringify(stdout.slice(-200))}`,
    )
  }
  const inner = stdout.substring(beginIdx + RESULT_BEGIN.length, endIdx)
  return inner.trim()
}

/** Transcribe raw PCM audio to text.
 *  Input: 16 kHz, signed 16-bit LE, mono PCM (from G2 mic or DJI fallback path).
 *  Throws if the result is a known hallucination — caller surfaces stt_error.
 */
export async function transcribe(pcmBuffer: Buffer, config: G2CCConfig): Promise<string> {
  const processed = await preprocessAudio(pcmBuffer)
  const wavBuffer = pcmToWav(processed, 16000, 16, 1)
  const tmpPath = join('/tmp', `g2cc-stt-${Date.now()}.wav`)
  writeFileSync(tmpPath, wavBuffer)

  try {
    if (config.stt.engine === 'parakeet') {
      return await transcribeParakeet(tmpPath, config)
    }
    return await transcribeFasterWhisper(tmpPath, config)
  } finally {
    // Loud cleanup per docs/FORBIDDEN_PATTERN_AUDIT.md §3: if the tmpfile is
    // missing the cleanup is a no-op; if unlink fails for any other reason
    // we log it (disk full, permission, race) so it doesn't silently rot.
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath) }
      catch (err) { console.warn(`[stt] tmpfile cleanup failed (${tmpPath}): ${err}`) }
    }
  }
}

async function transcribeFasterWhisper(wavPath: string, config: G2CCConfig): Promise<string> {
  const { whisperModel, whisperDevice, whisperCompute, language, pythonPath } = config.stt
  // Mirrors /home/user/aria/whisper_engine.py:155-161 exactly (VAD + beam 5).
  const script = [
    'import sys',
    'from faster_whisper import WhisperModel',
    `model = WhisperModel(${JSON.stringify(whisperModel)}, device=${JSON.stringify(whisperDevice)}, compute_type=${JSON.stringify(whisperCompute)})`,
    'segments, _ = model.transcribe(',
    '    sys.argv[1],',
    `    language=${JSON.stringify(language)},`,
    '    beam_size=5,',
    '    vad_filter=True,',
    '    vad_parameters={"min_silence_duration_ms": 500},',
    ')',
    "print(' '.join(s.text for s in segments))",
  ].join('\n')

  // Non-blocking; no I/O timeout (long audio legitimately takes minutes).
  // maxBuffer bumped to 16 MB so a long transcript doesn't overflow stdout.
  const { stdout } = await execFileAsync(
    pythonPath,
    ['-c', script, wavPath],
    { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
  )
  const result = stdout.trim()

  console.log(`[stt] faster-whisper result (${result.length} chars): "${result}"`)

  if (isLikelyHallucination(result)) {
    console.warn(`[stt] Rejected hallucination: "${result}"`)
    throw new Error('No speech detected (likely background noise)')
  }
  return result
}

/** Phase 8: DJI Mic 3 path — 48 kHz / 2 ch / float32 audio through the full
 *  noise pipeline (notch → wiener → parakeet). Bypasses the legacy
 *  16 kHz/mono/int16 preprocessAudio() entirely.
 *
 *  Input: raw interleaved float32 PCM bytes as announced by audio_start.
 *  Output: transcript string (post-pipeline).
 *
 *  Writes an IEEE-float WAV to /tmp and shells out to
 *  `pipeline.dji_pipeline_cli` in the project venv. The Python CLI handles:
 *    - stereo→mono downmix
 *    - resample to noise profile rate (48 kHz)
 *    - notch_filter at profile['peak_freqs']
 *    - spectral_subtract with profile['noise_psd']
 *    - parakeet transcribe (resamples internally to 16 kHz)
 *
 *  Hallucination denylist still applies; Parakeet's empirical failure
 *  modes on DJI captures get added once Adam runs the H5 hardware gate. */
export async function transcribeDji(
  pcmBuffer: Buffer,
  format: { sampleRate: number; channels: number; encoding: string },
  config: G2CCConfig,
): Promise<string> {
  if (format.encoding !== 'float32') {
    throw new Error(`transcribeDji expects float32, got ${format.encoding}`)
  }
  // Wrap raw float32 bytes in a proper IEEE-float WAV header so the Python
  // soundfile decoder can read it without ambiguity. bitsPerSample=32,
  // audioFormat=3.
  const wavBuffer = pcmToWav(pcmBuffer, format.sampleRate, 32, format.channels, 3)
  const tmpPath = join('/tmp', `g2cc-dji-${Date.now()}.wav`)
  writeFileSync(tmpPath, wavBuffer)
  try {
    const { pythonPath } = config.stt
    const { stdout } = await execFileAsync(
      pythonPath,
      ['-m', 'pipeline.dji_pipeline_cli', tmpPath],
      {
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
        cwd: '/home/user/G2CC/audio',
      },
    )
    const result = extractSentinelResult(stdout)
    console.log(`[stt] dji-pipeline result (${result.length} chars): "${result}"`)
    if (isLikelyHallucination(result)) {
      console.warn(`[stt] Rejected hallucination: "${result}"`)
      throw new Error('No speech detected (likely background noise)')
    }
    return result
  } finally {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath) }
      catch (err) { console.warn(`[stt] tmpfile cleanup failed (${tmpPath}): ${err}`) }
    }
  }
}

/** Phase 8: Parakeet TDT 0.6B v2 via pipeline/parakeet_engine.py.
 *
 *  Calls the project-scoped venv's python with `-m pipeline.parakeet_cli <wav>`.
 *  No timeout (long audio legitimately takes minutes); maxBuffer 16 MB so a
 *  long transcript can't overflow stdout.
 *
 *  REQUIRES: `nemo_toolkit[asr]` installed in the venv (`audio/venv/`). This
 *  is uncommented in audio/requirements.txt only after the CUDA driver/toolkit
 *  divergence is resolved per Phase 0's VERIFIED_ENVIRONMENT.md note. */
async function transcribeParakeet(wavPath: string, config: G2CCConfig): Promise<string> {
  const { pythonPath } = config.stt
  const { stdout } = await execFileAsync(
    pythonPath,
    ['-m', 'pipeline.parakeet_cli', wavPath],
    {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      cwd: '/home/user/G2CC/audio',     // so `-m pipeline.parakeet_cli` resolves
    },
  )
  const result = extractSentinelResult(stdout)
  console.log(`[stt] parakeet result (${result.length} chars): "${result}"`)

  // Hallucination denylist: empirical, mostly Whisper-specific YouTube outros.
  // Phase 8 may extend or replace with a Parakeet-specific list once the model's
  // failure modes on real DJI captures are documented.
  if (isLikelyHallucination(result)) {
    console.warn(`[stt] Rejected hallucination: "${result}"`)
    throw new Error('No speech detected (likely background noise)')
  }
  return result
}
