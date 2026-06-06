package com.g2cc.g2cc.render

/**
 * Transport sink for the renderer: writes one ordered batch of AA packets (one display
 * operation, possibly multi-packet) and reports completion. [BleDisplaySink] backs this with
 * a lens's BLE write queue; tests back it with a fake that records what was sent.
 */
fun interface DisplaySink {
    fun write(packets: List<ByteArray>, delaysAfterMs: List<Long>, label: String, onComplete: (Boolean) -> Unit)
}

/**
 * The G2 display renderer — owns the EvenHub image/region display encoding end-to-end.
 *
 * Composes a [Scene] of named text + image regions and drives it to the glasses, sending
 * ONLY what changed (dirty-rect / partial-region updates — the native, interactive-fast
 * path). Layout (region geometry) is pushed via f1=0/f1=7 only when it actually changes;
 * region content updates go via f1=5 (text, cheap) and f1=3 (image, chunked).
 *
 * Sequence / msgId / image-token counters live here and wrap exactly like the proven EvenHud
 * path (seq 0x10..0xFF, msgId 0x20..0xFFFF). No Android dependency — the [DisplaySink]
 * abstracts the BLE transport, so the orchestration is fully unit-tested with a fake sink.
 *
 * See docs/PROTOCOL_NOTES.md §"EvenHub display rendering".
 */
class G2Renderer(
    private val sink: DisplaySink,
    private val diag: (String) -> Unit = {},
) {
    private val lock = Any()
    private var seq = SEQ_START
    private var msgId = MSGID_START
    private var token = 1
    private var current: Scene? = null

    /** The scene last handed to the glasses (after the in-flight write was issued). */
    val currentScene: Scene? get() = synchronized(lock) { current }

    private fun nextSeq(): Int = synchronized(lock) { seq.also { seq = if (seq >= 0xFF) SEQ_START else seq + 1 } }
    private fun nextMsgId(): Int = synchronized(lock) { msgId.also { msgId = if (msgId >= 0xFFFF) MSGID_START else msgId + 1 } }
    private fun nextToken(): Int = synchronized(lock) { token.also { token = if (token >= 0xFF) 1 else token + 1 } }

    // ---------------------------------------------------------------- public API

    /**
     * Cold-launch a Hub session: optional verbatim prelude frames (the caller passes
     * EvenHub.COLD_INIT), then the f1=0 launch (regions + app token, text embedded), then a
     * push of every image region's content.
     */
    fun launch(appToken: Int, scene: Scene, prelude: List<ByteArray> = emptyList(), onComplete: (Boolean) -> Unit = {}) {
        val ops = try {
            val o = ArrayList<List<ByteArray>>()
            for (f in prelude) o += listOf(f)
            o += DisplayProto.frame(
                nextSeq(),
                DisplayProto.launchPayload(
                    nextMsgId(), appToken,
                    scene.textRegions().map { textContainer(scene, it) },
                    scene.imageRegions().map { imageContainer(it) },
                ),
            )
            o += imageContentOps(scene, scene.imageRegions().map { it.name })
            o
        } catch (e: IllegalArgumentException) {
            // A bad/wrong-size image in the scene loud-fails gracefully (matches setImage)
            // instead of throwing out to a BLE callback / coroutine.
            diag("launch: bad image in scene — ${e.message}")
            onComplete(false); return
        }
        synchronized(lock) { current = scene }
        sendOps(ops, "launch", onComplete)
    }

    /**
     * Render [scene], sending only what changed vs the current scene. If the layout changed,
     * re-declares regions (f1=7) and re-pushes all image content; otherwise pushes just the
     * regions whose content changed.
     */
    fun setScene(scene: Scene, onComplete: (Boolean) -> Unit = {}) {
        val prev = synchronized(lock) { current }
        if (prev == null) {
            // No cold-launched Hub slot yet → an f1=7 would be silently ignored by the firmware.
            diag("setScene before launch() — cold-launch a session first")
            onComplete(false); return
        }
        val d = scene.diff(prev)
        for (name in d.removedRegions) {
            diag("setScene: region '$name' content removed — not auto-cleared; set blank content to clear it")
        }
        val ops = try {
            val o = ArrayList<List<ByteArray>>()
            if (d.layoutChanged) {
                o += DisplayProto.frame(
                    nextSeq(),
                    DisplayProto.layoutPayload(
                        nextMsgId(),
                        scene.textRegions().map { textContainer(scene, it) },
                        scene.imageRegions().map { imageContainer(it) },
                    ),
                )
                o += imageContentOps(scene, scene.imageRegions().map { it.name })
            } else {
                for (name in d.changedRegions) {
                    when (val c = scene.content[name]) {
                        is Content.Text -> o += textOp(scene.region(name)!!, c)
                        is Content.Image -> o += imageOps(scene.region(name)!!, c.bmp)
                        null -> {}
                    }
                }
            }
            o
        } catch (e: IllegalArgumentException) {
            diag("setScene: bad image in scene — ${e.message}")
            onComplete(false); return
        }
        synchronized(lock) { current = scene }
        sendOps(ops, "setScene(layout=${d.layoutChanged}, dirty=${d.changedRegions.size})", onComplete)
    }

    /** Update a single text region by name (cheap f1=5). Loud-fails if the region is unknown
     *  or not a text region — never silently drops the update.
     *
     *  Note: a text region's `scroll` flag (f11) is a CONTAINER property and cannot change via
     *  an f1=5 update, so it is intentionally NOT a parameter here — the region keeps its
     *  launch-time scroll. To change scroll, re-push the layout via [setScene]. */
    fun setText(
        name: String, text: String,
        scrollOffset: Int? = null, contentHeight: Int? = null, onComplete: (Boolean) -> Unit = {},
    ) {
        val scene = synchronized(lock) { current }
        val region = scene?.region(name)
        if (scene == null || region == null || region.kind != RegionKind.TEXT) {
            diag("setText('$name'): no such text region (launched=${scene != null})")
            onComplete(false); return
        }
        val existingScroll = (scene.content[name] as? Content.Text)?.scroll ?: false
        val c = Content.Text(text, existingScroll, scrollOffset, contentHeight)
        synchronized(lock) { current = scene.withContent(name, c) }
        sendOps(listOf(textOp(region, c)), "text:$name", onComplete)
    }

    /** Update a single image region by name from a pre-encoded 4bpp BMP (chunked f1=3). The
     *  BMP's dimensions must match the region; mismatch loud-fails. */
    fun setImage(name: String, bmp: ByteArray, onComplete: (Boolean) -> Unit = {}) {
        val scene = synchronized(lock) { current }
        val region = scene?.region(name)
        if (scene == null || region == null || region.kind != RegionKind.IMAGE) {
            diag("setImage('$name'): no such image region (launched=${scene != null})")
            onComplete(false); return
        }
        val ops = try {
            imageOps(region, bmp)
        } catch (e: IllegalArgumentException) {
            diag("setImage('$name'): ${e.message}"); onComplete(false); return
        }
        synchronized(lock) { current = scene.withContent(name, Content.Image(bmp)) }
        sendOps(ops, "image:$name", onComplete)
    }

    /** A keepalive frame (f1=12) to hold the Hub session; mint one every ~4 s and write to R. */
    fun keepaliveFrame(): ByteArray = DisplayProto.keepalive(nextSeq(), nextMsgId())

    // ---------------------------------------------------------------- internals

    private fun textContainer(scene: Scene, r: Region): ByteArray {
        val c = scene.content[r.name] as? Content.Text
        return DisplayProto.textContainer(r.x, r.y, r.w, r.h, r.id, r.name, c?.scroll ?: false, c?.text ?: "")
    }

    private fun imageContainer(r: Region): ByteArray =
        DisplayProto.imageContainer(r.x, r.y, r.w, r.h, r.id, r.name)

    private fun textOp(r: Region, c: Content.Text): List<ByteArray> =
        DisplayProto.frame(nextSeq(), DisplayProto.textPayload(nextMsgId(), r.id, r.name, c.text, c.scrollOffset, c.contentHeight))

    /** Chunk a BMP at MAX_IMAGE_CHUNK and frame each chunk as its own f1=3 message. */
    private fun imageOps(r: Region, bmp: ByteArray): List<List<ByteArray>> {
        val dec = Gray4Bmp.decode(bmp)   // throws loudly if not a 4bpp BM
        require(dec.width == r.w && dec.height == r.h) {
            "image ${dec.width}x${dec.height} != region '${r.name}' ${r.w}x${r.h}"
        }
        val tok = nextToken()
        val ops = ArrayList<List<ByteArray>>()
        var off = 0; var idx = 0
        while (off < bmp.size) {
            val end = minOf(off + DisplayProto.MAX_IMAGE_CHUNK, bmp.size)
            val chunk = bmp.copyOfRange(off, end)
            ops += DisplayProto.frame(nextSeq(), DisplayProto.imagePayload(nextMsgId(), r.id, r.name, tok, bmp.size, idx, chunk))
            off = end; idx++
        }
        return ops
    }

    private fun imageContentOps(scene: Scene, names: List<String>): List<List<ByteArray>> {
        val ops = ArrayList<List<ByteArray>>()
        for (name in names) (scene.content[name] as? Content.Image)?.let { ops += imageOps(scene.region(name)!!, it.bmp) }
        return ops
    }

    /**
     * Send each message (layout / image-chunk / text) as its OWN write — a small atomic batch of
     * just that message's AA fragments — sequenced one-after-another with an inter-message pause.
     *
     * This mirrors the native Even Hub apps (capture U=19): chunks went out ~0.3 s apart as
     * discrete writes with keepalives *between* them. The previous version flattened the whole
     * image into ONE 367-packet atomic batch, which held the BLE queue for ~20 s, blocked the
     * keepalive, and dropped the link mid-push. Per-message writes let the keepalive (a separate
     * enqueue) interleave between chunks, exactly like the app the firmware expects.
     */
    private fun sendOps(ops: List<List<ByteArray>>, label: String, onComplete: (Boolean) -> Unit) {
        if (ops.isEmpty()) { onComplete(true); return }
        diag("render $label: ${ops.size} messages / ${ops.sumOf { it.size }} packets (discrete, keepalive-interleavable)")
        sendMessage(ops, 0, label, true, onComplete)
    }

    private fun sendMessage(ops: List<List<ByteArray>>, i: Int, label: String, ok: Boolean, onComplete: (Boolean) -> Unit) {
        if (i >= ops.size) { onComplete(ok); return }
        val msg = ops[i]
        val delays = ArrayList<Long>(msg.size)
        // pace fragments within the message; a longer pause AFTER the last fragment is the gap the
        // keepalive (and the next chunk's ack) slot into, matching the native ~0.3 s/chunk cadence.
        for (k in msg.indices) delays += if (k == msg.size - 1) INTER_MESSAGE_PACE_MS else FRAGMENT_PACE_MS
        sink.write(msg, delays, "$label#${i + 1}/${ops.size}") { wok ->
            if (!wok) diag("render $label#${i + 1}: WRITE FAILED")
            sendMessage(ops, i + 1, label, ok && wok, onComplete)
        }
    }

    companion object {
        const val SEQ_START = 0x10          // 0x00..0x0F reserved for auth
        const val MSGID_START = 0x20
        const val FRAGMENT_PACE_MS = 12L    // between AA fragments WITHIN one message (chunk)
        const val INTER_MESSAGE_PACE_MS = 100L  // after each message — keepalive interleaves here (native ~0.3 s/chunk)
    }
}
