package com.g2cc.g2cc.ble

/**
 * Protobuf-style varint encoding/decoding.
 *
 * Citation: /home/user/G2 Custom/even-g2-protocol/examples/teleprompter/teleprompter.py:50-57
 *
 * Values 0–127 → single byte.
 * Values 128–16383 → two bytes (MSB has bit 7 set).
 * 16384+ → three or more bytes.
 */
object Varint {

    fun encode(value: Int): ByteArray {
        require(value >= 0) { "varint: only non-negative supported, got $value" }
        if (value == 0) return byteArrayOf(0x00)
        val out = ArrayList<Byte>(5)
        var v = value
        while (v > 0x7F) {
            out.add(((v and 0x7F) or 0x80).toByte())
            v = v ushr 7
        }
        out.add((v and 0x7F).toByte())
        return out.toByteArray()
    }

    /** Decode a varint starting at `offset`. Returns the value plus the number of
     *  bytes consumed. Throws on malformed input (10+ bytes without termination). */
    fun decode(data: ByteArray, offset: Int = 0): Pair<Int, Int> {
        require(offset >= 0 && offset < data.size) {
            "varint: offset $offset out of bounds (size=${data.size})"
        }
        var value = 0
        var shift = 0
        var i = offset
        while (i < data.size) {
            val b = data[i].toInt() and 0xFF
            value = value or ((b and 0x7F) shl shift)
            i++
            if ((b and 0x80) == 0) return value to (i - offset)
            shift += 7
            if (shift >= 35) {
                throw IllegalArgumentException("varint: malformed (>5 bytes without termination)")
            }
        }
        throw IllegalArgumentException("varint: truncated at end of buffer (offset=$offset, size=${data.size})")
    }
}
