package com.g2cc.g2cc.render

/**
 * Encoder/decoder for the 4-bit grayscale Windows BMP that the G2 firmware accepts as
 * image-region content. Decoded 2026-06-05 from capture U=19 — see
 * docs/PROTOCOL_NOTES.md §"EvenHub display rendering" → "Image wire format".
 *
 * Format (verified byte-for-byte against the captured chessboard tiles):
 *   BITMAPFILEHEADER(14) + BITMAPINFOHEADER(40) + 16-entry BGRA palette(64) = 118-byte
 *   preamble, then bottom-up rows, 4 bpp (2 px/byte, **high nibble = LEFT pixel**), each
 *   row padded to a 4-byte boundary. Palette is the linear gray ramp:
 *   index i → (0x11*i, 0x11*i, 0x11*i, 0x00); index 0 = black … index 15 = white.
 *
 * Pure — no Android dependency; fully unit-tested (header byte-match + round-trip).
 */
object Gray4Bmp {
    const val HEADER_SIZE = 118          // 14 (file) + 40 (info) + 16*4 (palette)
    const val BITS_PER_PIXEL = 4
    const val PALETTE_ENTRIES = 16
    private const val DPI_PPM = 2835     // 72 DPI; matches capture biX/YPelsPerMeter

    /** Packed bytes per row, padded to a 4-byte boundary (BMP requirement). */
    fun rowBytes(width: Int): Int = ((width * BITS_PER_PIXEL + 31) / 32) * 4

    /** The 16-entry grayscale palette as raw BGRA bytes (64 bytes). */
    fun palette(): ByteArray {
        val p = ByteArray(PALETTE_ENTRIES * 4)
        for (i in 0 until PALETTE_ENTRIES) {
            val g = (0x11 * i).toByte()
            p[i * 4] = g; p[i * 4 + 1] = g; p[i * 4 + 2] = g; p[i * 4 + 3] = 0
        }
        return p
    }

    /**
     * Encode gray4 indices (one byte per pixel, value 0..15, row-major **top-down**) into a
     * 4bpp BMP. `indices.size` must equal width*height; values outside 0..15 raise loudly
     * (no silent clamp — per the no-silent-failure rule).
     */
    fun encode(width: Int, height: Int, indices: ByteArray): ByteArray {
        require(width > 0 && height > 0) { "Gray4Bmp: bad dimensions ${width}x$height" }
        require(indices.size == width * height) {
            "Gray4Bmp: indices size ${indices.size} != ${width}x$height = ${width * height}"
        }
        val rb = rowBytes(width)
        val imgSize = rb * height
        val out = ByteArray(HEADER_SIZE + imgSize)
        // BITMAPFILEHEADER
        out[0] = 'B'.code.toByte(); out[1] = 'M'.code.toByte()
        putI32(out, 2, HEADER_SIZE + imgSize)   // bfSize
        putI32(out, 10, HEADER_SIZE)            // bfOffBits = 118
        // BITMAPINFOHEADER
        putI32(out, 14, 40)                     // biSize
        putI32(out, 18, width)                  // biWidth
        putI32(out, 22, height)                 // biHeight (positive => bottom-up)
        putI16(out, 26, 1)                      // biPlanes
        putI16(out, 28, BITS_PER_PIXEL)         // biBitCount = 4
        putI32(out, 30, 0)                      // biCompression = BI_RGB
        putI32(out, 34, imgSize)                // biSizeImage
        putI32(out, 38, DPI_PPM)                // biXPelsPerMeter
        putI32(out, 42, DPI_PPM)                // biYPelsPerMeter
        putI32(out, 46, PALETTE_ENTRIES)        // biClrUsed = 16
        putI32(out, 50, 0)                      // biClrImportant
        palette().copyInto(out, 54)
        // pixel data: bottom-up rows, high nibble = left pixel
        for (y in 0 until height) {
            val srcRow = height - 1 - y          // input top-down; file bottom-up
            val dstBase = HEADER_SIZE + y * rb
            var col = 0
            while (col < width) {
                val hi = nibble(indices, srcRow * width + col)
                val lo = if (col + 1 < width) nibble(indices, srcRow * width + col + 1) else 0
                out[dstBase + col / 2] = ((hi shl 4) or lo).toByte()
                col += 2
            }
        }
        return out
    }

    /** Decode a 4bpp gray BMP back to (width, height, top-down indices). Supports only the
     *  format this object emits (4bpp BI_RGB); used for round-trip tests and re-tiling. */
    fun decode(bmp: ByteArray): Decoded {
        require(bmp.size >= HEADER_SIZE) { "Gray4Bmp.decode: too short (${bmp.size})" }
        require(bmp[0] == 'B'.code.toByte() && bmp[1] == 'M'.code.toByte()) { "Gray4Bmp.decode: not a BM file" }
        val dataOff = getI32(bmp, 10)
        val width = getI32(bmp, 18)
        val height = getI32(bmp, 22)
        val bpp = getI16(bmp, 28)
        require(bpp == BITS_PER_PIXEL) { "Gray4Bmp.decode: expected 4bpp, got $bpp" }
        require(width > 0 && height > 0) { "Gray4Bmp.decode: bad dims ${width}x$height" }
        val rb = rowBytes(width)
        require(dataOff + rb * height <= bmp.size) { "Gray4Bmp.decode: truncated pixel data" }
        val indices = ByteArray(width * height)
        for (y in 0 until height) {
            val srcRow = height - 1 - y
            val base = dataOff + srcRow * rb
            var col = 0
            while (col < width) {
                val b = bmp[base + col / 2].toInt() and 0xFF
                indices[y * width + col] = ((b ushr 4) and 0xF).toByte()
                if (col + 1 < width) indices[y * width + col + 1] = (b and 0xF).toByte()
                col += 2
            }
        }
        return Decoded(width, height, indices)
    }

    class Decoded(val width: Int, val height: Int, val indices: ByteArray)

    /** True if the BMP's pixel data is entirely index 0 (an all-black tile). The glasses
     *  CHOKE on a blank image region (hardware-confirmed 2026-06-06: pushing an all-zero tile
     *  drops the app slot), so the renderer rejects these. Cheap byte scan — no full decode. */
    fun isBlank(bmp: ByteArray): Boolean {
        if (bmp.size < HEADER_SIZE) return true
        val dataOff = getI32(bmp, 10)
        if (dataOff < HEADER_SIZE || dataOff > bmp.size) return true
        for (i in dataOff until bmp.size) if (bmp[i].toInt() != 0) return false
        return true
    }

    private fun nibble(a: ByteArray, i: Int): Int {
        val v = a[i].toInt()
        require(v in 0..15) { "Gray4Bmp: pixel value $v out of 0..15 at index $i" }
        return v
    }
    private fun putI32(o: ByteArray, at: Int, v: Int) {
        o[at] = (v and 0xFF).toByte(); o[at + 1] = ((v ushr 8) and 0xFF).toByte()
        o[at + 2] = ((v ushr 16) and 0xFF).toByte(); o[at + 3] = ((v ushr 24) and 0xFF).toByte()
    }
    private fun putI16(o: ByteArray, at: Int, v: Int) {
        o[at] = (v and 0xFF).toByte(); o[at + 1] = ((v ushr 8) and 0xFF).toByte()
    }
    private fun getI32(a: ByteArray, at: Int): Int =
        (a[at].toInt() and 0xFF) or ((a[at + 1].toInt() and 0xFF) shl 8) or
            ((a[at + 2].toInt() and 0xFF) shl 16) or ((a[at + 3].toInt() and 0xFF) shl 24)
    private fun getI16(a: ByteArray, at: Int): Int =
        (a[at].toInt() and 0xFF) or ((a[at + 1].toInt() and 0xFF) shl 8)
}
