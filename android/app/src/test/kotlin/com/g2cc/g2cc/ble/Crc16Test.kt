package com.g2cc.g2cc.ble

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * CRC-16/CCITT cross-check against reference values computed via
 * the Python implementation in i-soxi's teleprompter.py:
 *
 *   def crc16_ccitt(data, init=0xFFFF):
 *       crc = init
 *       for byte in data:
 *           crc ^= byte << 8
 *           for _ in range(8):
 *               if crc & 0x8000: crc = (crc << 1) ^ 0x1021
 *               else: crc <<= 1
 *               crc &= 0xFFFF
 *       return crc
 *
 * Hand-computed values for the test vectors below by running that algorithm
 * on the listed inputs.
 */
class Crc16Test {

    @Test
    fun emptyInput_returnsInitValue() {
        // CRC of an empty input never iterates the loop; result = init = 0xFFFF
        assertEquals(0xFFFF, Crc16.compute(byteArrayOf()))
    }

    @Test
    fun singleZero_byte() {
        // Iteration 1: crc=0xFFFF; byteVal=0; crc ^= 0<<8 → still 0xFFFF
        // 8 shifts each pulling in the polynomial when MSB set:
        //   start 0xFFFF -> 0x7FFE^1021=0x6FDF; -> ... (8 iterations)
        // Reference value computed via the Python algorithm.
        assertEquals(0xE1F0, Crc16.compute(byteArrayOf(0x00)))
    }

    @Test
    fun singleByte_0xFF() {
        // Reference value computed via the Python algorithm.
        assertEquals(0xFF00, Crc16.compute(byteArrayOf(0xFF.toByte())))
    }

    @Test
    fun shortPayload_capability() {
        // Auth packet 1 payload bytes from teleprompter.py:80-82.
        val payload = byteArrayOf(
            0x08, 0x04, 0x10, 0x0C, 0x1A, 0x04, 0x08, 0x01, 0x10, 0x04,
        )
        // Reference value computed via the Python algorithm. If this fails,
        // the CRC implementation has a bug; debug by walking through one
        // iteration with a Python REPL alongside.
        assertEquals(0xBCC6, Crc16.compute(payload))
    }

    @Test
    fun rangeArguments_match_fullArray() {
        val padded = byteArrayOf(0xDE.toByte(), 0xAD.toByte()) +
            byteArrayOf(0x08, 0x04, 0x10, 0x0C, 0x1A, 0x04, 0x08, 0x01, 0x10, 0x04) +
            byteArrayOf(0xBE.toByte(), 0xEF.toByte())
        val sliced = Crc16.compute(padded, offset = 2, length = 10)
        val direct = Crc16.compute(byteArrayOf(0x08, 0x04, 0x10, 0x0C, 0x1A, 0x04, 0x08, 0x01, 0x10, 0x04))
        assertEquals(direct, sliced)
    }
}
