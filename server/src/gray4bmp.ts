// Minimal 4-bit-grayscale Windows BMP encoder for the Glasses-OS server.
//
// Byte-matched to the Android decoder render/Gray4Bmp.kt (which is itself
// byte-verified against the captured native chessboard tiles). The firmware
// accepts exactly this format as image-region content, and SceneCodec on the
// client runs Gray4Bmp.decode over whatever we emit — so any deviation here
// loud-fails on the device rather than painting garbage.
//
// Format (see docs/PROTOCOL_NOTES.md §"EvenHub display rendering" →
// "Image wire format"):
//   BITMAPFILEHEADER(14) + BITMAPINFOHEADER(40) + 16-entry BGRA palette(64)
//   = 118-byte header, then BOTTOM-UP rows, 4 bpp (2 px/byte, HIGH nibble =
//   LEFT pixel), each row padded to a 4-byte boundary. Palette is the linear
//   gray ramp: index i → (0x11*i, 0x11*i, 0x11*i, 0x00); 0 = black, 15 = white.

const HEADER_SIZE = 118 // 14 (file) + 40 (info) + 16*4 (palette)
const BITS_PER_PIXEL = 4
const PALETTE_ENTRIES = 16
const DPI_PPM = 2835 // 72 DPI; matches the capture's biX/YPelsPerMeter

/** Packed bytes per row, padded to a 4-byte boundary (BMP requirement). */
export function rowBytes(width: number): number {
  return Math.floor((width * BITS_PER_PIXEL + 31) / 32) * 4
}

function nibble(indices: Uint8Array, i: number): number {
  const v = indices[i]
  // No silent clamp (LOUD AND PROUD): an out-of-range index is a caller bug.
  if (v < 0 || v > 15) throw new Error(`gray4bmp: pixel value ${v} out of 0..15 at index ${i}`)
  return v
}

/**
 * Encode gray4 indices (one byte per pixel, value 0..15, row-major TOP-DOWN,
 * length === width*height) into a 4bpp BMP Buffer. Throws loudly on bad
 * dimensions, wrong-length input, or an out-of-range pixel value.
 */
export function encodeGray4Bmp(width: number, height: number, indices: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`gray4bmp: bad dimensions ${width}x${height}`)
  }
  if (indices.length !== width * height) {
    throw new Error(`gray4bmp: indices length ${indices.length} != ${width}x${height} = ${width * height}`)
  }
  const rb = rowBytes(width)
  const imgSize = rb * height
  const out = Buffer.alloc(HEADER_SIZE + imgSize)

  // BITMAPFILEHEADER
  out[0] = 0x42 // 'B'
  out[1] = 0x4d // 'M'
  out.writeInt32LE(HEADER_SIZE + imgSize, 2) // bfSize
  out.writeInt32LE(HEADER_SIZE, 10) // bfOffBits = 118
  // BITMAPINFOHEADER
  out.writeInt32LE(40, 14) // biSize
  out.writeInt32LE(width, 18) // biWidth
  out.writeInt32LE(height, 22) // biHeight (positive => bottom-up)
  out.writeInt16LE(1, 26) // biPlanes
  out.writeInt16LE(BITS_PER_PIXEL, 28) // biBitCount = 4
  out.writeInt32LE(0, 30) // biCompression = BI_RGB
  out.writeInt32LE(imgSize, 34) // biSizeImage
  out.writeInt32LE(DPI_PPM, 38) // biXPelsPerMeter
  out.writeInt32LE(DPI_PPM, 42) // biYPelsPerMeter
  out.writeInt32LE(PALETTE_ENTRIES, 46) // biClrUsed = 16
  out.writeInt32LE(0, 50) // biClrImportant
  // 16-entry BGRA grayscale palette
  for (let i = 0; i < PALETTE_ENTRIES; i++) {
    const g = (0x11 * i) & 0xff
    const off = 54 + i * 4
    out[off] = g
    out[off + 1] = g
    out[off + 2] = g
    out[off + 3] = 0
  }
  // Pixel data: bottom-up rows, high nibble = left pixel.
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y // input top-down; file bottom-up
    const dstBase = HEADER_SIZE + y * rb
    for (let col = 0; col < width; col += 2) {
      const hi = nibble(indices, srcRow * width + col)
      const lo = col + 1 < width ? nibble(indices, srcRow * width + col + 1) : 0
      out[dstBase + (col >> 1)] = (hi << 4) | lo
    }
  }
  return out
}

/** Convenience: encode and return base64 (the on-wire form for SceneImageContent). */
export function encodeGray4BmpBase64(width: number, height: number, indices: Uint8Array): string {
  return encodeGray4Bmp(width, height, indices).toString('base64')
}
