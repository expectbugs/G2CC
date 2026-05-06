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
}
