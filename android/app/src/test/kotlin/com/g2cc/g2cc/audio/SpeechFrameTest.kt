package com.g2cc.g2cc.audio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Speech-frame codec (earbud 2026-08-04) — the downstream WS binary layout
 * mirrored from shared/src/constants.ts: [0x11][num u32BE][seq u32BE][PCM16LE].
 * The server-side framer is earbud.ts speakOne(); these vectors match its
 * Buffer.writeUInt32BE layout exactly.
 */
class SpeechFrameTest {

    private fun frame(tag: Int, num: Long, seq: Long, payload: ByteArray): ByteArray {
        val out = ByteArray(9 + payload.size)
        out[0] = tag.toByte()
        for (i in 0 until 4) out[1 + i] = ((num shr (24 - 8 * i)) and 0xFF).toByte()
        for (i in 0 until 4) out[5 + i] = ((seq shr (24 - 8 * i)) and 0xFF).toByte()
        payload.copyInto(out, 9)
        return out
    }

    @Test fun parsesWellFormedFrame() {
        val pcm = byteArrayOf(1, 2, 3, 4, 5, 6)
        val f = SpeechFrame.parse(frame(0x11, 7, 42, pcm))!!
        assertEquals(7L, f.num)
        assertEquals(42L, f.seq)
        assertArrayEquals(pcm, f.pcm)
    }

    @Test fun parsesU32Extremes() {
        // num is a u32 wrap counter server-side ((seq+1)>>>0) — full range must survive.
        val f = SpeechFrame.parse(frame(0x11, 0xFFFFFFFFL, 0, byteArrayOf(0, 0)))!!
        assertEquals(0xFFFFFFFFL, f.num)
        assertEquals(0L, f.seq)
    }

    @Test fun rejectsWrongTag() {
        assertNull(SpeechFrame.parse(frame(0x01, 1, 0, byteArrayOf(0, 0))))   // upstream mic tag
        assertNull(SpeechFrame.parse(frame(0x12, 1, 0, byteArrayOf(0, 0))))
    }

    @Test fun rejectsShortAndEmpty() {
        assertNull(SpeechFrame.parse(ByteArray(0)))
        assertNull(SpeechFrame.parse(ByteArray(8)))                            // header short
        assertNull(SpeechFrame.parse(frame(0x11, 1, 0, ByteArray(0))))         // no payload
    }

    @Test fun rejectsOddPayload() {
        // s16 alignment: an odd payload is a torn frame, never playable.
        assertNull(SpeechFrame.parse(frame(0x11, 1, 0, byteArrayOf(1, 2, 3))))
    }
}
