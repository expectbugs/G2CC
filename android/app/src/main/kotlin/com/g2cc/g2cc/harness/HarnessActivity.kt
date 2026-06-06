package com.g2cc.g2cc.harness

import android.Manifest
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.g2cc.g2cc.BuildConfig
import com.g2cc.g2cc.ble.BleScanner
import com.g2cc.g2cc.ble.ConnectionState
import com.g2cc.g2cc.ble.EvenHub
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.G2Constants
import com.g2cc.g2cc.ble.G2Frame
import com.g2cc.g2cc.ble.Side
import com.g2cc.g2cc.ble.Varint
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager
import com.g2cc.g2cc.net.ServerMessage
import com.g2cc.g2cc.net.WireScene
import com.g2cc.g2cc.os.OsLayout
import com.g2cc.g2cc.os.SceneCodec
import com.g2cc.g2cc.render.BleDisplaySink
import com.g2cc.g2cc.render.DisplayProto
import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.G2Renderer
import com.g2cc.g2cc.render.Scene
import com.g2cc.g2cc.render.scene
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.OkHttpClient
import kotlin.coroutines.resume

/**
 * Standalone display-renderer test harness — no foreground service, no setup, no probe app.
 * Three buttons + a Diag checkbox + a pixel-perfect "expected" mirror.
 *
 *  - **Connect**: scan the G2 pair → connect + auth both lenses → cold-launch the Hub session
 *    (DocuLens hijack) with a text splash → start the 4 s keepalive.
 *  - **Test Display**: run [DisplayTestSequence] — exercises every renderer capability.
 *  - **Disconnect**: stop keepalive + tear down BLE.
 *  - **Diag**: stream deep verbose diagnostics for everything (BLE state, link params, every
 *    render op + write result, ring input, errors, test steps) to the server's /diag log.
 *
 * Token + Tailscale server are baked in via BuildConfig (gitignored). Display writes go to the
 * R lens (firmware mirrors R→L). Implements [TestHarness] for the sequence.
 */
class HarnessActivity : AppCompatActivity(), TestHarness {

    private lateinit var statusText: TextView
    private lateinit var connectBtn: Button
    private lateinit var testBtn: Button
    private lateinit var disconnectBtn: Button
    private lateinit var serverBtn: Button
    private lateinit var diagCheck: CheckBox
    private lateinit var boundsCheck: CheckBox
    private lateinit var mirror: ImageView

    private var scanner: BleScanner? = null
    private var left: G2BleClient? = null
    private var right: G2BleClient? = null
    private var renderer: G2Renderer? = null
    private val stateJobs = mutableListOf<Job>()
    private var keepaliveJob: Job? = null
    private var clockJob: Job? = null
    private var renderConsumerJob: Job? = null       // single serialized consumer of server-pushed scenes
    private var sceneCh: Channel<WireScene>? = null   // CONFLATED → latest scene wins (no scroll-render pileup/interleave)
    private var syncJob: Job? = null          // 80-00 sync_trigger keepalive (both lenses)
    private var watchdogJob: Job? = null      // glasses-response gap watchdog (silent-drop detector)
    private var renewalJob: Job? = null       // periodic re-takeover (the ~120s app-slot lifetime)
    private var coldLaunchJob: Job? = null    // the cold-launch coroutine — tracked so teardown cancels it
    private var testJob: Job? = null          // the Test Display sequence coroutine — tracked for teardown
    private var sessionGen = 0                // bumped on teardown; a stale coroutine re-checks it before mutating
    private var recovering = false            // auto-recovery in progress (guard against re-trigger)
    private var wasServerMode = false         // re-enter server mode after a recovery
    @Volatile private var lastRecoverMs = 0L  // rate-limit auto-recoveries (no thrashing)
    @Volatile private var lastNotifyMs = 0L   // last notify (incl e0-00 ack) from R lens
    private var syncSeq = 0x10
    private var syncMsgId = 0x20
    private var launched = false
    private var connecting = false

    // Glasses-OS "Server Mode": once the glasses are up, open a WS to the PC and
    // let the server drive the display via render/input.
    private var connection: ConnectionManager? = null
    private var serverMode = false

    // Latest HH:MM:SS — ticked into the app-owned clock region every second and
    // reused whenever a server scene is (re)built so the clock is never blank.
    private var latestClockText = OsLayout.clockText()
    private fun nowClock(): String { latestClockText = OsLayout.clockText(); return latestClockText }

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        if (grants.values.all { it }) onConnect()
        else setStatus("Permissions denied: ${grants.filterValues { !it }.keys.joinToString()}")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        DiagLog.start(lifecycleScope)
        DiagLog.log("app", "harness onCreate — server ${BuildConfig.SERVER_HOST}:${BuildConfig.SERVER_PORT}, token=${if (BuildConfig.AUTH_TOKEN.isEmpty()) "MISSING" else "set"}")
        diagCheck.setOnCheckedChangeListener { _, c ->
            DiagLog.enabled = c
            DiagLog.log("ui", "Diag streaming ${if (c) "ON" else "OFF"}")
        }
        boundsCheck.setOnCheckedChangeListener { _, _ -> updateMirror(renderer?.currentScene) }
        connectBtn.setOnClickListener { DiagLog.log("btn", "Connect tapped"); onConnect() }
        testBtn.setOnClickListener { DiagLog.log("btn", "Test tapped"); onTest() }
        serverBtn.setOnClickListener { DiagLog.log("btn", "Server tapped"); onServerMode() }
        disconnectBtn.setOnClickListener { DiagLog.log("btn", "Disconnect tapped (MANUAL)"); onDisconnect() }
        updateButtons()
        updateMirror(null)
    }

    override fun onDestroy() {
        teardown()
        DiagLog.stop()
        super.onDestroy()
    }

    // ----------------------------------------------------------------- UI

    private fun buildUi(): ViewGroup {
        val pad = (resources.displayMetrics.density * 12).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.parseColor("#101014"))
        }
        statusText = TextView(this).apply {
            text = "Disconnected"
            setTextColor(Color.WHITE)
            textSize = 15f
        }
        val statusScroll = ScrollView(this).apply {
            addView(statusText)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (resources.displayMetrics.density * 56).toInt())
        }
        root.addView(statusScroll)

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        connectBtn = Button(this).apply { text = "Connect" }
        testBtn = Button(this).apply { text = "Test" }
        serverBtn = Button(this).apply { text = "Server" }
        disconnectBtn = Button(this).apply { text = "Disconnect" }
        val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        row.addView(connectBtn, lp); row.addView(testBtn, lp); row.addView(serverBtn, lp); row.addView(disconnectBtn, lp)
        root.addView(row)

        diagCheck = CheckBox(this).apply {
            text = "Diag — stream verbose diagnostics to server log"
            setTextColor(Color.WHITE)
        }
        root.addView(diagCheck)

        boundsCheck = CheckBox(this).apply {
            text = "Region bounds — outline regions in the mirror (debug; the glasses show none)"
            setTextColor(Color.WHITE)
        }
        root.addView(boundsCheck)

        val label = TextView(this).apply {
            text = "Expected (what the glasses should show) — 576×288:"
            setTextColor(Color.LTGRAY)
            textSize = 12f
            setPadding(0, pad, 0, pad / 2)
        }
        root.addView(label)

        mirror = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            setBackgroundColor(Color.BLACK)
            adjustViewBounds = true
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        root.addView(mirror)
        return root
    }

    private fun setStatus(s: String) {
        statusText.text = s
    }

    private fun updateButtons() {
        connectBtn.isEnabled = !launched && !connecting
        testBtn.isEnabled = launched && !serverMode
        serverBtn.isEnabled = launched && !serverMode
        disconnectBtn.isEnabled = launched || connecting
    }

    private fun updateMirror(s: Scene?) {
        mirror.setImageBitmap(ExpectedMirror.render(s, boundsCheck.isChecked))
    }

    // ----------------------------------------------------------------- connect

    private fun onConnect() {
        if (launched || connecting) return
        val missing = missingPermissions()
        if (missing.isNotEmpty()) {
            DiagLog.log("perm", "requesting ${missing.joinToString()}")
            permLauncher.launch(missing.toTypedArray())
            return
        }
        connecting = true
        updateButtons()
        setStatus("Scanning for Even G2…")
        DiagLog.log("conn", "scan start")
        val sc = BleScanner(this)
        scanner = sc
        sc.start { ev -> runOnUiThread { onScanResult(ev) } }
    }

    private fun onScanResult(ev: BleScanner.Event) {
        when (ev) {
            is BleScanner.Event.FoundPair -> {
                DiagLog.log("conn", "found pair L=${ev.left.address} R=${ev.right.address}")
                val lc = G2BleClient(applicationContext, Side.Left)
                val rc = G2BleClient(applicationContext, Side.Right)
                left = lc; right = rc
                observe(lc, Side.Left)
                observe(rc, Side.Right)
                setStatus("Connecting + authenticating both lenses…")
                lc.connectTo(ev.left)
                rc.connectTo(ev.right)
            }
            is BleScanner.Event.Failure -> {
                DiagLog.log("conn", "scan FAILED: ${ev.reason}")
                setStatus("Scan failed: ${ev.reason}")
                connecting = false
                updateButtons()
            }
        }
    }

    private fun observe(client: G2BleClient, side: Side) {
        stateJobs += lifecycleScope.launch {
            client.state.collect { st ->
                DiagLog.log("ble", "$side → ${st::class.simpleName}${stateDetail(st)}")
                if (st is ConnectionState.Ready) maybeColdLaunch()
                if (st is ConnectionState.Error) setStatus("$side error: ${st.message}")
            }
        }
        stateJobs += lifecycleScope.launch {
            client.events.collect { ev ->
                if (side == Side.Right) lastNotifyMs = System.currentTimeMillis()  // liveness for the watchdog
                DiagLog.log("input", "$side $ev")
                // Forward ring input to the PC when the server is driving the display.
                // Input arrives on the R lens (EventParser service 0x01-01 / e0-01).
                if (serverMode && side == Side.Right) {
                    SceneCodec.toInput(ev)?.let { input ->
                        val sent = connection?.send(input) ?: false
                        DiagLog.log("os", "input $ev → ${if (sent) "sent" else "DROPPED"}")
                    }
                }
            }
        }
    }

    private fun stateDetail(st: ConnectionState): String = when (st) {
        is ConnectionState.Error -> " (${st.message})"
        is ConnectionState.Disconnected -> " (${st.reason})"
        else -> ""
    }

    private fun maybeColdLaunch() {
        if (launched) return
        val l = left ?: return
        val r = right ?: return
        if (l.state.value !is ConnectionState.Ready || r.state.value !is ConnectionState.Ready) return
        launched = true
        DiagLog.log("conn", "both lenses Ready — R link mtu=${r.lastMtu} phy=${r.lastPhy} conn=${r.lastConnParams}")
        val rend = G2Renderer(BleDisplaySink(r)) { msg -> DiagLog.log("render", msg) }
        renderer = rend
        val gen = sessionGen
        coldLaunchJob = lifecycleScope.launch {
            setStatus("Cold-launching Hub session…")
            val splash = scene {
                text("clock", OsLayout.CLOCK_X, OsLayout.CLOCK_Y, OsLayout.CLOCK_WIDTH, OsLayout.CLOCK_HEIGHT,
                    nowClock(), scroll = false, id = OsLayout.CLOCK_ID)
                text("main", 0, OsLayout.CONTENT_Y, Display.WIDTH, OsLayout.CONTENT_HEIGHT,
                    "G2 OS v${OsLayout.OS_VERSION}\n\nConnected.\n\nTap  Test  for the renderer test,\nor  Server  to let the PC drive\nthe display.", scroll = false, id = 2)
            }
            val ok = awaitLaunch(rend, splash)
            // Bail if teardown ran while we were launching — don't re-arm jobs or set launched
            // against a torn-down session (that stale completion used to leave recovery stalled).
            if (gen != sessionGen) { DiagLog.log("conn", "cold-launch result ignored — session torn down"); return@launch }
            if (ok) {
                DiagLog.log("conn", "cold-launch OK")
                setStatus("Connected. Tap Test Display.")
                startKeepalive()
                startClock()
                startSyncTrigger()
                startWatchdog()
                startRenewal()
                updateMirror(rend.currentScene)
                if (recovering) {
                    recovering = false
                    DiagLog.log("recover", "reconnect + cold-launch OK after silent drop")
                    if (wasServerMode) { wasServerMode = false; onServerMode() }
                }
            } else {
                // Reset so the dead-end can't permanently block recovery: launched stuck true →
                // onConnect's `if (launched) return` blocked all future reconnects, and the watchdog
                // never started. Clearing it re-enables Connect + lets the next BLE-ready retry.
                DiagLog.log("conn", "cold-launch FAILED — resetting (launched=false) so a reconnect can retry")
                launched = false
                connecting = false
                if (recovering) { recovering = false; wasServerMode = false }
                setStatus("Cold-launch failed — see Diag log. Will retry on next reconnect.")
            }
            updateButtons()
        }
    }

    private fun startKeepalive() {
        keepaliveJob?.cancel()
        keepaliveJob = lifecycleScope.launch {
            while (isActive) {
                delay(4000)                              // session keepalive cadence (pacing)
                val r = right ?: break
                val rend = renderer ?: break
                r.sendPacket(rend.keepaliveFrame(), "HB:f1=12") { ok ->
                    DiagLog.log("hb", "keepalive write=${if (ok) "OK" else "FAIL"}")
                }
            }
        }
    }

    private fun nextSyncTrigger(): ByteArray {
        // sync_trigger: service 0x80-00, type 14 — payload `08 0E 10 <msgId-varint> 6A 00`.
        // Verbatim from the native Chess BTSnoop. This is a SESSION keepalive packet, NOT
        // teleprompter display mode (06-20, the input-swallowing path we rejected). Inlined
        // here so there's zero coupling to the teleprompter code.
        val payload = byteArrayOf(0x08, 0x0E, 0x10) + Varint.encode(syncMsgId) + byteArrayOf(0x6A, 0x00)
        val f = G2Frame.command(syncSeq, G2Constants.Services.AUTH_CONTROL, payload)
        syncSeq = if (syncSeq >= 0xFF) 0x10 else syncSeq + 1
        syncMsgId = (syncMsgId + 1) and 0xFF        // 1-byte wrap (same constraint as G2Renderer.nextMsgId)
        return f
    }

    /** The session-extend keepalive we were MISSING: sync_trigger (service 80-00, type 14)
     *  to BOTH lenses every ~15 s, staggered ~2 s — exactly as native Chess does (BTSnoop
     *  /tmp/g2cc-btsnoop5). We previously sent only the e0-20 f1=12 (R lens); the glasses use
     *  this 80-00 packet for their session-extend logic, so without it they reclaim our app. */
    private fun startSyncTrigger() {
        syncJob?.cancel()
        syncJob = lifecycleScope.launch {
            while (isActive) {
                delay(13000)
                left?.sendPacket(nextSyncTrigger(), "SYNC:80-00:L") { ok -> DiagLog.log("sync", "L write=${if (ok) "OK" else "FAIL"}") }
                delay(2000)                                  // L→R stagger ~2s (Chess pattern)
                right?.sendPacket(nextSyncTrigger(), "SYNC:80-00:R") { ok -> DiagLog.log("sync", "R write=${if (ok) "OK" else "FAIL"}") }
            }
        }
    }

    /** Glasses-response watchdog. The glasses ack our writes (~1/s on e0-00). If those
     *  responses STOP while we keep writing, the EvenHub app slot was likely SILENTLY dropped
     *  (link stays up, no BLE event). Log it loudly with timing — this is the detector for the
     *  silent app-drop (and the hook future auto-recovery will trigger on). */
    private fun startWatchdog() {
        watchdogJob?.cancel()
        lastNotifyMs = System.currentTimeMillis()
        watchdogJob = lifecycleScope.launch {
            var lastWarn = 0L
            var bad = 0
            while (isActive) {
                delay(1000)
                val gap = System.currentTimeMillis() - lastNotifyMs
                if (gap > 3000) {
                    bad++
                    if (System.currentTimeMillis() - lastWarn > 2000) {
                        DiagLog.log("watch", "NO glasses response for ${gap}ms (bad=$bad) — possible SILENT app-drop")
                        lastWarn = System.currentTimeMillis()
                    }
                    // Sustained (~12 s of no healthy acks) → auto-recover. A normal heavy-render
                    // ack pause (~6 s) won't reach this; rate-limited to 1 per 30 s (no thrash).
                    if (bad >= 12 && !recovering && System.currentTimeMillis() - lastRecoverMs > 30_000) {
                        runOnUiThread { recoverSession() }
                    }
                } else {
                    bad = 0
                }
            }
        }
    }

    /** Auto-recovery. The silent app-drop leaves the BLE link "up" (nothing else notices) and
     *  re-launching into the dead slot does nothing — only a FRESH BLE session revives it. So
     *  force a full teardown + reconnect + cold-launch, then re-attach server mode. The
     *  all-day-unattended backbone: heals regardless of the drop's (still-unconfirmed) root cause. */
    private fun recoverSession() {
        if (recovering) return
        recovering = true
        wasServerMode = serverMode
        lastRecoverMs = System.currentTimeMillis()
        DiagLog.log("recover", "SILENT DROP — auto-recovering: BLE reconnect + cold-launch${if (wasServerMode) " + re-attach server" else ""}")
        setStatus("Auto-recovering (silent drop)…")
        teardown()        // full BLE teardown (clears launched/serverMode, cancels jobs)
        onConnect()       // re-scan + connect -> Ready -> maybeColdLaunch (clears `recovering`)
    }

    /** Session RENEWAL — the hijacked EvenHub app slot has a ~120 s lifetime (drops measured
     *  ~110–134 s after cold-launch, independent of renders). Native Chess renews it by
     *  re-running the f1=0 launch + re-pushing the current frame every ~113–118 s (BTSnoop
     *  /tmp/g2cc-btsnoop5: launches at +0 / +118.5 / +231.8 s). We do the same at ~100 s
     *  (margin under expiry). Re-paints the CURRENT scene, so it resumes exactly where it
     *  left off. Empty prelude (just f1=0 + content), matching Chess's re-launch. */
    private fun startRenewal() {
        renewalJob?.cancel()
        renewalJob = lifecycleScope.launch {
            while (isActive) {
                delay(80_000)                                // ~80s, margin under the ~120s app-slot lifetime
                val r = renderer ?: break
                val scene = r.currentScene ?: continue
                // FULL takeover: COLD_INIT prelude (hijack re-establishment) + f1=0 + content.
                // The empty-prelude version did NOT reset the ~120s timer (measured 2026-06-06);
                // re-running the full COLD_INIT is the actual "full takeover protocol".
                DiagLog.log("renew", "re-takeover (COLD_INIT) — resubmit current frame (${scene.regions.size} regions)")
                r.launch(DisplayProto.TOKEN_DOCULENS, scene, EvenHub.COLD_INIT) { ok ->
                    DiagLog.log("renew", "re-takeover result=${if (ok) "OK" else "FAIL"}")
                }
            }
        }
    }

    /** Tick a live HH:MM:SS clock into the top status bar once a second. Doubles as the
     *  "never-blank" periodic content change and keeps a text region present in every layout —
     *  the thing the firmware needs in order to paint a screen (the games always have one). */
    private fun startClock() {
        clockJob?.cancel()
        clockJob = lifecycleScope.launch {
            while (isActive) {
                delay(1000)
                val r = renderer ?: break
                val sc = r.currentScene ?: continue
                val t = nowClock()
                // OS/splash scenes carry the tiny top-right "clock"; the renderer
                // self-test (Test Display) uses a full-width "status" — tick
                // whichever is present so the never-blank text region keeps
                // updating in both modes (preserves the proven test behaviour).
                when {
                    sc.region(OsLayout.CLOCK_NAME) != null -> { r.setText(OsLayout.CLOCK_NAME, t); updateMirror(r.currentScene) }
                    sc.region("status") != null -> { r.setText("status", "G2CC  $t"); updateMirror(r.currentScene) }
                }
            }
        }
    }

    // ----------------------------------------------------------------- test

    private fun onTest() {
        if (!launched) return
        testBtn.isEnabled = false
        testJob = lifecycleScope.launch {
            DiagLog.log("test", "═══ Test Display sequence START ═══")
            try {
                DisplayTestSequence.run(this@HarnessActivity)
                if (launched) setStatus("Tests complete. Tap Test Display to repeat.")
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e   // never swallow structured-concurrency cancellation
            } catch (e: Exception) {
                DiagLog.log("test", "sequence error: $e")
                setStatus("Test error: ${e.message}")
            }
            DiagLog.log("test", "═══ Test Display sequence END ═══")
            updateButtons()   // re-enable per current state (honors serverMode/launched) — not unconditional
        }
    }

    // ----------------------------------------------------------------- server mode

    /** Glasses-OS Slice 1: open a WS to the PC and let the server drive the
     *  display. BLE must already be up (we reuse the cold-launched session,
     *  keepalive + clock). On connect → os_attach; on `render` → setScene; ring
     *  events → `input`. */
    private fun onServerMode() {
        if (!launched || serverMode) return
        serverMode = true
        updateButtons()
        // Single serialized render pump: server scenes go through a CONFLATED channel and ONE
        // consumer renders them one at a time. Without this, rapid scrolls each spawned their own
        // setScene coroutine and the concurrent BLE writes INTERLEAVED — corrupting a tile
        // mid-update (the "double-scroll wedge"; confirmed in the diag — render C started before
        // render B's result). Conflation also drops stale intermediate scrolls so nav stays responsive.
        val ch = Channel<WireScene>(Channel.CONFLATED)
        sceneCh = ch
        renderConsumerJob = lifecycleScope.launch {
            for (wire in ch) {
                val r = renderer ?: continue
                val scene = try {
                    SceneCodec.toScene(wire, latestClockText)
                } catch (e: IllegalArgumentException) {
                    // LOUD AND PROUD — a bad scene from the server is surfaced, not dropped.
                    DiagLog.log("os", "BAD render scene: ${e.message}")
                    setStatus("Bad scene from server: ${e.message}")
                    continue
                }
                DiagLog.log("os", "render → setScene (${scene.regions.size} regions: ${scene.regions.joinToString { it.name }})")
                val ok = awaitSetScene(r, scene)
                updateMirror(r.currentScene)
                DiagLog.log("os", "render result=${if (ok) "OK" else "FAIL"}")
            }
        }
        val url = "ws://${BuildConfig.SERVER_HOST}:${BuildConfig.SERVER_PORT}/ws"
        DiagLog.log("os", "server mode → connecting $url")
        setStatus("Server mode: connecting to PC…")
        val cm = ConnectionManager(
            initialEndpoints = listOf(url),
            authToken = BuildConfig.AUTH_TOKEN,
            httpClient = OkHttpClient(),
            onMessage = { msg -> runOnUiThread { onServerMessage(msg) } },
            onConnected = {
                DiagLog.log("os", "WS authed → sending os_attach")
                connection?.send(ClientMessage.OsAttach)
                runOnUiThread { setStatus("Server mode: PC connected. Use the ring.") }
            },
            onDisconnected = { DiagLog.log("os", "WS disconnected") },
        )
        connection = cm
        cm.connect()
    }

    private fun onServerMessage(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.Render -> {
                // Hand off to the serialized render pump (see onServerMode). CONFLATED: a newer
                // scene replaces an unconsumed one, so a burst of scrolls renders only the latest.
                if (sceneCh?.trySend(msg.scene)?.isSuccess != true)
                    DiagLog.log("os", "render dropped — render queue not active (not in server mode?)")
            }
            else -> {
                // config_snapshot / dispatch_target_list / etc. — not used in OS mode.
                DiagLog.log("os", "ignored server msg ${msg::class.simpleName}")
            }
        }
    }

    // TestHarness ----------------------------------------------------

    override suspend fun render(label: String, scene: Scene): Boolean {
        step(label)
        val r = renderer ?: return false
        DiagLog.log("test", "→ setScene (${scene.regions.size} regions: ${scene.regions.joinToString { it.name }})")
        val ok = awaitSetScene(r, scene)
        updateMirror(r.currentScene)
        DiagLog.log("test", "  result=${if (ok) "OK" else "FAIL"}")
        return ok
    }

    override suspend fun renderImage(label: String, region: String, bmp: ByteArray): Boolean {
        step(label)
        val r = renderer ?: return false
        DiagLog.log("test", "→ setImage('$region', ${bmp.size} B)")
        val ok = awaitSetImage(r, region, bmp)
        updateMirror(r.currentScene)
        DiagLog.log("test", "  result=${if (ok) "OK" else "FAIL"}")
        return ok
    }

    override suspend fun renderText(label: String, region: String, text: String): Boolean {
        step(label)
        val r = renderer ?: return false
        DiagLog.log("test", "→ setText('$region', ${text.length} chars)")
        val ok = awaitSetText(r, region, text)
        updateMirror(r.currentScene)
        DiagLog.log("test", "  result=${if (ok) "OK" else "FAIL"}")
        return ok
    }

    override fun note(msg: String) {
        DiagLog.log("test", msg)
    }

    override suspend fun pause(ms: Long) {
        delay(ms)
    }

    private fun step(label: String) {
        setStatus(label)
        DiagLog.log("test", "STEP $label")
    }

    // ----------------------------------------------------------------- disconnect / teardown

    private fun onDisconnect() {
        DiagLog.log("conn", "disconnect requested")
        teardown()
        setStatus("Disconnected.")
        updateButtons()
        updateMirror(null)
    }

    private fun teardown() {
        keepaliveJob?.cancel(); keepaliveJob = null
        clockJob?.cancel(); clockJob = null
        renderConsumerJob?.cancel(); renderConsumerJob = null
        sceneCh?.close(); sceneCh = null
        syncJob?.cancel(); syncJob = null
        watchdogJob?.cancel(); watchdogJob = null
        renewalJob?.cancel(); renewalJob = null
        coldLaunchJob?.cancel(); coldLaunchJob = null
        testJob?.cancel(); testJob = null
        sessionGen++   // invalidate any in-flight cold-launch/test coroutine that completes after this
        stateJobs.forEach { it.cancel() }; stateJobs.clear()
        connection?.shutdown(); connection = null
        serverMode = false
        scanner?.stop(); scanner = null
        left?.shutdownBle(); right?.shutdownBle()
        left = null; right = null; renderer = null
        launched = false; connecting = false
    }

    // ----------------------------------------------------------------- helpers

    private fun missingPermissions(): List<String> {
        val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        return needed.filter { ContextCompat.checkSelfPermission(this, it) != android.content.pm.PackageManager.PERMISSION_GRANTED }
    }

    private suspend fun awaitLaunch(r: G2Renderer, s: Scene): Boolean =
        suspendCancellableCoroutine { c -> r.launch(DisplayProto.TOKEN_DOCULENS, s, EvenHub.COLD_INIT) { if (c.isActive) c.resume(it) } }

    private suspend fun awaitSetScene(r: G2Renderer, s: Scene): Boolean =
        suspendCancellableCoroutine { c -> r.setScene(s) { if (c.isActive) c.resume(it) } }

    private suspend fun awaitSetImage(r: G2Renderer, name: String, bmp: ByteArray): Boolean =
        suspendCancellableCoroutine { c -> r.setImage(name, bmp) { if (c.isActive) c.resume(it) } }

    private suspend fun awaitSetText(r: G2Renderer, name: String, text: String): Boolean =
        suspendCancellableCoroutine { c -> r.setText(name, text) { if (c.isActive) c.resume(it) } }
}
