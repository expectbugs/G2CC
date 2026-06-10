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
 * Sequence / msgId / image-token counters live here. ALL THREE ARE SINGLE BYTES that wrap at
 * 0xFF (seq→0x10, token→1, msgId→0x00). msgId MUST stay 1 byte: native Chess wraps it 255→0
 * mid-session and survives, but a >255 (2-byte varint) msgId silently kills the hijacked app
 * slot — verified across 8 sessions each dying exactly at msgId==255 (Chess BTSnoop vs our
 * diag, 2026-06-06; see memory g2-render-limits "ROOT CAUSE (CORRECTED)"). No Android
 * dependency — the [DisplaySink] abstracts the BLE transport, so it's fully unit-tested.
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

    // Serialize full render ops so two ops' multi-message AA writes can't interleave on the BLE
    // queue (the clock/renewal-vs-server-render wedge — the conflated server channel only covers
    // server-vs-server). The single-packet keepalive heartbeat writes OUTSIDE this path and still
    // interleaves between chunks by design.
    /** One renderer message (its AA fragments) + optionally the msgId whose `e0-00` ack must
     *  arrive before the NEXT message goes out. Image chunks set it (ack-gated, matching the
     *  official app's 0/100 overlap); everything else leaves it null (fixed inter-message pacing). */
    private data class RenderMsg(val packets: List<ByteArray>, val ackMsgId: Int? = null)
    private data class SendJob(val msgs: List<RenderMsg>, val label: String, val onComplete: (Boolean) -> Unit)
    private val sendQueue = ArrayDeque<SendJob>()
    private var sending = false

    // Image ack-gate. A sent image chunk parks its continuation here until its `e0-00` ack
    // (onImageAck) — or until abort() releases it (teardown/recovery; the watchdog is the external
    // supervisor, so a never-arriving ack can't wedge the pump). NO timeout (per the three rules).
    private var ackWaitMsgId: Int? = null
    private var ackWaitResume: ((Boolean) -> Unit)? = null
    private var lastAckedMsgId: Int = -1     // most recent e0-00 ack msgId (handles ack-arrives-before-park)
    private var aborting = false             // set by abort(); cleared by the next enqueueSend

    /** The scene last handed to the glasses (after the in-flight write was issued). */
    val currentScene: Scene? get() = synchronized(lock) { current }

    private fun nextSeq(): Int = synchronized(lock) { seq.also { seq = if (seq >= 0xFF) SEQ_START else seq + 1 } }
    private fun nextMsgId(): Int = synchronized(lock) { msgId.also { msgId = (msgId + 1) and 0xFF } }  // 1-byte wrap 0xFF→0x00 — a >255 msgId kills the slot (see class doc)
    private fun nextToken(): Int = synchronized(lock) { token.also { token = if (token >= 0xFF) 1 else token + 1 } }

    /** Pre-push guard: reject a scene that would KILL or BLANK the glasses, BEFORE any BLE
     *  write goes out. Returns the rejection reason, or null if the scene is safe. These are
     *  hardware-confirmed kill conditions — see memory g2-render-limits / PROTOCOL_NOTES.md /
     *  docs/G2_BLE_PROTOCOL.md §7. The renderer is the API boundary, so callers never have to
     *  hand-walk these limits. */
    private fun validate(scene: Scene): String? {
        if (scene.regions.size > MAX_CONTAINERS)
            return "${scene.regions.size} containers exceeds the SDK max $MAX_CONTAINERS"
        val texts = scene.textRegions()
        if (texts.size > MAX_TEXT_REGIONS)
            return "${texts.size} text regions exceeds the max $MAX_TEXT_REGIONS"
        val imgs = scene.imageRegions()
        if (imgs.size > MAX_IMAGE_REGIONS)
            return "${imgs.size} image regions exceeds the max $MAX_IMAGE_REGIONS (extras silently drop)"
        for (r in imgs) {
            if (r.w > MAX_IMAGE_W || r.h > MAX_IMAGE_H)
                return "image region '${r.name}' ${r.w}x${r.h} exceeds the safe ${MAX_IMAGE_W}x${MAX_IMAGE_H} (a region ≥384×192 drops the BLE link)"
            val c = scene.content[r.name]
            if (c is Content.Image && Gray4Bmp.isBlank(c.bmp))
                return "image region '${r.name}' is all-black — the glasses choke on a blank image tile and drop the app"
        }
        // Exactly one input-capture region per page (text f11 / list f12 — wire rule §6.1).
        // >1 is a hard reject; 0 renders fine but leaves input dead, so warn loudly only.
        val captures = texts.count { (scene.content[it.name] as? Content.Text)?.scroll == true } +
            scene.listRegions().count { (scene.content[it.name] as? Content.ListItems)?.eventCapture == true }
        if (captures > 1)
            return "$captures event-capture regions (text scroll / list eventCapture) — a page allows exactly ONE"
        if (captures == 0)
            diag("validate: scene has NO event-capture region — ring/tap input will be dead on this page")
        return null
    }

    // ---------------------------------------------------------------- public API

    /**
     * Cold-launch a Hub session: optional verbatim prelude frames (the caller passes
     * EvenHub.COLD_INIT), then the f1=0 launch (regions + app token, text embedded), then a
     * push of every image region's content.
     */
    fun launch(appToken: Int, scene: Scene, prelude: List<ByteArray> = emptyList(), onComplete: (Boolean) -> Unit = {}) {
        validate(scene)?.let { diag("launch REJECTED — $it"); onComplete(false); return }
        val ops = try {
            val o = ArrayList<RenderMsg>()
            for (f in prelude) o += RenderMsg(listOf(f))
            o += RenderMsg(DisplayProto.frame(
                nextSeq(),
                DisplayProto.launchPayload(
                    nextMsgId(), appToken,
                    scene.textRegions().map { textContainer(scene, it) },
                    scene.imageRegions().map { imageContainer(it) },
                    scene.listRegions().map { listContainer(scene, it) },
                ),
            ))
            o += imageContentOps(scene, scene.imageRegions().map { it.name })
            o
        } catch (e: IllegalArgumentException) {
            // A bad/wrong-size image in the scene loud-fails gracefully (matches setImage)
            // instead of throwing out to a BLE callback / coroutine.
            diag("launch: bad image in scene — ${e.message}")
            onComplete(false); return
        }
        synchronized(lock) { current = scene }
        enqueueSend(ops, "launch", onComplete)
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
        validate(scene)?.let { diag("setScene REJECTED — $it"); onComplete(false); return }
        val d = scene.diff(prev)
        for (name in d.removedRegions) {
            diag("setScene: region '$name' content removed — not auto-cleared; set blank content to clear it")
        }
        val ops = try {
            val o = ArrayList<RenderMsg>()
            if (d.layoutChanged) {
                o += RenderMsg(DisplayProto.frame(
                    nextSeq(),
                    DisplayProto.layoutPayload(
                        nextMsgId(),
                        scene.textRegions().map { textContainer(scene, it) },
                        scene.imageRegions().map { imageContainer(it) },
                        scene.listRegions().map { listContainer(scene, it) },
                    ),
                ))
                o += imageContentOps(scene, scene.imageRegions().map { it.name })
            } else {
                for (name in d.changedRegions) {
                    when (val c = scene.content[name]) {
                        is Content.Text -> o += textOp(scene.region(name)!!, c)
                        is Content.Image -> o += imageOps(scene.region(name)!!, c.bmp)
                        // Unreachable: Scene.diff reports any list change as layoutChanged
                        // (items ride the layout frame). Defensive diag, never silent.
                        is Content.ListItems -> diag("setScene: list '$name' changed without layoutChanged — diff bug?")
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
        enqueueSend(ops, "setScene(layout=${d.layoutChanged}, dirty=${d.changedRegions.size})", onComplete)
    }

    /** Update a single text region by name (cheap f1=5). Loud-fails if the region is unknown
     *  or not a text region — never silently drops the update.
     *
     *  [contentOffset]+[contentLength] do a PARTIAL in-place replace (the SDK's
     *  textContainerUpgrade(contentOffset, contentLength) — efficient for streaming a growing
     *  tail); both null = full replace. A text region's `scroll` flag (f11/isEventCapture) is a
     *  CONTAINER property that cannot change via f1=5, so it is intentionally NOT a parameter
     *  here — the region keeps its launch-time scroll. To change scroll, re-push via [setScene]. */
    fun setText(
        name: String, text: String,
        contentOffset: Int? = null, contentLength: Int? = null, onComplete: (Boolean) -> Unit = {},
    ) {
        val scene = synchronized(lock) { current }
        val region = scene?.region(name)
        if (scene == null || region == null || region.kind != RegionKind.TEXT) {
            diag("setText('$name'): no such text region (launched=${scene != null})")
            onComplete(false); return
        }
        val existingScroll = (scene.content[name] as? Content.Text)?.scroll ?: false
        val c = Content.Text(text, existingScroll, contentOffset, contentLength)
        synchronized(lock) { current = scene.withContent(name, c) }
        enqueueSend(listOf(textOp(region, c)), "text:$name", onComplete)
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
        if (Gray4Bmp.isBlank(bmp)) { diag("setImage('$name') REJECTED — all-black tile"); onComplete(false); return }
        val ops = try {
            imageOps(region, bmp)
        } catch (e: IllegalArgumentException) {
            diag("setImage('$name'): ${e.message}"); onComplete(false); return
        }
        synchronized(lock) { current = scene.withContent(name, Content.Image(bmp)) }
        enqueueSend(ops, "image:$name", onComplete)
    }

    /** A keepalive frame (f1=12) to hold the Hub session; mint one every ~4 s and write to R. */
    fun keepaliveFrame(): ByteArray = DisplayProto.keepalive(nextSeq(), nextMsgId())

    // ---------------------------------------------------------------- internals

    private fun textContainer(scene: Scene, r: Region): ByteArray {
        val c = scene.content[r.name] as? Content.Text
        return DisplayProto.textContainer(r.x, r.y, r.w, r.h, r.id, r.name, c?.scroll ?: false, c?.text ?: "", r.style)
    }

    private fun imageContainer(r: Region): ByteArray =
        DisplayProto.imageContainer(r.x, r.y, r.w, r.h, r.id, r.name)

    private fun listContainer(scene: Scene, r: Region): ByteArray {
        val c = scene.content[r.name] as? Content.ListItems
            ?: throw IllegalArgumentException("list region '${r.name}' declared without ListItems content (items ride the layout frame)")
        return DisplayProto.listContainer(r.x, r.y, r.w, r.h, r.id, r.name,
            c.items, c.itemWidth, c.selectBorder, c.eventCapture, r.style)
    }

    private fun textOp(r: Region, c: Content.Text): RenderMsg =
        RenderMsg(DisplayProto.frame(nextSeq(), DisplayProto.textPayload(nextMsgId(), r.id, r.name, c.text, c.contentOffset, c.contentLength)))

    /** Chunk a BMP at MAX_IMAGE_CHUNK and frame each chunk as its own f1=3 message. Each chunk is
     *  ack-gated on its own msgId so the NEXT chunk waits for this one's `e0-00` ack (the official
     *  push pattern). */
    private fun imageOps(r: Region, bmp: ByteArray): List<RenderMsg> {
        val dec = Gray4Bmp.decode(bmp)   // throws loudly if not a 4bpp BM
        require(dec.width == r.w && dec.height == r.h) {
            "image ${dec.width}x${dec.height} != region '${r.name}' ${r.w}x${r.h}"
        }
        val tok = nextToken()
        val ops = ArrayList<RenderMsg>()
        var off = 0; var idx = 0
        while (off < bmp.size) {
            val end = minOf(off + DisplayProto.MAX_IMAGE_CHUNK, bmp.size)
            val chunk = bmp.copyOfRange(off, end)
            val mid = nextMsgId()
            ops += RenderMsg(
                DisplayProto.frame(nextSeq(), DisplayProto.imagePayload(mid, r.id, r.name, tok, bmp.size, idx, chunk)),
                ackMsgId = mid,
            )
            off = end; idx++
        }
        return ops
    }

    private fun imageContentOps(scene: Scene, names: List<String>): List<RenderMsg> {
        val ops = ArrayList<RenderMsg>()
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
    private fun sendOps(msgs: List<RenderMsg>, label: String, onComplete: (Boolean) -> Unit) {
        if (msgs.isEmpty()) { onComplete(true); return }
        diag("render $label: ${msgs.size} messages / ${msgs.sumOf { it.packets.size }} packets (discrete, keepalive-interleavable)")
        sendMessage(msgs, 0, label, onComplete)
    }

    private fun sendMessage(msgs: List<RenderMsg>, i: Int, label: String, onComplete: (Boolean) -> Unit) {
        if (i >= msgs.size) { onComplete(true); return }
        val msg = msgs[i]
        val packets = msg.packets
        val delays = ArrayList<Long>(packets.size)
        // Pace fragments within the message. The last-fragment pause is the inter-message gap that
        // the keepalive slots into. An ack-gated (image) message uses only a small floor here and
        // then WAITS for its e0-00 ack before the next chunk — matching the official ack-gated push
        // and self-adapting to link speed (faster ack ⇒ faster next chunk). Tune for the hat in
        // HAT_BRIDGE_SPEC.md §13. A non-ack-gated message keeps the fixed inter-message pace.
        val lastPace = if (msg.ackMsgId != null) IMAGE_INTER_CHUNK_FLOOR_MS else INTER_MESSAGE_PACE_MS
        for (k in packets.indices) delays += if (k == packets.size - 1) lastPace else FRAGMENT_PACE_MS
        sink.write(packets, delays, "$label#${i + 1}/${msgs.size}") { wok ->
            if (!wok) {
                // Abort on a write failure rather than pushing the remaining chunks into a
                // possibly-dying session (coordinated with the queueWrites BLE-1 fix).
                diag("render $label#${i + 1}: WRITE FAILED — aborting ${msgs.size - i - 1} remaining message(s)")
                onComplete(false)
                return@write
            }
            val ackId = msg.ackMsgId
            if (ackId == null) {
                sendMessage(msgs, i + 1, label, onComplete)
            } else {
                // Ack-gate: hold the next chunk until this one's e0-00 ack (or abort()).
                awaitImageAck(ackId) { acked ->
                    if (acked) sendMessage(msgs, i + 1, label, onComplete)
                    else { diag("render $label#${i + 1}: ack-wait released by abort — stopping"); onComplete(false) }
                }
            }
        }
    }

    /** Serialize full render ops: only one op's messages sit on the BLE queue at a time, so a
     *  clock tick / renewal / server render can't interleave its AA writes into another op's. */
    private fun enqueueSend(msgs: List<RenderMsg>, label: String, onComplete: (Boolean) -> Unit) {
        synchronized(lock) {
            aborting = false                       // a fresh op means we're live again (post-recovery)
            sendQueue.addLast(SendJob(msgs, label, onComplete))
            if (sending) return
            sending = true
        }
        pumpNext()
    }

    private fun pumpNext() {
        val job = synchronized(lock) {
            if (sendQueue.isEmpty()) { sending = false; null } else sendQueue.removeFirst()
        } ?: return
        sendOps(job.msgs, job.label) { ok ->
            job.onComplete(ok)
            pumpNext()
        }
    }

    /** Feed every `e0-00` ack's msgId here (the connection layer parses `ack.f2`). Resumes the
     *  parked image-chunk send if it was waiting on this msgId; other acks just record liveness.
     *  All `e0-20` writes (launch/image/text/layout/keepalive) share one msgId counter, so an
     *  image chunk's msgId is unique within the ack window — no cross-op false match. */
    fun onImageAck(msgId: Int) {
        val resume = synchronized(lock) {
            lastAckedMsgId = msgId
            if (ackWaitMsgId == msgId) { ackWaitMsgId = null; ackWaitResume.also { ackWaitResume = null } } else null
        }
        resume?.invoke(true)
    }

    /** Release any parked image-chunk send (failing it) and drop queued ops — call on teardown /
     *  before recovery so a never-arriving ack can't wedge the render pump. The watchdog supervises
     *  the session externally; this is the local unblock. Safe when nothing is parked. */
    fun abort(reason: String) {
        val resume = synchronized(lock) {
            aborting = true
            sendQueue.clear()
            ackWaitMsgId = null
            ackWaitResume.also { ackWaitResume = null }
        }
        if (resume != null) diag("renderer abort ($reason): releasing parked image-chunk send")
        resume?.invoke(false)
    }

    /** Park [resume] until the [msgId] ack arrives (→ resume(true)) or abort() fires (→ resume(false)).
     *  Resolves immediately if the ack already arrived (race) or an abort is in progress. */
    private fun awaitImageAck(msgId: Int, resume: (Boolean) -> Unit) {
        var fire: Boolean? = null
        synchronized(lock) {
            when {
                aborting -> fire = false                   // teardown underway → don't park, fail fast
                lastAckedMsgId == msgId -> fire = true      // ack already arrived → proceed now
                else -> { ackWaitMsgId = msgId; ackWaitResume = resume }
            }
        }
        fire?.let { resume(it) }
    }

    companion object {
        const val SEQ_START = 0x10          // 0x00..0x0F reserved for auth
        const val MSGID_START = 0x20
        const val MAX_IMAGE_REGIONS = 4         // glasses paint ≤4 image regions; a 5th+ silently drops
        const val MAX_TEXT_REGIONS = 8          // SDK cap (docs/G2_BLE_PROTOCOL.md §7, ramp-12 proven)
        const val MAX_CONTAINERS = 12           // SDK total-container cap (§7)
        const val MAX_IMAGE_W = 288             // proven-safe per-region size; a region ≥384×192 drops the BLE link
        const val MAX_IMAGE_H = 129
        const val FRAGMENT_PACE_MS = 12L    // between AA fragments WITHIN one message (chunk)
        const val INTER_MESSAGE_PACE_MS = 100L  // after a NON-ack-gated message (text/layout) — keepalive interleaves here
        // After an image chunk, before its ack-gate. Just a small floor — the real inter-chunk gap
        // is the e0-00 ack (so it self-adapts to link speed). The knob the hat pacing sweep tunes
        // toward the glasses' true ingestion ceiling once the link is rock-solid (HAT_BRIDGE_SPEC.md §13).
        const val IMAGE_INTER_CHUNK_FLOOR_MS = 12L
    }
}
