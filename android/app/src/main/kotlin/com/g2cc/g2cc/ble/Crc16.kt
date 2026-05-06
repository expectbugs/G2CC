package com.g2cc.g2cc.ble

/**
 * CRC-16/CCITT — exactly matches the algorithm in
 * /home/user/G2 Custom/even-g2-protocol/examples/teleprompter/teleprompter.py:29-37.
 *
 * Init = 0xFFFF, polynomial = 0x1021. Computed over PAYLOAD bytes only (skip
 * the 8-byte packet header). Stored little-endian in the last two bytes of
 * the packet.
 */
object Crc16 {
    fun compute(data: ByteArray, offset: Int = 0, length: Int = data.size - offset): Int {
        require(offset >= 0 && length >= 0 && offset + length <= data.size) {
            "CRC16: invalid range offset=$offset length=$length size=${data.size}"
        }
        var crc = 0xFFFF
        for (i in offset until offset + length) {
            val byteVal = data[i].toInt() and 0xFF
            crc = crc xor (byteVal shl 8)
            for (b in 0 until 8) {
                crc = if ((crc and 0x8000) != 0) {
                    (crc shl 1) xor 0x1021
                } else {
                    crc shl 1
                }
                crc = crc and 0xFFFF
            }
        }
        return crc
    }
}
