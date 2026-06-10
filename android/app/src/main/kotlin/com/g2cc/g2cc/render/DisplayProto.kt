package com.g2cc.g2cc.render

import com.g2cc.g2cc.ble.Crc16
import com.g2cc.g2cc.ble.G2Constants
import com.g2cc.g2cc.ble.G2Frame
import com.g2cc.g2cc.ble.Varint

/**
 * Wire encoder for the EvenHub IMAGE + REGION display model (service id e0-20, GATT char
 * 0x5401). Decoded 2026-06-05 from capture U=19; full schemas + per-field lineage in
 * docs/PROTOCOL_NOTES.md §"EvenHub display rendering".
 *
 * Message types (top-level f1): 0 launch, 3 image-push, 5 text-update, 7 layout, 12 keepalive.
 * A screen is a set of NAMED REGIONS; image regions receive 4bpp BMPs via f1=3 (chunked,
 * targeted by name), text regions receive UTF-8 via f1=5. Layout (region geometry) is
 * declared once via f1=0/f1=7 and only re-sent when it changes.
 *
 * This re-implements the e0 AA-framing (single CRC-16/CCITT over the WHOLE payload, on the
 * final packet only) that EvenHub.frame also uses — both are byte-locked to real captures by
 * unit tests, so the small duplication keeps this renderer module self-contained (per the
 * "dedicated renderer owns the display encoding entirely" directive). Pure, no Android dep.
 */
object DisplayProto {
    /** Service id placed in header[6..7] of every EvenHub content frame. */
    val SVC = byteArrayOf(0xE0.toByte(), 0x20)

    /** Max payload bytes per AA packet (mirrors EvenHub.MAX_CHUNK; also MTU-bounded). */
    const val MAX_AA_CHUNK = 232

    /** App-level image-chunk cap (the `f5.f7` length). The native Hub app chunks BMPs at 4096 B. */
    const val MAX_IMAGE_CHUNK = 4096

    // message types (top-level f1)
    const val MSG_LAUNCH = 0
    const val MSG_IMAGE = 3
    const val MSG_TEXT = 5
    const val MSG_LAYOUT = 7
    const val MSG_KEEPALIVE = 12

    // ---- launch app token (launch wrapper f5) ----
    // The token labels which Hub-app slot the cold-launch takes over. Known catalog tokens
    // (from the official app's 03-20 enumeration, docs/G2_BLE_PROTOCOL.md §4.1):
    //   DocuLens 11417, Reddit 10217, Chess 10061, Solitaire 10060, Books 11313, …
    /** DocuLens — a catalog token, HARDWARE-PROVEN to cold-launch over our DIRECT BLE link. */
    const val TOKEN_DOCULENS = 11417
    /** Our own token (the g2cap demo launched with it). It is NOT in the glasses' installed-app
     *  catalog, so it can't collide with a real app — the clean "don't impersonate DocuLens"
     *  choice. **UNVERIFIED on the direct-BLE path:** g2cap launched 10000 *through the Even App
     *  SDK*, which may have registered it; a direct cold-launch with a non-catalog token is
     *  untested and could fail to bring up the display. Flip [LAUNCH_TOKEN] to this and verify on
     *  glass (Adam's eyes) before trusting it; revert to TOKEN_DOCULENS if it doesn't launch. */
    const val TOKEN_G2CC = 10000
    /** The token the app actually cold-launches with — single source of truth. Set to our own
     *  [TOKEN_G2CC] to test the un-impersonated direct-BLE launch (UNVERIFIED on hardware — see its
     *  note). **If the display fails to cold-launch, revert this one line to [TOKEN_DOCULENS]** (the
     *  HARDWARE-PROVEN catalog token). */
    const val LAUNCH_TOKEN = TOKEN_G2CC

    // ---------- protobuf field primitives (wire 0 = varint, wire 2 = length-delimited) ----------
    private fun key(field: Int, wire: Int) = Varint.encode((field shl 3) or wire)
    private fun v(field: Int, value: Int) = key(field, 0) + Varint.encode(value)
    private fun l(field: Int, body: ByteArray) = key(field, 2) + Varint.encode(body.size) + body
    private fun s(field: Int, str: String) = l(field, str.toByteArray(Charsets.UTF_8))
    private fun cat(parts: List<ByteArray>): ByteArray {
        val out = ByteArray(parts.sumOf { it.size }); var o = 0
        for (p in parts) { p.copyInto(out, o); o += p.size }
        return out
    }
    private fun cat(vararg parts: ByteArray): ByteArray = cat(parts.asList())

    // ---------- region container builders (decoded "lean" schema, matches the native games) ----------
    /** Text-region container — placed in a launch/layout wrapper under field 3.
     *  f1..f4 = x,y,w,h; f9 = id; f10 = name; f11 = scroll flag; f12 = embedded text. */
    fun textContainer(x: Int, y: Int, w: Int, h: Int, id: Int, name: String,
                      scroll: Boolean = false, text: String = ""): ByteArray =
        cat(v(1, x), v(2, y), v(3, w), v(4, h), v(9, id), s(10, name),
            v(11, if (scroll) 1 else 0), s(12, text))

    /** Image-region container — placed in a launch/layout wrapper under field 4.
     *  f1..f4 = x,y,w,h; f5 = id; f6 = name. Content is pushed separately via [imagePayload]. */
    fun imageContainer(x: Int, y: Int, w: Int, h: Int, id: Int, name: String): ByteArray =
        cat(v(1, x), v(2, y), v(3, w), v(4, h), v(5, id), s(6, name))

    // ---------- top-level message payloads (pre-framing; exposed so tests byte-match captures) ----------

    /** f1=0 launch: declare app token + initial region containers (text containers embed their text). */
    fun launchPayload(msgId: Int, token: Int, texts: List<ByteArray>, images: List<ByteArray>): ByteArray =
        cat(v(1, MSG_LAUNCH), v(2, msgId), l(3, wrapper(texts, images, token)))

    /** f1=7 layout / content-update: re-declare all regions (no app token). */
    fun layoutPayload(msgId: Int, texts: List<ByteArray>, images: List<ByteArray>): ByteArray =
        cat(v(1, MSG_LAYOUT), v(2, msgId), l(7, wrapper(texts, images, null)))

    /** f1=5 text-update: replace one text region's content by name. With [contentOffset]+
     *  [contentLength] set, this is a PARTIAL in-place replace (wire f3/f4 = the SDK's
     *  textContainerUpgrade(contentOffset, contentLength), confirmed from the g2cap UPGRADE
     *  capture — docs/G2_BLE_PROTOCOL.md §6.3); both null = full replace. */
    fun textPayload(msgId: Int, regionId: Int, name: String, text: String,
                    contentOffset: Int? = null, contentLength: Int? = null): ByteArray {
        val inner = ArrayList<ByteArray>(5)
        inner += v(1, regionId); inner += s(2, name)
        if (contentOffset != null) inner += v(3, contentOffset)
        if (contentLength != null) inner += v(4, contentLength)
        inner += s(5, text)
        return cat(v(1, MSG_TEXT), v(2, msgId), l(9, cat(inner)))
    }

    /** f1=3 image-push: one BMP chunk to a named region. `token` is a per-image transfer nonce
     *  (echoed in the ack; NOT a content hash — verified content-independent). */
    fun imagePayload(msgId: Int, regionId: Int, name: String, token: Int,
                     totalBytes: Int, chunkIndex: Int, chunk: ByteArray): ByteArray {
        val inner = cat(v(1, regionId), s(2, name), v(3, token), v(4, totalBytes),
            v(6, chunkIndex), v(7, chunk.size), l(8, chunk))
        return cat(v(1, MSG_IMAGE), v(2, msgId), l(5, inner))
    }

    private fun wrapper(texts: List<ByteArray>, images: List<ByteArray>, token: Int?): ByteArray {
        val parts = ArrayList<ByteArray>(2 + texts.size + images.size)
        parts += v(1, texts.size + images.size)        // f1 = container count
        for (t in texts) parts += l(3, t)              // f3 = text containers
        for (im in images) parts += l(4, im)           // f4 = image containers
        if (token != null) parts += v(5, token)        // f5 = app token (launch only)
        return cat(parts)
    }

    // ---------- AA framing (e0 whole-payload-CRC convention; mirrors EvenHub.frame) ----------

    /** Frame an e0-20 payload into one-or-more AA packets. One CRC over the WHOLE payload,
     *  on the final packet only; non-final packets carry no CRC (Len = chunk length). */
    fun frame(seq: Int, payload: ByteArray): List<ByteArray> {
        val maxChunk = minOf(G2Constants.ConnectionParams.MTU - G2Frame.HEADER_SIZE - G2Frame.CRC_SIZE, MAX_AA_CHUNK)
        require(maxChunk > 0) { "MTU too small for e0 framing" }
        val crc = Crc16.compute(payload)
        val total = maxOf(1, (payload.size + maxChunk - 1) / maxChunk)
        val out = ArrayList<ByteArray>(total)
        var off = 0; var serial = 1
        do {
            val end = minOf(off + maxChunk, payload.size)
            val chunk = payload.copyOfRange(off, end)
            val isFinal = serial >= total
            out += buildPacket(seq, chunk, total, serial, if (isFinal) crc else null)
            off = end; serial++
        } while (off < payload.size)
        return out
    }

    private fun buildPacket(seq: Int, chunk: ByteArray, total: Int, serial: Int, finalCrc: Int?): ByteArray {
        require(seq in 0..0xFF) { "seq out of range: $seq" }
        require(total in 1..0xFF && serial in 1..total) { "invalid packet seq total=$total serial=$serial" }
        val crcSize = if (finalCrc != null) G2Frame.CRC_SIZE else 0
        val len = chunk.size + crcSize
        require(len <= 0xFF) { "e0 chunk Len $len exceeds 255 (chunk=${chunk.size})" }
        val out = ByteArray(G2Frame.HEADER_SIZE + chunk.size + crcSize)
        out[0] = G2Constants.MAGIC
        out[1] = G2Constants.TYPE_COMMAND
        out[2] = (seq and 0xFF).toByte()
        out[3] = len.toByte()
        out[4] = total.toByte()
        out[5] = serial.toByte()
        out[6] = SVC[0]; out[7] = SVC[1]
        chunk.copyInto(out, G2Frame.HEADER_SIZE)
        if (finalCrc != null) {
            out[out.size - 2] = (finalCrc and 0xFF).toByte()
            out[out.size - 1] = ((finalCrc ushr 8) and 0xFF).toByte()
        }
        return out
    }

    /** Keepalive frame f1=12 (`08 0c 10 <msgId> 72 00`). Send to the R lens every ~4 s. */
    fun keepalive(seq: Int, msgId: Int): ByteArray =
        frame(seq, cat(v(1, MSG_KEEPALIVE), v(2, msgId), l(14, ByteArray(0)))).single()
}
