package com.g2cc.g2cc.os

import com.g2cc.g2cc.render.Content
import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.Region
import com.g2cc.g2cc.render.RegionKind
import com.g2cc.g2cc.render.Scene
import kotlin.math.min

/**
 * Pure mirror geometry (multi-surface 2026-07-13) — shared by [com.g2cc.g2cc.harness.ExpectedMirror]
 * DRAWING and control-mode HIT-TESTING, so tapped rows land exactly where they're
 * drawn. Mirrors the PC page's `static/pc/geometry.js` (same adaptive pitch).
 * No Android dependency → fully unit-tested.
 *
 *  - [listRowPitch]: adaptive list row pitch — the firmware's ~34 px, compressed
 *    so EVERY row of a long browse page fits (and is tappable) in the region.
 *  - [hitListRow]: scene-px point → (list region, row index), or null.
 *  - [captureOf]: the scene's input-capture region — what a drag scrolls.
 *  - [viewToScene]: view-px → scene-px for a FIT-scaled 576×288 mirror
 *    (letterbox/pillarbox aware; null inside the black bars).
 */
object MirrorGeometry {

    /** The firmware's native list row pitch (docs/SIM_TOOLING.md metrics). */
    const val FIRMWARE_ROW_PITCH = 34

    /** One drawn/tappable list row's rect (scene px). */
    data class RowRect(val x: Int, val y: Int, val w: Int, val h: Int)

    /** Adaptive row pitch: native 34 px, shrunk so [count] rows fit in [h].
     *  Floored at 1 so a pathological count can never divide by zero. */
    fun listRowPitch(h: Int, count: Int): Int =
        if (count <= 0) FIRMWARE_ROW_PITCH
        else min(FIRMWARE_ROW_PITCH, h / count).coerceAtLeast(1)

    /** Where row [index] of a [count]-row list is drawn inside [region]. */
    fun listRowRect(region: Region, index: Int, count: Int): RowRect {
        val pitch = listRowPitch(region.h, count)
        return RowRect(region.x, region.y + index * pitch, region.w, pitch)
    }

    /** Hit-test a scene-px point against every LIST region: (region, row) when
     *  it lands on a drawn row; null when it's below the last row (dead space
     *  inside the region) or in no list region at all. */
    fun hitListRow(scene: Scene, x: Float, y: Float): Pair<Region, Int>? {
        for (r in scene.regions) {
            if (r.kind != RegionKind.LIST) continue
            val items = (scene.content[r.name] as? Content.ListItems)?.items ?: continue
            if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue
            val pitch = listRowPitch(r.h, items.size)
            val row = ((y - r.y) / pitch).toInt()
            // Inside the region but below the last row → dead space, not row N-1.
            return if (row < items.size) Pair(r, row) else null
        }
        return null
    }

    /** The scene's input-capture region — what a control-mode drag scrolls:
     *  the eventCapture LIST first, else the scroll-flagged TEXT region. The
     *  app-injected clock is SKIPPED even when it's the on-glass antenna
     *  (scroll=true on pure-image scenes) — it isn't a touch target. */
    fun captureOf(scene: Scene): Region? {
        scene.regions.firstOrNull { r ->
            r.name != OsLayout.CLOCK_NAME && r.kind == RegionKind.LIST &&
                (scene.content[r.name] as? Content.ListItems)?.eventCapture == true
        }?.let { return it }
        return scene.regions.firstOrNull { r ->
            r.name != OsLayout.CLOCK_NAME && r.kind == RegionKind.TEXT &&
                (scene.content[r.name] as? Content.Text)?.scroll == true
        }
    }

    /** FIT scale for a 576×288 mirror inside a viewW×viewH view (0 when the
     *  view has no size yet). The drawing code uses the same function so
     *  touch mapping and pixels can never disagree. */
    fun fitScale(viewW: Int, viewH: Int): Float =
        if (viewW <= 0 || viewH <= 0) 0f
        else min(viewW.toFloat() / Display.WIDTH, viewH.toFloat() / Display.HEIGHT)

    /** View-px → scene-px for the FIT-scaled, centered mirror. Null when the
     *  point falls in the letterbox/pillarbox bars (dead space, not display). */
    fun viewToScene(viewW: Int, viewH: Int, x: Float, y: Float): Pair<Float, Float>? {
        val scale = fitScale(viewW, viewH)
        if (scale <= 0f) return null
        val offX = (viewW - Display.WIDTH * scale) / 2f
        val offY = (viewH - Display.HEIGHT * scale) / 2f
        val sx = (x - offX) / scale
        val sy = (y - offY) / scale
        if (sx < 0f || sx >= Display.WIDTH || sy < 0f || sy >= Display.HEIGHT) return null
        return Pair(sx, sy)
    }
}
