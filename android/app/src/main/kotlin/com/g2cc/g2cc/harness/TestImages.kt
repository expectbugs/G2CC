package com.g2cc.g2cc.harness

import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.Gray4Bmp
import com.g2cc.g2cc.render.Quantize
import com.g2cc.g2cc.render.Rasterizer

/**
 * Generators for the Test Display sequence — each exercises a specific renderer capability and
 * produces a 4bpp gray BMP. Because the harness rasterizes these itself, the expected-image
 * mirror is pixel-identical to what is sent.
 */
object TestImages {

    /** 16 vertical bands, gray levels 0..15 — exercises every [Gray4Bmp] palette entry exactly. */
    fun grayRamp(w: Int = Display.WIDTH, h: Int = Display.HEIGHT): ByteArray {
        val idx = ByteArray(w * h)
        val band = (w + 15) / 16
        for (y in 0 until h) for (x in 0 until w) {
            idx[y * w + x] = (x / band).coerceIn(0, 15).toByte()
        }
        return Gray4Bmp.encode(w, h, idx)
    }

    /** Top half: a smooth horizontal gradient run through [Quantize] dithering. Bottom half: the
     *  same gradient as 16 hard bands (no dither). Side-by-side = the dithering win at 16 levels. */
    fun ditherGradient(w: Int = Display.WIDTH, h: Int = Display.HEIGHT): ByteArray {
        val argb = IntArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            val g = x * 255 / (w - 1)
            argb[y * w + x] = (0xFF shl 24) or (g shl 16) or (g shl 8) or g
        }
        val idx = Quantize.toGray4(argb, w, h, dither = true)
        val band = (w + 15) / 16
        for (y in h / 2 until h) for (x in 0 until w) {
            idx[y * w + x] = (x / band).coerceIn(0, 15).toByte()
        }
        return Gray4Bmp.encode(w, h, idx)
    }

    /** Canvas-drawn UI scaled to the tile: frame, title, vector shapes, a gray-step bar — exercises
     *  the full [Rasterizer] path (own fonts + shapes → gray4). Dither off for crisp line art.
     *  Coordinates are relative to [w]×[h] so it renders correctly at tile sizes (≤200×100). */
    fun rasterUi(title: String, w: Int = 200, h: Int = 100): ByteArray =
        Rasterizer.render(w, h, dither = false) { c ->
            c.drawColor(Color.BLACK)
            val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 2f
            }
            c.drawRect(2f, 2f, w - 2f, h - 2f, stroke)
            val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.WHITE; textSize = h * 0.18f; typeface = Typeface.DEFAULT_BOLD
            }
            c.drawText(title, 8f, h * 0.26f, text)
            c.drawCircle(w * 0.22f, h * 0.62f, h * 0.20f, stroke)
            c.drawLine(w * 0.42f, h * 0.42f, w * 0.58f, h * 0.82f, stroke)
            c.drawRect(w * 0.64f, h * 0.42f, w * 0.90f, h * 0.82f, stroke)
            for (i in 0 until 8) {
                val g = 0x11 * (i * 2 + 1)
                val fill = Paint().apply { color = Color.rgb(g, g, g) }
                val x0 = 6f + i * (w - 12) / 8f
                c.drawRect(x0, h - 10f, x0 + (w - 12) / 8f - 2f, h - 3f, fill)
            }
        }

    /** A labelled solid-fill panel with a frame + diagonals + centred label — for region/tile tests. */
    fun panel(label: String, w: Int, h: Int, fill: Int): ByteArray =
        Rasterizer.render(w, h, dither = false) { c ->
            c.drawColor(Color.rgb(fill, fill, fill))
            val on = if (fill < 0x88) Color.WHITE else Color.BLACK
            val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = on; style = Paint.Style.STROKE; strokeWidth = 3f
            }
            c.drawRect(2f, 2f, w - 2f, h - 2f, stroke)
            c.drawLine(0f, 0f, w.toFloat(), h.toFloat(), stroke)
            c.drawLine(w.toFloat(), 0f, 0f, h.toFloat(), stroke)
            val t = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = on; textSize = 30f; typeface = Typeface.DEFAULT_BOLD; textAlign = Paint.Align.CENTER
            }
            c.drawText(label, w / 2f, h / 2f + 10f, t)
        }

    /** One animation frame: a white box at horizontal position [boxX] over a framed black field. */
    fun animFrame(boxX: Int, w: Int, h: Int): ByteArray =
        Rasterizer.render(w, h, dither = false) { c ->
            c.drawColor(Color.BLACK)
            val frame = Paint().apply { color = Color.rgb(0x66, 0x66, 0x66); style = Paint.Style.STROKE; strokeWidth = 1f }
            c.drawRect(1f, 1f, w - 1f, h - 1f, frame)
            val box = Paint().apply { color = Color.WHITE }
            val top = (h / 2 - 15).toFloat()
            c.drawRect(boxX.toFloat(), top, (boxX + 30).toFloat(), top + 30f, box)
        }
}
