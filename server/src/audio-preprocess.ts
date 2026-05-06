// Audio preprocessing for STT.
// - RNNoise denoise (neural, browser-WASM — gracefully skipped in Node where it can't load)
// - Peak normalization (pure JS, always runs)
//
// Inherited from g2aria/server/src/audio-preprocess.ts (which is functionally identical
// to g2code's; g2aria just updated comments to be ASR-route-agnostic). The graceful
// "Rnnoise unavailable, using normalize-only" branch is loud-and-proud (warn log),
// not a silent swallow — keep as-is.

import { Rnnoise, type DenoiseState } from '@shiguredo/rnnoise-wasm'

type RnnoiseInstance = Awaited<ReturnType<typeof Rnnoise.load>>

let rnnoiseLoadAttempted = false
let rnnoiseInstance: RnnoiseInstance | null = null
let denoiseState: DenoiseState | null = null

async function getRnnoise(): Promise<{ instance: RnnoiseInstance; state: DenoiseState } | null> {
  if (rnnoiseLoadAttempted) {
    if (!rnnoiseInstance || !denoiseState) return null
    return { instance: rnnoiseInstance, state: denoiseState }
  }
  rnnoiseLoadAttempted = true

  try {
    rnnoiseInstance = await Rnnoise.load()
    denoiseState = rnnoiseInstance.createDenoiseState()
    console.log('[audio] RNNoise loaded successfully')
    return { instance: rnnoiseInstance, state: denoiseState }
  } catch (err) {
    // Loud-and-proud: log the reason, continue with normalize-only.
    console.warn('[audio] RNNoise unavailable (using normalize-only):', (err as Error).message)
    rnnoiseInstance = null
    denoiseState = null
    return null
  }
}

function pcmBufferToFloat32(pcmBuffer: Buffer): Float32Array {
  const sampleCount = Math.floor(pcmBuffer.length / 2)
  const out = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = pcmBuffer.readInt16LE(i * 2)
  }
  return out
}

function float32ToPcmBuffer(f: Float32Array): Buffer {
  const out = Buffer.alloc(f.length * 2)
  for (let i = 0; i < f.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(f[i])))
    out.writeInt16LE(clamped, i * 2)
  }
  return out
}

async function maybeDenoise(samples: Float32Array): Promise<Float32Array> {
  const rn = await getRnnoise()
  if (!rn) return samples
  const frameSize = rn.instance.frameSize
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i += frameSize) {
    if (samples.length - i < frameSize) {
      out.set(samples.subarray(i), i)
      break
    }
    const frame = samples.slice(i, i + frameSize)
    rn.state.processFrame(frame)
    out.set(frame, i)
  }
  return out
}

function normalize(samples: Float32Array): Float32Array {
  let maxAbs = 0
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i])
    if (abs > maxAbs) maxAbs = abs
  }
  if (maxAbs === 0) return samples
  // -3 dB = 10^(-3/20) ≈ 0.7079 of full scale (32767)
  const targetPeak = 32767 * 0.7079
  const gain = targetPeak / maxAbs
  if (gain >= 10) return samples // near-silence — don't amplify
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain
  return out
}

export async function preprocessAudio(pcmBuffer: Buffer): Promise<Buffer> {
  if (pcmBuffer.length < 2) return pcmBuffer
  const f = pcmBufferToFloat32(pcmBuffer)
  const denoised = await maybeDenoise(f)
  const normalized = normalize(denoised)
  return float32ToPcmBuffer(normalized)
}
