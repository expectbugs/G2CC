package com.g2cc.g2cc.ble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthSequenceTest {

    @Test
    fun build_producesExactlySevenPackets() {
        val packets = AuthSequence.build(unixTimestampSec = 1714737600L)  // arbitrary timestamp
        assertEquals(7, packets.size)
    }

    @Test
    fun build_seqNumbersAreOneToSeven() {
        val packets = AuthSequence.build(unixTimestampSec = 1714737600L)
        for ((i, p) in packets.withIndex()) {
            assertEquals("packet ${i + 1} seq", (i + 1).toByte(), p[2])
        }
    }

    @Test
    fun build_servicesAlternateAuthControlAndAuthData() {
        // Per teleprompter.py:78-114, the order is 0x80-00 / 0x80-20 / 0x80-20
        // / 0x80-00 / 0x80-00 / 0x80-20 / 0x80-20.
        val expected = listOf(
            G2Constants.Services.AUTH_CONTROL,
            G2Constants.Services.AUTH_DATA,
            G2Constants.Services.AUTH_DATA,
            G2Constants.Services.AUTH_CONTROL,
            G2Constants.Services.AUTH_CONTROL,
            G2Constants.Services.AUTH_DATA,
            G2Constants.Services.AUTH_DATA,
        )
        val packets = AuthSequence.build(unixTimestampSec = 1714737600L)
        for ((i, expService) in expected.withIndex()) {
            assertEquals("packet ${i + 1} svcHi", expService[0], packets[i][6])
            assertEquals("packet ${i + 1} svcLo", expService[1], packets[i][7])
        }
    }

    @Test
    fun build_packet1_matchesReference() {
        val packets = AuthSequence.build(unixTimestampSec = 1714737600L)
        // Packet 1 is timestamp-independent (capability query, fixed payload).
        // Compare against the literal bytes from teleprompter.py:79-82 plus CRC.
        val expectedHeader = byteArrayOf(
            0xAA.toByte(), 0x21, 0x01, 0x0C, 0x01, 0x01, 0x80.toByte(), 0x00,
        )
        val expectedPayload = byteArrayOf(
            0x08, 0x04, 0x10, 0x0C, 0x1A, 0x04, 0x08, 0x01, 0x10, 0x04,
        )
        val crc = Crc16.compute(expectedPayload)
        val expected = expectedHeader + expectedPayload + byteArrayOf(
            (crc and 0xFF).toByte(),
            ((crc ushr 8) and 0xFF).toByte(),
        )
        assertArrayEquals(expected, packets[0])
    }

    @Test
    fun build_packet3_containsTimestamp() {
        val ts = 0x6234ABCDL  // arbitrary; varint will encode a multi-byte value
        val packets = AuthSequence.build(unixTimestampSec = ts)
        val packet3 = packets[2]
        // Confirm the varint of `ts` appears in the payload section.
        val payload = packet3.copyOfRange(G2Frame.HEADER_SIZE, packet3.size - G2Frame.CRC_SIZE)
        val tsVarint = Varint.encode(ts.toInt())
        // Find tsVarint as a contiguous subsequence of payload.
        val idx = (0..payload.size - tsVarint.size).firstOrNull { offset ->
            tsVarint.indices.all { payload[offset + it] == tsVarint[it] }
        }
        assertTrue("timestamp varint must appear in packet 3 payload (idx=$idx)", idx != null)
    }

    @Test
    fun build_allPacketsCrcValid() {
        val packets = AuthSequence.build(unixTimestampSec = 1714737600L)
        for ((i, p) in packets.withIndex()) {
            assertTrue("packet ${i + 1} CRC", G2Frame.verifyCrc(p))
        }
    }
}
