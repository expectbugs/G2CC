// System stats (Adam 2026-06-12) — the deep-stats pages behind Main → Stats.
//
// A 10 s sampler (pacing cadence) keeps ~1 h ring buffers of CPU%, RAM/swap,
// CPU/GPU temperature, GPU util/VRAM — charts render from these via the
// Phase-8 ```chart pipeline (render_chart.py, page-≥2-class imagery: the
// user explicitly dug in). Storage + process pages are sampled on demand
// (execFile — B4). Everything degrades loudly: a dead nvidia-smi or missing
// hwmon logs ONCE and renders as "(unavailable)" — never wedges a page.
//
// Sources (verified on beardos 2026-06-12):
//   CPU %    /proc/stat aggregate delta
//   RAM/swap /proc/meminfo (MemTotal/MemAvailable/SwapTotal/SwapFree)
//   CPU temp /sys/class/hwmon/<coretemp>/temp1_input (Package id 0)
//   GPU      nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,
//            temperature.gpu --format=csv,noheader,nounits
//   Disks    df -B1 --output=target,size,avail <mounts that exist>
//   Procs    ps axo pid,pcpu,pmem,rss,comm --sort=-pcpu / -pmem

import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { evaluateSampleAlerts, evaluateVolumeAlerts, fireStatsAlert } from './stats-alerts.js'

const SAMPLE_MS = 10_000          // pacing cadence
const RING_MAX = 360              // ~1 h at 10 s

export interface StatSample {
  ts: number
  cpuPct: number | null
  ramUsedMb: number | null
  ramTotalMb: number | null
  swapUsedMb: number | null
  swapTotalMb: number | null
  cpuTempC: number | null
  gpuPct: number | null
  gpuMemMb: number | null
  gpuMemTotalMb: number | null
  gpuTempC: number | null
}

const ring: StatSample[] = []
export function samples(): readonly StatSample[] { return ring }

// ---- CPU % (aggregate /proc/stat delta) -----------------------------------

let prevCpu: { idle: number; total: number } | null = null

function readCpuTimes(): { idle: number; total: number } | null {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0]
    const f = line.trim().split(/\s+/).slice(1).map(Number)
    if (f.length < 5 || f.some(Number.isNaN)) return null
    const idle = f[3] + (f[4] ?? 0)            // idle + iowait
    const total = f.reduce((a, b) => a + b, 0)
    return { idle, total }
  } catch { return null }
}

function sampleCpuPct(): number | null {
  const cur = readCpuTimes()
  if (!cur) return null
  const prev = prevCpu
  prevCpu = cur
  if (!prev || cur.total <= prev.total) return null   // first sample / counter reset
  const dTotal = cur.total - prev.total
  const dIdle = cur.idle - prev.idle
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)))
}

// ---- RAM / swap ------------------------------------------------------------

function sampleMem(): { ramUsedMb: number; ramTotalMb: number; swapUsedMb: number; swapTotalMb: number } | null {
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8')
    const kb = (key: string): number | null => {
      const m = mi.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))
      return m ? Number(m[1]) : null
    }
    const total = kb('MemTotal'); const avail = kb('MemAvailable')
    const st = kb('SwapTotal'); const sf = kb('SwapFree')
    if (total === null || avail === null || st === null || sf === null) return null
    return {
      ramUsedMb: Math.round((total - avail) / 1024),
      ramTotalMb: Math.round(total / 1024),
      swapUsedMb: Math.round((st - sf) / 1024),
      swapTotalMb: Math.round(st / 1024),
    }
  } catch { return null }
}

// ---- CPU temp (coretemp hwmon, discovered once) ----------------------------

let coretempPath: string | null | undefined   // undefined = not probed yet

function findCoretemp(): string | null {
  try {
    for (const h of readdirSync('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${h}`
      try {
        if (readFileSync(`${base}/name`, 'utf8').trim() === 'coretemp'
            && existsSync(`${base}/temp1_input`)) return `${base}/temp1_input`
      } catch { /* per-entry: try the next hwmon */ }
    }
  } catch (e) {
    console.error(`[stats] hwmon scan failed: ${(e as Error).message}`)
  }
  return null
}

function sampleCpuTemp(): number | null {
  if (coretempPath === undefined) {
    coretempPath = findCoretemp()
    if (!coretempPath) console.error('[stats] no coretemp hwmon found — CPU temp will read (unavailable)')
  }
  if (!coretempPath) return null
  try {
    return Math.round(Number(readFileSync(coretempPath, 'utf8').trim()) / 1000)
  } catch { return null }
}

// ---- GPU (nvidia-smi, async) -----------------------------------------------

let gpuFailedOnce = false

function sampleGpu(): Promise<{ gpuPct: number; gpuMemMb: number; gpuMemTotalMb: number; gpuTempC: number } | null> {
  return new Promise((resolve) => {
    execFile('nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          if (!gpuFailedOnce) { gpuFailedOnce = true; console.error(`[stats] nvidia-smi failed (GPU stats unavailable): ${err.message}`) }
          resolve(null); return
        }
        const p = stdout.trim().split(',').map((s) => Number(s.trim()))
        if (p.length < 4 || p.some(Number.isNaN)) { resolve(null); return }
        gpuFailedOnce = false
        resolve({ gpuPct: p[0], gpuMemMb: p[1], gpuMemTotalMb: p[2], gpuTempC: p[3] })
      })
  })
}

// ---- the sampler ------------------------------------------------------------

let started = false

export function startStatsSampler(): void {
  if (started) return
  started = true
  prevCpu = readCpuTimes()   // prime the delta
  const tick = async (): Promise<void> => {
    const gpu = await sampleGpu()
    const mem = sampleMem()
    const sample: StatSample = {
      ts: Date.now(),
      cpuPct: sampleCpuPct(),
      ramUsedMb: mem?.ramUsedMb ?? null,
      ramTotalMb: mem?.ramTotalMb ?? null,
      swapUsedMb: mem?.swapUsedMb ?? null,
      swapTotalMb: mem?.swapTotalMb ?? null,
      cpuTempC: sampleCpuTemp(),
      gpuPct: gpu?.gpuPct ?? null,
      gpuMemMb: gpu?.gpuMemMb ?? null,
      gpuMemTotalMb: gpu?.gpuMemTotalMb ?? null,
      gpuTempC: gpu?.gpuTempC ?? null,
    }
    ring.push(sample)
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
    // Phase 10: threshold alerts (sustained crossings fire ONCE via the notify
    // layer). Never throws — the alert step is pure state + a fire-and-forget.
    evaluateSampleAlerts(sample, sample.ts, fireStatsAlert)
  }
  void tick().catch((e: unknown) => console.error(`[stats] first sample failed: ${e instanceof Error ? e.message : String(e)}`))
  setInterval(() => {
    void tick().catch((e: unknown) => console.error(`[stats] sample failed: ${e instanceof Error ? e.message : String(e)}`))
  }, SAMPLE_MS)
  // Volume-fullness alerts on a slower cadence (df is heavier; 5 min is plenty
  // for a 30-min sustain window). A maintenance cadence, not an I/O timeout.
  const volTick = (): void => {
    void readStorage()
      .then((rows) => evaluateVolumeAlerts(rows, Date.now(), fireStatsAlert))
      .catch((e: unknown) => console.error(`[stats] volume-alert df failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  volTick()
  setInterval(volTick, 5 * 60_000)
  console.log(`[stats] sampler started (${SAMPLE_MS / 1000}s cadence, ${RING_MAX}-sample ring ≈ 1 h)`)
}

// ---- on-demand pages ---------------------------------------------------------

const DF_MOUNTS = ['/', '/mnt/lilhomie', '/mnt/turtle', '/mnt/slug', '/run/media/user/vault']

export function readStorage(): Promise<{ target: string; sizeB: number; availB: number }[]> {
  // Only pass mounts that exist (vault is often absent — df errors on missing).
  const present = DF_MOUNTS.filter((m) => existsSync(m))
  return new Promise((resolve, reject) => {
    execFile('df', ['-B1', '--output=target,size,avail', ...present], { maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`df failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`)); return }
        const rows = stdout.trim().split('\n').slice(1).map((l) => {
          const m = l.trim().split(/\s+/)
          return { target: m[0], sizeB: Number(m[1]), availB: Number(m[2]) }
        }).filter((r) => r.target && !Number.isNaN(r.sizeB))
        resolve(rows)
      })
  })
}

export function readTopProcs(by: 'cpu' | 'mem', n = 12): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['axo', 'pid,pcpu,pmem,rss,comm', `--sort=-p${by}`, '--no-headers'],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`ps failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`)); return }
        resolve(stdout.trim().split('\n').slice(0, n).map((l) => {
          const m = l.trim().split(/\s+/)
          const [pid, pcpu, pmem, rss, ...comm] = m
          const rssMb = Math.round(Number(rss) / 1024)
          return `${pcpu!.padStart(5)}% ${pmem!.padStart(4)}% ${String(rssMb).padStart(5)}M ${comm.join(' ').slice(0, 18)} (${pid})`
        }))
      })
  })
}

// ---- chart specs from the ring ------------------------------------------------

/** NUMERIC x (minutes ago, ≤0) — string labels would render as CATEGORICAL
 *  ticks in matplotlib: 360 of them = an unreadable smear on a 480 px chart.
 *  A numeric axis auto-thins to a handful of clean ticks. */
function xMinutesAgo(ss: readonly StatSample[]): number[] {
  const now = Date.now()
  return ss.map((s) => Math.round((s.ts - now) / 6_000) / 10)
}

function series(ss: readonly StatSample[], pick: (s: StatSample) => number | null): number[] {
  // Charts need numbers; gaps render as 0 with a log (rare — sampler keeps going).
  return ss.map((s) => pick(s) ?? 0)
}

export interface ChartSpecPage { title: string; spec: Record<string, unknown> }

/** The time-series chart specs (render via os-content renderChart). Null when
 *  the ring is still too short to chart (first ~30 s after boot). */
export function chartSpecs(): ChartSpecPage[] | null {
  const ss = ring
  if (ss.length < 3) return null
  const x = xMinutesAgo(ss)
  return [
    {
      title: 'CPU %',
      spec: { type: 'line', title: 'CPU usage % (last hour)', xlabel: 'min ago', x, series: [{ label: 'cpu', y: series(ss, (s) => s.cpuPct) }] },
    },
    {
      title: 'Temps',
      spec: {
        type: 'line', title: 'Temps °C (last hour)', xlabel: 'min ago', x,
        series: [
          { label: 'cpu', y: series(ss, (s) => s.cpuTempC) },
          { label: 'gpu', y: series(ss, (s) => s.gpuTempC) },
        ],
      },
    },
    {
      title: 'GPU',
      spec: {
        type: 'line', title: 'GPU % + VRAM GB (last hour)', xlabel: 'min ago', x,
        series: [
          { label: 'util %', y: series(ss, (s) => s.gpuPct) },
          { label: 'vram GB', y: series(ss, (s) => s.gpuMemMb === null ? null : Math.round(s.gpuMemMb / 102.4) / 10) },
        ],
      },
    },
    {
      title: 'RAM',
      spec: {
        type: 'line', title: 'RAM + swap GB (last hour)', xlabel: 'min ago', x,
        series: [
          { label: 'ram GB', y: series(ss, (s) => s.ramUsedMb === null ? null : Math.round(s.ramUsedMb / 102.4) / 10) },
          { label: 'swap GB', y: series(ss, (s) => s.swapUsedMb === null ? null : Math.round(s.swapUsedMb / 102.4) / 10) },
        ],
      },
    },
  ]
}

const GB = 1024 ** 3

/** The "now" overview text page. */
export function overviewText(): string {
  const s = ring[ring.length - 1]
  if (!s) return '(no samples yet — the 10 s sampler just started)'
  const pct = (used: number | null, total: number | null): string =>
    used !== null && total ? ` (${Math.round((used / total) * 100)}%)` : ''
  const lines = [
    `CPU     ${s.cpuPct ?? '--'} %   ·   ${s.cpuTempC ?? '--'} °C`,
    `RAM     ${s.ramUsedMb !== null ? (s.ramUsedMb / 1024).toFixed(1) : '--'} / ${s.ramTotalMb !== null ? (s.ramTotalMb / 1024).toFixed(1) : '--'} GB${pct(s.ramUsedMb, s.ramTotalMb)}`,
    `swap    ${s.swapUsedMb !== null ? (s.swapUsedMb / 1024).toFixed(1) : '--'} GB used`,
    `GPU     ${s.gpuPct ?? '--'} %   ·   ${s.gpuTempC ?? '--'} °C`,
    `VRAM    ${s.gpuMemMb !== null ? (s.gpuMemMb / 1024).toFixed(1) : '--'} / ${s.gpuMemTotalMb !== null ? (s.gpuMemTotalMb / 1024).toFixed(1) : '--'} GB${pct(s.gpuMemMb, s.gpuMemTotalMb)}`,
    '',
    `${ring.length} samples · ${new Date(s.ts).toLocaleTimeString()}`,
  ]
  return lines.join('\n')
}

export function storageText(rows: { target: string; sizeB: number; availB: number }[]): string {
  const lines = rows.map((r) => {
    const used = r.sizeB - r.availB
    const pct = Math.round((used / r.sizeB) * 100)
    return `${r.target.padEnd(18).slice(0, 18)} ${(used / GB).toFixed(0).padStart(5)}G/${(r.sizeB / GB).toFixed(0)}G ${String(pct).padStart(3)}%`
  })
  const missing = DF_MOUNTS.filter((m) => !existsSync(m))
  if (missing.length) lines.push('', ...missing.map((m) => `${m} (not mounted)`))
  return lines.join('\n')
}
