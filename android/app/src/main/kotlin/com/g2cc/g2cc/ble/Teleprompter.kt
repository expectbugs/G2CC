package com.g2cc.g2cc.ble

/**
 * Teleprompter service (0x06-20) — the HUD text-display primitive.
 *
 * PROTOCOL_NOTES.md §"Teleprompter — the HUD text primitive" + i-soxi
 * /examples/teleprompter/teleprompter.py:121-178 + /docs/teleprompter.md.
 *
 * Render flow:
 *   1. send display_config (service 0x0E-20)
 *   2. send teleprompter_init (type=1) — selects script + scroll mode
 *   3. send content pages 0–9 (type=3)
 *   4. send mid-stream marker (type=255)
 *   5. send content pages 10–11 (type=3)
 *   6. send sync trigger (service 0x80-00, type=14)
 *   7. send remaining pages (type=3)
 *
 * Per docs/teleprompter.md: minimum ~10 pages or content may not render — pad
 * with whitespace pages to >= 14. ~25 chars per line; exactly 10 lines per page.
 *
 * The G2 firmware natively scrolls multi-page content — this is what makes the
 * "no truncation" rule cheap on the protocol side. Long transcripts and CC
 * streaming output map directly onto teleprompter pages.
 */
object Teleprompter {

    private const val LINES_PER_PAGE = 10
    private const val CHARS_PER_LINE = 25
    private const val MIN_PAGES = 14
    /** Content height in display units; teleprompter.py:139 scales linearly with line count.
     *  Bee Movie reference: 140 lines = 2665 height units. */
    private const val CONTENT_HEIGHT_PER_LINE = 2665.0 / 140.0

    /** Scroll mode field 9 of TeleprompterDisplaySettings. */
    enum class ScrollMode(val byte: Byte) {
        Manual(0x00),
        Ai(0x01),
    }

    /** Display config block — fixed 106-byte hex blob from teleprompter.py:123-129.
     *  This is reverse-engineered as opaque settings (DisplayRegion records per
     *  i-soxi proto, but the exact field values aren't fully decoded). Until
     *  deeper RE work, send the captured bytes verbatim. */
    private val DISPLAY_CONFIG_BLOB: ByteArray = byteArrayOf(
        0x08, 0x01, 0x12, 0x13, 0x08, 0x02, 0x10, 0x90.toByte(),
        0x4E, 0x1D, 0x00, 0xE0.toByte(), 0x94.toByte(), 0x44, 0x25, 0x00,
        0x00, 0x00, 0x00, 0x28, 0x00, 0x30, 0x00, 0x12, 0x13,
        0x08, 0x03, 0x10, 0x0D, 0x0F, 0x1D, 0x00, 0x40,
        0x8D.toByte(), 0x44, 0x25, 0x00, 0x00, 0x00, 0x00, 0x28,
        0x00, 0x30, 0x00, 0x12, 0x12, 0x08, 0x04, 0x10,
        0x00, 0x1D, 0x00, 0x00, 0x88.toByte(), 0x42, 0x25,
        0x00, 0x00, 0x00, 0x00, 0x28, 0x00, 0x30,
        0x00, 0x12, 0x12, 0x08, 0x05, 0x10, 0x00, 0x1D,
        0x00, 0x00, 0x92.toByte(), 0x42, 0x25, 0x00, 0x00,
        0xA2.toByte(), 0x42, 0x28, 0x00, 0x30, 0x00, 0x12, 0x12,
        0x08, 0x06, 0x10, 0x00, 0x1D, 0x00, 0x00, 0xC6.toByte(),
        0x42, 0x25, 0x00, 0x00, 0xC4.toByte(), 0x42, 0x28, 0x00,
        0x30, 0x00, 0x18, 0x00,
    )

    /** Build the display_config packet (service 0x0E-20, type=2). */
    fun buildDisplayConfig(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0x02, 0x10) +
            Varint.encode(msgId) +
            byteArrayOf(0x22, 0x6A) +
            DISPLAY_CONFIG_BLOB
        return G2Frame.command(seq, G2Constants.Services.DISPLAY_CONFIG, payload)
    }

    /** Build teleprompter_init (service 0x06-20, type=1). */
    fun buildInit(seq: Int, msgId: Int, totalLines: Int, mode: ScrollMode): ByteArray {
        require(totalLines >= 1) { "totalLines must be >= 1" }
        val contentHeight = maxOf(1, (totalLines * CONTENT_HEIGHT_PER_LINE).toInt())

        val display = byteArrayOf(0x08, 0x01, 0x10, 0x00, 0x18, 0x00, 0x20, 0x8B.toByte(), 0x02) +
            byteArrayOf(0x28) + Varint.encode(contentHeight) +
            byteArrayOf(0x30, 0xE6.toByte(), 0x01) +    // line height = 230
            byteArrayOf(0x38, 0x8E.toByte(), 0x0A) +    // viewport = 1294
            byteArrayOf(0x40, 0x05, 0x48, mode.byte)

        val settings = byteArrayOf(0x08, 0x01, 0x12, display.size.toByte()) + display
        val payload = byteArrayOf(0x08, 0x01, 0x10) +
            Varint.encode(msgId) +
            byteArrayOf(0x1A, settings.size.toByte()) + settings

        return G2Frame.command(seq, G2Constants.Services.TELEPROMPTER, payload)
    }

    /** Build a content page (service 0x06-20, type=3). */
    fun buildContentPage(seq: Int, msgId: Int, pageNum: Int, text: String): ByteArray {
        // Text format from docs/teleprompter.md §"Type 3":
        //   - leading newline ('\n')
        //   - 10 lines separated by '\n'
        //   - trailing ' \n' (space + newline)
        val textBytes = ("\n" + text).toByteArray(Charsets.UTF_8)
        val inner = byteArrayOf(0x08) + Varint.encode(pageNum) +
            byteArrayOf(0x10, 0x0A) +              // 10 lines
            byteArrayOf(0x1A) + Varint.encode(textBytes.size) + textBytes

        val content = byteArrayOf(0x2A) + Varint.encode(inner.size) + inner
        val payload = byteArrayOf(0x08, 0x03, 0x10) + Varint.encode(msgId) + content

        return G2Frame.command(seq, G2Constants.Services.TELEPROMPTER, payload)
    }

    /** Build the mid-stream marker (service 0x06-20, type=255). */
    fun buildMarker(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0xFF.toByte(), 0x01, 0x10) +
            Varint.encode(msgId) +
            byteArrayOf(0x6A, 0x04, 0x08, 0x00, 0x10, 0x06)
        return G2Frame.command(seq, G2Constants.Services.TELEPROMPTER, payload)
    }

    /** Build the sync trigger (service 0x80-00, type=14). */
    fun buildSyncTrigger(seq: Int, msgId: Int): ByteArray {
        val payload = byteArrayOf(0x08, 0x0E, 0x10) +
            Varint.encode(msgId) +
            byteArrayOf(0x6A, 0x00)
        return G2Frame.command(seq, G2Constants.Services.AUTH_CONTROL, payload)
    }

    /** Format text into pages of (LINES_PER_PAGE) lines, ~CHARS_PER_LINE chars each.
     *  Per docs/teleprompter.md §"Text Formatting": wrap at word boundaries; pad
     *  to MIN_PAGES total. NEVER truncate — long content gets more pages. */
    fun formatPages(text: String): List<String> {
        val wrapped = ArrayList<String>()
        for (raw in text.replace("\\n", "\n").split('\n')) {
            if (raw.isBlank()) {
                wrapped += ""
                continue
            }
            val words = raw.split(' ').filter { it.isNotEmpty() }
            val current = StringBuilder()
            for (w in words) {
                if (current.isNotEmpty() && current.length + 1 + w.length > CHARS_PER_LINE) {
                    wrapped += current.toString().trim()
                    current.clear()
                }
                if (current.isNotEmpty()) current.append(' ')
                current.append(w)
            }
            if (current.isNotEmpty()) wrapped += current.toString().trim()
        }
        if (wrapped.isEmpty()) wrapped += text

        // Pad to LINES_PER_PAGE multiple.
        while (wrapped.size % LINES_PER_PAGE != 0) wrapped += " "
        // Make pages.
        val pages = wrapped.chunked(LINES_PER_PAGE).map { it.joinToString("\n") + " \n" }.toMutableList()
        // Pad to MIN_PAGES.
        while (pages.size < MIN_PAGES) {
            pages += List(LINES_PER_PAGE) { " " }.joinToString("\n") + " \n"
        }
        return pages
    }
}
