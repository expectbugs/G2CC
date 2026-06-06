package com.g2cc.g2cc.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EventParserTest {

    @Test
    fun parse_malformed_whenTooShort() {
        val ev = EventParser.parse(byteArrayOf(0xAA.toByte(), 0x12))
        assertTrue(ev is EventParser.Event.Malformed)
    }

    @Test
    fun parse_malformed_whenBadMagic() {
        val raw = ByteArray(G2Frame.HEADER_SIZE + G2Frame.CRC_SIZE)
        raw[0] = 0x55                                  // wrong magic
        val ev = EventParser.parse(raw)
        assertTrue(ev is EventParser.Event.Malformed)
    }

    @Test
    fun parse_malformed_whenBadCrc() {
        // Build a valid packet and corrupt its CRC.
        val packet = G2Frame.command(
            seq = 1,
            service = G2Constants.Services.AUTH_CONTROL,
            payload = byteArrayOf(0x01, 0x02, 0x03),
        )
        val corrupted = packet.copyOf()
        corrupted[corrupted.size - 1] = (corrupted[corrupted.size - 1].toInt() xor 0xFF).toByte()
        val ev = EventParser.parse(corrupted)
        assertTrue("CRC mismatch must produce Malformed", ev is EventParser.Event.Malformed)
    }

    @Test
    fun parse_unknown_forValidUnrecognizedFrame() {
        // Phase 5 returns Unknown for any well-formed frame until tap/scroll
        // bytes are reverse-engineered. Verify the service+payload are surfaced.
        val packet = G2Frame.command(
            seq = 1,
            service = G2Constants.Services.AUTH_CONTROL,
            payload = byteArrayOf(0x01, 0x02, 0x03),
        )
        val ev = EventParser.parse(packet)
        assertTrue(ev is EventParser.Event.Unknown)
        val unknown = ev as EventParser.Event.Unknown
        assertEquals(0x80.toByte(), unknown.service.first)
        assertEquals(0x00.toByte(), unknown.service.second)
        assertEquals("01 02 03", unknown.payloadHex)
    }

    // === Service 0x01-01 ring event channel (decoded from BTSnoop 2026-06-02) ===

    /** Build a notification-style packet (type 0x12) on the given service.
     *  G2Frame.command() builds 0x21 commands; for testing the parser against
     *  glasses→phone notifications we need to flip the type byte. */
    private fun ringNotif(payload: ByteArray): ByteArray {
        // Build via command() then patch type byte; CRC stays valid because
        // it's computed over header[8:] (which is unchanged) per i-soxi spec.
        // Wait — actually CRC IS over the bytes after the 8-byte header
        // (verified in G2Frame.kt). The type byte is INSIDE the header, so
        // changing it doesn't invalidate CRC. Good.
        val pkt = G2Frame.command(seq = 0x10, service = byteArrayOf(0x01, 0x01), payload = payload)
        pkt[1] = 0x12.toByte()
        return pkt
    }

    @Test
    fun parse_tap_fromKnownBtsnoopBytes() {
        // BTSnoop 2026-06-02: every Tap event was exactly this 8-byte payload.
        val ev = EventParser.parse(ringNotif(byteArrayOf(0x08, 0x0B, 0x10, 0x01, 0x6A, 0x02, 0x08, 0x01)))
        assertTrue("expected Tap, got $ev", ev is EventParser.Event.Tap)
    }

    @Test
    fun parse_scrollFocus_emptyEvent() {
        // BTSnoop: empty 0x72 sub-event = focus/wake (ring detected motion start).
        val ev = EventParser.parse(ringNotif(byteArrayOf(0x08, 0x0C, 0x10, 0x01, 0x72, 0x00)))
        assertTrue("expected ScrollFocus, got $ev", ev is EventParser.Event.ScrollFocus)
    }

    @Test
    fun parse_scrollDown_nonEmptyEvent() {
        // BTSnoop: f1=v2 f2=v1 (incrementing scroll position).
        val ev = EventParser.parse(ringNotif(byteArrayOf(0x08, 0x0C, 0x10, 0x01, 0x72, 0x04, 0x08, 0x02, 0x10, 0x01)))
        assertTrue("expected ScrollDown, got $ev", ev is EventParser.Event.ScrollDown)
    }

    @Test
    fun parse_scrollFocus_whenNoSubField() {
        // Payload ending right after msg_id (no 0x72 trailer) — wake-up signal.
        val ev = EventParser.parse(ringNotif(byteArrayOf(0x08, 0x0C, 0x10, 0x01)))
        assertTrue("expected ScrollFocus, got $ev", ev is EventParser.Event.ScrollFocus)
    }

    @Test
    fun parse_malformed_whenScrollVarintTruncated() {
        // 4th-pass review fix: truncated varint should produce Malformed loudly,
        // NOT silently fall through to ScrollFocus.
        val ev = EventParser.parse(ringNotif(byteArrayOf(0x08, 0x0C, 0x10, 0x80.toByte())))
        assertTrue("expected Malformed (truncated varint), got $ev", ev is EventParser.Event.Malformed)
    }

    @Test
    fun parse_internalMenuEvent_decoratedType3() {
        // BTSnoop pattern: type=3 wrapped in 0x12345678 magic + counter.
        // f1=v3 f2=v305419896 f6=[f1=v1024 f5=...]
        // Wire bytes: 08 03 10 f8 ac d1 91 01 32 0b 08 80 08 2a 06 08 01 12 02 10 01
        val payload = byteArrayOf(
            0x08, 0x03, 0x10,
            0xF8.toByte(), 0xAC.toByte(), 0xD1.toByte(), 0x91.toByte(), 0x01,    // varint = 0x12345678
            0x32, 0x0B,                                                            // f6 length-delim
            0x08, 0x80.toByte(), 0x08,                                             // counter=1024
            0x2A, 0x06, 0x08, 0x01, 0x12, 0x02, 0x10, 0x01,                       // f5 sub
        )
        val ev = EventParser.parse(ringNotif(payload))
        assertTrue("expected InternalMenuEvent, got $ev", ev is EventParser.Event.InternalMenuEvent)
        val ime = ev as EventParser.Event.InternalMenuEvent
        assertEquals(1024, ime.counter)
    }

    @Test
    fun parse_unknown_for0x0101WithUnrecognizedType() {
        // Any 0x01-01 packet with type byte not in {0x03, 0x0B, 0x0C} should
        // surface as Unknown (not silently dropped, per "no silent failures").
        val ev = EventParser.parse(ringNotif(byteArrayOf(0x08, 0x77, 0x10, 0x01)))
        assertTrue("expected Unknown, got $ev", ev is EventParser.Event.Unknown)
    }

    // === Service 0xe0-01 EvenHub input channel (decoded from BTSnoop 2026-06-04) ===

    /** Build a notification (type 0x12) on the EvenHub input service 0xe0-01. */
    private fun hubNotif(payload: ByteArray): ByteArray {
        val pkt = G2Frame.command(seq = 0x10, service = byteArrayOf(0xE0.toByte(), 0x01), payload = payload)
        pkt[1] = 0x12.toByte()
        return pkt
    }

    @Test
    fun parse_hubSelect_menuListWithIndex() {
        // parse3 18:04:12.332: f13.f1={f1=2, f2="menu-list", f4=1}.
        val payload = byteArrayOf(0x08, 0x02, 0x6A, 0x11, 0x0A, 0x0F, 0x08, 0x02, 0x12, 0x09) +
            "menu-list".toByteArray(Charsets.UTF_8) + byteArrayOf(0x20, 0x01)
        val ev = EventParser.parse(hubNotif(payload))
        assertTrue("expected HubSelect, got $ev", ev is EventParser.Event.HubSelect)
        ev as EventParser.Event.HubSelect
        assertEquals("menu-list", ev.widgetType)
        assertEquals(1, ev.index)
    }

    @Test
    fun parse_hubSelect_noIndexDefaultsToZero() {
        // parse3 18:03:55.957: f13.f1={f1=21, f2="doclist"} (no f4 index).
        val payload = byteArrayOf(0x08, 0x02, 0x6A, 0x0D, 0x0A, 0x0B, 0x08, 0x15, 0x12, 0x07) +
            "doclist".toByteArray(Charsets.UTF_8)
        val ev = EventParser.parse(hubNotif(payload))
        assertTrue("expected HubSelect, got $ev", ev is EventParser.Event.HubSelect)
        ev as EventParser.Event.HubSelect
        assertEquals("doclist", ev.widgetType)
        assertEquals(0, ev.index)
    }

    @Test
    fun parse_hubGesture_decodesCode() {
        // parse1 13:16:01.487: f13.f3={f1=3, f2=2}.
        val ev = EventParser.parse(hubNotif(byteArrayOf(0x08, 0x02, 0x6A, 0x06, 0x1A, 0x04, 0x08, 0x03, 0x10, 0x02)))
        assertTrue("expected HubGesture, got $ev", ev is EventParser.Event.HubGesture)
        assertEquals(3, (ev as EventParser.Event.HubGesture).code)
    }

    @Test
    fun parse_hubFocus_namesFocusedRegion() {
        // hardware capture 2026-06-06 (G2CC server-mode scroll): ring scroll on a
        // focused container → f13.f2={f1=11(containerId), f2="body", f3=2}. Exact
        // payload from /tmp/g2cc-harness-diag.log.
        val payload = byteArrayOf(0x08, 0x02, 0x6A, 0x0C, 0x12, 0x0A, 0x08, 0x0B, 0x12, 0x04) +
            "body".toByteArray(Charsets.UTF_8) + byteArrayOf(0x18, 0x02)
        val ev = EventParser.parse(hubNotif(payload))
        assertTrue("expected HubFocus, got $ev", ev is EventParser.Event.HubFocus)
        ev as EventParser.Event.HubFocus
        assertEquals(11, ev.containerId)
        assertEquals("body", ev.name)
        assertEquals(2, ev.f3)
    }
}
