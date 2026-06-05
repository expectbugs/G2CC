package com.g2cc.g2cc.ble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the [EvenHub] encoder reproduces the captured Even App e0-20 frames
 * BYTE-FOR-BYTE — the strongest no-hardware validation of the wire format.
 * Capture source: 2026-06-03 BTSnoop, decoded by scripts/btsnoop_parse.py
 * (/tmp/g2cc-btsnoop/, "parse1"). If any layout constant or field order drifts,
 * these assertions fail before the APK ships.
 */
class EvenHubTest {

    // ---- captured payloads (the bytes after the 8-byte AA header, before CRC) ----

    /** DocuLens cold-launch, msgId 65. [parse1 13:15:51.199] */
    private val CAP_LAUNCH = "080010411a4608011a3f0808100818b0042090022800300038004008" +
        "480152076c6f6164696e675801621e446f63754c656e730a0a4c6f6164696e6720646f63756d656e74732e2e2e289959"

    /** Reddit "Select your Feed" menu (menu-list + menu-header), msgId 88.
     *  [parse1 13:16:18.762, P=3/3 reassembled] */
    private val CAP_MENU = "080710583ad403080212e902083c102b18c80320f50128004000480252096d656e752d6c697374" +
        "5ac902080810c8031801222f202020204265737420202d2020506572736f6e616c697a6564206665656420286f6e6c79207769746820617574682922" +
        "233e2020486f7420202d202043757272656e746c79207472656e64696e6720706f737473221e202020204e657720202d20204e657765737420706f737473206669727374" +
        "222720202020526973696e6720202d2020506f737473206761696e696e6720706f70756c6172697479222420202020546f7020202d2020546f7020706f7374732062792074696d6520706572696f64" +
        "222e20202020436f6e74726f7665727369616c20202d20204d6f737420636f6e74726f7665727369616c20706f737473222520202020506f70756c617220202d2020506f70756c6172206163726f737320526564646974" +
        "222420202020416c6c20202d2020506f7374732066726f6d20616c6c206f662052656464697460011a640828100018f8032026280040054801520b6d656e752d686561646572" +
        "58006244e295ade29480e29480e29480e29480e29480e29480e29480202053656c65637420796f757220466565642020e29480e29480e29480e29480e29480e29480e29480e295ae"

    /** Full keepalive frame (f1=12), seq 0x41, msgId 0x4c. [parse1 13:15:56.330 FULLFRAME] */
    private val CAP_KEEPALIVE_FRAME = "aa2141080101e020080c104c72002995"

    private val REDDIT_ITEMS = listOf(
        "    Best  -  Personalized feed (only with auth)",
        ">  Hot  -  Currently trending posts",
        "    New  -  Newest posts first",
        "    Rising  -  Posts gaining popularity",
        "    Top  -  Top posts by time period",
        "    Controversial  -  Most controversial posts",
        "    Popular  -  Popular across Reddit",
        "    All  -  Posts from all of Reddit",
    )
    // ╭───────  Select your Feed  ───────╮ — box-drawing arc + light-horizontal glyphs.
    private val REDDIT_HEADER = "╭" + "─".repeat(7) + "  Select your Feed  " + "─".repeat(7) + "╮"

    @Test
    fun launch_isByteIdenticalToCapture() {
        val frame = EvenHub.launch(seq = 0x36, msgId = 65)
        assertEquals("launch payload", CAP_LAUNCH, payloadHex(frame))
        // svc e0-20, command, single packet, CRC valid (CRC == over the payload).
        assertEquals(0xE0.toByte(), frame[6]); assertEquals(0x20.toByte(), frame[7])
        assertEquals(0x21.toByte(), frame[1])
        assertTrue("launch CRC", G2Frame.verifyCrc(frame))
    }

    @Test
    fun menu_reassemblesByteIdenticalToCapture() {
        val packets = EvenHub.menuScreen(seq = 0x4d, msgId = 88, statusText = REDDIT_HEADER, items = REDDIT_ITEMS)
        // The Even App split this into 3 packets; ours will too at MAX_CHUNK=232.
        assertTrue("multi-packet", packets.size >= 2)
        assertEquals("reassembled menu payload", CAP_MENU, hex(reassemble(packets)))
    }

    @Test
    fun multiPacket_followsEvenHubCrcConvention() {
        val packets = EvenHub.menuScreen(seq = 0x4d, msgId = 88, statusText = REDDIT_HEADER, items = REDDIT_ITEMS)
        val total = packets.size
        for ((i, p) in packets.withIndex()) {
            val len = p[3].toInt() and 0xFF
            val ptot = p[4].toInt() and 0xFF
            val pser = p[5].toInt() and 0xFF
            assertEquals("ptot", total, ptot)
            assertEquals("pser", i + 1, pser)
            assertEquals("svcHi", 0xE0.toByte(), p[6]); assertEquals("svcLo", 0x20.toByte(), p[7])
            if (pser < ptot) {
                // non-final: Len == raw chunk length, NO CRC (size == header + chunk)
                assertEquals("non-final size", 8 + len, p.size)
            } else {
                // final: Len == chunk + 2, the trailing CRC covers the WHOLE payload
                assertEquals("final size", 8 + len, p.size)
            }
        }
        // The single trailing CRC must equal CRC-16/CCITT over the whole reassembled payload.
        val payload = reassemble(packets)
        val last = packets.last()
        val gotCrc = (last[last.size - 1].toInt() and 0xFF shl 8) or (last[last.size - 2].toInt() and 0xFF)
        assertEquals("whole-payload CRC", Crc16.compute(payload), gotCrc)
    }

    @Test
    fun keepalive_isByteIdenticalToCapture() {
        val frame = EvenHub.keepalive(seq = 0x41, msgId = 0x4c)
        assertEquals(CAP_KEEPALIVE_FRAME, hex(frame))
        assertTrue("keepalive CRC", G2Frame.verifyCrc(frame))
    }

    @Test
    fun keepalive_msgIdVariesEachBeat() {
        // Distinct msgIds yield distinct frames so the firmware can't dedup a beat.
        val a = EvenHub.keepalive(seq = 0x10, msgId = 100)
        val b = EvenHub.keepalive(seq = 0x10, msgId = 101)
        assertTrue(!a.contentEquals(b))
    }

    @Test
    fun textScreen_isWellFormedAndScrolls() {
        // A long body must split into valid multi-packet e0-20 with a verifiable CRC.
        val body = "Iris and Chameleon swept up together. ".repeat(20)
        val packets = EvenHub.textScreen(seq = 0x50, msgId = 0x12, statusText = "G2CC | aria | Ready", body = body)
        assertTrue("multi-packet long body", packets.size >= 2)
        for (p in packets) { assertEquals(0xE0.toByte(), p[6]); assertEquals(0x20.toByte(), p[7]) }
        val payload = reassemble(packets)
        val last = packets.last()
        val gotCrc = (last[last.size - 1].toInt() and 0xFF shl 8) or (last[last.size - 2].toInt() and 0xFF)
        assertEquals(Crc16.compute(payload), gotCrc)
    }

    @Test
    fun coldInit_framesAreWellFormedWithValidCrc() {
        // Verbatim display-activation prelude (81-20 / 04-20 / 0e-20) — re-validate
        // the embedded hex via CRC so a mis-transcription fails here, not on glasses.
        val expectedSvc = listOf(0x8120, 0x0420, 0x0e20)
        assertEquals(3, EvenHub.COLD_INIT.size)
        for ((i, f) in EvenHub.COLD_INIT.withIndex()) {
            assertEquals("init[$i] magic", 0xAA.toByte(), f[0])
            val svc = ((f[6].toInt() and 0xFF) shl 8) or (f[7].toInt() and 0xFF)
            assertEquals("init[$i] service", expectedSvc[i], svc)
            assertTrue("init[$i] CRC", G2Frame.verifyCrc(f))
        }
    }

    @Test
    fun confirmScreen_hasBodyTextAndOptionsList() {
        val packets = EvenHub.confirmScreen(
            seq = 0x20, msgId = 0x30,
            statusText = "● Claude Code",
            body = "transcribed prompt text",
            options = listOf("✓ Send", "⟲ Re-record", "✗ Cancel"),
        )
        for (p in packets) { assertEquals(0xE0.toByte(), p[6]); assertEquals(0x20.toByte(), p[7]) }
        val h = hex(reassemble(packets))
        assertTrue("menu-header status bar (the display trigger)", h.contains("6d656e752d686561646572")) // "menu-header"
        assertTrue("main body container", h.contains("6d61696e"))           // "main"
        assertTrue("menu-list options container", h.contains("6d656e752d6c697374")) // "menu-list"
        assertTrue("option text present", h.contains("53656e64"))           // "Send"
        // Final-packet CRC covers the whole reassembled payload.
        val payload = reassemble(packets)
        val last = packets.last()
        val gotCrc = (last[last.size - 1].toInt() and 0xFF shl 8) or (last[last.size - 2].toInt() and 0xFF)
        assertEquals(Crc16.compute(payload), gotCrc)
    }

    @Test(expected = IllegalArgumentException::class)
    fun content_exceedingPacketCeiling_throwsCleanlyNotCorrupt() {
        // The AA PktTot field is one byte (max 255 packets). Content beyond
        // 255 * MAX_CHUNK payload bytes must throw (the dispatchInbound layer
        // catches it and surfaces via diag — review A1) rather than silently wrap
        // PktTot into a corrupt frame. This locks in the clean-refusal boundary.
        val huge = "x".repeat(256 * EvenHub.MAX_CHUNK)
        EvenHub.textScreen(seq = 0x10, msgId = 0x20, statusText = "s", body = huge)
    }

    // ---- helpers ----

    /** Reassemble the payload from AA packets per the EvenHub convention:
     *  non-final chunk = Len bytes; final chunk = Len-2 bytes (Len includes CRC). */
    private fun reassemble(packets: List<ByteArray>): ByteArray {
        val out = ArrayList<Byte>()
        for (p in packets) {
            val len = p[3].toInt() and 0xFF
            val ptot = p[4].toInt() and 0xFF
            val pser = p[5].toInt() and 0xFF
            val chunkLen = if (pser == ptot) len - 2 else len
            for (i in 8 until 8 + chunkLen) out.add(p[i])
        }
        return out.toByteArray()
    }

    /** Hex of the payload of a single-packet frame (header stripped, CRC stripped). */
    private fun payloadHex(frame: ByteArray): String = hex(frame.copyOfRange(8, frame.size - 2))

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
}
