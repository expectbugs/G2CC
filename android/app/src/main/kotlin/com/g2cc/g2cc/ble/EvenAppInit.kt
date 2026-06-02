package com.g2cc.g2cc.ble

/**
 * Phase Y scaffolding — Even App-style initialization sequence.
 *
 * Adam's BTSnoop capture (2026-06-02, factory environment, Even App News
 * session) showed the Even App sends an elaborate multi-service init flow
 * BEFORE rendering anything. Our minimal init (just the 7-packet auth +
 * teleprompter render) may be why our session is more fragile than theirs.
 * This file builds the packets to replicate their full init.
 *
 * **NOT WIRED INTO G2Pipeline YET.** Phase Y will integrate after we verify
 * commit 89c7f47 (Even-App-style keepalive copied exactly) holds in Adam's
 * factory environment. If 89c7f47 holds, we may not need this; if it
 * doesn't, this is the next escalation.
 *
 * Sequence observed in BTSnoop (R lens handle 65, T+27.8s to T+31.7s):
 *  1. CCCD subscribe to gh=2117 (0x0100) — enable secondary-notify channel
 *  2. CCCD subscribe to gh=2085 (0x0100)
 *  3. CCCD subscribe to gh=2149 (0x0100)
 *  4. CCCD subscribe to gh=2181 (0x0100)
 *  5. ATT_WRITE to gh=4 (0x0200) — Service Changed indication CCCD
 *  6. Auth packets (7 packets — we already do this, identical)
 *  7. Service 0x09-20 Device Info query (returns firmware version)
 *  8. Service 0x03-20 App Enumeration (179-byte feature list)
 *  9. Service 0x0D-20 Configuration (small query)
 * 10. Service 0x0C-20 Tasks (one-shot config)
 * 11. Service 0x07-20 Dashboard (12-byte config)
 * 12. Service 0x0E-20 Display Config (LARGE — 230-byte payload defining
 *     display regions, then fragment continuation)
 * 13. Service 0x30-20 Unknown (small init)
 * 14. Service 0x10-20 Unknown (small init)
 * 15. Service 0x91-20 R1 Registration (TELLS GLASSES THE RING MAC ADDRESS)
 * 16. Service 0x09-20 Device Info again (different query)
 * 17. Service 0x01-20 Heartbeat/Liveness setup
 * 18. Service 0x81-20 Display Trigger (THE WAKE/ACTIVATE COMMAND)
 * 19. Secondary characteristic (gh=2178 = 0x0882) settings push, ~100 bytes
 * 20. More display config (multiple regions)
 * 21. Service 0x20-20 Commit (finalize the init transaction)
 *
 * Then steady state: sync_trigger to each lens every 15s (already done).
 *
 * The packets we already build (auth + teleprompter render) are NOT
 * duplicated here. Only the NEW packets needed for the Even App init
 * pattern that we don't currently send. Some are placeholders — payload
 * bytes captured verbatim from Adam's BTSnoop and replayed (faithful but
 * opaque, like the existing DISPLAY_CONFIG_BLOB in Teleprompter.kt).
 *
 * USAGE (future, in G2Pipeline after 89c7f47 verified or not):
 *   val initPackets = EvenAppInit.buildFullInitSequence(seq, msgId)
 *   leftBle.queueWrites(initPackets, "L:phy-init", initDelays) { ... }
 *   rightBle.queueWrites(initPackets, "R:phy-init", initDelays) { ... }
 * Then proceed to render content via the new 0x0E-20 path (also TBD).
 */
object EvenAppInit {

    /** Replay the EXACT 12-byte payload for service 0x09-20 Device Info
     *  initial query from BTSnoop. Glasses respond with firmware version
     *  string ("2.2.2.202" / "2.2.2.208" on Adam's pair). */
    fun buildDeviceInfoQuery(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0x01, 0x10) + Varint.encode(msgId) +
            byteArrayOf(0x1A, 0x0C, 0x4A, 0x0A, 0x08, 0x01, 0x10, 0x01, 0x18, 0x01, 0x20, 0x01, 0x28, 0x02)
        return G2Frame.command(seq, G2Constants.Services.DEVICE_INFO_QUERY, payload)
    }

    /** Service 0x81-20 Display Trigger — the "wake/activate display" packet.
     *  i-soxi documents this service but doesn't decode the payload.
     *  Even App observed value (T+29.50s): 6-byte payload `08 01 10 [msgId] 1a 00`. */
    fun buildDisplayTrigger(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0x01, 0x10) + Varint.encode(msgId) +
            byteArrayOf(0x1A, 0x00)
        return G2Frame.command(seq, G2Constants.Services.DISPLAY_TRIGGER, payload)
    }

    /** Service 0x20-20 Commit — finalizes a multi-packet init transaction.
     *  Even App observed: two packets, one with `08 00 10 [msgId] 1a 02 08 00`
     *  and one with `08 01 10 [msgId] 22 00`. We send the second form here
     *  as the "commit confirmation". */
    fun buildCommit(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0x01, 0x10) + Varint.encode(msgId) +
            byteArrayOf(0x22, 0x00)
        return G2Frame.command(seq, G2Constants.Services.COMMIT, payload)
    }

    /** Service 0x91-20 R1 Ring Registration — tells the glasses about the R1
     *  ring's BLE MAC address so they can pair to it and route input events.
     *  Even App observed (3 times: at init, after each R1 reconnect):
     *    payload = `08 01 10 [msgId] 1a 0c 0a 06 [MAC_6_BYTES] 10 01 18 00`
     *  MAC is in BLE byte order (little-endian, reversed from human form). */
    fun buildR1Registration(seq: Int, msgId: Int, r1MacBleOrder: ByteArray): ByteArray {
        require(r1MacBleOrder.size == 6) { "R1 MAC must be 6 bytes in BLE order" }
        val payload = byteArrayOf(0x08, 0x01, 0x10) + Varint.encode(msgId) +
            byteArrayOf(0x1A, 0x0C, 0x0A, 0x06) + r1MacBleOrder +
            byteArrayOf(0x10, 0x01, 0x18, 0x00)
        return G2Frame.command(seq, G2Constants.Services.R1_REGISTRATION, payload)
    }

    /** Service 0x04-20 Display Wake — 14-byte init packet from BTSnoop.
     *  Payload `08 01 10 [msgId] 1a 08 08 01 10 01 18 07 28 01`. */
    fun buildDisplayWake(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0x01, 0x10) + Varint.encode(msgId) +
            byteArrayOf(0x1A, 0x08, 0x08, 0x01, 0x10, 0x01, 0x18, 0x07, 0x28, 0x01)
        return G2Frame.command(seq, G2Constants.Services.DISPLAY_WAKE, payload)
    }

    /** Service 0x10-20 unknown one-shot — 8-byte payload from BTSnoop.
     *  Payload `08 01 10 [msgId] 1a 02 08 04`. */
    fun buildUnknown10(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0x01, 0x10) + Varint.encode(msgId) +
            byteArrayOf(0x1A, 0x02, 0x08, 0x04)
        return G2Frame.command(seq, G2Constants.Services.UNKNOWN_10, payload)
    }

    /** Service 0x30-20 unknown one-shot — 10-byte payload from BTSnoop.
     *  Payload `08 01 10 [msgId] 1a 04 08 01 10 00`. */
    fun buildUnknown30(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0x01, 0x10) + Varint.encode(msgId) +
            byteArrayOf(0x1A, 0x04, 0x08, 0x01, 0x10, 0x00)
        return G2Frame.command(seq, G2Constants.Services.UNKNOWN_30, payload)
    }

    /** Build the FULL Even-App-style init sequence as a list of (packet,
     *  delay-after-ms) pairs ready to pass to G2BleClient.queueWrites.
     *
     *  Order matches BTSnoop observation. Inter-packet delays are conservative
     *  (matches Even App pacing approximately). Auth packets are NOT included
     *  here — they're built and sent by G2BleClient.runAuthHandshake before
     *  this init sequence runs.
     *
     *  Caller provides startSeq + startMsgId so the values continue from where
     *  auth left off (auth uses seq 1-7). */
    fun buildFullInitSequence(
        startSeq: Int,
        startMsgId: Int,
        r1MacBleOrder: ByteArray? = null,
    ): List<Pair<ByteArray, Long>> {
        val packets = mutableListOf<Pair<ByteArray, Long>>()
        var seq = startSeq and 0xFF
        var msgId = startMsgId and 0xFFFF
        fun nextSeq(): Int { val s = seq; seq = (seq + 1) and 0xFF; return s }
        fun nextMsgId(): Int { val m = msgId; msgId = (msgId + 1) and 0xFFFF; return m }

        // Match BTSnoop sequence. Delays are observed-similar; tune empirically.
        packets += buildDeviceInfoQuery(nextSeq(), nextMsgId()) to 100L
        packets += buildDisplayWake(nextSeq(), nextMsgId()) to 100L
        packets += buildUnknown30(nextSeq(), nextMsgId()) to 100L
        packets += buildUnknown10(nextSeq(), nextMsgId()) to 100L
        if (r1MacBleOrder != null) {
            packets += buildR1Registration(nextSeq(), nextMsgId(), r1MacBleOrder) to 100L
        }
        packets += buildDisplayTrigger(nextSeq(), nextMsgId()) to 200L
        packets += buildCommit(nextSeq(), nextMsgId()) to 200L
        return packets
    }
}
