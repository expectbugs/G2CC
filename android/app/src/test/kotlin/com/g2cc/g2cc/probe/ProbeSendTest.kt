package com.g2cc.g2cc.probe

import com.g2cc.g2cc.ble.G2Constants
import com.g2cc.g2cc.ble.G2Frame
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class ProbeSendTest {

    // ---- parseHex --------------------------------------------------------

    @Test
    fun parseHex_plainContiguous() {
        assertArrayEquals(
            byteArrayOf(0x08, 0x11, 0xa2.toByte(), 0x01, 0x03, 0x08, 0x99.toByte(), 0x59),
            ProbeSend.parseHex("0811a20103089959"),
        )
    }

    @Test
    fun parseHex_spaceSeparated() {
        assertArrayEquals(
            byteArrayOf(0x08, 0x11, 0xa2.toByte(), 0x01, 0x03, 0x08, 0x99.toByte(), 0x59),
            ProbeSend.parseHex("08 11 a2 01 03 08 99 59"),
        )
    }

    @Test
    fun parseHex_toleratesMixedSeparatorsAnd0xPrefix() {
        // colons, dashes, pipes, newlines, 0x prefixes, upper + lower case
        val parsed = ProbeSend.parseHex("0xAA:0x12\n b2-0a|01_01 E0 01")
        assertArrayEquals(
            byteArrayOf(0xAA.toByte(), 0x12, 0xb2.toByte(), 0x0a, 0x01, 0x01, 0xE0.toByte(), 0x01),
            parsed,
        )
    }

    @Test
    fun parseHex_emptyOrAllSeparators_isEmpty() {
        assertEquals(0, ProbeSend.parseHex("").size)
        assertEquals(0, ProbeSend.parseHex("   \n , : ").size)
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseHex_oddDigitCount_throws() {
        ProbeSend.parseHex("08 1")
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseHex_nonHexChar_throws() {
        ProbeSend.parseHex("08 1g")
    }

    // ---- resolveCharUuid -------------------------------------------------

    @Test
    fun resolveCharUuid_suffixMatchesG2Constants() {
        assertEquals(G2Constants.CHAR_WRITE, ProbeSend.resolveCharUuid("5401"))
        assertEquals(G2Constants.CHAR_NOTIFY, ProbeSend.resolveCharUuid("5402"))
        assertEquals(G2Constants.CHAR_DISPLAY, ProbeSend.resolveCharUuid("6402"))
    }

    @Test
    fun resolveCharUuid_acceptsLeading0xAndUppercase() {
        assertEquals(G2Constants.CHAR_DISPLAY, ProbeSend.resolveCharUuid("0x6402"))
        assertEquals(G2Constants.CHAR_WRITE, ProbeSend.resolveCharUuid("  5401  "))
    }

    @Test
    fun resolveCharUuid_acceptsFullUuid() {
        val full = "00002760-08c2-11e1-9073-0e8ac72e5401"
        assertEquals(UUID.fromString(full), ProbeSend.resolveCharUuid(full))
    }

    @Test(expected = IllegalArgumentException::class)
    fun resolveCharUuid_rejectsWrongLengthSuffix() {
        ProbeSend.resolveCharUuid("540")
    }

    @Test(expected = IllegalArgumentException::class)
    fun resolveCharUuid_rejectsEmpty() {
        ProbeSend.resolveCharUuid("   ")
    }

    // ---- prepare: RAW ----------------------------------------------------

    @Test
    fun prepare_raw_writesVerbatimToResolvedChar() {
        // Replay the captured EvenHub e0-01 frame verbatim (header+payload+crc),
        // exactly as it would be lifted from a BTSnoop, to the 0x5401 write char.
        val frameHex = "aa12b20a0101e0010811a20103089959153b"
        val prepared = ProbeSend.prepare(ProbeSend.Mode.RAW, "5401", frameHex, seq = 99)
        assertEquals(G2Constants.CHAR_WRITE, prepared.charUuid)
        assertArrayEquals(ProbeSend.parseHex(frameHex), prepared.bytes)
        // RAW does not touch the bytes — seq arg is irrelevant here.
        assertTrue(prepared.summary.startsWith("RAW "))
    }

    @Test(expected = IllegalArgumentException::class)
    fun prepare_raw_rejectsEmptyBody() {
        ProbeSend.prepare(ProbeSend.Mode.RAW, "5401", "  ", seq = 8)
    }

    // ---- prepare: FRAME --------------------------------------------------

    @Test
    fun prepare_frame_buildsValidAaFrameToWriteChar() {
        // Construct an e0-00 write carrying an arbitrary payload (here we reuse
        // the 8-byte protobuf body the firmware sent us on e0-01) and confirm it
        // is a well-formed, CRC-valid AA-frame addressed to the 0x5401 write char.
        val payloadHex = "08 11 a2 01 03 08 99 59"
        val prepared = ProbeSend.prepare(ProbeSend.Mode.FRAME, "e0 00", payloadHex, seq = 17)
        val f = prepared.bytes

        assertEquals(G2Constants.CHAR_WRITE, prepared.charUuid)
        assertEquals(G2Constants.MAGIC, f[0])
        assertEquals(G2Constants.TYPE_COMMAND, f[1])
        assertEquals(17.toByte(), f[2])                 // our supplied seq
        // service id e0-00 lives in the frame header, bytes 6-7
        assertEquals(0xE0.toByte(), f[6])
        assertEquals(0x00.toByte(), f[7])
        // payload (8 bytes) immediately follows the 8-byte header
        assertArrayEquals(ProbeSend.parseHex(payloadHex), f.copyOfRange(8, 16))
        assertTrue("FRAME output must carry a valid CRC", G2Frame.verifyCrc(f))
    }

    @Test
    fun prepare_frame_allowsEmptyPayload() {
        val prepared = ProbeSend.prepare(ProbeSend.Mode.FRAME, "e0 00", "", seq = 8)
        // header(8) + crc(2), no payload
        assertEquals(10, prepared.bytes.size)
        assertTrue(G2Frame.verifyCrc(prepared.bytes))
    }

    @Test(expected = IllegalArgumentException::class)
    fun prepare_frame_rejectsServiceNotTwoBytes() {
        ProbeSend.prepare(ProbeSend.Mode.FRAME, "e0", "0811", seq = 8)
    }

    @Test(expected = IllegalArgumentException::class)
    fun prepare_frame_rejectsServiceTooLong() {
        ProbeSend.prepare(ProbeSend.Mode.FRAME, "e0 00 20", "0811", seq = 8)
    }
}
