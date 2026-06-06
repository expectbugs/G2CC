package com.g2cc.g2cc.render

import android.graphics.Bitmap
import android.graphics.Canvas

/**
 * Client-side rasterization: draw arbitrary UI with an Android [Canvas]/[Bitmap], then
 * quantize it to a 4bpp gray BMP sized for a G2 image region. This is the "fully capable"
 * half of the renderer — own fonts, vector shapes, gauges, blended bitmaps, anything you can
 * draw — turned into a region-ready image.
 *
 * Android-dependent (graphics only). The heavy lifting (quantize + BMP encode) lives in the
 * pure [Quantize] / [Gray4Bmp] objects, which are unit-tested independently, so this stays a
 * thin, low-risk bridge.
 */
object Rasterizer {
    /**
     * Allocate a [width]×[height] ARGB bitmap, run [draw] on its [Canvas], then encode the
     * result to a 4bpp gray BMP ready for [G2Renderer.setImage].
     *
     * @param dither 4×4 ordered dithering — ON for shaded/photographic content, OFF for crisp
     *   line art or text (avoids speckling sharp edges).
     */
    fun render(width: Int, height: Int, dither: Boolean = true, draw: (Canvas) -> Unit): ByteArray {
        require(width > 0 && height > 0) { "Rasterizer: bad size ${width}x$height" }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            draw(Canvas(bitmap))
            val argb = IntArray(width * height)
            bitmap.getPixels(argb, 0, width, 0, 0, width, height)
            val gray = Quantize.toGray4(argb, width, height, dither)
            return Gray4Bmp.encode(width, height, gray)
        } finally {
            bitmap.recycle()
        }
    }
}
