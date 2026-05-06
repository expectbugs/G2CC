// PCM-to-WAV conversion — 44-byte RIFF/WAVE header.
// Verbatim from g2code/server/src/pcm-wav.ts. Used by stt.ts to wrap raw
// 16 kHz / 16-bit / mono PCM in a WAV container so faster-whisper (and later
// Parakeet) can read it.

export function pcmToWav(
  pcmData: Buffer,
  sampleRate: number = 16000,
  bitsPerSample: number = 16,
  channels: number = 1,
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
  buffer.writeUInt16LE(1, 20)             // PCM format
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
