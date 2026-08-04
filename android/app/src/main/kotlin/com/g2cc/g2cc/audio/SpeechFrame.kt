package com.g2cc.g2cc.audio

/**
 * Downstream speech-frame codec (earbud 2026-08-04) — the WS binary layout
 * mirrored from shared/src/constants.ts:
 *
 *   [tag u8 = 0x11][num u32BE][seq u32BE][payload PCM16LE @ 24 kHz mono]
 *
 * Pure + allocation-light → unit-tested without Android. parse() returns null
 * for anything that isn't a well-formed speech frame (wrong tag, short
 * header, odd payload length) — the caller logs LOUDLY.
 */
object SpeechFrame {
    const val TAG_SPEECH = 0x11
    const val HEADER_BYTES = 9

    data class Frame(val num: Long, val seq: Long, val pcm: ByteArray)

    fun parse(bytes: ByteArray): Frame? {
        if (bytes.size < HEADER_BYTES) return null
        if (bytes[0].toInt() and 0xFF != TAG_SPEECH) return null
        val payloadLen = bytes.size - HEADER_BYTES
        if (payloadLen == 0 || payloadLen % 2 != 0) return null   // s16 alignment
        val num = readU32BE(bytes, 1)
        val seq = readU32BE(bytes, 5)
        val pcm = bytes.copyOfRange(HEADER_BYTES, bytes.size)
        return Frame(num, seq, pcm)
    }

    private fun readU32BE(b: ByteArray, off: Int): Long =
        ((b[off].toLong() and 0xFF) shl 24) or
            ((b[off + 1].toLong() and 0xFF) shl 16) or
            ((b[off + 2].toLong() and 0xFF) shl 8) or
            (b[off + 3].toLong() and 0xFF)
}
