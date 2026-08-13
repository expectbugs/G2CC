// ff1/bridge.ts — JSON-lines stdio client for games/ff1/bridge/ff1_daemon.py
// (PLAN §3/§4). Mirrors stt.ts ParakeetDaemon exactly: single inflight job,
// FIFO queue, pump, identity-gated respawn on death, reject-on-'close' (not
// 'exit' — a result flushed just before death is still draining at 'exit'),
// NO timeouts anywhere (the daemon is frame-budgeted internally; supervision
// is the engine's watchdog, not wall-clock I/O wrappers).
//
// Protocol (verified against ff1_daemon.py run()): one JSON object per line in,
// EXACTLY one JSON object per line out carrying the request's `seq` —
// responses arrive strictly in request order, so single-inflight matching is
// sound; the seq is still checked and a mismatch is LOUD.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

/** The FF1 project dir (daemon + venv + ROM live here). Env override for the
 *  smoke suite, mirroring G2CC_PAPERCLIPS_DIR. */
export const FF1_DIR = process.env.G2CC_FF1_DIR ?? '/home/user/G2CC/games/ff1'

/** Runaway/wedge backstop only (SRV-17 shape): a normal response is ≤ ~40 KB
 *  (savestate b64 ≈ 29 KB; a map-frame PNG b64 lands well under 1 MB). */
const MAX_BUF = 16 * 1024 * 1024

interface Job {
  line: string
  op: string
  seq: number
  resolve: (r: Record<string, unknown>) => void
  reject: (e: Error) => void
}

/** Thrown when the daemon answers `{error, traceback}` — the op itself failed
 *  (desync, budget overrun, bad request); the daemon is still alive. */
export class Ff1OpError extends Error {
  constructor(message: string, readonly traceback?: string) { super(message) }
}

export class Ff1Bridge {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private queue: Job[] = []
  private inflight: Job | null = null
  private seq = 0
  /** Called (once per death) when the daemon dies with the spawn generation —
   *  the engine's watchdog respawn hook (PLAN §3). */
  onDeath: ((err: Error) => void) | null = null

  constructor(private dir: string = FF1_DIR) {}

  alive(): boolean { return this.proc !== null }

  /** Send one op. Resolves with the daemon's response object (ok:true) or
   *  rejects: Ff1OpError for an in-protocol failure, plain Error for a dead
   *  daemon (queued + inflight jobs all reject on death — LOUD, no limbo). */
  request(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const seq = ++this.seq
    const line = JSON.stringify({ op, seq, ...fields })
    return new Promise((resolve, reject) => {
      this.queue.push({ line, op, seq, resolve, reject })
      this.pump()
    })
  }

  /** Kill the daemon (engine shutdown / smoke teardown). Queued jobs reject
   *  via the 'close' path. */
  kill(): void {
    const p = this.proc
    if (!p) return
    try { p.kill('SIGKILL') } catch (e) {
      console.error(`[ff1] bridge kill failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private ensureProc(): void {
    if (this.proc) return
    const python = join(this.dir, 'venv', 'bin', 'python')
    const daemon = join(this.dir, 'bridge', 'ff1_daemon.py')
    // -u: unbuffered stdio so each request line is read and each response
    // flushed immediately (the daemon also flush=True's every print).
    const proc = spawn(python, ['-u', daemon], { cwd: this.dir })
    this.proc = proc
    this.buf = ''
    proc.stdout.setEncoding('utf-8')
    // Identity-gated (stt.ts): late pipe data from a killed predecessor must
    // not pollute the fresh daemon's buffer or resolve its jobs.
    proc.stdout.on('data', (c: string) => { if (this.proc === proc) this.onStdout(c) })
    proc.stderr.setEncoding('utf-8')
    // The daemon's stderr lines ([ff1-daemon] …) are its LOUD channel — forward.
    proc.stderr.on('data', (c: string) => {
      for (const ln of c.split('\n')) if (ln.trim()) console.error(`[ff1] ${ln.trim()}`)
    })
    proc.stdin.on('error', (e: Error) => console.error(`[ff1] daemon stdin error: ${e.message}`))
    const die = (err: Error): void => {
      if (this.proc !== proc) return
      this.proc = null
      this.buf = ''
      if (this.inflight) { const j = this.inflight; this.inflight = null; j.reject(err) }
      while (this.queue.length) this.queue.shift()!.reject(err)
      // Watchdog hook AFTER the rejects, so the engine sees a clean bridge.
      if (this.onDeath) this.onDeath(err)
    }
    proc.on('exit', (code, signal) => {
      console.error(`[ff1] daemon exited (code=${code} signal=${signal})`)
    })
    proc.on('close', (code, signal) => {
      die(new Error(`ff1 daemon exited (code=${code} signal=${signal})`))
    })
    // 'close' never fires for a failed spawn (ENOENT/EACCES) — die() here too;
    // the identity gate makes a second call a no-op.
    proc.on('error', (e) => { console.error(`[ff1] daemon spawn error: ${e.message}`); die(e) })
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
    if (this.buf.length > MAX_BUF) {
      // Wedged/flooding daemon (inflight or not — an idle daemon emitting at
      // all is already wrong; Ph-F review closed the idle-unbounded gap).
      // Treat as a DEATH: reject everything and fire onDeath so the ENGINE
      // re-boots the replacement — the old path spawned a fresh daemon with
      // no ROM loaded and never told the engine, wedging every later op on
      // 'no ROM booted' (Ph-F review find).
      console.error(`[ff1] daemon stdout exceeded ${MAX_BUF} bytes with no complete response — killing (engine reboots via onDeath)`)
      this.buf = ''
      const dying = this.proc; this.proc = null
      const err = new Error('ff1 daemon stdout overflow (no response line)')
      if (this.inflight) { const j = this.inflight; this.inflight = null; j.reject(err) }
      while (this.queue.length) this.queue.shift()!.reject(err)
      try { dying?.kill('SIGKILL') } catch { /* already dead */ }
      if (this.onDeath) this.onDeath(err)
      return
    }
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let resp: Record<string, unknown>
      try {
        resp = JSON.parse(line) as Record<string, unknown>
      } catch (e) {
        // Protocol corruption is fatal for the inflight job — LOUD.
        console.error(`[ff1] daemon emitted non-JSON on stdout (${line.length} chars): ${line.slice(0, 200)}`)
        const job = this.inflight; this.inflight = null
        job?.reject(new Error(`ff1 daemon protocol corruption: ${e instanceof Error ? e.message : String(e)}`))
        this.pump()
        continue
      }
      const job = this.inflight
      if (!job) {
        console.error(`[ff1] daemon response with no inflight job (seq=${String(resp['seq'])}) — dropped LOUDLY`)
        continue
      }
      if (resp['seq'] !== job.seq) {
        // One-response-per-request in order is the protocol; a mismatch means
        // the streams desynced — fail the job, keep the line count honest.
        this.inflight = null
        job.reject(new Error(`ff1 daemon seq mismatch: got ${String(resp['seq'])}, expected ${job.seq} (op ${job.op})`))
        this.pump()
        continue
      }
      this.inflight = null
      if (typeof resp['error'] === 'string') {
        const tb = typeof resp['traceback'] === 'string' ? resp['traceback'] : undefined
        console.error(`[ff1] op ${job.op} failed: ${resp['error']}${tb ? `\n${tb}` : ''}`)
        job.reject(new Ff1OpError(resp['error'], tb))
      } else {
        job.resolve(resp)
      }
      this.pump()
    }
  }
}
