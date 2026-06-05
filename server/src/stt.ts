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
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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

// ---- Warm Parakeet daemon: load the NeMo model ONCE, transcribe many ----
// The old per-request execFile(parakeet_cli) cold-loaded the model (~12 s) on
// EVERY call (the "transcribing…" stall). This persistent process loads it once
// (pipeline/parakeet_daemon.py); subsequent transcriptions are ~0.5 s.
// Serializes requests (one at a time), respawns loudly on crash, no timeouts.

const DAEMON_RESULT_BEGIN = '___G2CC_RESULT_BEGIN___'
const DAEMON_RESULT_END = '___G2CC_RESULT_END___'
const DAEMON_ERROR_BEGIN = '___G2CC_ERROR_BEGIN___'
const DAEMON_ERROR_END = '___G2CC_ERROR_END___'
// SRV-17: a transcript frame is tiny; this only catches a runaway / never-
// terminated block (crash mid-write, stdout flood) so the buffer can't grow
// without bound while the inflight promise hangs forever.
const DAEMON_MAX_BUF = 4 * 1024 * 1024

class ParakeetDaemon {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private queue: Array<{ wav: string; resolve: (t: string) => void; reject: (e: Error) => void }> = []
  private inflight: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null

  constructor(private pythonPath: string, private cwd: string) {}

  transcribe(wavPath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ wav: wavPath, resolve, reject })
      this.pump()
    })
  }

  private ensureProc(): void {
    if (this.proc) return
    // -u: unbuffered stdio so each request line is read and each result flushed now.
    const proc = spawn(this.pythonPath, ['-u', '-m', 'pipeline.parakeet_daemon'], { cwd: this.cwd })
    this.proc = proc
    this.buf = ''
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (c: string) => this.onStdout(c))
    proc.stderr.on('data', () => { /* NeMo / tqdm chatter — ignored unless it dies */ })
    proc.stdin.on('error', (e: Error) => console.warn(`[stt] parakeet daemon stdin error: ${e}`))
    const die = (err: Error): void => {
      // Only clean up if THIS proc is still the current one — a later respawn
      // (e.g. the SRV-17 overflow path) may have already replaced it, and we
      // must not null/reject the fresh daemon's state.
      if (this.proc !== proc) return
      this.proc = null
      if (this.inflight) { const j = this.inflight; this.inflight = null; j.reject(err) }
      while (this.queue.length) this.queue.shift()!.reject(err)
    }
    proc.on('exit', (code, signal) => {
      console.warn(`[stt] parakeet daemon exited (code=${code} signal=${signal})`)
      die(new Error(`parakeet daemon exited (code=${code} signal=${signal})`))
    })
    proc.on('error', (e) => { console.error(`[stt] parakeet daemon spawn error: ${e}`); die(e) })
  }

  private pump(): void {
    if (this.inflight || this.queue.length === 0) return
    this.ensureProc()
    const proc = this.proc
    if (!proc) return                 // spawn failed; the reject already fired
    const job = this.queue.shift()!
    this.inflight = { resolve: job.resolve, reject: job.reject }
    try {
      proc.stdin.write(job.wav + '\n')
    } catch (e) {
      const j = this.inflight; this.inflight = null
      j.reject(e as Error)
    }
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    // SRV-17: bound the buffer. If it grows past the cap with a request still in
    // flight and no complete sentinel block, the daemon is wedged/flooding —
    // reject loudly, drop the broken proc, and respawn a fresh one (so the
    // promise can't hang forever; honors no-timeouts by supervising externally).
    if (this.inflight && this.buf.length > DAEMON_MAX_BUF) {
      console.error(`[stt] parakeet daemon stdout exceeded ${DAEMON_MAX_BUF} bytes with no result frame — killing + respawning`)
      this.buf = ''
      const job = this.inflight; this.inflight = null
      const dying = this.proc; this.proc = null   // next pump() → ensureProc() spawns fresh
      job.reject(new Error('parakeet daemon stdout overflow (no result frame); respawning'))
      try { dying?.kill('SIGKILL') } catch { /* already dead */ }
      this.pump()                                 // drain any queued jobs onto the fresh daemon
      return
    }
    while (this.inflight) {
      const rb = this.buf.indexOf(DAEMON_RESULT_BEGIN)
      const re = rb >= 0 ? this.buf.indexOf(DAEMON_RESULT_END, rb) : -1
      const eb = this.buf.indexOf(DAEMON_ERROR_BEGIN)
      const ee = eb >= 0 ? this.buf.indexOf(DAEMON_ERROR_END, eb) : -1
      const haveRes = rb >= 0 && re >= 0
      const haveErr = eb >= 0 && ee >= 0
      if (!haveRes && !haveErr) break
      const job = this.inflight
      this.inflight = null
      if (haveRes && (!haveErr || rb < eb)) {
        const text = this.buf.substring(rb + DAEMON_RESULT_BEGIN.length, re).trim()
        this.buf = this.buf.substring(re + DAEMON_RESULT_END.length)
        job.resolve(text)
      } else {
        const m = this.buf.substring(eb + DAEMON_ERROR_BEGIN.length, ee).trim()
        this.buf = this.buf.substring(ee + DAEMON_ERROR_END.length)
        job.reject(new Error(m))
      }
      this.pump()
    }
  }
}

let parakeetDaemon: ParakeetDaemon | null = null
function getParakeetDaemon(config: G2CCConfig): ParakeetDaemon {
  if (!parakeetDaemon) parakeetDaemon = new ParakeetDaemon(config.stt.pythonPath, '/home/user/G2CC/audio')
  return parakeetDaemon
}

/** Pre-load the Parakeet model so the FIRST real voice command isn't a ~12 s cold
 *  load. Sends 1 s of silence through the daemon (which lazy-loads the model on
 *  its first transcribe). Fire-and-forget at server start; on failure the next
 *  real request just lazy-loads. */
export async function warmParakeet(config: G2CCConfig): Promise<void> {
  if (config.stt.engine !== 'parakeet') return
  const tmp = join('/tmp', 'g2cc-stt-warmup.wav')
  writeFileSync(tmp, pcmToWav(Buffer.alloc(16_000 * 2), 16000, 16, 1))   // 1 s silence
  try {
    const t0 = Date.now()
    await getParakeetDaemon(config).transcribe(tmp)
    console.log(`[stt] Parakeet daemon warm (${Date.now() - t0} ms model load)`)
  } catch (err) {
    console.warn(`[stt] Parakeet warm-up failed (lazy-loads on first request): ${err}`)
  } finally {
    if (existsSync(tmp)) { try { unlinkSync(tmp) } catch (e) { console.warn(`[stt] warmup cleanup: ${e}`) } }
  }
}

/** Phase 8: Parakeet TDT 0.6B v2 via the WARM pipeline/parakeet_daemon.py
 *  (persistent — model loaded once). No timeout; the daemon is supervised by the
 *  server lifecycle. REQUIRES `nemo_toolkit[asr]` in audio/venv. */
async function transcribeParakeet(wavPath: string, config: G2CCConfig): Promise<string> {
  const result = (await getParakeetDaemon(config).transcribe(wavPath)).trim()
  console.log(`[stt] parakeet result (${result.length} chars): "${result}"`)
  if (isLikelyHallucination(result)) {
    console.warn(`[stt] Rejected hallucination: "${result}"`)
    throw new Error('No speech detected (likely background noise)')
  }
  return result
}
