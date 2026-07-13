package com.g2cc.g2cc.os

import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.os.ControlInputMapper.Gesture
import com.g2cc.g2cc.render.Scene
import com.g2cc.g2cc.render.scene
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Control-mode gesture → `input` mapping (multi-surface 2026-07-13), table-
 * driven. The scroll accumulator is the load-bearing part: one focus notch per
 * 48 scene-px (pacing by pixels, never timers), remainder carried within a
 * gesture, dropped on reset() (finger up).
 */
class ControlInputMapperTest {

    /** Browse page: an eventCapture LIST is the capture. 5 rows in 200 px → native 34 px pitch. */
    private val browseScene: Scene = scene {
        text("clock", 469, 0, 107, 33, "1:00 PM", scroll = false, id = 1)
        list("browse", 0, 40, 576, 200, items = List(5) { "row $it" }, eventCapture = true, id = 30)
    }

    /** Reader-style page: a scroll TEXT region ("strip") is the capture. */
    private val antennaScene: Scene = scene {
        text("clock", 469, 0, 107, 33, "1:00 PM", scroll = false, id = 1)
        text("strip", 0, 35, 576, 253, "line 1\nline 2", scroll = true, id = 50)
    }

    /** Pure-image-style page: only the clock (the on-glass antenna) — no touch capture. */
    private val capturelessScene: Scene = scene {
        text("clock", 469, 0, 107, 33, "1:00 PM", scroll = true, id = 1)
    }

    // ---------------------------------------------------------------- taps

    @Test
    fun `tap on a browse row maps to hub_select with the row index`() {
        val out = ControlInputMapper().map(browseScene, Gesture.SingleTap(100f, 40f + 34f + 10f))   // row 1
        assertEquals(listOf(ClientMessage.Input(event = "hub_select", widgetType = "browse", index = 1)), out)
    }

    @Test
    fun `tap outside every list maps to a plain tap`() {
        val out = ControlInputMapper().map(browseScene, Gesture.SingleTap(100f, 10f))   // above the list
        assertEquals(listOf(ClientMessage.Input(event = "tap")), out)
    }

    @Test
    fun `tap below the last row is dead space — plain tap, not the last row`() {
        // rows end at 40 + 5*34 = 210; the region runs to 240.
        val out = ControlInputMapper().map(browseScene, Gesture.SingleTap(100f, 220f))
        assertEquals(listOf(ClientMessage.Input(event = "tap")), out)
    }

    @Test
    fun `tap with no scene maps to a plain tap`() {
        assertEquals(
            listOf(ClientMessage.Input(event = "tap")),
            ControlInputMapper().map(null, Gesture.SingleTap(10f, 10f)),
        )
    }

    @Test
    fun `double tap maps to double_tap (back)`() {
        assertEquals(
            listOf(ClientMessage.Input(event = "double_tap")),
            ControlInputMapper().map(browseScene, Gesture.DoubleTap),
        )
    }

    // ---------------------------------------------------------------- drags

    @Test
    fun `dragUp emits focus value 2 (next) — ws-handler-ts line 1105 convention (f3 1=up 2=down)`() {
        // A single 100 px up-drag owes exactly TWO 48 px notches (remainder 4).
        val out = ControlInputMapper().map(antennaScene, Gesture.ScrollBy(100f))
        assertEquals(
            listOf(
                ClientMessage.Input(event = "focus", region = "strip", value = 2),
                ClientMessage.Input(event = "focus", region = "strip", value = 2),
            ),
            out,
        )
    }

    @Test
    fun `dragDown emits focus value 1 (prev)`() {
        val out = ControlInputMapper().map(antennaScene, Gesture.ScrollBy(-100f))
        assertEquals(
            listOf(
                ClientMessage.Input(event = "focus", region = "strip", value = 1),
                ClientMessage.Input(event = "focus", region = "strip", value = 1),
            ),
            out,
        )
    }

    @Test
    fun `remainder carries across calls within one gesture`() {
        val m = ControlInputMapper()
        assertTrue(m.map(antennaScene, Gesture.ScrollBy(30f)).isEmpty())          // acc 30
        assertEquals(1, m.map(antennaScene, Gesture.ScrollBy(30f)).size)          // acc 60 → 1 notch, 12 left
        assertTrue(m.map(antennaScene, Gesture.ScrollBy(30f)).isEmpty())          // acc 42
        assertEquals(1, m.map(antennaScene, Gesture.ScrollBy(10f)).size)          // acc 52 → 1 notch, 4 left
    }

    @Test
    fun `exactly 48 px is one notch`() {
        assertEquals(1, ControlInputMapper().map(antennaScene, Gesture.ScrollBy(48f)).size)
    }

    @Test
    fun `reset drops the remainder (finger up)`() {
        val m = ControlInputMapper()
        assertTrue(m.map(antennaScene, Gesture.ScrollBy(30f)).isEmpty())
        m.reset()
        assertTrue(m.map(antennaScene, Gesture.ScrollBy(30f)).isEmpty())          // 30, NOT 60
        assertEquals(1, m.map(antennaScene, Gesture.ScrollBy(18f)).size)          // 48 → 1 notch
    }

    @Test
    fun `direction reversal nets out through the signed accumulator`() {
        val m = ControlInputMapper()
        assertTrue(m.map(antennaScene, Gesture.ScrollBy(40f)).isEmpty())          // acc 40
        assertTrue(m.map(antennaScene, Gesture.ScrollBy(-40f)).isEmpty())         // acc 0 — cancelled
        assertTrue(m.map(antennaScene, Gesture.ScrollBy(40f)).isEmpty())
    }

    @Test
    fun `drag on a LIST capture emits nothing — adaptive pitch shows all rows`() {
        val m = ControlInputMapper()
        assertTrue(m.map(browseScene, Gesture.ScrollBy(100f)).isEmpty())
        assertTrue(m.map(browseScene, Gesture.ScrollBy(200f)).isEmpty())
        // and it did NOT quietly accumulate for a later antenna scene:
        assertTrue(m.map(antennaScene, Gesture.ScrollBy(30f)).isEmpty())
    }

    @Test
    fun `drag with no capture region emits nothing (clock antenna is not a touch target)`() {
        assertTrue(ControlInputMapper().map(capturelessScene, Gesture.ScrollBy(100f)).isEmpty())
        assertTrue(ControlInputMapper().map(null, Gesture.ScrollBy(100f)).isEmpty())
    }
}
