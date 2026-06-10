package com.g2cc.g2cc.render

import com.g2cc.g2cc.ble.Crc16
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Byte-for-byte verification of the named-region display encoders against the REAL captured
 * frames from BTSnoop U=19 (Chess, 2026-06-05). Same discipline as EvenHubTest: if the encoder
 * drifts from the wire, these fail. Captured payload hex extracted via scripts/decode_display.py.
 */
class DisplayProtoTest {

    // ---- captured e0-20 payloads (post AA-header, pre-CRC) ----
    private val CAP_LAUNCH =
        "080010431a840108021a680800104018c00420e0014801520963686573732d6875645801624d0a576869" +
            "7465202d204d6f766520330ae29480e29480e29480e29480e29480e29480e29480e294800a0a546170" +
            "20746f20737065616b0a5363726f6c6c20746f20626567696e20e296b2e296bc221308bc01101418c8" +
            "012028280432056272616e6428cd4e"

    private val CAP_LAYOUT =
        "080710473ab40108041a680800100818f0022098024801520963686573732d6875645801624d0a576869" +
            "7465202d204d6f766520330ae29480e29480e29480e29480e29480e29480e29480e294800a0a546170" +
            "20746f20737065616b0a5363726f6c6c20746f20626567696e20e296b2e296bc221708f802102c18c8" +
            "01206428023209626f6172642d746f70221808f80210900118c801206428033209626f6172642d626f" +
            "74221308f802100418c8012028280432056272616e64"

    private val CAP_TEXT_CHESSHUD =
        "080510444a4b0801120963686573732d6875642a3c0a5768697465202d204d6f766520330ae29480e294" +
            "80e29480e29480e29480e29480e29480e294800a0a507265706172696e6720626f617264e280a6"

    private val CAP_TEXT_PSCORE = "0805100b4a1208031207702d73636f72651800200a2a0130"

    private val CAP_IMG_BRAND_CHUNK1 =
        "080310462a2b080412056272616e6418c10120962030013816421600000000000000000000000000000000000000000000"

    @Test
    fun textUpdate_pscore_matchesCapture() {
        // f1=5 to "p-score": regionId 3, contentOffset 0, contentLength 10, text "0", msgId 11.
        // (Chess cleared the 10-char score field then wrote the new value — partial in-place replace.)
        val payload = DisplayProto.textPayload(0x0b, 3, "p-score", "0", contentOffset = 0, contentLength = 10)
        assertEquals(CAP_TEXT_PSCORE, hx(payload))
    }

    @Test
    fun textUpdate_chessHud_matchesCapture() {
        // f1=5 to "chess-hud": regionId 1, no scroll fields, "Preparing board…", msgId 68.
        val payload = DisplayProto.textPayload(0x44, 1, "chess-hud", ChessText.PREPARING)
        assertEquals(CAP_TEXT_CHESSHUD, hx(payload))
    }

    @Test
    fun imagePush_matchesCapture() {
        // f1=3 brand chunk 1: regionId 4, token 193, total 4118, chunkIndex 1, 22 bytes (all zero), msgId 70.
        val payload = DisplayProto.imagePayload(0x46, 4, "brand", token = 193, totalBytes = 4118, chunkIndex = 1, chunk = ByteArray(22))
        assertEquals(CAP_IMG_BRAND_CHUNK1, hx(payload))
    }

    @Test
    fun launch_matchesCapture() {
        val texts = listOf(DisplayProto.textContainer(0, 64, 576, 224, id = 1, name = "chess-hud", scroll = true, text = ChessText.HEADER))
        val images = listOf(DisplayProto.imageContainer(188, 20, 200, 40, id = 4, name = "brand"))
        val payload = DisplayProto.launchPayload(0x43, token = 10061, texts = texts, images = images)
        assertEquals(CAP_LAUNCH, hx(payload))
    }

    @Test
    fun layout_matchesCapture() {
        val texts = listOf(DisplayProto.textContainer(0, 8, 368, 280, id = 1, name = "chess-hud", scroll = true, text = ChessText.HEADER))
        val images = listOf(
            DisplayProto.imageContainer(376, 44, 200, 100, id = 2, name = "board-top"),
            DisplayProto.imageContainer(376, 144, 200, 100, id = 3, name = "board-bot"),
            DisplayProto.imageContainer(376, 4, 200, 40, id = 4, name = "brand"),
        )
        val payload = DisplayProto.layoutPayload(0x47, texts = texts, images = images)
        assertEquals(CAP_LAYOUT, hx(payload))
    }

    @Test
    fun framing_singlePacket_wrapsPayloadWithWholePayloadCrc() {
        val payload = unhx(CAP_TEXT_PSCORE)
        val packets = DisplayProto.frame(0x10, payload)
        assertEquals(1, packets.size)
        val p = packets[0]
        assertEquals(0xAA, p[0].toInt() and 0xFF)        // magic
        assertEquals(0x21, p[1].toInt() and 0xFF)        // command
        assertEquals(0x10, p[2].toInt() and 0xFF)        // seq
        assertEquals(payload.size + 2, p[3].toInt() and 0xFF) // Len = payload + CRC
        assertEquals(1, p[4].toInt() and 0xFF)           // pktTot
        assertEquals(1, p[5].toInt() and 0xFF)           // pktSer
        assertEquals(0xE0, p[6].toInt() and 0xFF)        // svc hi
        assertEquals(0x20, p[7].toInt() and 0xFF)        // svc lo
        val crc = Crc16.compute(payload)
        assertEquals(crc and 0xFF, p[p.size - 2].toInt() and 0xFF)
        assertEquals((crc ushr 8) and 0xFF, p[p.size - 1].toInt() and 0xFF)
    }

    @Test
    fun framing_multiPacket_crcOnFinalOnly_reassemblesToPayload() {
        // > MAX_AA_CHUNK forces a split. Use a 600-byte synthetic image push.
        val payload = DisplayProto.imagePayload(1, 2, "tile", token = 7, totalBytes = 600, chunkIndex = 0, chunk = ByteArray(560) { (it and 0xFF).toByte() })
        assertTrue(payload.size > DisplayProto.MAX_AA_CHUNK)
        val packets = DisplayProto.frame(0x22, payload)
        assertTrue("expected a split", packets.size >= 2)
        for ((i, p) in packets.withIndex()) {
            assertEquals(packets.size, p[4].toInt() and 0xFF) // pktTot constant across packets
            assertEquals(i + 1, p[5].toInt() and 0xFF)        // pktSer 1-indexed
        }
        // non-final packets carry NO CRC; only the final does — the reassembly proves it.
        assertArrayEquals(payload, splitMessages(packets).single())
        // final-packet CRC covers the WHOLE payload, not just the last chunk.
        val crc = Crc16.compute(payload)
        val last = packets.last()
        assertEquals(crc and 0xFF, last[last.size - 2].toInt() and 0xFF)
        assertEquals((crc ushr 8) and 0xFF, last[last.size - 1].toInt() and 0xFF)
    }

    // ---- LIST container + style fields (docs/G2_BLE_PROTOCOL.md §6.1, g2cap LIST group) ----

    @Test
    fun listContainer_matchesOfficialSchema() {
        // HAND-ENCODED golden bytes (computed from the §6.1 schema by hand, independent of the
        // encoder) for the g2cap capture example 16:32:50 "list5 sel1 wAuto": geometry
        // 0,44,576,244; style bw1 bc6 br2 p4; id 2; name "body"; itemContainer {count 5,
        // width 0 (auto), selBorder 1, "it-0".."it-4"}; isEventCapture 1. All style values are
        // non-zero here, so emit-if-nonzero matches the official frame exactly. The f11 inner
        // f1/f2/f3 are ALWAYS emitted (official frames carry explicit zeros there —
        // "list20 sel0 w120" → f11={f1=20 f2=120 f3=0}).
        val golden = "0800102c18c00420f40128013006380240044802" +     // f1..f4 geom, f5..f8 style, f9 id
            "5204626f6479" +                                          // f10 "body"
            "5a24080510001801" +                                      // f11 + len + {f1=5 f2=0 f3=1}
            "220469742d30220469742d31220469742d32220469742d33220469742d34" + // f11.f4 items ×5
            "6001"                                                    // f12 isEventCapture=1
        val enc = DisplayProto.listContainer(
            0, 44, 576, 244, id = 2, name = "body",
            items = listOf("it-0", "it-1", "it-2", "it-3", "it-4"),
            itemWidth = 0, selectBorder = true, eventCapture = true,
            style = RegionStyle(borderWidth = 1, borderColor = 6, borderRadius = 2, padding = 4),
        )
        assertEquals(golden, hx(enc))
    }

    @Test
    fun launch_withList_wrapperOrdersListsTextsImagesToken() {
        // Wrapper ordering is load-bearing (§5): f1 count, f2 lists, f3 texts, f4 images,
        // f5 token. Expected bytes assembled from the individually golden-tested container
        // encoders, so this isolates the WRAPPER structure.
        val li = DisplayProto.listContainer(0, 38, 96, 212, id = 3, name = "menu", items = listOf("Next", "Prev"), eventCapture = true)
        val tx = DisplayProto.textContainer(0, 0, 444, 38, id = 2, name = "title", text = "T")
        val im = DisplayProto.imageContainer(96, 38, 240, 106, id = 10, name = "t0")
        fun lenHex(n: Int): String { require(n < 128); return "%02x".format(n) }
        val wrapper = "0803" +                                  // f1 = 3 containers
            "12" + lenHex(li.size) + hx(li) +                   // f2 list
            "1a" + lenHex(tx.size) + hx(tx) +                   // f3 text
            "22" + lenHex(im.size) + hx(im) +                   // f4 image
            "28904e"                                            // f5 token = 10000
        val expected = "0800" + "1021" + "1a" + lenHex(wrapper.length / 2) + wrapper
        val payload = DisplayProto.launchPayload(0x21, token = 10000, texts = listOf(tx), images = listOf(im), lists = listOf(li))
        assertEquals(expected, hx(payload))
    }

    @Test
    fun textContainer_styleFields_emitOnlyWhenNonZero() {
        // style=NONE is byte-identical to the lean schema (the capture-locked launch/layout
        // tests prove the full unstyled frames; this pins the explicit-NONE path too).
        val lean = DisplayProto.textContainer(0, 64, 576, 224, id = 1, name = "hud", text = "x")
        val none = DisplayProto.textContainer(0, 64, 576, 224, id = 1, name = "hud", text = "x", style = RegionStyle.NONE)
        assertArrayEquals(lean, none)
        // Styled emits f5/f6/f8 in field order between f4 and f9; the zero-valued f7 is omitted.
        val styled = DisplayProto.textContainer(0, 0, 444, 38, id = 2, name = "title", text = "T",
            style = RegionStyle(borderWidth = 1, borderColor = 6, borderRadius = 0, padding = 4))
        assertTrue(hx(styled).contains("2801" + "3006" + "4004" + "4802"))   // f5=1 f6=6 [no f7] f8=4 f9=2
    }

    @Test
    fun keepalive_hasExpectedPayloadAndValidCrc() {
        val frame = DisplayProto.keepalive(0x10, 0x20)
        assertEquals(0xAA, frame[0].toInt() and 0xFF)
        assertEquals(0x21, frame[1].toInt() and 0xFF)
        assertEquals(0x10, frame[2].toInt() and 0xFF)               // seq
        assertEquals(0xE0, frame[6].toInt() and 0xFF)               // svc hi
        assertEquals(0x20, frame[7].toInt() and 0xFF)               // svc lo
        assertEquals("080c10207200", hx(splitMessages(listOf(frame)).single())) // f1=12 f2=32 f14=empty
        assertTrue(com.g2cc.g2cc.ble.G2Frame.verifyCrc(frame))
    }
}
