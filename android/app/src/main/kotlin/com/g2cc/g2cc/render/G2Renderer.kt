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
    /** Injectable for tests (park age / grace decisions); production = wall clock. */
    private val clock: () -> Long = System::currentTimeMillis,
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
     *  official app's 0/100 overlap); everything else leaves it null (fixed inter-message
     *  pacing). [regionName] marks SKIPPABLE per-region content messages for preemption —
     *  null (layout/launch frames) means the message must always complete. */
    private data class RenderMsg(val packets: List<ByteArray>, val ackMsgId: Int? = null, val regionName: String? = null)
    private data class SendJob(
        val msgs: List<RenderMsg>,
        val label: String,
        val onComplete: (Boolean) -> Unit,
        /** The scene this job is delivering + the one on the glasses before it — preemption
         *  rolls `current` back for regions whose content never went out. */
        val sceneRef: Scene? = null,
        val prevScene: Scene? = null,
        /** abort() fences: a job whose epoch predates the current one stops at the next
         *  REGION boundary (review 2026-06-11 — replaces the shared `aborting` flag that
         *  a follow-up enqueue could reset while the doomed job was still in flight). */
        val epoch: Int = 0,
        /** preempt() fences: a preempt that fired AFTER this job was enqueued targets it;
         *  jobs enqueued after the preempt are immune (the old single boolean was cleared
         *  on dequeue, losing preempts aimed at QUEUED stale scenes). */
        val preemptSnap: Int = 0,
    )
    private val sendQueue = ArrayDeque<SendJob>()
    private var sending = false
    // Preemption (menu taps must not wait ~4 s behind a 4-tile push): bumping preemptSeq
    // makes every job with an older snapshot stop at its next REGION boundary — the current
    // region's chunk chain always finishes (an interrupted mid-image transfer is unprobed
    // firmware territory), remaining regions' messages are skipped and their content rolled
    // back so the next diff re-sends them.
    private var preemptSeq = 0
    // abort() epoch — see SendJob.epoch.
    private var epoch = 0

    // Image ack-gate. A sent image chunk parks its continuation here until its `e0-00` ack
    // (onImageAck) — or until abort() releases it (teardown/recovery; the watchdog is the external
    // supervisor, so a never-arriving ack can't wedge the pump). NO timeout (per the three rules).
    private var ackWaitMsgId: Int? = null
    private var ackWaitResume: ((Boolean) -> Unit)? = null
    // Is the parked message a LAYOUT frame (regionName == null)? preempt() may release ONLY
    // those (the wall-ignore wedge). Releasing a parked IMAGE chunk abandons a mid-image
    // transfer and the follow-up rebuild lands on the half-fed image — HARDWARE 2026-06-10 r4:
    // that CRASHED THE GLASSES OUTRIGHT (Main→Aria tap mid-tile-load).
    private var ackWaitIsLayout = false
    private var ackWaitSince = 0L            // when the current park was entered (grace/staleness checks)
    private var lastAckedMsgId: Int = -1     // most recent e0-00 ack msgId (handles ack-arrives-before-park)
    private var aborting = false             // set by FORCE abort (teardown); cleared by the next enqueueSend

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
        // Every page MUST contain a text region — image/list-only layouts ack but never
        // paint (and break the L-mirror): G2_BLE_PROTOCOL.md §7 rule 1. The OS path is
        // covered by the injected clock; this guards the harness/direct-renderer paths.
        if (texts.isEmpty())
            return "scene has no text region — image-only layouts ack but never paint (§7)"
        scene.regions.firstOrNull { it.name.toByteArray(Charsets.UTF_8).size > 16 }?.let {
            return "region name '${it.name}' exceeds the 16-byte f10 cap (§6.1)"
        }
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
        // Native-list caps: §6.1 proved exactly 20 items; >20 items or >64-char item
        // names are unprobed firmware territory — reject before any byte goes out.
        for (r in scene.listRegions()) {
            val c = scene.content[r.name] as? Content.ListItems ?: continue
            if (c.items.size > MAX_LIST_ITEMS)
                return "list '${r.name}' has ${c.items.size} items — SDK max is $MAX_LIST_ITEMS"
            // UTF-8 BYTES, not UTF-16 chars — the wire encodes UTF-8 and the firmware
            // caps were proven with ASCII; 40 three-byte glyphs are 120 wire bytes
            // (review 2026-06-11; mirrors the server's Buffer.byteLength clamp).
            c.items.firstOrNull { it.toByteArray(Charsets.UTF_8).size > MAX_LIST_ITEM_CHARS }?.let {
                return "list '${r.name}' item exceeds $MAX_LIST_ITEM_CHARS UTF-8 bytes: \"${it.take(70)}\""
            }
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
            val payload = DisplayProto.launchPayload(
                nextMsgId(), appToken,
                scene.textRegions().map { textContainer(scene, it) },
                scene.imageRegions().map { imageContainer(it) },
                scene.listRegions().map { listContainer(scene, it) },
            )
            if (payload.size > MAX_LAYOUT_PAYLOAD_BYTES) {
                diag("launch REJECTED — frame ${payload.size} B exceeds the ~$MAX_LAYOUT_PAYLOAD_BYTES B multi-packet wall (firmware ignores oversize frames)")
                onComplete(false); return
            }
            o += RenderMsg(DisplayProto.frame(nextSeq(), payload))
            o += imageContentOps(scene, scene.imageRegions().map { it.name })
            o
        } catch (e: Exception) {
            // Bad region content (wrong-size/garbage/corrupt image, list without items, …)
            // loud-fails gracefully instead of crashing the process — a corrupt BMP's
            // ArrayIndexOutOfBounds escaped the old IllegalArgumentException-only catch
            // (review 2026-06-11).
            diag("launch: bad region content — ${e::class.simpleName}: ${e.message}")
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
                val layoutMsgId = nextMsgId()
                val payload = DisplayProto.layoutPayload(
                    layoutMsgId,
                    scene.textRegions().map { textContainer(scene, it) },
                    scene.imageRegions().map { imageContainer(it) },
                    scene.listRegions().map { listContainer(scene, it) },
                )
                // The firmware SILENTLY IGNORES a single message past the multi-packet wall
                // (hardware 2026-06-10: a 7-packet/1.6 KB Mail rebuild never acked; the
                // official app never exceeds 4 packets ≈ 900 B). Reject loudly pre-wire.
                if (payload.size > MAX_LAYOUT_PAYLOAD_BYTES) {
                    // `current` is untouched at this point — the scene swap happens after
                    // the ops build, so a rejected scene leaves the prior state truthful.
                    diag("setScene REJECTED — layout frame ${payload.size} B exceeds the ~$MAX_LAYOUT_PAYLOAD_BYTES B multi-packet wall (firmware ignores oversize frames; trim list items/regions)")
                    onComplete(false); return
                }
                // Ack-gated like image chunks (the official app never overlaps ANY message
                // with its predecessor's ack, §9) — a missing f1=8 rebuild ack now parks
                // visibly (and preempt()/abort() release it) instead of silently lying.
                o += RenderMsg(DisplayProto.frame(nextSeq(), payload), ackMsgId = layoutMsgId)
                o += imageContentOps(scene, scene.imageRegions().map { it.name })
            } else {
                // Text before images: the cheap chrome updates (title/status/tabs, ~62 ms
                // each) land first instead of queueing behind a multi-second tile push.
                val changed = d.changedRegions.mapNotNull { name -> scene.content[name]?.let { name to it } }
                for ((name, c) in changed) if (c is Content.Text) o += textOp(scene.region(name)!!, c)
                for ((name, c) in changed) when (c) {
                    is Content.Image -> o += imageOps(scene.region(name)!!, c.bmp)
                    is Content.Text -> {}   // already emitted above
                    // Unreachable: Scene.diff reports any list change as layoutChanged
                    // (items ride the layout frame). Defensive diag, never silent.
                    is Content.ListItems -> diag("setScene: list '$name' changed without layoutChanged — diff bug?")
                }
            }
            o
        } catch (e: Exception) {
            // Exception (not just IAE): see launch() — corrupt-content AIOOBE must not crash.
            diag("setScene: bad region content — ${e::class.simpleName}: ${e.message}")
            onComplete(false); return
        }
        val prev2 = synchronized(lock) { current.also { current = scene } }
        enqueueSend(ops, "setScene(layout=${d.layoutChanged}, dirty=${d.changedRegions.size})", onComplete, sceneRef = scene, prevScene = prev2)
    }

    /** Request preemption of the in-flight render op (a NEWER scene supersedes it). The
     *  in-flight region's chunk chain ALWAYS completes — its image park resolves on the
     *  ~176 ms ack and the boundary check then skips the remaining regions. NEVER abandon a
     *  mid-image transfer: releasing an image park + rebuilding on the half-fed transfer
     *  CRASHED THE GLASSES (hardware 2026-06-10 r4).
     *
     *  A parked LAYOUT ack is released only when the park is OLDER than
     *  LAYOUT_PARK_GRACE_MS: every ack-gated layout frame parks for its normal
     *  ~40-160 ms ack window, and releasing those healthy parks made every fast
     *  antenna-scroll send a second f1=7 while the first's ack was outstanding —
     *  overlapping a predecessor's ack is unprobed firmware territory (§9; review
     *  2026-06-11). A park past the grace IS the wall-ignore wedge (ack never
     *  coming) — released + rolled back exactly as before. Rolled-back regions
     *  re-send via the superseding scene's diff. */
    fun preempt() {
        val resume = synchronized(lock) {
            preemptSeq++
            if (ackWaitResume != null && ackWaitIsLayout
                && clock() - ackWaitSince >= LAYOUT_PARK_GRACE_MS) {
                ackWaitMsgId = null
                ackWaitResume.also { ackWaitResume = null }
            } else null
        }
        resume?.invoke(false)
    }

    /** Mark a failing job's undelivered tail as NOT on the glasses, so the next diff
     *  re-sends it (no optimistic lies in [current] / the mirror). [fromIndex] = the first
     *  message whose delivery is unknown/failed. An undelivered LAYOUT frame rolls all the
     *  way back to the job's previous scene (the region set on glass never changed). */
    private fun failJob(job: SendJob, fromIndex: Int, reason: String) {
        if (job.sceneRef == null) return        // launch/single-op jobs: recovery owns these
        val undelivered = job.msgs.drop(fromIndex)
        if (undelivered.isEmpty()) return
        val names = undelivered.mapNotNull { it.regionName }.distinct()
        val layoutUndelivered = undelivered.any { it.regionName == null }
        synchronized(lock) {
            current = if (layoutUndelivered) job.prevScene else current?.withoutContent(names)
        }
        diag("render ${job.label}: $reason — rolled back ${if (layoutUndelivered) "to the previous scene (layout undelivered)" else "regions $names"}")
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
        val snap = synchronized(lock) { current }
        val region = snap?.region(name)
        if (snap == null || region == null || region.kind != RegionKind.TEXT) {
            diag("setText('$name'): no such text region (launched=${snap != null})")
            onComplete(false); return
        }
        // Build + wall-check BEFORE the content swap (review 2026-06-11b): the
        // old order updated `current` first, then textOp's wall `require` threw
        // uncaught into the caller's coroutine — the reject path itself
        // produced the permanent-silent-divergence the check exists to prevent
        // (current claimed delivery of a frame the firmware never saw).
        val probe = Content.Text(text, (snap.content[name] as? Content.Text)?.scroll ?: false, contentOffset, contentLength)
        val op = try {
            textOp(region, probe)
        } catch (e: Exception) {
            diag("setText('$name'): ${e::class.simpleName}: ${e.message}")
            onComplete(false); return
        }
        // Commit atomically against the CURRENT scene (not the snapshot): the
        // old read→build→write spanned two lock acquisitions, so a BLE-thread
        // failJob rollback in between was silently overwritten — the lost
        // rollback meant the failed regions never re-sent via diff until the
        // ~80 s renewal healed them (review 2026-06-11b).
        val committed = synchronized(lock) {
            val cur = current
            val r2 = cur?.region(name)
            if (cur == null || r2 == null || r2.kind != RegionKind.TEXT) {
                false
            } else {
                val scroll = (cur.content[name] as? Content.Text)?.scroll ?: false
                current = cur.withContent(name, Content.Text(text, scroll, contentOffset, contentLength))
                true
            }
        }
        if (!committed) {
            diag("setText('$name'): scene changed during build — dropped")
            onComplete(false); return
        }
        enqueueSend(listOf(op), "text:$name", onComplete)
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
        // The rollback sentinel is an internal "undelivered" marker — NEVER wire
        // material (it contains NUL bytes, unprobed on firmware). Renewal/
        // relaunch/display_reload all launch() the CURRENT scene, which can
        // legitimately hold the sentinel for a rolled-back scroll-text region;
        // push blank instead — the owner's next real update repaints it
        // (review 2026-06-11b; latent until a scroll-text f1=5 path ships).
        val text = c?.text?.takeUnless { it == Scene.ROLLED_BACK_SENTINEL } ?: ""
        return DisplayProto.textContainer(r.x, r.y, r.w, r.h, r.id, r.name, c?.scroll ?: false, text, r.style)
    }

    private fun imageContainer(r: Region): ByteArray =
        DisplayProto.imageContainer(r.x, r.y, r.w, r.h, r.id, r.name)

    private fun listContainer(scene: Scene, r: Region): ByteArray {
        val c = scene.content[r.name] as? Content.ListItems
            ?: throw IllegalArgumentException("list region '${r.name}' declared without ListItems content (items ride the layout frame)")
        return DisplayProto.listContainer(r.x, r.y, r.w, r.h, r.id, r.name,
            c.items, c.itemWidth, c.selectBorder, c.eventCapture, r.style)
    }

    private fun textOp(r: Region, c: Content.Text): RenderMsg {
        val payload = DisplayProto.textPayload(nextMsgId(), r.id, r.name, c.text, c.contentOffset, c.contentLength)
        // The wall applies to EVERY e0-20 message, not just layout frames — an oversize
        // f1=5 was silently eaten by firmware, marked delivered in `current`, and never
        // re-sent by any diff: permanent silent divergence (review 2026-06-11).
        require(payload.size <= MAX_LAYOUT_PAYLOAD_BYTES) {
            "text update '${r.name}' ${payload.size} B exceeds the ~$MAX_LAYOUT_PAYLOAD_BYTES B multi-packet wall (paginate/trim server-side)"
        }
        return RenderMsg(DisplayProto.frame(nextSeq(), payload), regionName = r.name)
    }

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
                regionName = r.name,
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
    private fun sendOps(job: SendJob) {
        if (job.msgs.isEmpty()) { job.onComplete(true); return }
        diag("render ${job.label}: ${job.msgs.size} messages / ${job.msgs.sumOf { it.packets.size }} packets (discrete, keepalive-interleavable)")
        sendMessage(job, 0)
    }

    private fun sendMessage(job: SendJob, i: Int) {
        val msgs = job.msgs
        val label = job.label
        if (i >= msgs.size) { job.onComplete(true); return }
        // Fences (preempt()/abort()): a superseding scene or an abort wants the BLE queue.
        // Checks happen only at a REGION boundary: the in-flight region's chunk chain
        // finishes first (an interrupted mid-image transfer is unprobed firmware
        // territory). Preemption skips only per-region CONTENT messages of scene jobs;
        // an abort fence (stale epoch) additionally stops BEFORE an unsent layout frame.
        // Skipped regions roll back from `current` BEFORE onComplete fires, so the
        // superseding setScene's diff (computed after this completes) re-sends them.
        if (i > 0) {
            val msg = msgs[i]
            val atBoundary = msg.regionName == null || msg.regionName != msgs[i - 1].regionName
            val (stale, preempted) = synchronized(lock) {
                (job.epoch != epoch) to (preemptSeq > job.preemptSnap && job.sceneRef != null)
            }
            if (atBoundary && stale) {
                failJob(job, i, "ABORTED at msg ${i + 1}/${msgs.size}")
                job.onComplete(false)
                return
            }
            if (preempted && msg.regionName != null && msg.regionName != msgs[i - 1].regionName) {
                failJob(job, i, "PREEMPTED at msg ${i + 1}/${msgs.size}")
                job.onComplete(false)
                return
            }
        }
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
                failJob(job, i, "write failed at msg ${i + 1}")
                job.onComplete(false)
                return@write
            }
            val ackId = msg.ackMsgId
            if (ackId == null) {
                sendMessage(job, i + 1)
            } else {
                // Ack-gate: hold the next message until this one's e0-00 ack — released
                // early by abort() (teardown/recovery) or, for LAYOUT frames only, by
                // preempt() (the wall-ignore wedge). Image parks are never force-released
                // (abandoning a mid-image transfer crashed the glasses — 2026-06-10 r4).
                awaitImageAck(ackId, isLayout = msg.regionName == null) { acked ->
                    if (acked) sendMessage(job, i + 1)
                    else {
                        diag("render $label#${i + 1}: ack-wait released (abort/preempt) — stopping")
                        failJob(job, i, "ack never arrived for msg ${i + 1}")
                        job.onComplete(false)
                    }
                }
            }
        }
    }

    /** Serialize full render ops: only one op's messages sit on the BLE queue at a time, so a
     *  clock tick / renewal / server render can't interleave its AA writes into another op's. */
    private fun enqueueSend(
        msgs: List<RenderMsg>, label: String, onComplete: (Boolean) -> Unit,
        sceneRef: Scene? = null, prevScene: Scene? = null,
    ) {
        synchronized(lock) {
            aborting = false                       // a fresh op means we're live again (post-recovery)
            sendQueue.addLast(SendJob(msgs, label, onComplete, sceneRef, prevScene, epoch, preemptSeq))
            if (sending) return
            sending = true
        }
        pumpNext()
    }

    private fun pumpNext() {
        val job = synchronized(lock) {
            if (sendQueue.isEmpty()) { sending = false; null } else sendQueue.removeFirst()
        } ?: return
        // (No flag reset here — preempt/abort fencing is per-job via epoch/preemptSnap.)
        val wrapped = SendJob(job.msgs, job.label, { ok ->
            job.onComplete(ok)
            pumpNext()
        }, job.sceneRef, job.prevScene, job.epoch, job.preemptSnap)
        sendOps(wrapped)
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

    /** Stop current work and drop queued ops — display_reload recovery and teardown.
     *
     *  Review 2026-06-11 (two finders each): (1) cleared queue jobs MUST fire their
     *  onComplete(false) — the render pump awaits exactly that callback, and dropping it
     *  wedged server mode permanently after a Reload that raced a queued scene; their
     *  rollback runs newest-first so `current` unwinds truthfully. (2) a HEALTHY parked
     *  image chunk (normal ~176 ms ack window) is NOT released on a live link — releasing
     *  it abandons the chunk chain mid-image and the follow-up COLD_INIT rebuild lands on
     *  the half-fed transfer: the exact r4 glasses-crash recipe, triggered by the very
     *  Reload the user presses when a multi-second image push feels stuck. The epoch
     *  fence stops the in-flight job at its next REGION boundary instead. A park older
     *  than IMAGE_PARK_STALE_MS is the genuine wedge (ack never coming) and is released
     *  exactly as before. [force] (teardown — the BLE session dies right after) releases
     *  everything unconditionally. */
    fun abort(reason: String, force: Boolean = false) {
        var dropped: List<SendJob> = emptyList()
        var keptParkAgeMs = -1L
        val resume = synchronized(lock) {
            epoch++
            if (force) aborting = true
            dropped = sendQueue.toList()
            sendQueue.clear()
            val parkAge = clock() - ackWaitSince
            if (ackWaitResume != null && (force || ackWaitIsLayout || parkAge >= IMAGE_PARK_STALE_MS)) {
                ackWaitMsgId = null
                ackWaitResume.also { ackWaitResume = null }
            } else {
                if (ackWaitResume != null) keptParkAgeMs = parkAge
                null
            }
        }
        // Newest-first so each rollback lands on the scene the PREVIOUS job had installed.
        for (job in dropped.asReversed()) {
            failJob(job, 0, "aborted ($reason)")
            job.onComplete(false)
        }
        if (dropped.isNotEmpty()) diag("renderer abort ($reason): dropped ${dropped.size} queued op(s)")
        if (resume != null) diag("renderer abort ($reason): releasing parked send")
        if (keptParkAgeMs >= 0) diag("renderer abort ($reason): image park only ${keptParkAgeMs}ms old — letting its region finish (epoch fence stops the job at the boundary)")
        resume?.invoke(false)
    }

    /** Park [resume] until the [msgId] ack arrives (→ resume(true)) or abort() fires (→ resume(false));
     *  [isLayout] parks may additionally be released by preempt() (wall-ignore unstick).
     *  Resolves immediately if the ack already arrived (race) or an abort is in progress. */
    private fun awaitImageAck(msgId: Int, isLayout: Boolean = false, resume: (Boolean) -> Unit) {
        var fire: Boolean? = null
        synchronized(lock) {
            when {
                aborting -> fire = false                   // teardown underway → don't park, fail fast
                // NOTE (review 2026-06-11b): msgId is mod-256 and lastAckedMsgId is
                // never invalidated, so this immediate-release is theoretically
                // aliasable by an ack from ≥256 messages earlier. Unreachable with
                // real traffic (keepalive acks refresh lastAcked every ~4 s; chunk
                // msgIds are minted at build and sent within seconds) — documented
                // rather than changed: this machinery is hardware-frozen.
                lastAckedMsgId == msgId -> fire = true      // ack already arrived → proceed now
                else -> { ackWaitMsgId = msgId; ackWaitResume = resume; ackWaitIsLayout = isLayout; ackWaitSince = clock() }
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
        const val MAX_LIST_ITEMS = 20           // SDK list cap (§6.1 proved exactly 20)
        const val MAX_LIST_ITEM_CHARS = 64      // SDK item-name cap (MAX_ITEM_NAME_LENGTH)
        /** Single-message multi-packet wall: the firmware SILENTLY ignores one e0-20
         *  message past ~4-5 AA packets. Hardware 2026-06-10: a 7-packet (~1.6 KB) Mail
         *  rebuild never acked (link alive, keepalives fine); official app max observed =
         *  4 packets ≈ 900 B; the 83-entry directory list hung the HUD the same way
         *  (g2code era). 1000 B ≈ 5 packets — conservative middle; tune on hardware. */
        const val MAX_LAYOUT_PAYLOAD_BYTES = 1000
        const val MAX_IMAGE_W = 288             // proven-safe per-region size; a region ≥384×192 drops the BLE link
        const val MAX_IMAGE_H = 129
        /** preempt() releases a parked LAYOUT ack only past this age — younger parks are
         *  the normal 40-160 ms ack window (overlapping them is unprobed); older = the
         *  wall-ignore wedge. */
        const val LAYOUT_PARK_GRACE_MS = 500L
        /** abort() (non-force) releases a parked IMAGE chunk only past this age — younger
         *  parks are healthy mid-push (release = the r4 crash recipe); older = wedged.
         *  8 s (was 3 s — review 2026-06-11b): the ConnectionService watchdog comment
         *  records an EMPIRICAL "~6 s heavy-render ack pause" (its own threshold is
         *  tuned above it), so a 3 s stale release could classify a healthy park as
         *  wedged during a heavy push + Reload — and COLD_INIT on a live chunk chain
         *  IS the r4 crash recipe. Kept above the observed pause; a genuine wedge now
         *  waits ~8 s for its Reload release (slower unstick, zero crash risk). */
        const val IMAGE_PARK_STALE_MS = 8_000L
        const val FRAGMENT_PACE_MS = 12L    // between AA fragments WITHIN one message (chunk)
        const val INTER_MESSAGE_PACE_MS = 100L  // after a NON-ack-gated message (text/layout) — keepalive interleaves here
        // After an image chunk, before its ack-gate. Just a small floor — the real inter-chunk gap
        // is the e0-00 ack (so it self-adapts to link speed). The knob the hat pacing sweep tunes
        // toward the glasses' true ingestion ceiling once the link is rock-solid (HAT_BRIDGE_SPEC.md §13).
        const val IMAGE_INTER_CHUNK_FLOOR_MS = 12L
    }
}
