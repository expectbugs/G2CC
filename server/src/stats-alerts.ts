// Stats threshold alerts (upgrades.md Phase 10) — the 10 s sampler + a slower
// volume check feed rules of the shape (metric, threshold, SUSTAIN, re-arm).
//
// "Sustained means sustained" (Adam 2026-06-12: "not just a couple of minutes
// while generating an image"): a rule fires only after the condition holds
// CONTINUOUSLY for its sustain window. Re-arm: once fired, no repeat within
// the re-arm window UNLESS the metric dropped below and re-crossed (a real new
// event) — a drop clears both the sustain clock AND the fired stamp, so a fresh
// sustained crossing fires immediately; a metric pinned over threshold re-fires
// only every re-arm window. Data-unavailable (null) holds state, never fires.
//
// Fires priority `info` through the notification layer (the title-flash class —
// and the Phase-2 blank flash if the screen is dark).

import { notify } from './os-notify.js'

const MIN = 60_000
/** No repeat within 2 h while continuously over threshold (Adam). */
const REARM_MS = 2 * 60 * MIN

export interface SampleLike {
  cpuTempC: number | null
  gpuTempC: number | null
  ramUsedMb: number | null
  ramTotalMb: number | null
  swapUsedMb: number | null
  swapTotalMb: number | null
}

interface AlertRule {
  key: string
  label: string
  /** true = currently crossed; false = below; null = data unavailable. */
  test: (s: SampleLike) => boolean | null
  sustainMs: number
}

/** Defaults (Adam 2026-06-12); tune here. GPU throttles ~83-87 °C, CPU ~100 °C. */
export const SAMPLE_RULES: AlertRule[] = [
  { key: 'gpu_temp', label: 'GPU temp >87°C (sustained 10m)', sustainMs: 10 * MIN, test: (s) => s.gpuTempC === null ? null : s.gpuTempC > 87 },
  { key: 'cpu_temp', label: 'CPU temp >95°C (sustained 5m)', sustainMs: 5 * MIN, test: (s) => s.cpuTempC === null ? null : s.cpuTempC > 95 },
  {
    key: 'ram_swap', label: 'RAM >95% AND swap >50% (sustained 10m)', sustainMs: 10 * MIN,
    test: (s) => {
      if (s.ramUsedMb === null || !s.ramTotalMb || s.swapUsedMb === null || !s.swapTotalMb) return null
      return s.ramUsedMb / s.ramTotalMb > 0.95 && s.swapUsedMb / s.swapTotalMb > 0.50
    },
  },
]

const VOL_PCT = 95
const VOL_SUSTAIN_MS = 30 * MIN

interface RuleState { crossedSince: number | null; lastFiredAt: number | null }
const state = new Map<string, RuleState>()

function ruleState(key: string): RuleState {
  let s = state.get(key)
  if (!s) { s = { crossedSince: null, lastFiredAt: null }; state.set(key, s) }
  return s
}

/** Advance one rule's state machine; returns true if it should FIRE this step.
 *  Exported for the smoke (drive synthetic `crossed`/`now` sequences). */
export function stepRule(key: string, crossed: boolean | null, now: number, sustainMs: number, rearmMs: number = REARM_MS): boolean {
  const s = ruleState(key)
  if (crossed === null) return false              // data gap: hold state, never fire
  if (!crossed) {                                 // dropped below → reset (a re-cross bypasses re-arm)
    s.crossedSince = null
    s.lastFiredAt = null
    return false
  }
  if (s.crossedSince === null) s.crossedSince = now
  if (now - s.crossedSince < sustainMs) return false              // not sustained yet
  if (s.lastFiredAt !== null && now - s.lastFiredAt < rearmMs) return false   // still re-armed
  s.lastFiredAt = now
  return true
}

/** Evaluate the ring-sample rules (CPU/GPU temp, RAM+swap). `fire` is injected
 *  so the smoke can assert without touching the notification layer. */
export function evaluateSampleAlerts(s: SampleLike, now: number, fire: (label: string) => void): void {
  for (const r of SAMPLE_RULES) {
    if (stepRule(r.key, r.test(s), now, r.sustainMs)) fire(r.label)
  }
}

/** Evaluate the volume-fullness rule (df rows) on a slower cadence. */
export function evaluateVolumeAlerts(rows: { target: string; sizeB: number; availB: number }[], now: number, fire: (label: string) => void): void {
  for (const row of rows) {
    if (!(row.sizeB > 0)) continue
    const pct = ((row.sizeB - row.availB) / row.sizeB) * 100
    if (stepRule(`vol:${row.target}`, pct > VOL_PCT, now, VOL_SUSTAIN_MS)) {
      fire(`${row.target} ${Math.round(pct)}% full (sustained 30m)`)
    }
  }
}

/** The production fire path — a priority-info notification (title flash + the
 *  Phase-2 blank flash if dark; persists in Notices). */
export function fireStatsAlert(label: string): void {
  console.log(`[stats-alert] FIRED: ${label}`)
  void notify({
    source: 'stats',
    priority: 'info',
    title: `⚠ ${label}`,
    body: `${label}\n\nCheck the machine — the Stats window has the trend.`,
  })
}

/** Smoke-only: clear all rule state between scenarios. */
export function _resetAlertStateForSmoke(): void { state.clear() }
