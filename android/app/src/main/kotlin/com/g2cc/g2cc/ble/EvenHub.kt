package com.g2cc.g2cc.ble

/**
 * EvenHub (`e0-XX`) Hub-app protocol encoder — phone-initiated launch, content
 * rendering, and session keepalive on the `e0-20` channel.
 *
 * **Provenance (CLAUDE.md "Reverse-Engineered Protocol Discipline"):** every
 * field, tag, and layout constant here is reproduced from the 2026-06-03 BTSnoop
 * of the Even App driving DocuLens + Reddit on Adam's glasses, decoded by
 * `scripts/btsnoop_parse.py` (`/tmp/g2cc-btsnoop{,3}/`) and documented in
 * `docs/PROTOCOL_NOTES.md §"EvenHub channel"`. The encoder reproduces the
 * captured container structures EXACTLY — [EvenHubTest] asserts byte-equality of
 * [launch] and [menuScreen] against the capture payloads — and only the variable
 * parts (msgId, status text, menu items, body text) are parameterized. Unlike the
 * probe's hex-template patching ([com.g2cc.g2cc.probe.ReplayKit]), this is a
 * structured builder that scales to arbitrary content + item counts.
 *
 * Wire model (PROTOCOL_NOTES §"EvenHub channel"):
 * ```
 *   top-level e0-20 message = { f1=msgType, f2=msgId, <wrapper> }
 *     f1=0  launch    : f3 = { f1=1, f3=<text-container>, f5=<appToken> }
 *     f1=7  content   : f7 = { f1=count, f2=<list-container…>, f3=<text-container…> }
 *     f1=12 keepalive : 08 0c 10 <msgId> 72 00
 *   container = { f1=x f2=y f3=w f4=h … f9=id f10="type" f11=items|flag f12=text|flag }
 *   inside a wrapper: LIST-type widgets → f2, TEXT-type widgets → f3
 * ```
 *
 * Multi-packet (PROVEN 2026-06-04 against the doclist capture, whole-payload
 * CRC = 0x5e5b): non-final packets carry the raw chunk with `Len = chunkLen` and
 * NO CRC; the final packet has `Len = lastChunk+2` and a single CRC-16/CCITT
 * (init 0xFFFF, poly 0x1021) over the ENTIRE reassembled payload, little-endian.
 * [G2Frame.commandMulti computes CRC per-packet — WRONG for e0, so this object
 *  frames e0 content itself via [frame]/[buildRawPacket].]
 */
object EvenHub {

    /** DocuLens app token (launch wrapper `f5`). Stable per app; cold-launching it
     *  hijacks DocuLens's slot. [PROTOCOL_NOTES; parse1 13:15:51.199] */
    const val DOCULENS_TOKEN = 11417

    /** Loading-screen text shown for the split-second between launch and our first
     *  content-update. Defaults to the captured DocuLens string so [launch] is
     *  byte-identical to the proven cold-launch frame. [parse1 13:15:51.199] */
    const val DEFAULT_LOADING = "DocuLens\n\nLoading documents..."

    /** EvenHub data service id (host → glasses). The byte pair lives in the
     *  AA-frame header[6..7], NOT as its own GATT characteristic — all e0-20
     *  frames are written to [G2Constants.CHAR_WRITE]. [PROTOCOL_NOTES] */
    val SVC_DATA = byteArrayOf(0xE0.toByte(), 0x20)

    /** Max payload bytes per AA packet for e0 content. The Even App split a
     *  244-byte doclist into 232 + 12 [parse1 13:15:51.378], so 232 is a proven
     *  chunk size; also clamped below by the MTU and the 1-byte Len ceiling. */
    const val MAX_CHUNK = 232

    /** Display-activation prelude sent ONCE before the cold [launch] (verbatim
     *  full AA frames from the 2026-06-03 phone-launch BTSnoop — the writes the
     *  Even Hub app sends to ready the display before its cold `e0-20` launch):
     *    1. `81-20` Display Trigger   2. `04-20` Display Wake   3. `0e-20` region config
     *  [parse1; same bytes the probe (ReplayKit.COLD_INIT) cold-launched with]. */
    val COLD_INIT: List<ByteArray> = listOf(
        hexFrame("aa213108010181200801103c1a00d8ee"),
        hexFrame("aa213210010104200801103d1a080801100118072801a95f"),
        hexFrame("aa21469301010e2008021051228a0108011215080210904e1d00d8ad4525000000002800300038001215080310d00f1d00007a4425000000002800300038001214080410001d0000000025000000002800300038001214080510001d0000b842250000ae422800300038001214080610001d0000c042250000c4422800300038001214080910001d00000000250000000028003000380018006d43"),
    )

    private fun hexFrame(s: String): ByteArray {
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            out[i] = ((Character.digit(s[i * 2], 16) shl 4) or Character.digit(s[i * 2 + 1], 16)).toByte()
        }
        return out
    }

    // ============================================================
    // Public message builders
    // ============================================================

    /** Phone-initiated COLD launch (`f1=0`). Send the [G2Constants.Services]
     *  cold-init prelude first (see probe ReplayKit.COLD_INIT), then this, then a
     *  [content] frame for our UI. Single packet. */
    fun launch(
        seq: Int,
        msgId: Int,
        token: Int = DOCULENS_TOKEN,
        loadingText: String = DEFAULT_LOADING,
    ): ByteArray {
        val container = loadingContainer(loadingText)
        // launch wrapper: f1=1 (one container), f3=<text container>, f5=<token>
        val wrapper = cat(vfield(1, 1), lfield(3, container), vfield(5, token))
        val payload = cat(vfield(1, 0), vfield(2, msgId), lfield(3, wrapper))
        return frame(seq, payload).single()
    }

    /** Content-update (`f1=7`). [lists] render in wrapper f2, [texts] in f3, count =
     *  total. Returns one-or-more AA packets (multi-packet per the e0 convention). */
    fun content(seq: Int, msgId: Int, lists: List<ByteArray>, texts: List<ByteArray>): List<ByteArray> {
        val parts = ArrayList<ByteArray>(1 + lists.size + texts.size)
        parts += vfield(1, lists.size + texts.size)       // f1 = container count
        for (c in lists) parts += lfield(2, c)            // list-type → f2
        for (c in texts) parts += lfield(3, c)            // text-type → f3
        val wrapper = cat(parts)
        val payload = cat(vfield(1, 7), vfield(2, msgId), lfield(7, wrapper))
        return frame(seq, payload)
    }

    /** Session keepalive (`f1=12`): `08 0c 10 <msgId> 72 00`. Send every ~4s. THE
     *  keepalive (probe v12). Never send f1=9 — it pops the native exit menu. */
    fun keepalive(seq: Int, msgId: Int): ByteArray {
        val payload = cat(vfield(1, 12), vfield(2, msgId), lfield(14, ByteArray(0)))
        return frame(seq, payload).single()
    }

    // ---- convenience: the two g2code-style screens ----

    /** A menu screen: a `menu-list` (region 2) under a `menu-header` status bar
     *  (region 1) — exactly g2code's status + content layout. */
    fun menuScreen(seq: Int, msgId: Int, statusText: String, items: List<String>): List<ByteArray> =
        content(seq, msgId, lists = listOf(menuList(items)), texts = listOf(menuHeader(statusText)))

    /** A text screen: a `main` body (region 2, CC output / errors) under a
     *  `menu-header` status bar (region 1). Both are text containers → wrapper f3. */
    fun textScreen(seq: Int, msgId: Int, statusText: String, body: String): List<ByteArray> =
        content(seq, msgId, lists = emptyList(), texts = listOf(menuHeader(statusText), mainText(body)))

    /** A confirmation screen: read-only [body] (e.g. an STT transcript) in a
     *  scrollable text region on top, with a selectable [options] menu-list below
     *  (so the firmware reports the chosen option on `e0-01`). Uses a custom
     *  top/bottom geometry — px positions are app layout data; the container wire
     *  format is the same proven encoding. */
    fun confirmScreen(seq: Int, msgId: Int, statusText: String, body: String, options: List<String>): List<ByteArray> =
        // MUST carry a menu-header status bar. Every screen the firmware actually
        // DISPLAYS (menuScreen, textScreen) has one; the old header-less
        // main+menu-list confirm wrote OK to the glasses but never PAINTED —
        // stranding the user on the prior frame (the "spawning"/"transcribing"
        // sticks, and the invisible transcript-confirm). Header + body(main) +
        // options(menu-list).
        content(seq, msgId, lists = listOf(confirmList(options)),
            texts = listOf(menuHeader(statusText), confirmBody(body)))

    // ============================================================
    // Container builders (layout constants copied verbatim per widget type)
    // ============================================================

    /** `menu-header` text container — the status bar (region 1, top).
     *  Dims/ids verbatim from the Reddit "Select your Feed" header. [parse1 13:16:18.762 f3] */
    fun menuHeader(text: String): ByteArray =
        textContainer(x = 40, y = 0, w = 504, h = 38, f5 = 0, f6 = null, f7 = null, f8 = 5, id = 1,
            type = "menu-header", scrollFlag = 0, text = text)

    /** `menu-list` list container — the menu (region 2). Firmware draws the
     *  selection border (f11.f3=1) and reports the picked index on `e0-01`.
     *  Dims/ids verbatim from the Reddit feed-picker. [parse1 13:16:18.762 f2] */
    fun menuList(items: List<String>): ByteArray =
        listContainer(x = 60, y = 43, w = 456, h = 245, f5 = 0, f6 = null, f7 = null, f8 = 0, id = 2,
            type = "menu-list", itemWidth = 456, items = items)

    /** `main` text container — full-screen body text (CC output, errors).
     *  Dims/ids verbatim from the Reddit feed screen. [parse1 13:16:14.382 f3] */
    fun mainText(text: String): ByteArray =
        textContainer(x = 0, y = 58, w = 576, h = 172, f5 = 0, f6 = null, f7 = null, f8 = 6, id = 1,
            type = "main", scrollFlag = 0, text = text)

    /** `loading` text container — the launch splash. [parse1 13:15:51.199] */
    private fun loadingContainer(text: String): ByteArray =
        textContainer(x = 8, y = 8, w = 560, h = 272, f5 = 0, f6 = 0, f7 = 0, f8 = 8, id = 1,
            type = "loading", scrollFlag = 1, text = text)

    /** Confirm-screen body: scrollable `main` text filling the top region.
     *  Custom geometry (top band) — see [confirmScreen]. */
    private fun confirmBody(text: String): ByteArray =
        // y=43 (below the menu-header status bar at y=0 h=38), leaving the bottom
        // band for the options list (confirmList at y=185).
        textContainer(x = 0, y = 43, w = 576, h = 140, f5 = 0, f6 = null, f7 = null, f8 = 6, id = 1,
            type = "main", scrollFlag = 1, text = text)

    /** Confirm-screen options: a `menu-list` in the bottom region. Custom
     *  geometry (bottom band) — see [confirmScreen]. */
    private fun confirmList(options: List<String>): ByteArray =
        listContainer(x = 0, y = 185, w = 576, h = 95, f5 = 0, f6 = null, f7 = null, f8 = 0, id = 2,
            type = "menu-list", itemWidth = 576, items = options)

    /** Text-type container: `f11` is a varint scroll flag (tag 0x58), `f12` is the
     *  UTF-8 text (tag 0x62). f6/f7 are emitted only when non-null (some widget
     *  types omit them; see PROTOCOL_NOTES). */
    private fun textContainer(
        x: Int, y: Int, w: Int, h: Int, f5: Int, f6: Int?, f7: Int?, f8: Int, id: Int,
        type: String, scrollFlag: Int, text: String,
    ): ByteArray {
        val f = ArrayList<ByteArray>(12)
        f += vfield(1, x); f += vfield(2, y); f += vfield(3, w); f += vfield(4, h); f += vfield(5, f5)
        if (f6 != null) f += vfield(6, f6)
        if (f7 != null) f += vfield(7, f7)
        f += vfield(8, f8); f += vfield(9, id); f += sfield(10, type)
        f += vfield(11, scrollFlag)   // tag 0x58 — varint scroll flag
        f += sfield(12, text)         // tag 0x62 — string
        return cat(f)
    }

    /** List-type container: `f11` is the item sub-message {f1=count, f2=itemWidth,
     *  f3=1 (firmware-drawn select border), f4=items…} (tag 0x5a), `f12` is varint 1
     *  (tag 0x60). */
    private fun listContainer(
        x: Int, y: Int, w: Int, h: Int, f5: Int, f6: Int?, f7: Int?, f8: Int, id: Int,
        type: String, itemWidth: Int, items: List<String>,
    ): ByteArray {
        val f = ArrayList<ByteArray>(12)
        f += vfield(1, x); f += vfield(2, y); f += vfield(3, w); f += vfield(4, h); f += vfield(5, f5)
        if (f6 != null) f += vfield(6, f6)
        if (f7 != null) f += vfield(7, f7)
        f += vfield(8, f8); f += vfield(9, id); f += sfield(10, type)
        val itemParts = ArrayList<ByteArray>(3 + items.size)
        itemParts += vfield(1, items.size)   // item count
        itemParts += vfield(2, itemWidth)
        itemParts += vfield(3, 1)            // isItemSelectBorderEn — firmware draws focus
        for (it in items) itemParts += sfield(4, it)
        f += lfield(11, cat(itemParts))      // tag 0x5a — item sub-message
        f += vfield(12, 1)                   // tag 0x60 — varint 1
        return cat(f)
    }

    // ============================================================
    // AA framing (e0 multi-packet convention)
    // ============================================================

    /** Frame an e0-20 payload into one-or-more AA packets. Single CRC over the
     *  WHOLE payload, placed on the final packet only (PROTOCOL_NOTES "PROVEN"). */
    private fun frame(seq: Int, payload: ByteArray): List<ByteArray> {
        val maxChunk = minOf(
            G2Constants.ConnectionParams.MTU - G2Frame.HEADER_SIZE - G2Frame.CRC_SIZE,
            MAX_CHUNK,
        )
        require(maxChunk > 0) { "MTU too small for e0 framing" }
        val crc = Crc16.compute(payload)   // over the entire payload
        val total = maxOf(1, (payload.size + maxChunk - 1) / maxChunk)
        val out = ArrayList<ByteArray>(total)
        var off = 0
        var serial = 1
        do {
            val end = minOf(off + maxChunk, payload.size)
            val chunk = payload.copyOfRange(off, end)
            val isFinal = serial >= total
            out += buildRawPacket(seq, chunk, total, serial, if (isFinal) crc else null)
            off = end
            serial++
        } while (off < payload.size)
        return out
    }

    /** Build one AA packet. `finalCrc != null` ⇒ this is the final (or only) packet:
     *  Len = chunk+2, CRC appended. Otherwise Len = chunk, no CRC bytes. */
    private fun buildRawPacket(seq: Int, chunk: ByteArray, total: Int, serial: Int, finalCrc: Int?): ByteArray {
        require(seq in 0..0xFF) { "seq out of range: $seq" }
        require(total in 1..0xFF && serial in 1..total) { "invalid packet seq: total=$total serial=$serial" }
        val crcSize = if (finalCrc != null) G2Frame.CRC_SIZE else 0
        val len = chunk.size + crcSize
        require(len <= 0xFF) { "e0 chunk Len $len exceeds 255 (chunk=${chunk.size}); raise split count" }
        val out = ByteArray(G2Frame.HEADER_SIZE + chunk.size + crcSize)
        out[0] = G2Constants.MAGIC
        out[1] = G2Constants.TYPE_COMMAND
        out[2] = (seq and 0xFF).toByte()
        out[3] = len.toByte()
        out[4] = total.toByte()
        out[5] = serial.toByte()
        out[6] = SVC_DATA[0]
        out[7] = SVC_DATA[1]
        chunk.copyInto(out, G2Frame.HEADER_SIZE)
        if (finalCrc != null) {
            out[out.size - 2] = (finalCrc and 0xFF).toByte()
            out[out.size - 1] = ((finalCrc ushr 8) and 0xFF).toByte()
        }
        return out
    }

    // ============================================================
    // protobuf field primitives (wire type 0 = varint, 2 = length-delimited)
    // ============================================================

    private fun key(field: Int, wire: Int): ByteArray = Varint.encode((field shl 3) or wire)
    private fun vfield(field: Int, value: Int): ByteArray = key(field, 0) + Varint.encode(value)
    private fun lfield(field: Int, body: ByteArray): ByteArray = key(field, 2) + Varint.encode(body.size) + body
    private fun sfield(field: Int, s: String): ByteArray = lfield(field, s.toByteArray(Charsets.UTF_8))

    private fun cat(parts: List<ByteArray>): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var o = 0
        for (p in parts) { p.copyInto(out, o); o += p.size }
        return out
    }

    private fun cat(vararg parts: ByteArray): ByteArray = cat(parts.asList())
}
