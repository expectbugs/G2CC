// Phase 10 smoke — stats threshold alerts: the sustained-crossing + re-arm
// state machine (synthetic time, no real sampler). Asserts: fires only after
// the sustain window; no repeat within re-arm while continuously over; a
// drop-below + re-cross bypasses re-arm; a data gap (null) holds state.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import {
  stepRule, evaluateSampleAlerts, evaluateVolumeAlerts, _resetAlertStateForSmoke,
} from '../dist/stats-alerts.js'

const MIN = 60_000
const SUSTAIN = 10 * MIN
const REARM = 2 * 60 * MIN

// --- 1. sustain: no fire until the window elapses, then exactly one ---
_resetAlertStateForSmoke()
assert.equal(stepRule('t', true, 0, SUSTAIN, REARM), false, 'just crossed — not sustained')
assert.equal(stepRule('t', true, 5 * MIN, SUSTAIN, REARM), false, '5m in — not yet')
assert.equal(stepRule('t', true, 10 * MIN, SUSTAIN, REARM), true, 'sustained 10m — FIRE')
assert.equal(stepRule('t', true, 11 * MIN, SUSTAIN, REARM), false, 'still over but re-armed — no repeat')
console.error('  1. fires once at the sustain window, then re-armed ✓')

// --- 2. re-arm while continuously over: re-fires only after the re-arm window ---
assert.equal(stepRule('t', true, 10 * MIN + REARM - MIN, SUSTAIN, REARM), false, 'before re-arm — quiet')
assert.equal(stepRule('t', true, 10 * MIN + REARM, SUSTAIN, REARM), true, 'after 2h still pinned — re-fire')
console.error('  2. continuous over-threshold re-fires only after re-arm ✓')

// --- 3. drop below + re-cross bypasses re-arm (a real NEW event) ---
_resetAlertStateForSmoke()
assert.equal(stepRule('t', true, 100, SUSTAIN, REARM), false)
assert.equal(stepRule('t', true, 100 + SUSTAIN, SUSTAIN, REARM), true, 'first sustained crossing fires')
assert.equal(stepRule('t', false, 100 + SUSTAIN + MIN, SUSTAIN, REARM), false, 'dropped below — reset (no fire)')
assert.equal(stepRule('t', true, 100 + SUSTAIN + 2 * MIN, SUSTAIN, REARM), false, 're-crossed — must re-sustain')
assert.equal(stepRule('t', true, 100 + 2 * SUSTAIN + 2 * MIN, SUSTAIN, REARM), true, 're-sustained — fires immediately (re-arm bypassed)')
console.error('  3. drop + re-cross bypasses re-arm; still requires a fresh sustain ✓')

// --- 4. a brief dip RESETS the sustain (sustained means sustained) ---
_resetAlertStateForSmoke()
assert.equal(stepRule('t', true, 0, SUSTAIN, REARM), false)
assert.equal(stepRule('t', true, 9 * MIN, SUSTAIN, REARM), false, 'almost there')
assert.equal(stepRule('t', false, 9 * MIN + 1, SUSTAIN, REARM), false, 'one dip below')
assert.equal(stepRule('t', true, 9 * MIN + 2, SUSTAIN, REARM), false, 'restarts the clock — not the old 9m')
assert.equal(stepRule('t', true, 19 * MIN + 2, SUSTAIN, REARM), true, 'a fresh 10m sustains')
console.error('  4. a brief dip restarts the sustain clock ✓')

// --- 5. data gap (null) HOLDS state — neither fires nor resets ---
_resetAlertStateForSmoke()
assert.equal(stepRule('t', true, 0, SUSTAIN, REARM), false)
assert.equal(stepRule('t', null, 5 * MIN, SUSTAIN, REARM), false, 'gap — no fire')
assert.equal(stepRule('t', true, 10 * MIN, SUSTAIN, REARM), true, 'the gap did not reset the sustain clock')
console.error('  5. data-unavailable holds state (no fire, no reset) ✓')

// --- 6. evaluateSampleAlerts: a GPU-temp crossing fires the right label once ---
_resetAlertStateForSmoke()
const fired = []
const fire = (label) => fired.push(label)
const hot = { cpuTempC: 40, gpuTempC: 90, ramUsedMb: 1000, ramTotalMb: 32000, swapUsedMb: 0, swapTotalMb: 196000 }
evaluateSampleAlerts(hot, 0, fire)
evaluateSampleAlerts(hot, 5 * MIN, fire)
assert.equal(fired.length, 0, 'GPU >87 not yet sustained 10m')
evaluateSampleAlerts(hot, 10 * MIN, fire)
assert.equal(fired.length, 1, 'fires once at 10m')
assert.match(fired[0], /GPU temp/)
console.error('  6. evaluateSampleAlerts: GPU-temp rule fires once when sustained ✓')

// --- 7. evaluateVolumeAlerts: a >95%-full volume sustained 30m fires ---
_resetAlertStateForSmoke()
const volFired = []
const full = [{ target: '/mnt/turtle', sizeB: 1000, availB: 10 }]   // 99% full
evaluateVolumeAlerts(full, 0, (l) => volFired.push(l))
assert.equal(volFired.length, 0, 'not yet sustained 30m')
evaluateVolumeAlerts(full, 30 * MIN, (l) => volFired.push(l))
assert.equal(volFired.length, 1, 'fires once at 30m')
assert.match(volFired[0], /turtle.*full/)
// #7 (Adam 2026-06-13): a still-full disk does NOT re-fire — once, ever (Infinity re-arm)…
evaluateVolumeAlerts(full, 5 * 60 * MIN, (l) => volFired.push(l))   // 5h later, still full
assert.equal(volFired.length, 1, 'still full 5h later → NO repeat (once per drive)')
// …UNLESS it drops below the threshold and gets full again
evaluateVolumeAlerts([{ target: '/mnt/turtle', sizeB: 1000, availB: 500 }], 6 * 60 * MIN, (l) => volFired.push(l))   // 50% — dropped (resets the clock + stamp)
evaluateVolumeAlerts(full, 6 * 60 * MIN + 30 * MIN, (l) => volFired.push(l))   // full again — starts a fresh sustain clock
assert.equal(volFired.length, 1, 'a fresh fill is not yet sustained')
evaluateVolumeAlerts(full, 7 * 60 * MIN + 30 * MIN, (l) => volFired.push(l))   // sustained 30m → re-fires
assert.equal(volFired.length, 2, 'a drop-below then sustained re-fill DOES re-fire')
console.error('  7. evaluateVolumeAlerts: fires once, no repeat while full, re-fires after a drop+refill ✓')

console.log('phase12-stats-alerts: ALL OK')
