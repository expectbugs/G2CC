// PCM-to-WAV conversion — 44-byte RIFF/WAVE header.
// Verbatim from g2code/server/src/pcm-wav.ts originally; extended in Phase 8
// to handle IEEE float (audioFormat=3) for the DJI 48 kHz stereo float32 path.
//
// WAV format primer:
//  - audioFormat=1 → integer PCM (8/16/24/32-bit signed little-endian)
//  - audioFormat=3 → IEEE 754 float (32-bit). bitsPerSample must be 32.
// soundfile / scipy.io.wavfile both accept the 16-byte fmt chunk for either,
// even though the spec technically requires a `fact` chunk for non-PCM data.

export function pcmToWav(
  pcmData: Buffer,
  sampleRate: number = 16000,
  bitsPerSample: number = 16,
  channels: number = 1,
  audioFormat: number = 1,                // 1 = integer PCM, 3 = IEEE float
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = pcmData.length
  const headerSize = 44
  const buffer = Buffer.alloc(headerSize + dataSize)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)

  // fmt chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)            // chunk size
  buffer.writeUInt16LE(audioFormat, 20)   // 1 = integer PCM, 3 = IEEE float
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  pcmData.copy(buffer, 44)

  return buffer
}
