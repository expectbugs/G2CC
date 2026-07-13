package com.g2cc.g2cc.os

import com.g2cc.g2cc.render.Region
import com.g2cc.g2cc.render.RegionKind
import com.g2cc.g2cc.render.scene
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The shared draw/hit-test geometry the control-mode touch surface rides on
 * (multi-surface 2026-07-13). Pitch + row rects + hit edges + capture
 * precedence + the FIT view→scene mapping — [com.g2cc.g2cc.harness.ExpectedMirror]
 * draws with the same pitch, so these tests are also the draw/hit agreement proof.
 */
class MirrorGeometryTest {

    // ---------------------------------------------------------------- pitch

    @Test
    fun `pitch stays native 34 when rows fit`() {
        assertEquals(34, MirrorGeometry.listRowPitch(222, 6))     // 222/6 = 37 → capped at 34
        assertEquals(34, MirrorGeometry.listRowPitch(288, 8))
    }

    @Test
    fun `pitch compresses for long browse pages`() {
        assertEquals(13, MirrorGeometry.listRowPitch(222, 16))    // 222/16 = 13 (int division)
        assertEquals(15, MirrorGeometry.listRowPitch(253, 16))
    }

    @Test
    fun `pitch defaults to 34 for empty lists and never reaches 0`() {
        assertEquals(34, MirrorGeometry.listRowPitch(222, 0))
        assertEquals(34, MirrorGeometry.listRowPitch(222, -3))
        assertEquals(1, MirrorGeometry.listRowPitch(100, 200))    // pathological — floored at 1
    }

    // ---------------------------------------------------------------- row rects

    @Test
    fun `row rects tile the region top-down at the adaptive pitch`() {
        val r = Region(30, "browse", 0, 40, 400, 222, RegionKind.LIST)
        assertEquals(MirrorGeometry.RowRect(0, 40, 400, 13), MirrorGeometry.listRowRect(r, 0, 16))
        assertEquals(MirrorGeometry.RowRect(0, 40 + 2 * 13, 400, 13), MirrorGeometry.listRowRect(r, 2, 16))
        // 6 rows → native pitch
        assertEquals(MirrorGeometry.RowRect(0, 40 + 34, 400, 34), MirrorGeometry.listRowRect(r, 1, 6))
    }

    // ---------------------------------------------------------------- hit-testing

    private fun browseScene(count: Int) = scene {
        text("clock", 469, 0, 107, 33, "1:00 PM", scroll = false, id = 1)
        list("browse", 0, 40, 400, 222, items = List(count) { "row $it" }, eventCapture = true, id = 30)
    }

    @Test
    fun `hit just below the top edge lands on row 0`() {
        val hit = MirrorGeometry.hitListRow(browseScene(16), 10f, 41f)   // top edge + 1
        assertNotNull(hit)
        assertEquals("browse", hit!!.first.name)
        assertEquals(0, hit.second)
    }

    @Test
    fun `hit resolves the row band at compressed pitch`() {
        // pitch 13: y = 40 + 5*13 + 6 → mid row 5
        val hit = MirrorGeometry.hitListRow(browseScene(16), 200f, (40 + 5 * 13 + 6).toFloat())
        assertEquals(5, hit!!.second)
        // a row BOUNDARY belongs to the next row
        assertEquals(1, MirrorGeometry.hitListRow(browseScene(16), 200f, (40 + 13).toFloat())!!.second)
    }

    @Test
    fun `hit below the last row is dead space, not the last row`() {
        // 16 rows * 13 px end at y=248; the region runs to 262 → 250 is inside
        // the region but below every drawn row.
        assertNull(MirrorGeometry.hitListRow(browseScene(16), 200f, 250f))
    }

    @Test
    fun `hit outside the region misses`() {
        assertNull(MirrorGeometry.hitListRow(browseScene(16), 450f, 100f))   // right of the list
        assertNull(MirrorGeometry.hitListRow(browseScene(16), 200f, 20f))    // above it (clock band)
        assertNull(MirrorGeometry.hitListRow(browseScene(16), 200f, 270f))   // below the region
    }

    @Test
    fun `hit ignores non-list regions`() {
        val s = scene {
            text("clock", 469, 0, 107, 33, "1:00 PM", scroll = false, id = 1)
            text("body", 0, 35, 576, 200, "hello", scroll = true, id = 20)
        }
        assertNull(MirrorGeometry.hitListRow(s, 100f, 100f))
    }

    // ---------------------------------------------------------------- captureOf

    @Test
    fun `captureOf prefers the eventCapture list over scroll text`() {
        val s = scene {
            text("clock", 469, 0, 107, 33, "1:00 PM", scroll = false, id = 1)
            text("body", 0, 35, 576, 100, "text", scroll = true, id = 20)
            list("browse", 0, 140, 576, 140, items = listOf("a", "b"), eventCapture = true, id = 30)
        }
        assertEquals("browse", MirrorGeometry.captureOf(s)!!.name)
    }

    @Test
    fun `captureOf falls back to the scroll text region`() {
        val s = scene {
            text("clock", 469, 0, 107, 33, "1:00 PM", scroll = false, id = 1)
            text("body", 0, 35, 576, 100, "text", scroll = true, id = 20)
            list("menu", 0, 140, 576, 140, items = listOf("a", "b"), eventCapture = false, id = 30)
        }
        assertEquals("body", MirrorGeometry.captureOf(s)!!.name)
    }

    @Test
    fun `captureOf skips the clock even when it is the on-glass antenna`() {
        // Pure-image-style scene: SceneCodec makes the clock scroll=true (the
        // antenna) — but it's not a touch target, so captureOf finds nothing.
        val s = scene {
            text("clock", 469, 0, 107, 33, "1:00 PM", scroll = true, id = 1)
        }
        assertNull(MirrorGeometry.captureOf(s))
    }

    // ---------------------------------------------------------------- view→scene (FIT)

    @Test
    fun `viewToScene maps an exact-fit view 1-to-1 over the scale`() {
        // 1152×576 = exactly 2× 576×288 → no bars.
        assertEquals(Pair(50f, 25f), MirrorGeometry.viewToScene(1152, 576, 100f, 50f))
        assertEquals(Pair(0f, 0f), MirrorGeometry.viewToScene(1152, 576, 0f, 0f))
    }

    @Test
    fun `viewToScene pillarbox — bars are null, content maps`() {
        // 2400×1080 → scale 3.75, scaled width 2160 → 120 px bars left/right.
        assertNull(MirrorGeometry.viewToScene(2400, 1080, 119f, 500f))          // left bar
        assertNull(MirrorGeometry.viewToScene(2400, 1080, 2281f, 500f))         // right bar
        val p = MirrorGeometry.viewToScene(2400, 1080, 120f + 375f, 375f)!!     // inside
        assertEquals(100f, p.first, 0.001f)
        assertEquals(100f, p.second, 0.001f)
    }

    @Test
    fun `viewToScene letterbox — top and bottom bars are null`() {
        // 1152×600 → scale 2, scaled height 576 → 12 px bars top/bottom.
        assertNull(MirrorGeometry.viewToScene(1152, 600, 500f, 5f))             // top bar
        assertNull(MirrorGeometry.viewToScene(1152, 600, 500f, 595f))           // bottom bar
        val p = MirrorGeometry.viewToScene(1152, 600, 500f, 12f)!!              // first scene row
        assertEquals(0f, p.second, 0.001f)
    }

    @Test
    fun `viewToScene is null for a zero-size view`() {
        assertNull(MirrorGeometry.viewToScene(0, 0, 10f, 10f))
    }
}
