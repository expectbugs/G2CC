// gray4bmp.js — decode the server's 4bpp-gray BMP (the exact bytes pushed to
// the glasses) back to gray indices. PURE (no DOM) so node smoke tests import
// it directly. Mirrors android render/Gray4Bmp.kt + server gray4bmp.ts:
//   - 'BM' magic; pixel-data offset u32le@10; width i32le@18; height i32le@22
//     (positive ⇒ bottom-up rows); bitcount u16le@28 == 4
//   - row stride = ((w*4 + 31) >> 5) * 4 bytes; HIGH nibble = LEFT pixel
//   - palette is the linear gray ramp (index i → 0x11·i) — we return indices.
//
// Failures THROW with a precise reason (loud; the caller paints the error).

/** @param {string} b64 @returns {{width:number,height:number,indices:Uint8ClampedArray}} */
export function decodeGray4Bmp(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return decodeGray4BmpBytes(bytes)
}

/** @param {Uint8Array} bytes */
export function decodeGray4BmpBytes(bytes) {
  if (bytes.length < 54) throw new Error(`BMP too short (${bytes.length} B)`)
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP (missing BM magic)')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dataOff = dv.getUint32(10, true)
  const width = dv.getInt32(18, true)
  const rawHeight = dv.getInt32(22, true)
  const bpp = dv.getUint16(28, true)
  if (bpp !== 4) throw new Error(`BMP is ${bpp} bpp, expected 4`)
  const bottomUp = rawHeight > 0
  const height = Math.abs(rawHeight)
  if (width < 1 || width > 4096 || height < 1 || height > 4096) {
    throw new Error(`BMP dims ${width}x${rawHeight} out of range`)
  }
  const stride = ((width * 4 + 31) >> 5) * 4
  const need = dataOff + stride * height
  if (dataOff < 54 || need > bytes.length) {
    throw new Error(`BMP pixel data out of bounds (offset ${dataOff}, need ${need}, have ${bytes.length})`)
  }
  const indices = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y++) {
    const srcRow = bottomUp ? height - 1 - y : y
    const rowStart = dataOff + srcRow * stride
    for (let x = 0; x < width; x++) {
      const byte = bytes[rowStart + (x >> 1)]
      indices[y * width + x] = (x & 1) === 0 ? (byte >> 4) & 0xf : byte & 0xf
    }
  }
  return { width, height, indices }
}
