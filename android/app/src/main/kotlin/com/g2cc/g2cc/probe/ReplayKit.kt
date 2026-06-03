package com.g2cc.g2cc.probe

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

    private fun hex(s: String): ByteArray = ProbeSend.parseHex(s)
}
