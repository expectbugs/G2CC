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
import com.g2cc.g2cc.ble.Side
import com.g2cc.g2cc.render.BleDisplaySink
import com.g2cc.g2cc.render.DisplayProto
import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.G2Renderer
import com.g2cc.g2cc.render.Scene
import com.g2cc.g2cc.render.scene
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
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
    private lateinit var diagCheck: CheckBox
    private lateinit var mirror: ImageView

    private var scanner: BleScanner? = null
    private var left: G2BleClient? = null
    private var right: G2BleClient? = null
    private var renderer: G2Renderer? = null
    private val stateJobs = mutableListOf<Job>()
    private var keepaliveJob: Job? = null
    private var clockJob: Job? = null
    private var launched = false
    private var connecting = false

    private val clockFmt = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
    private fun statusLine(): String = "G2CC  ${clockFmt.format(java.util.Date())}"

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
        connectBtn.setOnClickListener { onConnect() }
        testBtn.setOnClickListener { onTest() }
        disconnectBtn.setOnClickListener { onDisconnect() }
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
        testBtn = Button(this).apply { text = "Test Display" }
        disconnectBtn = Button(this).apply { text = "Disconnect" }
        val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        row.addView(connectBtn, lp); row.addView(testBtn, lp); row.addView(disconnectBtn, lp)
        root.addView(row)

        diagCheck = CheckBox(this).apply {
            text = "Diag — stream verbose diagnostics to server log"
            setTextColor(Color.WHITE)
        }
        root.addView(diagCheck)

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
        testBtn.isEnabled = launched
        disconnectBtn.isEnabled = launched || connecting
    }

    private fun updateMirror(s: Scene?) {
        mirror.setImageBitmap(ExpectedMirror.render(s))
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
            client.events.collect { ev -> DiagLog.log("input", "$side $ev") }
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
        lifecycleScope.launch {
            setStatus("Cold-launching Hub session…")
            val splash = scene {
                text("status", 0, 0, Display.WIDTH, 28, statusLine(), scroll = false)
                text("main", 0, 36, Display.WIDTH, Display.HEIGHT - 36,
                    "G2CC DISPLAY HARNESS\n\nConnected.\n\nTap  Test Display  to run the\nrenderer test sequence.", scroll = false)
            }
            val ok = awaitLaunch(rend, splash)
            if (ok) {
                DiagLog.log("conn", "cold-launch OK")
                setStatus("Connected. Tap Test Display.")
                startKeepalive()
                startClock()
                updateMirror(rend.currentScene)
            } else {
                DiagLog.log("conn", "cold-launch FAILED")
                setStatus("Cold-launch failed — see Diag log.")
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

    /** Tick a live HH:MM:SS clock into the top status bar once a second. Doubles as the
     *  "never-blank" periodic content change and keeps a text region present in every layout —
     *  the thing the firmware needs in order to paint a screen (the games always have one). */
    private fun startClock() {
        clockJob?.cancel()
        clockJob = lifecycleScope.launch {
            while (isActive) {
                delay(1000)
                val r = renderer ?: break
                if (r.currentScene?.region("status") != null) {
                    r.setText("status", statusLine())
                    updateMirror(r.currentScene)
                }
            }
        }
    }

    // ----------------------------------------------------------------- test

    private fun onTest() {
        if (!launched) return
        testBtn.isEnabled = false
        lifecycleScope.launch {
            DiagLog.log("test", "═══ Test Display sequence START ═══")
            try {
                DisplayTestSequence.run(this@HarnessActivity)
                setStatus("Tests complete. Tap Test Display to repeat.")
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e   // never swallow structured-concurrency cancellation
            } catch (e: Exception) {
                DiagLog.log("test", "sequence error: $e")
                setStatus("Test error: ${e.message}")
            }
            DiagLog.log("test", "═══ Test Display sequence END ═══")
            if (launched) testBtn.isEnabled = true
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
        stateJobs.forEach { it.cancel() }; stateJobs.clear()
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
