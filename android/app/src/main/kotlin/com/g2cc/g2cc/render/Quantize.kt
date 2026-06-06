package com.g2cc.g2cc.render

/**
 * ARGB → 4-bit grayscale (16 levels) quantization, with optional 4×4 ordered (Bayer)
 * dithering. The native G2 games dither their gray imagery (the captured chessboard
 * squares are a checker dither), so dithering defaults ON for shaded/photographic content
 * and should be turned OFF for crisp line art / text rasterized to an image region.
 *
 * Pure — no Android dependency. Dithering is purely a QUALITY choice on our side; the
 * firmware just displays whatever 16-level indices we hand it.
 */
object Quantize {
    /** 4×4 Bayer threshold matrix (values 0..15). */
    private val BAYER4 = intArrayOf(
        0, 8, 2, 10,
        12, 4, 14, 6,
        3, 11, 1, 9,
        15, 7, 13, 5,
    )

    /** Rec.601 luma 0..255 from an ARGB int (alpha ignored: 0.299R+0.587G+0.114B). */
    fun luma(argb: Int): Int {
        val r = (argb ushr 16) and 0xFF
        val g = (argb ushr 8) and 0xFF
        val b = argb and 0xFF
        return (r * 77 + g * 150 + b * 29) ushr 8   // 77+150+29 = 256
    }

    /** Quantize a single luma 0..255 to a gray4 index 0..15. */
    fun level(luma: Int): Int = ((luma.coerceIn(0, 255) * 15 + 127) / 255).coerceIn(0, 15)

    /**
     * Convert ARGB pixels (row-major, top-down) to gray4 indices (0..15).
     *
     * @param dither apply 4×4 Bayer ordered dithering. The dither only distributes the
     *   FRACTIONAL part of a pixel between its two nearest levels, so pixels already at an
     *   exact level (notably pure black and pure white) are preserved — no edge speckle.
     */
    fun toGray4(argb: IntArray, width: Int, height: Int, dither: Boolean = true): ByteArray {
        require(argb.size == width * height) { "Quantize: ${argb.size} != ${width}x$height" }
        val out = ByteArray(width * height)
        for (y in 0 until height) {
            for (x in 0 until width) {
                val i = y * width + x
                val luma = luma(argb[i])
                out[i] = if (!dither) {
                    level(luma).toByte()
                } else {
                    // luma*15 in [0,3825]; base = whole level, rem = fractional*255 in [0,254].
                    val q = luma * 15
                    val base = q / 255
                    val rem = q % 255
                    val threshold = (BAYER4[(y and 3) * 4 + (x and 3)] * 255) / 16   // 0..239
                    (if (rem > threshold) base + 1 else base).coerceIn(0, 15).toByte()
                }
            }
        }
        return out
    }
}
