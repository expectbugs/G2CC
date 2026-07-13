package com.g2cc.g2cc.harness

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import com.g2cc.g2cc.os.MirrorGeometry
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
 * levels. Text regions are **approximate** (the firmware renders them in its own font), so the
 * text is best-effort monospace and should be treated as a guide, not a pixel reference.
 *
 * [outlines] draws a thin box around each region — a layout-debugging overlay only. It is OFF by
 * default because the real renderer sends NO border data, so the glasses show no boxes; with
 * outlines off the mirror matches the glasses (confirmed on hardware 2026-06-06, where the only
 * mirror-vs-glasses discrepancy was these guide lines around text regions).
 */
object ExpectedMirror {
    fun render(scene: Scene?, outlines: Boolean = false): Bitmap {
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
                is Content.Text -> drawTextRegion(canvas, r, c.text, outlines)
                is Content.ListItems -> drawListRegion(canvas, r, c, outlines)
                null -> if (outlines) outline(canvas, r, Color.rgb(40, 40, 40))
            }
        }
        return out
    }

    /** Approximate guide for a native list region: one row per item. The firmware owns the
     *  real rendering AND the selection ring (which the phone can't know), so like text this
     *  is a layout guide, not a pixel reference. Row pitch comes from [MirrorGeometry]
     *  (multi-surface 2026-07-13) so control-mode HIT-TESTING lands on the rows exactly
     *  where they're DRAWN — the adaptive pitch also makes every row of a long browse
     *  page visible (and tappable) instead of clipping past the region. */
    private fun drawListRegion(canvas: Canvas, r: Region, c: Content.ListItems, outlines: Boolean) {
        if (outlines) outline(canvas, r, Color.rgb(60, 60, 60))
        val pitch = MirrorGeometry.listRowPitch(r.h, c.items.size)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            // Native pitch keeps the native 15px text; compressed rows shrink with it.
            textSize = minOf(15f, pitch - 2f).coerceAtLeast(6f)
            typeface = Typeface.MONOSPACE
        }
        canvas.save()
        canvas.clipRect(r.x, r.y, r.x + r.w, r.y + r.h)
        for ((i, item) in c.items.withIndex()) {
            val top = r.y + i * pitch
            if (top >= r.y + r.h) break    // firmware scrolls; the mirror just clips
            // Baseline centered in the row band (row i spans top..top+pitch —
            // the same band MirrorGeometry.hitListRow resolves to index i).
            canvas.drawText(item, r.x + 8f, top + (pitch + paint.textSize * 0.75f) / 2f, paint)
        }
        canvas.restore()
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

    private fun drawTextRegion(canvas: Canvas, r: Region, text: String, outlines: Boolean) {
        if (outlines) outline(canvas, r, Color.rgb(60, 60, 60))
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
