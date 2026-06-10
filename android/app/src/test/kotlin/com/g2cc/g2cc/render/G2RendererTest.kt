package com.g2cc.g2cc.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Orchestration tests for [G2Renderer] via a fake sink — verifies the dirty-rect logic,
 *  message types emitted, and loud-failure behaviour without any BLE/Android. */
class G2RendererTest {

    private fun img(w: Int, h: Int) = Gray4Bmp.encode(w, h, ByteArray(w * h) { (it % 16).toByte() })  // non-blank gradient — the renderer guard rejects all-black tiles
    private fun msgType(payload: ByteArray) = payload[1].toInt() and 0xFF   // f1 value byte

    @Test
    fun launch_emitsLaunchThenImageChunks_andSetsScene() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val brand = img(200, 40)   // 4118 bytes -> 2 image chunks
        val s = scene { text("hud", 0, 8, 368, 280, "hi"); image("brand", 376, 4, 200, 40, brand) }
        var ok = false
        r.launch(10061, s) { ok = it }
        assertTrue(ok)
        assertEquals(3, sink.calls.size)           // per-message: launch + 2 image chunks = 3 discrete writes
        val msgs = sink.messages()
        assertEquals(3, msgs.size)                 // launch + 2 image chunks
        assertEquals(DisplayProto.MSG_LAUNCH, msgType(msgs[0]))
        assertEquals(DisplayProto.MSG_IMAGE, msgType(msgs[1]))
        assertEquals(DisplayProto.MSG_IMAGE, msgType(msgs[2]))
        assertNotNull(r.currentScene)
    }

    @Test
    fun setText_emitsSingleTextUpdate_andUpdatesScene() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        r.launch(10061, scene { text("hud", 0, 8, 368, 280, "hi") }) {}
        sink.calls.clear()
        var ok = false
        r.setText("hud", "bye") { ok = it }
        assertTrue(ok)
        assertEquals(1, sink.calls.size)
        val msgs = sink.messages()
        assertEquals(1, msgs.size)
        assertEquals(DisplayProto.MSG_TEXT, msgType(msgs[0]))
        assertTrue(hx(msgs[0]).contains(hx("bye".toByteArray())))
        assertEquals("bye", (r.currentScene!!.content["hud"] as Content.Text).text)
    }

    @Test
    fun setText_unknownRegion_loudFailsWithoutWriting() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        r.launch(10061, scene { text("hud", 0, 0, 100, 50, "x") }) {}
        sink.calls.clear()
        var ok = true
        r.setText("nope", "y") { ok = it }
        assertFalse(ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun setImage_dimensionMismatch_loudFails() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        r.launch(10061, scene { image("pic", 0, 0, 200, 100, img(200, 100)) }) {}
        sink.calls.clear()
        var ok = true
        r.setImage("pic", img(100, 50)) { ok = it }   // wrong dims for the region
        assertFalse(ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun setScene_sameLayout_sendsOnlyChangedRegion() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val pic = img(200, 40)
        val s1 = scene { text("hud", 0, 8, 368, 280, "hi"); image("brand", 376, 4, 200, 40, pic) }
        r.launch(10061, s1) {}
        sink.calls.clear()
        val s2 = Scene(s1.regions, mapOf("hud" to Content.Text("yo"), "brand" to Content.Image(pic)))
        r.setScene(s2) {}
        val msgs = sink.messages()
        assertEquals(1, msgs.size)                 // only the text region changed
        assertEquals(DisplayProto.MSG_TEXT, msgType(msgs[0]))
    }

    @Test
    fun setScene_layoutChange_pushesLayoutThenImages() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        r.launch(10061, scene { text("a", 0, 0, 100, 50, "x") }) {}
        sink.calls.clear()
        r.setScene(scene { text("a", 0, 0, 100, 50, "x"); image("b", 376, 4, 200, 40, img(200, 40)) }) {}
        val msgs = sink.messages()
        assertEquals(DisplayProto.MSG_LAYOUT, msgType(msgs[0]))
        assertTrue("expected image chunks after layout", msgs.drop(1).all { msgType(it) == DisplayProto.MSG_IMAGE })
    }

    @Test
    fun writeFailure_propagatesToCaller() {
        val sink = FakeSink().apply { failNext = true }
        val r = mkRenderer(sink)
        var ok = true
        r.launch(10061, scene { text("a", 0, 0, 100, 50, "x") }) { ok = it }
        assertFalse(ok)
    }

    @Test
    fun keepaliveFrame_advancesSeq() {
        val r = G2Renderer(FakeSink())
        val a = r.keepaliveFrame()
        val b = r.keepaliveFrame()
        assertNotEquals(a[2], b[2])   // seq byte differs between successive keepalives
    }

    @Test
    fun setScene_beforeLaunch_loudFailsWithoutWriting() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        var ok = true
        r.setScene(scene { text("a", 0, 0, 100, 50, "x") }) { ok = it }
        assertFalse(ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun launch_badImageInScene_loudFailsNoCrash() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        // Scene.init only checks region KIND, so a non-BMP buffer is constructible; launch must
        // loud-fail (onComplete(false)) rather than throw out to the caller.
        val badScene = scene { image("x", 0, 0, 10, 10, byteArrayOf(1, 2, 3)) }
        var ok = true
        r.launch(10061, badScene) { ok = it }
        assertFalse(ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun imagePush_isDiscretePerMessageWrites_notOneAtomicBatch() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        r.launch(10061, scene { text("s", 0, 0, 576, 28, "x") }) {}
        sink.calls.clear()
        // layout change → 1 layout msg + a 200x100 image (10118 B = 3 chunks) = 4 discrete writes,
        // so the keepalive can interleave between them (the native pattern) instead of one batch.
        r.setScene(scene { text("s", 0, 0, 576, 28, "x"); image("pic", 0, 28, 200, 100, img(200, 100)) }) {}
        assertTrue("expected ≥4 discrete per-message writes, got ${sink.calls.size}", sink.calls.size >= 4)
        val msgs = sink.messages()
        assertEquals(DisplayProto.MSG_LAYOUT, msgType(msgs[0]))
        assertTrue("rest should be image chunks", msgs.drop(1).all { msgType(it) == DisplayProto.MSG_IMAGE })
    }

    // ---- LIST regions (the DE menu / browse lists) ----

    @Test
    fun launch_withList_emitsListContainerInWrapper() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val s = scene {
            text("title", 0, 0, 444, 38, "CC")
            list("menu", 0, 38, 96, 212, listOf("Next", "Prev", "Main"), eventCapture = true, id = 3)
        }
        var ok = false
        r.launch(10000, s) { ok = it }
        assertTrue(ok)
        val launch = sink.messages().single()
        assertEquals(DisplayProto.MSG_LAUNCH, msgType(launch))
        // The launch payload embeds the golden-tested list container bytes verbatim.
        val li = DisplayProto.listContainer(0, 38, 96, 212, id = 3, name = "menu",
            items = listOf("Next", "Prev", "Main"), eventCapture = true)
        assertTrue("launch must embed the list container", hx(launch).contains(hx(li)))
    }

    @Test
    fun setScene_menuItemsChange_rebuildsLayout() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val base = scene {
            text("title", 0, 0, 444, 38, "CC")
            list("menu", 0, 38, 96, 212, listOf("Next", "Prev"), eventCapture = true, id = 3)
        }
        r.launch(10000, base) {}
        sink.calls.clear()
        val swapped = Scene(base.regions, base.content.toMutableMap().apply {
            put("menu", Content.ListItems(listOf("Approve", "Deny"), eventCapture = true))
        })
        var ok = false
        r.setScene(swapped) { ok = it }
        assertTrue(ok)
        val msgs = sink.messages()
        assertEquals(DisplayProto.MSG_LAYOUT, msgType(msgs[0]))   // items change ⇒ f1=7 rebuild
    }

    @Test
    fun validate_twoEventCaptures_rejected_noWrites() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        // A scrollable text region AND an eventCapture list = 2 capture regions — hard reject.
        val s = scene {
            text("ant", 0, 0, 200, 38, "scroll", scroll = true)
            list("menu", 0, 38, 96, 212, listOf("A", "B"), eventCapture = true)
        }
        var ok = true
        r.launch(10000, s) { ok = it }
        assertFalse("two event-capture regions must be rejected", ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun validate_overTwelveContainers_rejected_noWrites() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        // 8 texts + 4 (empty) images + 1 list = 13 containers with every PER-KIND cap
        // respected — isolates the 12-container total check.
        val s = scene {
            for (i in 0 until 8) text("t$i", 0, i * 30, 40, 20, "x")
            for (i in 0 until 4) image("i$i", 100 + i * 50, 0, 40, 40)
            list("menu", 300, 0, 96, 200, listOf("A"), eventCapture = true)
        }
        var ok = true
        r.launch(10000, s) { ok = it }
        assertFalse("13 containers must be rejected (SDK cap 12)", ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun validate_nineTextRegions_rejected_noWrites() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val s = scene { for (i in 0 until 9) text("t$i", 0, i * 30, 40, 20, "x") }
        var ok = true
        r.launch(10000, s) { ok = it }
        assertFalse("9 text regions must be rejected (SDK cap 8)", ok)
        assertEquals(0, sink.calls.size)
    }

    // ---- pre-push guards (hardware-confirmed kill conditions; see G2Renderer.validate) ----

    // (each guard scene includes a text region so the image rule under test is
    // the one that fires — image-ONLY scenes are rejected earlier by the
    // every-page-needs-text rule, tested separately below)

    @Test
    fun launch_fifthImageRegion_rejected_noWrites() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val s = scene {
            text("s", 0, 100, 576, 28, "x")
            image("a", 0, 0, 40, 40, img(40, 40)); image("b", 50, 0, 40, 40, img(40, 40))
            image("c", 100, 0, 40, 40, img(40, 40)); image("d", 150, 0, 40, 40, img(40, 40))
            image("e", 200, 0, 40, 40, img(40, 40))   // 5th image region — over the 4-region cap
        }
        var ok = true
        r.launch(10061, s) { ok = it }
        assertFalse("5 image regions must be rejected before any write", ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun launch_allBlackImage_rejected_noWrites() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val blank = Gray4Bmp.encode(64, 64, ByteArray(64 * 64))   // all index 0 = all-black → glasses choke
        var ok = true
        r.launch(10061, scene { text("s", 0, 100, 576, 28, "x"); image("x", 0, 0, 64, 64, blank) }) { ok = it }
        assertFalse("all-black image tile must be rejected", ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun launch_oversizeImageRegion_rejected_noWrites() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        var ok = true
        r.launch(10061, scene { text("s", 0, 220, 576, 28, "x"); image("big", 0, 0, 400, 200, img(400, 200)) }) { ok = it }  // > 288x129
        assertFalse("an image region ≥384×192 drops the BLE link — must be rejected", ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun launch_imageOnlyScene_rejected_noWrites() {
        // §7 rule 1: image-only layouts ack but never paint — must reject pre-wire.
        val sink = FakeSink()
        val r = mkRenderer(sink)
        var ok = true
        r.launch(10061, scene { image("x", 0, 0, 64, 64, img(64, 64)) }) { ok = it }
        assertFalse("a scene with no text region must be rejected", ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun launch_listOverTwentyItems_rejected_noWrites() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val s = scene {
            text("t", 0, 0, 444, 33, "x")
            list("menu", 0, 33, 96, 222, (1..21).map { "row $it" }, eventCapture = true)
        }
        var ok = true
        r.launch(10000, s) { ok = it }
        assertFalse("21 list items must be rejected (SDK cap 20)", ok)
        assertEquals(0, sink.calls.size)
    }

    @Test
    fun launch_listItemOver64Chars_rejected_noWrites() {
        val sink = FakeSink()
        val r = mkRenderer(sink)
        val s = scene {
            text("t", 0, 0, 444, 33, "x")
            list("menu", 0, 33, 96, 222, listOf("ok", "y".repeat(65)), eventCapture = true)
        }
        var ok = true
        r.launch(10000, s) { ok = it }
        assertFalse("a 65-char list item must be rejected (SDK cap 64)", ok)
        assertEquals(0, sink.calls.size)
    }

    // ---- ack-gated image pacing (matches the official app; hang-safe via abort) ----

    @Test
    fun imageChunks_ackGated_nextChunkWaitsForPriorAck() {
        val sink = FakeSink()                 // acker NOT wired → chunks park; we drive acks manually
        val r = G2Renderer(sink)
        var done: Boolean? = null
        // 200×100 = 10118 B → 3 image chunks; the launch frame is NOT ack-gated and flows first.
        r.launch(10061, scene { text("s", 0, 0, 576, 28, "x"); image("pic", 0, 28, 200, 100, img(200, 100)) }) { done = it }

        // After launch: the (ungated) launch frame + the FIRST image chunk are out; chunk 1 is parked.
        run {
            val m = sink.messages()
            assertEquals("launch + chunk1 only (chunk2/3 gated on chunk1's ack)", 2, m.size)
            assertEquals(DisplayProto.MSG_LAUNCH, msgType(m[0]))
            assertEquals(DisplayProto.MSG_IMAGE, msgType(m[1]))
            assertNull("job must not complete while parked on an image ack", done)
        }
        // Ack chunk 1 → chunk 2 goes out, then parks.
        r.onImageAck(msgIdOf(sink.messages()[1]))
        assertEquals(3, sink.messages().size)
        assertNull(done)
        // Ack chunk 2 → chunk 3 goes out, then parks.
        r.onImageAck(msgIdOf(sink.messages()[2]))
        assertEquals(4, sink.messages().size)
        assertNull(done)
        // Ack chunk 3 (the last) → the whole launch completes.
        r.onImageAck(msgIdOf(sink.messages()[3]))
        assertEquals(true, done)
    }

    @Test
    fun abort_releasesParkedImageChunk_completesFalse_noHang() {
        val sink = FakeSink()                 // no auto-ack → the first chunk parks until abort
        val r = G2Renderer(sink)
        var done: Boolean? = null
        r.launch(10061, scene { text("s", 0, 0, 576, 28, "x"); image("pic", 0, 28, 200, 100, img(200, 100)) }) { done = it }
        assertNull("parked on the first image ack", done)
        r.abort("test teardown")              // the watchdog/teardown unblock
        assertEquals("a parked image send is released as a failure, never left hanging", false, done)
    }
}
