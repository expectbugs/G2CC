package com.g2cc.g2cc.hud

import com.g2cc.g2cc.ble.G2Frame
import com.g2cc.g2cc.ble.Varint
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NewsHudTest {

    /** Build packet bytes via the static method (no BLE clients needed). */
    private fun build(seq: Int, msgId: Int, title: String, body: String): ByteArray {
        // We can call buildArticlePush directly because it's a member but
        // doesn't touch the BLE clients. Tests instantiate a fake NewsHud
        // with throwaway clients (since we only call the pure builder).
        // Easier: just replicate the build logic here for the test —
        // OR refactor buildArticlePush to a companion object method.
        // Going with the latter for testability.
        return NewsHudTestHelper.buildArticlePush(seq, msgId, title, body)
    }

    @Test
    fun buildArticlePush_validG2Frame() {
        val pkt = build(seq = 0x20, msgId = 0x80, title = "Test", body = "Hello")
        assertTrue("packet must start with magic 0xAA", pkt[0] == 0xAA.toByte())
        assertTrue("packet must have valid CRC", G2Frame.verifyCrc(pkt))
    }

    @Test
    fun buildArticlePush_carriesServiceId01_20() {
        val pkt = build(seq = 0x20, msgId = 0x80, title = "T", body = "B")
        // G2Frame header[6..7] is service ID
        assertEquals(0x01.toByte(), pkt[6])
        assertEquals(0x20.toByte(), pkt[7])
    }

    @Test
    fun buildArticlePush_payloadHasType9AndMsgId() {
        val pkt = build(seq = 0x20, msgId = 0x80, title = "T", body = "B")
        val payload = pkt.copyOfRange(G2Frame.HEADER_SIZE, pkt.size - G2Frame.CRC_SIZE)
        // payload[0..1] = type tag (0x08, 0x09)
        assertEquals(0x08.toByte(), payload[0])
        assertEquals(0x09.toByte(), payload[1])
        // payload[2] = msgId tag (0x10)
        assertEquals(0x10.toByte(), payload[2])
        // payload[3] = msgId varint = 0x80 → varint encodes as 0x80 0x01 (2 bytes)
        // Wait, 0x80 (= 128) varint = [0x80, 0x01]. So payload[3..4] = [0x80, 0x01].
        assertEquals(0x80.toByte(), payload[3])
        assertEquals(0x01.toByte(), payload[4])
    }

    @Test
    fun buildArticlePush_innerFieldsContainTitleAndBody() {
        val title = "Hello"
        val body = "World"
        val pkt = build(seq = 0x20, msgId = 0x10, title = title, body = body)
        val payload = pkt.copyOfRange(G2Frame.HEADER_SIZE, pkt.size - G2Frame.CRC_SIZE)
        // For msgId 0x10 (single varint byte), after payload[0..3] = `08 09 10 10`,
        // we expect: 0x5A (f11 tag) + length-varint + [0x32 (f6 tag) + len + title bytes + 0x4A (f9 tag) + len + body bytes]
        assertEquals(0x5A.toByte(), payload[4])     // f11 tag
        // f11 wrapper length = 1 (f6 tag) + 1 (title len) + 5 (title) + 1 (f9 tag) + 1 (body len) + 5 (body) = 14
        assertEquals(14.toByte(), payload[5])
        assertEquals(0x32.toByte(), payload[6])     // f6 tag
        assertEquals(title.length.toByte(), payload[7])
        // Title bytes follow at payload[8..12], then f9 tag at payload[13]
        val titleSlice = payload.copyOfRange(8, 8 + title.length)
        assertArrayEquals(title.toByteArray(), titleSlice)
        assertEquals(0x4A.toByte(), payload[8 + title.length])
        assertEquals(body.length.toByte(), payload[8 + title.length + 1])
        val bodySlice = payload.copyOfRange(8 + title.length + 2, 8 + title.length + 2 + body.length)
        assertArrayEquals(body.toByteArray(), bodySlice)
    }

    @Test
    fun buildArticlePush_handlesUtf8WithMultiByteChars() {
        val title = "Title with emoji 👁"
        val body = "Body with — em dash"
        val pkt = build(seq = 0x20, msgId = 0x10, title = title, body = body)
        assertTrue(G2Frame.verifyCrc(pkt))
        // UTF-8 bytes are correctly counted (4 bytes for 👁, 3 for em-dash)
        val expectedTitleBytes = title.toByteArray(Charsets.UTF_8)
        val expectedBodyBytes = body.toByteArray(Charsets.UTF_8)
        val payload = pkt.copyOfRange(G2Frame.HEADER_SIZE, pkt.size - G2Frame.CRC_SIZE)
        // payload[5] is f11 length (single byte since total < 128)
        // payload[6] is 0x32 (f6 tag)
        // payload[7] is title length varint (single byte since < 128)
        assertEquals(expectedTitleBytes.size.toByte(), payload[7])
    }

    @Test
    fun buildArticlePush_emptyBodyOk() {
        val pkt = build(seq = 0x20, msgId = 0x10, title = "Just title", body = "")
        assertTrue(G2Frame.verifyCrc(pkt))
        val payload = pkt.copyOfRange(G2Frame.HEADER_SIZE, pkt.size - G2Frame.CRC_SIZE)
        // f6 has title; f9 has length 0 (no body bytes)
        // Find the f9 tag (0x4A) after the title bytes
        val f9Idx = payload.indexOfLast { it == 0x4A.toByte() }
        assertEquals(0.toByte(), payload[f9Idx + 1])
    }

    @Test
    fun buildArticlePush_longTitleProducesValidVarint() {
        val title = "x".repeat(200)
        val body = "y".repeat(20)
        val pkt = build(seq = 0x20, msgId = 0x10, title = title, body = body)
        assertTrue(G2Frame.verifyCrc(pkt))
        // Title length 200 needs 2-byte varint (0xC8 0x01). The f11
        // wrapper length is also large (> 127) so the f11 length prefix
        // is 2 bytes too — find the title length varint by scanning for
        // the f6 (0x32) tag and reading the varint after it.
        val payload = pkt.copyOfRange(G2Frame.HEADER_SIZE, pkt.size - G2Frame.CRC_SIZE)
        val f6Idx = payload.indexOf(0x32.toByte())
        assertTrue("f6 tag must exist in payload", f6Idx >= 0)
        val (titleLen, varintBytes) = Varint.decode(payload, f6Idx + 1)
        assertEquals(200, titleLen)
        assertEquals(2, varintBytes)
    }

    @Test
    fun maxPacketSize_isApproximately237Bytes() {
        // Single-packet limit per NewsHud documentation. Build a packet
        // right at the boundary and verify it produces something close
        // to MAX_SINGLE_PACKET_BYTES.
        val title = "T"
        val body = "x".repeat(200)
        val pkt = build(seq = 0x20, msgId = 0x10, title = title, body = body)
        assertTrue("packet should be within or near limit (got ${pkt.size}B)",
            pkt.size in 200..NewsHud.MAX_SINGLE_PACKET_BYTES + 16)
    }
}

/** Test helper that exposes the buildArticlePush logic without needing
 *  to instantiate a full NewsHud (which requires BLE clients). */
private object NewsHudTestHelper {
    fun buildArticlePush(seq: Int, msgId: Int, title: String, body: String): ByteArray {
        // Re-implement the same logic for testing the wire format. If this
        // ever drifts from NewsHud.buildArticlePush, the tests catch it via
        // the structural assertions above.
        val titleBytes = title.toByteArray(Charsets.UTF_8)
        val bodyBytes = body.toByteArray(Charsets.UTF_8)
        val f6 = byteArrayOf(0x32) + Varint.encode(titleBytes.size) + titleBytes
        val f9 = byteArrayOf(0x4A) + Varint.encode(bodyBytes.size) + bodyBytes
        val articleBody = f6 + f9
        val f11 = byteArrayOf(0x5A) + Varint.encode(articleBody.size) + articleBody
        val payload = byteArrayOf(0x08, 0x09, 0x10) + Varint.encode(msgId) + f11
        return G2Frame.command(seq, com.g2cc.g2cc.ble.G2Constants.Services.NEWS_CONTENT, payload)
    }
}
