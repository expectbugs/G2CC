package com.g2cc.g2cc.os

import com.g2cc.g2cc.ble.EventParser
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.SceneContent
import com.g2cc.g2cc.net.SceneRegion
import com.g2cc.g2cc.net.WireScene
import com.g2cc.g2cc.render.Content
import com.g2cc.g2cc.render.Gray4Bmp
import com.g2cc.g2cc.render.RegionKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

/**
 * The WireScene↔render.Scene bridge that the whole Glasses-OS render loop rides on.
 * Covers clock injection, the loud-fail validations (the no-silent-failure rule),
 * the base64 gray4-BMP round-trip through the real [Gray4Bmp], and the
 * EventParser→input mapping.
 */
class SceneCodecTest {

    private fun text(name: String, x: Int, y: Int, w: Int, h: Int, t: String = "", scroll: Boolean? = null) =
        SceneRegion(id = idFor(name), name = name, x = x, y = y, w = w, h = h, kind = "text",
            content = SceneContent(kind = "text", text = t, scroll = scroll))

    // distinct, non-reserved ids per region name so tests don't trip the unique-id check
    private var nextId = 10
    private val ids = HashMap<String, Int>()
    private fun idFor(name: String) = ids.getOrPut(name) { nextId++ }

    private fun b64(w: Int, h: Int): String {
        val px = ByteArray(w * h) { (it % 16).toByte() }
        return Base64.getEncoder().encodeToString(Gray4Bmp.encode(w, h, px))
    }

    private fun expectFail(msgContains: String, block: () -> Unit) {
        try {
            block(); fail("expected IllegalArgumentException containing \"$msgContains\"")
        } catch (e: IllegalArgumentException) {
            assertTrue("message was: ${e.message}", (e.message ?: "").contains(msgContains))
        }
    }

    // ---------------------------------------------------------------- clock injection

    @Test
    fun injectsClockRegion_firstAndStable() {
        val s = SceneCodec.toScene(WireScene(listOf(text("body", 0, OsLayout.CONTENT_Y, 576, 100, "hi"))), "12:34:56")
        val clock = s.region(OsLayout.CLOCK_NAME)
        assertTrue("clock region present", clock != null)
        assertEquals(OsLayout.CLOCK_ID, clock!!.id)
        assertEquals(OsLayout.CLOCK_X, clock.x)
        assertEquals(0, clock.y)
        assertEquals(OsLayout.CLOCK_WIDTH, clock.w)
        assertEquals(OsLayout.CLOCK_HEIGHT, clock.h)
        assertEquals(RegionKind.TEXT, clock.kind)
        assertEquals("12:34:56", (s.content[OsLayout.CLOCK_NAME] as Content.Text).text)
        // clock is the always-present mandatory text region
        assertTrue(s.textRegions().any { it.name == OsLayout.CLOCK_NAME })
        // body here is non-scrollable, so the clock becomes the input antenna
        assertEquals(true, (s.content[OsLayout.CLOCK_NAME] as Content.Text).scroll)
    }

    @Test
    fun clockIsAntennaOnlyWhenNoOtherScrollable() {
        // pure-image scene (no focusable region) → clock becomes the antenna (scroll=true)
        val img = SceneRegion(20, "img", 0, OsLayout.CONTENT_Y, 40, 24, "image", SceneContent("image", bmpBase64 = b64(40, 24)))
        val s1 = SceneCodec.toScene(WireScene(listOf(img)), "00:00:00")
        assertEquals(true, (s1.content[OsLayout.CLOCK_NAME] as Content.Text).scroll)

        // a scrollable body present → clock stays passive so the body is the scroll target
        val body = SceneRegion(21, "body", 0, OsLayout.CONTENT_Y, 200, 80, "text", SceneContent("text", text = "x", scroll = true))
        val s2 = SceneCodec.toScene(WireScene(listOf(body)), "00:00:00")
        assertEquals(false, (s2.content[OsLayout.CLOCK_NAME] as Content.Text).scroll)
    }

    // ---------------------------------------------------------------- list regions (DE menu / browse)

    @Test
    fun listRegion_parsesToListItems_withDefaults() {
        val wire = SceneRegion(30, "menu", 0, OsLayout.CLOCK_HEIGHT, 96, 212, "list",
            SceneContent(kind = "list", items = listOf("Next", "Prev", "Main"), eventCapture = true))
        val s = SceneCodec.toScene(WireScene(listOf(wire)), "1:04 PM")
        val r = s.region("menu")!!
        assertEquals(RegionKind.LIST, r.kind)
        val c = s.content["menu"] as Content.ListItems
        assertEquals(listOf("Next", "Prev", "Main"), c.items)
        assertEquals(0, c.itemWidth)            // omitted → auto
        assertEquals(true, c.selectBorder)      // omitted → true
        assertEquals(true, c.eventCapture)
    }

    @Test
    fun clockStaysPassive_whenEventCaptureListPresent() {
        // The DE menu/browse list owns input — the clock must NOT also be an antenna
        // (the wire allows exactly ONE capture region; docs/DE_DESIGN.md §2).
        val menu = SceneRegion(30, "menu", 0, OsLayout.CLOCK_HEIGHT, 96, 212, "list",
            SceneContent(kind = "list", items = listOf("A", "B"), eventCapture = true))
        val s = SceneCodec.toScene(WireScene(listOf(menu)), "1:04 PM")
        assertEquals(false, (s.content[OsLayout.CLOCK_NAME] as Content.Text).scroll)
    }

    @Test
    fun clockIsAntenna_whenListHasNoEventCapture() {
        // A passive (non-capture) list does not claim input → the clock antennas as usual.
        val l = SceneRegion(30, "lst", 0, OsLayout.CLOCK_HEIGHT, 96, 212, "list",
            SceneContent(kind = "list", items = listOf("A")))
        val s = SceneCodec.toScene(WireScene(listOf(l)), "1:04 PM")
        assertEquals(true, (s.content[OsLayout.CLOCK_NAME] as Content.Text).scroll)
    }

    @Test
    fun listContent_missingItems_loudFails() {
        val bad = SceneRegion(30, "menu", 0, OsLayout.CLOCK_HEIGHT, 96, 212, "list",
            SceneContent(kind = "list"))
        expectFail("missing items") { SceneCodec.toScene(WireScene(listOf(bad)), "1:04 PM") }
    }

    @Test
    fun regionStyle_mapsThrough_andInvalidLoudFails() {
        val styled = SceneRegion(30, "title", 0, 0, OsLayout.CLOCK_X, OsLayout.CLOCK_HEIGHT, "text",
            SceneContent("text", "T"), com.g2cc.g2cc.net.WireRegionStyle(borderWidth = 1, borderColor = 6, padding = 4))
        val s = SceneCodec.toScene(WireScene(listOf(styled)), "1:04 PM")
        val st = s.region("title")!!.style
        assertEquals(1, st.borderWidth); assertEquals(6, st.borderColor); assertEquals(4, st.padding)

        val bad = SceneRegion(31, "t2", 0, OsLayout.CLOCK_HEIGHT, 100, 40, "text",
            SceneContent("text", "T"), com.g2cc.g2cc.net.WireRegionStyle(borderWidth = 9))
        expectFail("style invalid") { SceneCodec.toScene(WireScene(listOf(bad)), "1:04 PM") }
    }

    @Test
    fun mapsTextContent_withScrollDefault() {
        val s = SceneCodec.toScene(
            WireScene(listOf(
                text("a", 0, OsLayout.CONTENT_Y, 200, 80, "alpha"),
                text("b", 0, OsLayout.CONTENT_Y + 90, 200, 80, "beta", scroll = true),
            )),
            "00:00:00",
        )
        assertEquals("alpha", (s.content["a"] as Content.Text).text)
        assertEquals(false, (s.content["a"] as Content.Text).scroll)   // omitted → false
        assertEquals(true, (s.content["b"] as Content.Text).scroll)
    }

    // ---------------------------------------------------------------- image round-trip

    @Test
    fun decodesBase64Bmp_roundTripsThroughGray4Bmp() {
        val w = 40; val h = 24
        val region = SceneRegion(20, "img", 0, OsLayout.CONTENT_Y, w, h, "image",
            SceneContent(kind = "image", bmpBase64 = b64(w, h)))
        val s = SceneCodec.toScene(WireScene(listOf(region)), "00:00:00")
        val img = s.content["img"] as Content.Image
        val dec = Gray4Bmp.decode(img.bmp)           // the exact render-time path
        assertEquals(w, dec.width)
        assertEquals(h, dec.height)
        assertEquals((0 % 16).toByte(), dec.indices[0])
        assertEquals((17 % 16).toByte(), dec.indices[17])
    }

    // ---------------------------------------------------------------- loud-fail validations

    @Test
    fun rejectsReservedClockId() {
        expectFail("reserved clock id") {
            SceneCodec.toScene(WireScene(listOf(
                SceneRegion(OsLayout.CLOCK_ID, "x", 0, OsLayout.CONTENT_Y, 100, 50, "text", SceneContent("text", "t")),
            )), "00:00:00")
        }
    }

    @Test
    fun rejectsReservedClockName() {
        expectFail("reserved clock name") {
            SceneCodec.toScene(WireScene(listOf(
                SceneRegion(55, OsLayout.CLOCK_NAME, 0, OsLayout.CONTENT_Y, 100, 50, "text", SceneContent("text", "t")),
            )), "00:00:00")
        }
    }

    @Test
    fun rejectsRegionOverlappingClockCutout() {
        // straddles the clock: x range [400,500) overlaps [444,576), y range [0,20) overlaps [0,28)
        expectFail("overlaps the clock cutout") {
            SceneCodec.toScene(WireScene(listOf(
                SceneRegion(30, "bad", 400, 0, 100, 20, "text", SceneContent("text", "t")),
            )), "00:00:00")
        }
    }

    @Test
    fun allowsRegionFlushAgainstClock() {
        // top-left band right up to (not into) the clock's left edge is fine
        val s = SceneCodec.toScene(WireScene(listOf(
            SceneRegion(30, "title", 0, 0, OsLayout.CLOCK_X, OsLayout.CLOCK_HEIGHT, "text", SceneContent("text", "T")),
        )), "00:00:00")
        assertTrue(s.region("title") != null)
    }

    @Test
    fun rejectsUnknownRegionKind() {
        expectFail("unknown region kind") {
            SceneCodec.toScene(WireScene(listOf(
                SceneRegion(30, "x", 0, OsLayout.CONTENT_Y, 100, 50, "video", SceneContent("text", "t")),
            )), "00:00:00")
        }
    }

    @Test
    fun rejectsTextContentOnImageRegion() {
        expectFail("text content on non-text region") {
            SceneCodec.toScene(WireScene(listOf(
                SceneRegion(30, "x", 0, OsLayout.CONTENT_Y, 100, 50, "image", SceneContent("text", "t")),
            )), "00:00:00")
        }
    }

    @Test
    fun rejectsImageContentOnTextRegion() {
        expectFail("image content on non-image region") {
            SceneCodec.toScene(WireScene(listOf(
                SceneRegion(30, "x", 0, OsLayout.CONTENT_Y, 40, 24, "text", SceneContent("image", bmpBase64 = b64(40, 24))),
            )), "00:00:00")
        }
    }

    @Test
    fun rejectsImageContentMissingBmp() {
        expectFail("missing bmpBase64") {
            SceneCodec.toScene(WireScene(listOf(
                SceneRegion(30, "x", 0, OsLayout.CONTENT_Y, 40, 24, "image", SceneContent("image")),
            )), "00:00:00")
        }
    }

    @Test
    fun rejectsBadBase64() {
        expectFail("bad base64") {
            SceneCodec.toScene(WireScene(listOf(
                SceneRegion(30, "x", 0, OsLayout.CONTENT_Y, 40, 24, "image", SceneContent("image", bmpBase64 = "!!!not base64!!!")),
            )), "00:00:00")
        }
    }

    // ---------------------------------------------------------------- input mapping

    @Test
    fun mapsEventParserEventsToInput() {
        assertEquals("tap", SceneCodec.toInput(EventParser.Event.Tap)!!.event)
        assertEquals("double_tap", SceneCodec.toInput(EventParser.Event.DoubleTap)!!.event)
        assertEquals("scroll_up", SceneCodec.toInput(EventParser.Event.ScrollUp)!!.event)
        assertEquals("scroll_down", SceneCodec.toInput(EventParser.Event.ScrollDown)!!.event)
        assertEquals("scroll_focus", SceneCodec.toInput(EventParser.Event.ScrollFocus)!!.event)

        val sel = SceneCodec.toInput(EventParser.Event.HubSelect("menu", 3))!!
        assertEquals("hub_select", sel.event)
        assertEquals("menu", sel.widgetType)
        assertEquals(3, sel.index)

        val ges = SceneCodec.toInput(EventParser.Event.HubGesture(7))!!
        assertEquals("hub_gesture", ges.event)
        assertEquals(7, ges.code)

        // empty-code hub gesture = single tap in the EvenHub hijack session
        assertEquals("tap", SceneCodec.toInput(EventParser.Event.HubGesture(-1))!!.event)

        // focus/scroll report → forwarded with the region name + raw f3
        val foc = SceneCodec.toInput(EventParser.Event.HubFocus(11, "body", 2))!!
        assertEquals("focus", foc.event)
        assertEquals("body", foc.region)
        assertEquals(2, foc.value)
    }

    @Test
    fun doesNotForwardNonInputEvents() {
        assertNull(SceneCodec.toInput(EventParser.Event.Unknown(0x01.toByte() to 0x01.toByte(), "00")))
        assertNull(SceneCodec.toInput(EventParser.Event.Malformed("bad", "00")))
        assertNull(SceneCodec.toInput(EventParser.Event.InternalMenuEvent(1, "00")))
    }

    @Test
    fun mappedInputSerializesToWireJson() {
        // the Input we build must round-trip through the same codec the client sends with
        val json = com.g2cc.g2cc.net.WsJson.codec.encodeToString(
            ClientMessage.serializer(), SceneCodec.toInput(EventParser.Event.HubSelect("row", 2))!!,
        )
        assertTrue(json.contains("\"type\":\"input\""))
        assertTrue(json.contains("\"event\":\"hub_select\""))
        assertTrue(json.contains("\"widgetType\":\"row\""))
        assertTrue(json.contains("\"index\":2"))
    }
}
