package com.g2cc.g2cc.ble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameReassemblerTest {

    private val svc = G2Constants.Services.DEVICE_INFO   // 0x09-00, a plausible reply service

    @Test
    fun singlePacketPassesThroughUnchanged() {
        val r = FrameReassembler()
        val frame = G2Frame.command(seq = 5, service = svc, payload = byteArrayOf(1, 2, 3))
        val out = r.offer(frame)
        assertNull("single packet must not warn", out.warning)
        assertArrayEquals("single packet delivered byte-for-byte", frame, out.deliver)
    }

    @Test
    fun multiFragmentReassemblesToOriginalPayload() {
        val r = FrameReassembler()
        val payload = ByteArray(100) { (it and 0xFF).toByte() }
        // mtu=32 → 22-byte chunks → ceil(100/22) = 5 fragments (matches G2FrameTest).
        val frags = G2Frame.commandMulti(seq = 9, service = svc, payload = payload, mtu = 32)
        assertEquals(5, frags.size)

        // First four accumulate, nothing delivered yet.
        for (i in 0 until 4) {
            val out = r.offer(frags[i])
            assertNull("fragment $i should still be accumulating", out.deliver)
            assertNull("fragment $i should not warn", out.warning)
        }
        // Fifth completes the message.
        val out = r.offer(frags[4])
        assertNull(out.warning)
        assertNotNull("fifth fragment completes the message", out.deliver)
        val frame = out.deliver!!
        assertTrue("reassembled frame CRC must verify", G2Frame.verifyCrc(frame))
        assertEquals("magic preserved", G2Constants.MAGIC, frame[0])
        assertEquals("PktTot collapsed to 1", 1.toByte(), frame[4])
        assertEquals("PktSer collapsed to 1", 1.toByte(), frame[5])
        assertEquals("service hi preserved", svc[0], frame[6])
        assertEquals("service lo preserved", svc[1], frame[7])
        val got = frame.copyOfRange(G2Frame.HEADER_SIZE, frame.size - G2Frame.CRC_SIZE)
        assertArrayEquals("payload round-trips", payload, got)
    }

    @Test
    fun outOfOrderFirstFragmentIsDroppedLoudly() {
        val r = FrameReassembler()
        val payload = ByteArray(100) { it.toByte() }
        val frags = G2Frame.commandMulti(seq = 9, service = svc, payload = payload, mtu = 32)
        // Feed fragment 2 first (PktSer=2) with no PktSer=1 having started.
        val out = r.offer(frags[1])
        assertNull("nothing to deliver from an orphan fragment", out.deliver)
        assertNotNull("orphan fragment must warn", out.warning)
    }

    @Test
    fun corruptFragmentIsDroppedLoudly() {
        val r = FrameReassembler()
        val payload = ByteArray(100) { it.toByte() }
        val frags = G2Frame.commandMulti(seq = 9, service = svc, payload = payload, mtu = 32)
        val bad = frags[0].copyOf()
        bad[G2Frame.HEADER_SIZE] = (bad[G2Frame.HEADER_SIZE].toInt() xor 0xFF).toByte()  // corrupt a chunk byte
        val out = r.offer(bad)
        assertNull("corrupt fragment delivers nothing", out.deliver)
        assertNotNull("corrupt fragment must warn (CRC fail)", out.warning)
    }

    @Test
    fun singlePacketMidReassemblyDeliversAndWarns() {
        val r = FrameReassembler()
        val payload = ByteArray(100) { it.toByte() }
        val frags = G2Frame.commandMulti(seq = 9, service = svc, payload = payload, mtu = 32)
        r.offer(frags[0])  // start a multi-packet message (1 of 5)
        // A single-packet frame arrives before the message completes.
        val single = G2Frame.command(seq = 3, service = svc, payload = byteArrayOf(0x42))
        val out = r.offer(single)
        assertArrayEquals("the single frame is still delivered", single, out.deliver)
        assertNotNull("dropping the partial must warn", out.warning)
    }

    @Test
    fun restartingMessageDropsPriorPartialThenCompletes() {
        val r = FrameReassembler()
        val payload = ByteArray(100) { it.toByte() }
        val frags = G2Frame.commandMulti(seq = 9, service = svc, payload = payload, mtu = 32)
        r.offer(frags[0]); r.offer(frags[1])     // partial: 2 of 5
        // A brand-new message (PktSer=1) starts — prior partial is abandoned.
        val frags2 = G2Frame.commandMulti(seq = 11, service = svc, payload = payload, mtu = 32)
        val first = r.offer(frags2[0])
        assertNotNull("restart must warn about the dropped partial", first.warning)
        for (i in 1 until 4) r.offer(frags2[i])
        val out = r.offer(frags2[4])
        assertNotNull("the new message completes", out.deliver)
        assertTrue(G2Frame.verifyCrc(out.deliver!!))
    }
}
