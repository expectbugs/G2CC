package com.g2cc.g2cc.probe

import com.g2cc.g2cc.ble.G2Frame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplayKitTest {

    private val frames = listOf(
        "DocuLens-launch" to ReplayKit.DOCULENS_LAUNCH,
        "G2CC-menu" to ReplayKit.G2CC_MENU,
        "G2CC-doclist" to ReplayKit.G2CC_DOCLIST,
    )

    @Test
    fun frames_areWellFormedE020WithValidCrc() {
        // Independently re-validates the embedded hex constants: if any digit
        // was mis-transcribed, the CRC check fails here before the APK ships.
        for ((name, f) in frames) {
            assertEquals("$name magic", 0xAA.toByte(), f[0])
            assertEquals("$name type=command", 0x21.toByte(), f[1])
            assertEquals("$name svcHi", 0xE0.toByte(), f[6])
            assertEquals("$name svcLo", 0x20.toByte(), f[7])
            assertTrue("$name single-packet", f[4].toInt() == 1 && f[5].toInt() == 1)
            assertTrue("$name CRC must verify", G2Frame.verifyCrc(f))
        }
    }

    @Test
    fun coldInit_framesAreWellFormedWithValidCrc() {
        // Verbatim display-activation frames (81-20 / 04-20 / 0e-20) — re-validate
        // the embedded hex via CRC so a mis-transcription fails here, not on glasses.
        val expected = listOf(0x8120, 0x0420, 0x0e20)
        assertEquals("COLD_INIT count", expected.size, ReplayKit.COLD_INIT.size)
        for ((i, f) in ReplayKit.COLD_INIT.withIndex()) {
            assertEquals("init[$i] magic", 0xAA.toByte(), f[0])
            val svc = ((f[6].toInt() and 0xFF) shl 8) or (f[7].toInt() and 0xFF)
            assertEquals("init[$i] service", expected[i], svc)
            assertTrue("init[$i] CRC must verify", G2Frame.verifyCrc(f))
        }
    }

    @Test
    fun doculensLaunch_isByteIdenticalToCapture() {
        // Captured CRC was f450 (little-endian last two bytes).
        val n = ReplayKit.DOCULENS_LAUNCH.size
        assertEquals(0xF4.toByte(), ReplayKit.DOCULENS_LAUNCH[n - 2])
        assertEquals(0x50.toByte(), ReplayKit.DOCULENS_LAUNCH[n - 1])
    }

    @Test
    fun field1_readsLaunchRequest() {
        // e0-01 launch payload 08 11 a2 01 03 08 99 59 -> field1 = 17
        assertEquals(ReplayKit.MSGTYPE_LAUNCH_REQUEST, ReplayKit.field1(ProbeSend.parseHex("0811a20103089959")))
    }

    @Test
    fun field1_readsLaunchAck() {
        // e0-00 launch ack 08 01 10 41 22 00 -> field1 = 1
        assertEquals(ReplayKit.MSGTYPE_LAUNCH_ACK, ReplayKit.field1(ProbeSend.parseHex("080110412200")))
    }

    @Test
    fun field1_readsInputEvent() {
        // e0-01 input 08 02 6a ... -> field1 = 2
        assertEquals(ReplayKit.MSGTYPE_INPUT_EVENT, ReplayKit.field1(ProbeSend.parseHex("08026a061a0408031002")))
    }

    @Test
    fun field1_nullWhenNotFieldOne() {
        assertNull(ReplayKit.field1(ProbeSend.parseHex("1001"))) // starts with field 2 tag
        assertNull(ReplayKit.field1(ByteArray(0)))
    }
}
