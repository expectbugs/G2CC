// TTS — warm Kokoro daemon manager (earbud lane, 2026-08-04, docs/EARBUD_SPEC.md).
//
// Mirror of stt.ts's ParakeetDaemon on the synthesis side: spawn
// audio/pipeline/tts_daemon.py ONCE (Kokoro ONNX loads in ~0.8 s on CPU —
// measured 2026-08-04; warm first-audio ~0.24 s), then stream many utterances
// through it. One difference from the ASR manager: a TTS job emits a STREAM of
// sentinel blocks (one per synthesized sentence, then a `done` block), so the
// inflight slot carries an onChunk callback and stays occupied until done/error.
//
// Serialized single-inflight queue, identity-gated respawn on crash, buffer
// cap against a wedged stream, NO timeouts (server supervises externally).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { G2CCConfig } from './config.js'

const DAEMON_RESULT_BEGIN = '___G2CC_RESULT_BEGIN___'
const DAEMON_RESULT_END = '___G2CC_RESULT_END___'
const DAEMON_ERROR_BEGIN = '___G2CC_ERROR_BEGIN___'
const DAEMON_ERROR_END = '___G2CC_ERROR_END___'
// A single sentence block can carry ~2 MB of base64 PCM (a hard-max 450-char
// unit ≈ 30 s of 24 kHz s16 audio). The cap only trips on a WEDGED stream
// (no complete sentinel block while a job is in flight) — same SRV-17
// rationale as the ASR daemon, sized for the bigger frames.
const DAEMON_MAX_BUF = 8 * 1024 * 1024

export interface TtsChunk {
  seq: number
  /** Raw PCM16LE mono @ TTS_SAMPLE_RATE (24 kHz). */
  pcm: Buffer
  /** Duration of this chunk in ms (from the daemon's sample count). */
  ms: number
}

export interface TtsResult {
  sentences: number
  totalMs: number
}

interface TtsJob {
  line: string
  onChunk: (chunk: TtsChunk) => void
  resolve: (r: TtsResult) => void
  reject: (e: Error) => void
}

class TtsDaemon {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private queue: TtsJob[] = []
  private inflight: TtsJob | null = null

  constructor(
    private pythonPath: string,
    private cwd: string,
    private modelDir: string,
    private voice: string,
    private speed: number,
  ) {}

  /** Synthesize `text`, streaming PCM chunks to onChunk as sentences complete.
   *  Resolves with the sentence/duration summary once the daemon's done block
   *  arrives; rejects on a daemon error block or process death (loud). Chunks
   *  delivered before an error STAY delivered — the caller speaks what it got. */
  synthesize(text: string, onChunk: (chunk: TtsChunk) => void, speed?: number): Promise<TtsResult> {
    const line = JSON.stringify({ text, speed: speed ?? this.speed })
    return new Promise<TtsResult>((resolve, reject) => {
      this.queue.push({ line, onChunk, resolve, reject })
      this.pump()
    })
  }

  private ensureProc(): void {
    if (this.proc) return
    // -u: unbuffered stdio. Voice/model/speed ride env (config.tts) exactly
    // like G2CC_ASR_MODEL does for the ASR daemon — a voice change is a config
    // flip + daemon restart, not a code change.
    const proc = spawn(this.pythonPath, ['-u', '-m', 'pipeline.tts_daemon'], {
      cwd: this.cwd,
      env: {
        ...process.env,
        G2CC_TTS_MODEL_DIR: this.modelDir,
        G2CC_TTS_VOICE: this.voice,
        G2CC_TTS_SPEED: String(this.speed),
      },
    })
    this.proc = proc
    this.buf = ''
    proc.stdout.setEncoding('utf-8')
    // Identity-gated (the ASR daemon's review-2026-06-11 fix): late pipe data
    // from a killed predecessor must not pollute the fresh daemon's buffer.
    proc.stdout.on('data', (c: string) => { if (this.proc === proc) this.onStdout(c) })
    proc.stderr.on('data', () => { /* Kokoro/ONNX chatter — ignored unless it dies */ })
    proc.stdin.on('error', (e: Error) => console.warn(`[tts] daemon stdin error: ${e}`))
    const die = (err: Error): void => {
      if (this.proc !== proc) return
      this.proc = null
      if (this.inflight) { const j = this.inflight; this.inflight = null; j.reject(err) }
      while (this.queue.length) this.queue.shift()!.reject(err)
    }
    proc.on('exit', (code, signal) => {
      console.warn(`[tts] daemon exited (code=${code} signal=${signal})`)
    })
    // Reject on 'close' (not 'exit') so a result flushed just before death
    // finishes draining through the pipe first — the ASR daemon's C6 fix.
    proc.on('close', (code, signal) => {
      die(new Error(`tts daemon exited (code=${code} signal=${signal})`))
    })
    proc.on('error', (e) => { console.error(`[tts] daemon spawn error: ${e}`); die(e) })
  }

  private pump(): void {
    if (this.inflight || this.queue.length === 0) return
    this.ensureProc()
    const proc = this.proc
    if (!proc) return                 // spawn failed; rejects already fired
    const job = this.queue.shift()!
    this.inflight = job
    try {
      proc.stdin.write(job.line + '\n')
    } catch (e) {
      this.inflight = null
      job.reject(e as Error)
    }
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    if (this.inflight && this.buf.length > DAEMON_MAX_BUF) {
      console.error(`[tts] daemon stdout exceeded ${DAEMON_MAX_BUF} bytes with no complete block — killing + respawning`)
      this.buf = ''
      const job = this.inflight; this.inflight = null
      const dying = this.proc; this.proc = null
      job.reject(new Error('tts daemon stdout overflow (no complete block); respawning'))
      try { dying?.kill('SIGKILL') } catch { /* already dead */ }
      this.pump()
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
      if (haveRes && (!haveErr || rb < eb)) {
        const body = this.buf.substring(rb + DAEMON_RESULT_BEGIN.length, re).trim()
        this.buf = this.buf.substring(re + DAEMON_RESULT_END.length)
        let parsed: { seq?: number; pcm_b64?: string; ms?: number; done?: boolean; sentences?: number; totalMs?: number }
        try {
          parsed = JSON.parse(body)
        } catch (e) {
          // A malformed block ends the job loudly — the daemon and manager are
          // out of sync and continuing would mis-attribute audio.
          this.inflight = null
          job.reject(new Error(`tts daemon emitted unparseable block (${(e as Error).message}): ${body.slice(0, 120)}`))
          this.pump()
          continue
        }
        if (parsed.done) {
          this.inflight = null
          job.resolve({ sentences: parsed.sentences ?? 0, totalMs: parsed.totalMs ?? 0 })
          this.pump()
        } else if (typeof parsed.pcm_b64 === 'string') {
          // Chunk callback errors must not wedge the daemon stream — surface
          // them loudly and keep consuming (the job still completes honestly).
          try {
            job.onChunk({ seq: parsed.seq ?? 0, pcm: Buffer.from(parsed.pcm_b64, 'base64'), ms: parsed.ms ?? 0 })
          } catch (e) {
            console.error(`[tts] onChunk callback threw (chunk ${parsed.seq}): ${e}`)
          }
          // stay inflight — more blocks coming
        } else {
          this.inflight = null
          job.reject(new Error(`tts daemon block missing pcm_b64/done: ${body.slice(0, 120)}`))
          this.pump()
        }
      } else {
        const m = this.buf.substring(eb + DAEMON_ERROR_BEGIN.length, ee).trim()
        this.buf = this.buf.substring(ee + DAEMON_ERROR_END.length)
        this.inflight = null
        job.reject(new Error(m))
        this.pump()
      }
    }
  }
}

let ttsDaemon: TtsDaemon | null = null

export function getTtsDaemon(config: G2CCConfig): TtsDaemon {
  if (!ttsDaemon) {
    ttsDaemon = new TtsDaemon(
      config.stt.pythonPath,
      '/home/user/G2CC/audio',
      config.tts.modelDir,
      config.tts.voice,
      config.tts.speed,
    )
  }
  return ttsDaemon
}

/** Pre-load Kokoro so the first real utterance isn't a cold load (~1 s — small,
 *  but the first spoken word shouldn't stutter). Fire-and-forget at boot;
 *  chunks are discarded. On failure the next real speak lazy-loads. */
export async function warmTts(config: G2CCConfig): Promise<void> {
  if (config.tts.engine !== 'kokoro') return
  try {
    const t0 = Date.now()
    const r = await getTtsDaemon(config).synthesize('Ready.', () => { /* warm-up audio discarded */ })
    console.log(`[tts] Kokoro daemon warm (${Date.now() - t0} ms, ${r.sentences} unit, voice ${config.tts.voice})`)
  } catch (err) {
    console.warn(`[tts] warm-up failed (lazy-loads on first speak): ${err}`)
  }
}
