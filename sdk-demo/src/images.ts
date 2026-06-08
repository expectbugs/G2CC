// Image data for updateImageRawData() — FORMAT SWEEP.
//
// Two earlier guesses failed to render: raw 8-bit grayscale bytes, and a canvas PNG (base64). The
// data TYPE isn't the issue (the SDK normalizes Uint8Array/base64 → the same bytes for the host), so
// it's the byte FORMAT. This file provides three candidate encodings of the SAME gray-bands tile,
// all returned as number[] (the SDK's List<int>); the IMAGE group pushes each in its own labeled
// step so one capture tells us which the host wants:
//   • bmp4  — uncompressed 4-bit gray Windows BMP, byte-identical to our direct-BLE renderer
//             (render/Gray4Bmp.kt) which the glasses are HARDWARE-PROVEN to accept. ← top bet
//   • bmp24 — a standard 24-bit BMP (the natural input if the host DECODES then converts to gray4).
//   • raw4  — the bmp4 pixel block with the header stripped (raw packed 4bpp, bottom-up).

const HEADER_SIZE = 118 // 14 file + 40 info + 16*4 palette
const DPI_PPM = 2835

/** 4bpp BMP packed row bytes, padded to a 4-byte boundary (matches Gray4Bmp.rowBytes). */
function rowBytes4(w: number): number { return ((w * 4 + 31) >> 5) << 2 }

/** The test pattern as gray4 indices (0..15), top-down: 4 vertical bands + a bright border. */
function bandIndices(w: number, h: number): Uint8Array {
  const idx = new Uint8Array(w * h)
  const levels = [0, 5, 10, 15]
  const bw = w / levels.length
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = levels[Math.min(levels.length - 1, Math.floor(x / bw))]
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) v = 15 // orientation border
      idx[y * w + x] = v
    }
  }
  return idx
}

/** Uncompressed 4bpp gray BMP — byte-for-byte the structure render/Gray4Bmp.kt puts on the wire. */
export function bmp4(w: number, h: number): number[] {
  const idx = bandIndices(w, h)
  const rb = rowBytes4(w)
  const img = rb * h
  const b = new Uint8Array(HEADER_SIZE + img)
  const dv = new DataView(b.buffer)
  b[0] = 0x42; b[1] = 0x4d                 // "BM"
  dv.setUint32(2, HEADER_SIZE + img, true) // bfSize
  dv.setUint32(10, HEADER_SIZE, true)      // bfOffBits = 118
  dv.setUint32(14, 40, true)               // biSize
  dv.setInt32(18, w, true)                 // biWidth
  dv.setInt32(22, h, true)                 // biHeight (positive => bottom-up)
  dv.setUint16(26, 1, true)                // biPlanes
  dv.setUint16(28, 4, true)                // biBitCount = 4
  dv.setUint32(30, 0, true)                // biCompression = BI_RGB
  dv.setUint32(34, img, true)              // biSizeImage
  dv.setInt32(38, DPI_PPM, true)
  dv.setInt32(42, DPI_PPM, true)
  dv.setUint32(46, 16, true)               // biClrUsed = 16
  dv.setUint32(50, 0, true)                // biClrImportant
  for (let i = 0; i < 16; i++) {           // palette: linear gray ramp, BGRA
    const g = 0x11 * i
    b[54 + i * 4] = g; b[55 + i * 4] = g; b[56 + i * 4] = g; b[57 + i * 4] = 0
  }
  for (let y = 0; y < h; y++) {            // bottom-up rows; high nibble = left pixel
    const src = h - 1 - y
    let col = 0
    while (col < w) {
      const hi = idx[src * w + col] & 0xf
      const lo = col + 1 < w ? idx[src * w + col + 1] & 0xf : 0
      b[HEADER_SIZE + y * rb + (col >> 1)] = (hi << 4) | lo
      col += 2
    }
  }
  return Array.from(b)
}

/** The bmp4 pixel block alone (no header) — raw packed 4bpp, bottom-up, padded rows. */
export function raw4(w: number, h: number): number[] {
  return bmp4(w, h).slice(HEADER_SIZE)
}

/** A standard 24-bit BMP (BGR, no palette) of the same pattern — the natural input if the host
 *  decodes a full-color image and converts it to gray4 itself. */
export function bmp24(w: number, h: number): number[] {
  const idx = bandIndices(w, h)
  const rb = (w * 3 + 3) & ~3
  const HDR = 54 // 14 file + 40 info, no palette
  const img = rb * h
  const b = new Uint8Array(HDR + img)
  const dv = new DataView(b.buffer)
  b[0] = 0x42; b[1] = 0x4d
  dv.setUint32(2, HDR + img, true)
  dv.setUint32(10, HDR, true)
  dv.setUint32(14, 40, true)
  dv.setInt32(18, w, true)
  dv.setInt32(22, h, true)
  dv.setUint16(26, 1, true)
  dv.setUint16(28, 24, true)
  dv.setUint32(30, 0, true)
  dv.setUint32(34, img, true)
  dv.setInt32(38, DPI_PPM, true)
  dv.setInt32(42, DPI_PPM, true)
  for (let y = 0; y < h; y++) {
    const src = h - 1 - y
    for (let x = 0; x < w; x++) {
      const g = (idx[src * w + x] & 0xf) * 0x11
      const o = HDR + y * rb + x * 3
      b[o] = g; b[o + 1] = g; b[o + 2] = g
    }
  }
  return Array.from(b)
}
