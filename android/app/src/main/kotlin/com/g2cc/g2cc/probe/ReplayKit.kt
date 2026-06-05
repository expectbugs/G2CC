package com.g2cc.g2cc.probe

import com.g2cc.g2cc.ble.Crc16
import com.g2cc.g2cc.ble.G2Frame
import com.g2cc.g2cc.ble.Varint

/**
 * Canned EvenHub replay frames + launch-handshake recognition for the
 * probe v4 Hub-app hijack test.
 *
 * **Provenance (lineage required — CLAUDE.md Reverse-Engineered Protocol
 * Discipline):** every frame here was derived from the 2026-06-03 BTSnoop
 * capture of the Even App launching DocuLens / Reddit on Adam's glasses
 * (`bugreport-stallion-CP1A.260505.005-2026-06-03-13-16-33.zip` ::
 * `FS/data/misc/bluetooth/logs/btsnoop_hci.log`). The launch-response is
 * byte-verbatim off the wire; the menu/doclist were rebuilt by templating
 * the captured containers (item strings + header swapped, item-count field
 * corrected) via the offline `build_kit.py` and independently CRC-verified
 * in [ReplayKitTest].
 *
 * All three are COMPLETE AA frames (8-byte header + payload + 2-byte CRC) on
 * service id `e0-20`. They are written verbatim to the main write
 * characteristic `0x5401` — the `e0-XX` service id lives inside the frame
 * header, not as its own GATT characteristic
 * (docs/EVENHUB_FINDING.md §"Discovered service tree").
 */
object ReplayKit {

    /** e0-01 message-type discriminators (protobuf field 1). */
    const val MSGTYPE_LAUNCH_REQUEST = 17  // glasses → host: "user picked app <token>, drive it"
    const val MSGTYPE_INPUT_EVENT = 2      // glasses → host: ring input while a Hub app is active
    /** e0-00 message-type: glasses → host launch-response acknowledgment. */
    const val MSGTYPE_LAUNCH_ACK = 1

    /** DocuLens app token (protobuf f20.f1 in the launch request). Stable across
     *  sessions — same value in the 12:56 probe test and the 13:15 Even App run. */
    const val DOCULENS_TOKEN = 11417

    /** Frame 1 — VERBATIM DocuLens launch-response. Captured 13:15:51.199,
     *  svc e0-20, seq 0x36, CRC f450. Byte-identical to the Even App's wire. */
    val DOCULENS_LAUNCH: ByteArray = hex(
        "aa21364e0101e020080010411a4608011a3f0808100818b0042090022800300038004008480152076c6f6164696e675801621e446f63754c656e730a0a4c6f6164696e6720646f63756d656e74732e2e2e289959f450"
    )

    /** Frame 2 — OUR menu-list content-update (the hijack + input test). Templated
     *  from the captured Reddit "menu-list" container: items + header replaced with
     *  G2CC's, item-count field set to 3. svc e0-20, seq 0x37. */
    val G2CC_MENU: ByteArray = hex(
        "aa2137b40101e020080710423aab010802127c083c102b18c80320f50128004000480252096d656e752d6c6973745a5d080310c8031801221b3e202047324343204f4e4520202d202068696a61636b2074657374221a202020473243432054574f20202d20207365636f6e6420726f77221b2020204732434320544852454520202d2020746869726420726f7760011a290828100018f8032026280040054801520b6d656e752d6865616465725800620947324343204d454e55378b"
    )

    /** Frame 2b — OUR doclist content-update (text fallback if menu-list won't
     *  render). Templated from the captured DocuLens "doclist". svc e0-20, seq 0x37. */
    val G2CC_DOCLIST: ByteArray = hex(
        "aa21375e0101e020080710423a56080112520826101418f40320f801280130053805400648155207646f636c6973745a31080310001801220d47324343206c696e65206f6e65220d47324343206c696e652074776f220b4732434320776f726b732160014afb"
    )

    /**
     * Display-activation prelude for a COLD (phone-initiated) launch — verbatim
     * from the 2026-06-03 *phone-launch* BTSnoop, i.e. the writes the Even Hub
     * app sends to ready the display before its cold `e0-20` launch (no glasses
     * menu, no `e0-01`). Sent in order *before* [DOCULENS_LAUNCH]:
     *   1. `81-20` Display Trigger
     *   2. `04-20` Display Wake
     *   3. `0e-20` display region config (the region DocuLens renders into)
     * Each is a complete AA frame; written verbatim to 0x5401.
     */
    val COLD_INIT: List<ByteArray> = listOf(
        hex("aa213108010181200801103c1a00d8ee"),
        hex("aa213210010104200801103d1a080801100118072801a95f"),
        hex("aa21469301010e2008021051228a0108011215080210904e1d00d8ad4525000000002800300038001215080310d00f1d00007a4425000000002800300038001214080410001d0000000025000000002800300038001214080510001d0000b842250000ae422800300038001214080610001d0000c042250000c4422800300038001214080910001d00000000250000000028003000380018006d43"),
    )

    /**
     * Read protobuf field 1 (the EvenHub message-type discriminator) from an
     * AA-frame PAYLOAD (the bytes after the 8-byte header, before the CRC).
     * Returns null if the payload doesn't begin with the field-1 varint tag
     * (`0x08`) or the varint is malformed.
     */
    fun field1(payload: ByteArray): Int? {
        if (payload.isEmpty() || (payload[0].toInt() and 0xFF) != 0x08) return null
        return try {
            Varint.decode(payload, 1).first
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /**
     * The G2CC menu re-issued with a fresh message id, for the session keepalive.
     * The Hub session times out (~20s) on host `e0` silence — the 80-00
     * sync_trigger does NOT reset it (v4 ≈ v5). Re-sending the content frame
     * does (same channel as the display — Phase-D "keepalive must match the
     * display path"). Patching the msg-id (f2) makes each beat a distinct write
     * so the firmware can't treat it as a no-op duplicate.
     *
     * In [G2CC_MENU] the f2 value is a single byte at frame offset 11
     * (header[8]=08 f1-tag, [9]=07 f1, [10]=10 f2-tag, [11]=42 f2 — PRB-8: the
     * real byte is 0x42; the old comment wrote it as decimal "66", which reads as
     * a phantom 0x66 offset against the hex neighbours). [msgId] must stay a
     * single-byte varint so the frame length is unchanged.
     */
    fun menuKeepalive(msgId: Int): ByteArray {
        require(msgId in 1..127) { "keepalive msgId must be a single-byte varint (1..127), got $msgId" }
        val f = G2CC_MENU.copyOf()
        f[11] = msgId.toByte()
        val payloadEnd = f.size - 2
        val crc = Crc16.compute(f, 8, payloadEnd - 8)
        f[payloadEnd] = (crc and 0xFF).toByte()
        f[payloadEnd + 1] = ((crc ushr 8) and 0xFF).toByte()
        return f
    }

    /** EvenHub data service (e0-20) — the channel both content and these app-state
     *  messages ride on (the service id lives in the AA-frame header). */
    private val SVC_EVENHUB_DATA = byteArrayOf(0xE0.toByte(), 0x20)

    /**
     * The Even App's small "app-state" e0-20 messages, sent ~every 5s during a
     * live DocuLens session — message types we have **never** sent (H1: they keep
     * the app foregrounded; the firmware reverts to its native UI without them).
     * Built fresh with the given [seq]/[msgId]; byte shapes verbatim from the
     * 2026-06-03 capture:
     *   - f1=9:  `08 09 10 <msgId> 5a 02 08 01`  (f1=9, f2=msgId, f11={f1=1})
     *   - f1=12: `08 0c 10 <msgId> 72 00`        (f1=12, f2=msgId, f14=empty)
     */
    fun stateAlive9(seq: Int, msgId: Int): ByteArray =
        G2Frame.command(
            seq, SVC_EVENHUB_DATA,
            byteArrayOf(0x08, 0x09, 0x10) + Varint.encode(msgId) + byteArrayOf(0x5a, 0x02, 0x08, 0x01),
        )

    fun stateAlive12(seq: Int, msgId: Int): ByteArray =
        G2Frame.command(
            seq, SVC_EVENHUB_DATA,
            byteArrayOf(0x08, 0x0c, 0x10) + Varint.encode(msgId) + byteArrayOf(0x72, 0x00),
        )

    private fun hex(s: String): ByteArray = ProbeSend.parseHex(s)
}
