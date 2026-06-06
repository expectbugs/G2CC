package com.g2cc.g2cc.harness

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import com.g2cc.g2cc.render.Content
import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.Gray4Bmp
import com.g2cc.g2cc.render.Region
import com.g2cc.g2cc.render.Scene

/**
 * Composites a [Scene] into a 576×288 bitmap = exactly what the glasses SHOULD be showing,
 * for side-by-side comparison with the real display.
 *
 * Image regions are **pixel-perfect** — the very 4bpp BMP we sent, decoded back to its 16 gray
 * levels. Text regions are **approximate** (the firmware renders them in its own font), so they
 * are drawn with a thin outline + best-effort monospace text and should be treated as a guide,
 * not a pixel reference. The test sequence leans on image regions precisely so the comparison
 * is exact where it matters.
 */
object ExpectedMirror {
    fun render(scene: Scene?): Bitmap {
        val out = Bitmap.createBitmap(Display.WIDTH, Display.HEIGHT, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        canvas.drawColor(Color.BLACK)
        if (scene == null) {
            val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.DKGRAY; textSize = 20f; textAlign = Paint.Align.CENTER; typeface = Typeface.MONOSPACE
            }
            canvas.drawText("(not connected)", Display.WIDTH / 2f, Display.HEIGHT / 2f, p)
            return out
        }
        for (r in scene.regions) {
            when (val c = scene.content[r.name]) {
                is Content.Image -> drawImageRegion(out, r, c.bmp)
                is Content.Text -> drawTextRegion(canvas, r, c.text)
                null -> outline(canvas, r, Color.rgb(40, 40, 40))
            }
        }
        return out
    }

    private fun drawImageRegion(out: Bitmap, r: Region, bmp: ByteArray) {
        val d = Gray4Bmp.decode(bmp)
        if (r.x < 0 || r.y < 0 || r.x + d.width > out.width || r.y + d.height > out.height) return
        val px = IntArray(d.width * d.height)
        for (i in px.indices) {
            val g = 0x11 * (d.indices[i].toInt() and 0xF)
            px[i] = (0xFF shl 24) or (g shl 16) or (g shl 8) or g
        }
        out.setPixels(px, 0, d.width, r.x, r.y, d.width, d.height)
    }

    private fun drawTextRegion(canvas: Canvas, r: Region, text: String) {
        outline(canvas, r, Color.rgb(60, 60, 60))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; textSize = 15f; typeface = Typeface.MONOSPACE
        }
        canvas.save()
        canvas.clipRect(r.x, r.y, r.x + r.w, r.y + r.h)
        var y = r.y + 16f
        for (line in text.split("\n")) {
            canvas.drawText(line, r.x + 4f, y, paint)
            y += 17f
            if (y > r.y + r.h) break
        }
        canvas.restore()
    }

    private fun outline(canvas: Canvas, r: Region, color: Int) {
        val p = Paint().apply { style = Paint.Style.STROKE; this.color = color; strokeWidth = 1f }
        canvas.drawRect(r.x + 0.5f, r.y + 0.5f, r.x + r.w - 0.5f, r.y + r.h - 0.5f, p)
    }
}
