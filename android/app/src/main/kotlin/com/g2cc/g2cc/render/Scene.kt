package com.g2cc.g2cc.render

/** The G2 display surface: 576×288 px, 4-bit grayscale. (Decoded from capture U=19.) */
object Display {
    const val WIDTH = 576
    const val HEIGHT = 288
}

enum class RegionKind { TEXT, IMAGE, LIST }

/**
 * Container border/padding styling — wire fields f5–f8 of the official container schema
 * (docs/G2_BLE_PROTOCOL.md §6.1). All-zero ([NONE]) emits nothing on the wire, keeping
 * unstyled regions byte-identical to the proven lean schema.
 */
data class RegionStyle(
    val borderWidth: Int = 0,   // 0–5
    val borderColor: Int = 0,   // 0–15 gray
    val borderRadius: Int = 0,  // 0–10
    val padding: Int = 0,       // 0–32
) {
    init {
        require(borderWidth in 0..5) { "borderWidth $borderWidth out of 0..5" }
        require(borderColor in 0..15) { "borderColor $borderColor out of 0..15" }
        require(borderRadius in 0..10) { "borderRadius $borderRadius out of 0..10" }
        require(padding in 0..32) { "padding $padding out of 0..32" }
    }
    val isNone get() = this == NONE
    companion object { val NONE = RegionStyle() }
}

/**
 * A named, positioned region on the display. [id] is the firmware container id (echoed back
 * in input-selection events); [name] is the stable handle used to target content updates.
 */
data class Region(
    val id: Int,
    val name: String,
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int,
    val kind: RegionKind,
    val style: RegionStyle = RegionStyle.NONE,
) {
    init {
        require(id > 0) { "Region id must be > 0 (got $id for '$name')" }
        require(name.isNotEmpty()) { "Region name must be non-empty" }
        require(w > 0 && h > 0) { "Region '$name' has non-positive size ${w}x$h" }
    }
    val right get() = x + w
    val bottom get() = y + h
}

/** Content bound to a region. */
sealed interface Content {
    data class Text(
        val text: String,
        val scroll: Boolean = false,
        // Partial in-place text replace (f1=5 wire f3/f4). Confirmed from the g2cap UPGRADE
        // capture as the SDK's textContainerUpgrade(contentOffset, contentLength) — NOT a scroll
        // position (the old "scrollOffset/contentHeight" labels were wrong; docs/G2_BLE_PROTOCOL.md
        // §6.3). null/null = full replace.
        val contentOffset: Int? = null,
        val contentLength: Int? = null,
    ) : Content

    /** A pre-encoded 4bpp gray BMP sized to the region's WxH (build via Rasterizer/Gray4Bmp). */
    class Image(val bmp: ByteArray) : Content {
        override fun equals(other: Any?) = other is Image && bmp.contentEquals(other.bmp)
        override fun hashCode() = bmp.contentHashCode()
    }

    /** Native firmware list rows (docs/G2_BLE_PROTOCOL.md §6.1 itemContainer). Items ride the
     *  LAYOUT frame — the wire has no list content-update message — so [Scene.diff] reports any
     *  items/flags change as a layout change (f1=7 rebuild). [eventCapture] marks this list as
     *  the page's single input region (wire f12); the firmware then draws the selection ring
     *  ([selectBorder]) and reports the tapped index as a hub_select event. */
    data class ListItems(
        val items: List<String>,
        val itemWidth: Int = 0,          // 0 = auto (wire itemContainer f2)
        val selectBorder: Boolean = true,
        val eventCapture: Boolean = false,
    ) : Content {
        init {
            require(items.isNotEmpty()) { "ListItems requires at least one item" }
        }
    }
}

/**
 * An immutable snapshot of the whole screen: the set of regions plus each region's current
 * content. Validated on construction (bounds, unique ids/names, content-kind match) so a
 * malformed UI fails loudly at build time rather than rendering wrong.
 */
class Scene(
    val regions: List<Region>,
    val content: Map<String, Content> = emptyMap(),
) {
    init {
        val names = regions.map { it.name }
        require(names.toSet().size == names.size) { "duplicate region names: $names" }
        val ids = regions.map { it.id }
        require(ids.toSet().size == ids.size) { "duplicate region ids: $ids" }
        val byName = regions.associateBy { it.name }
        for (r in regions) {
            require(r.x >= 0 && r.y >= 0 && r.right <= Display.WIDTH && r.bottom <= Display.HEIGHT) {
                "region '${r.name}' [${r.x},${r.y},${r.w},${r.h}] is out of ${Display.WIDTH}x${Display.HEIGHT} bounds"
            }
        }
        for ((name, c) in content) {
            val r = byName[name] ?: throw IllegalArgumentException("content for unknown region '$name'")
            when (c) {
                is Content.Text -> require(r.kind == RegionKind.TEXT) { "text content on non-text region '$name'" }
                is Content.Image -> require(r.kind == RegionKind.IMAGE) { "image content on non-image region '$name'" }
                is Content.ListItems -> require(r.kind == RegionKind.LIST) { "list content on non-list region '$name'" }
            }
        }
    }

    fun region(name: String): Region? = regions.firstOrNull { it.name == name }
    fun textRegions(): List<Region> = regions.filter { it.kind == RegionKind.TEXT }
    fun imageRegions(): List<Region> = regions.filter { it.kind == RegionKind.IMAGE }
    fun listRegions(): List<Region> = regions.filter { it.kind == RegionKind.LIST }

    /** Same regions (id/name/geometry/kind, in order) as [other]? If not, the layout frame
     *  must be re-pushed; if so, only changed region CONTENT needs sending. */
    fun sameLayoutAs(other: Scene?): Boolean = other != null && regions == other.regions

    /** Diff against the previously-rendered scene → what must be sent to the glasses.
     *
     *  A text region's `scroll` flag is a CONTAINER property (carried only in the launch/layout
     *  frame, not in an f1=5 text-update), so a scroll-flag change forces a layout re-push
     *  rather than a content update. Content present in [prev] but ABSENT now is reported in
     *  [SceneDiff.removedRegions] — clearing a region by key-removal is not auto-pushed (set
     *  blank content to clear); the renderer warns loudly if it sees one rather than silently
     *  leaving stale content on the glasses. */
    fun diff(prev: Scene?): SceneDiff {
        val layoutChanged = !sameLayoutAs(prev) || scrollFlagChanged(prev) || listContentChanged(prev)
        val changed = ArrayList<String>()
        val removed = ArrayList<String>()
        for (r in regions) {
            val now = content[r.name]
            val before = prev?.content?.get(r.name)
            when {
                now != null && (layoutChanged || now != before) -> changed += r.name
                now == null && before != null && !layoutChanged -> removed += r.name
            }
        }
        return SceneDiff(layoutChanged, changed, removed)
    }

    /** A text region's scroll flag (f11) differs from the previous scene — needs a layout re-push. */
    private fun scrollFlagChanged(prev: Scene?): Boolean {
        if (prev == null) return false
        for (r in regions) {
            if (r.kind != RegionKind.TEXT) continue
            val now = (content[r.name] as? Content.Text)?.scroll ?: false
            val before = (prev.content[r.name] as? Content.Text)?.scroll ?: false
            if (now != before) return true
        }
        return false
    }

    /** List items/flags ride the LAYOUT frame (no list content-update exists on the wire), so
     *  any list-content change forces an f1=7 rebuild. */
    private fun listContentChanged(prev: Scene?): Boolean {
        if (prev == null) return false
        for (r in regions) {
            if (r.kind != RegionKind.LIST) continue
            if (content[r.name] != prev.content[r.name]) return true
        }
        return false
    }

    fun withContent(name: String, c: Content): Scene =
        Scene(regions, content.toMutableMap().apply { put(name, c) })

    /** Same regions with [names]' content rolled back: a region whose push was skipped must
     *  read as never-delivered so the next diff re-sends it. A scroll=true TEXT region keeps
     *  a flag-preserving sentinel instead of full removal — the scroll flag is LAYOUT-level
     *  and still true on glass; removing it made the next diff read scroll false→true and
     *  force a spurious full f1=7 rebuild (and setText silently downgraded the stored flag)
     *  (review 2026-06-11). The sentinel text never equals real content, so re-send still
     *  happens. */
    fun withoutContent(names: Collection<String>): Scene =
        if (names.isEmpty()) this
        else Scene(regions, content.toMutableMap().apply {
            for (n in names) {
                val prev = get(n)
                if (prev is Content.Text && prev.scroll) put(n, Content.Text(ROLLED_BACK_SENTINEL, scroll = true))
                else remove(n)
            }
        })

    companion object {
        /** Never-matching placeholder for rolled-back scroll-text content. */
        const val ROLLED_BACK_SENTINEL = "\u0000<rolled-back>\u0000"
    }
}

/** Result of [Scene.diff]: layout change, which region contents changed, and which regions had
 *  their content removed (same layout) — the renderer warns on the last rather than dropping it. */
data class SceneDiff(
    val layoutChanged: Boolean,
    val changedRegions: List<String>,
    val removedRegions: List<String> = emptyList(),
)

/** Ergonomic builder so callers can declare UIs declaratively (auto-assigns region ids). */
class SceneBuilder {
    private val regions = ArrayList<Region>()
    private val content = HashMap<String, Content>()
    private var nextId = 1

    fun text(
        name: String, x: Int, y: Int, w: Int, h: Int,
        text: String = "", scroll: Boolean = false, id: Int? = null,
        style: RegionStyle = RegionStyle.NONE,
    ): SceneBuilder {
        regions += Region(id ?: nextId++, name, x, y, w, h, RegionKind.TEXT, style)
        content[name] = Content.Text(text, scroll)
        return this
    }

    fun image(
        name: String, x: Int, y: Int, w: Int, h: Int,
        bmp: ByteArray? = null, id: Int? = null,
    ): SceneBuilder {
        regions += Region(id ?: nextId++, name, x, y, w, h, RegionKind.IMAGE)
        if (bmp != null) content[name] = Content.Image(bmp)
        return this
    }

    fun list(
        name: String, x: Int, y: Int, w: Int, h: Int,
        items: List<String>, itemWidth: Int = 0, selectBorder: Boolean = true,
        eventCapture: Boolean = false, id: Int? = null,
        style: RegionStyle = RegionStyle.NONE,
    ): SceneBuilder {
        regions += Region(id ?: nextId++, name, x, y, w, h, RegionKind.LIST, style)
        content[name] = Content.ListItems(items, itemWidth, selectBorder, eventCapture)
        return this
    }

    fun build(): Scene = Scene(regions, content)
}

/** DSL entry point: `scene { text(...); image(...) }`. */
fun scene(block: SceneBuilder.() -> Unit): Scene = SceneBuilder().apply(block).build()
