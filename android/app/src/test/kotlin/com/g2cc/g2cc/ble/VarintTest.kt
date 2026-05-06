package com.g2cc.g2cc.ble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class VarintTest {

    @Test
    fun encode_zero() {
        assertArrayEquals(byteArrayOf(0x00), Varint.encode(0))
    }

    @Test
    fun encode_127_fitsInOneByte() {
        assertArrayEquals(byteArrayOf(0x7F), Varint.encode(127))
    }

    @Test
    fun encode_128_spillsToTwoBytes() {
        assertArrayEquals(byteArrayOf(0x80.toByte(), 0x01), Varint.encode(128))
    }

    @Test
    fun encode_255_twoBytes() {
        // 255 = 0xFF → low7=0x7F (with MSB) = 0xFF, high=0x01
        assertArrayEquals(byteArrayOf(0xFF.toByte(), 0x01), Varint.encode(255))
    }

    @Test
    fun encode_300_matchesProtocolDoc() {
        // PROTOCOL_NOTES.md / packet-structure.md example:  300 → 0xAC 0x02
        assertArrayEquals(byteArrayOf(0xAC.toByte(), 0x02), Varint.encode(300))
    }

    @Test
    fun encode_decode_roundtrip() {
        for (v in listOf(0, 1, 7, 127, 128, 255, 300, 1024, 16383, 16384, 1_000_000)) {
            val encoded = Varint.encode(v)
            val (decoded, consumed) = Varint.decode(encoded)
            assertEquals("roundtrip value", v, decoded)
            assertEquals("roundtrip length", encoded.size, consumed)
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun encode_negative_throwsLoudly() {
        Varint.encode(-1)
    }

    @Test(expected = IllegalArgumentException::class)
    fun decode_truncated_throwsLoudly() {
        // 0x80 sets continuation bit but there's no follow-up byte.
        Varint.decode(byteArrayOf(0x80.toByte()))
    }
}
