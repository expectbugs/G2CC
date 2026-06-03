package com.g2cc.g2cc.probe

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.util.TypedValue
import android.view.ViewGroup
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import com.g2cc.g2cc.ble.BleScanner
import com.g2cc.g2cc.ble.ConnectionState
import com.g2cc.g2cc.ble.PairingState
import com.g2cc.g2cc.ble.Side
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager
import com.g2cc.g2cc.net.ServerMessage
import com.g2cc.g2cc.service.G2CCService
import com.g2cc.g2cc.storage.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.io.File
import java.io.PrintWriter
import java.text.SimpleDateFormat
import java.time.Duration
import java.util.Date
import java.util.Locale

/**
 * Comprehensive BLE probe / protocol-shell activity (v2).
 *
 * Captures EVERY notify event on EVERY characteristic the G2 firmware
 * exposes, with full untruncated payloads. Logs to three sinks:
 *
 *  1. **On-screen TextView** (scrollable, monospace) — live view while
 *     phone is in hand
 *  2. **Local file** at
 *     `/Android/data/com.g2cc.g2cc/files/probe-logs/probe-<timestamp>.log`
 *     — accessible from phone Files app, persists across sessions
 *  3. **Home server diag stream** via WebSocket. Every log line is sent
 *     as `ClientMessage.Diag("[probe-...]")` and lands in
 *     `/tmp/g2cc-server.log` server-side, where Claude reads it without
 *     manual transfer
 *
 * Stops [G2CCService] on start so the probe owns the BLE connection
 * exclusively (the main service and probe would otherwise contend).
 *
 * No timeouts, no audio, no menu — pure observation + targeted writes.
 */
class ProbeActivity : ComponentActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private lateinit var statusText: TextView
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var connectBtn: Button
    private lateinit var disconnectBtn: Button
    private lateinit var saveBtn: Button
    private lateinit var listCharsBtn: Button

    private lateinit var prefs: Prefs
    private lateinit var pairing: PairingState

    private var leftBle: BleProbeClient? = null
    private var rightBle: BleProbeClient? = null
    private var scanner: BleScanner? = null
    private var connection: ConnectionManager? = null

    private var leftStateJob: Job? = null
    private var rightStateJob: Job? = null
    private var leftNotifyJob: Job? = null
    private var rightNotifyJob: Job? = null

    private var logFile: File? = null
    private var logWriter: PrintWriter? = null

    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val fileTimeFmt = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)

    private var leftReady = false
    private var rightReady = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        pairing = PairingState(applicationContext)

        // Stop the main G2CC service if running, so the probe owns BLE.
        try {
            stopService(Intent(this, G2CCService::class.java))
        } catch (e: Exception) {
            android.util.Log.w(TAG, "stopService failed", e)
        }

        setContentView(buildUi())
        openLogFile()
        log("ProbeActivity v2 ready")
        log("Server URL: ${prefs.serverUrl ?: "(NOT CONFIGURED — set in main G2CC app first)"}")
        log("Auth token: ${if (prefs.authToken != null) "(present)" else "(missing)"}")
        log("Saved pair: L=${pairing.leftAddress ?: "(none)"} R=${pairing.rightAddress ?: "(none)"}")
        log("Log file: ${logFile?.absolutePath ?: "(none)"}")
        if (!hasRequiredPermissions()) {
            log("WARN: BLE/audio permissions not granted; run main G2CC app once to grant them")
        }
        startWsIfConfigured()
    }

    private fun buildUi(): ViewGroup {
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            setPadding(16, 16, 16, 16)
        }
        statusText = TextView(this).apply {
            text = "Status: Disconnected"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setPadding(0, 0, 0, 12)
        }
        outer.addView(statusText)

        val row1 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        connectBtn = Button(this).apply {
            text = "Connect"
            setOnClickListener { startConnect() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        disconnectBtn = Button(this).apply {
            text = "Disconnect"
            isEnabled = false
            setOnClickListener { disconnect() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        row1.addView(connectBtn)
        row1.addView(disconnectBtn)
        outer.addView(row1)

        val row2 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        saveBtn = Button(this).apply {
            text = "Save Log Now"
            setOnClickListener { flushLog(); log("Log flushed: ${logFile?.absolutePath}") }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        listCharsBtn = Button(this).apply {
            text = "Dump Chars"
            isEnabled = false
            setOnClickListener { dumpCharsToLog() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        row2.addView(saveBtn)
        row2.addView(listCharsBtn)
        outer.addView(row2)

        // Log view — horizontal+vertical scroll so long hex lines don't wrap awkwardly.
        logScroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            )
            setPadding(0, 12, 0, 0)
        }
        val hScroll = HorizontalScrollView(this)
        logText = TextView(this).apply {
            setTextColor(Color.argb(255, 180, 240, 180))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
            typeface = android.graphics.Typeface.MONOSPACE
            movementMethod = ScrollingMovementMethod()
        }
        hScroll.addView(logText)
        logScroll.addView(hScroll)
        outer.addView(logScroll)
        return outer
    }

    // ============================================================
    // Logging
    // ============================================================

    private fun openLogFile() {
        try {
            val dir = File(getExternalFilesDir(null), "probe-logs")
            if (!dir.exists()) dir.mkdirs()
            val name = "probe-${fileTimeFmt.format(Date())}.log"
            val f = File(dir, name)
            logFile = f
            logWriter = PrintWriter(f.outputStream().bufferedWriter())
        } catch (e: Exception) {
            android.util.Log.e(TAG, "openLogFile failed", e)
            logFile = null
            logWriter = null
        }
    }

    private fun flushLog() {
        logWriter?.flush()
    }

    private fun log(s: String) {
        val ts = timeFmt.format(Date())
        val line = "[$ts] $s"
        // On-screen
        runOnUiThread {
            logText.append(line + "\n")
            logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
        // Local file
        try {
            logWriter?.println(line)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "file log failed", e)
        }
        // Server diag — async via connection manager
        try {
            connection?.send(ClientMessage.Diag("[probe] $line"))
        } catch (e: Exception) {
            android.util.Log.w(TAG, "diag send failed", e)
        }
        // logcat for adb fallback
        android.util.Log.i(TAG, line)
    }

    private fun setStatus(s: String) {
        runOnUiThread { statusText.text = "Status: $s" }
    }

    // ============================================================
    // WebSocket to home server
    // ============================================================

    private fun startWsIfConfigured() {
        val url = prefs.serverUrl
        val token = prefs.authToken
        if (url == null || token == null) {
            log("WS not started — server URL or auth token missing in prefs")
            return
        }
        val cm = ConnectionManager(
            initialEndpoints = listOf(url),
            authToken = token,
            httpClient = defaultHttpClient(),
            onMessage = { msg: ServerMessage ->
                android.util.Log.i(TAG, "ws server msg: ${msg::class.simpleName}")
            },
            onConnected = { log("WS connected to $url") },
            onDisconnected = { log("WS disconnected") },
            onAuthFailure = { count -> log("WS auth failure #$count") },
        )
        connection = cm
        cm.connect()
    }

    // ============================================================
    // Permissions / connect flow
    // ============================================================

    private fun hasRequiredPermissions(): Boolean {
        val perms = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            perms += Manifest.permission.BLUETOOTH_SCAN
            perms += Manifest.permission.BLUETOOTH_CONNECT
        }
        return perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
    }

    @SuppressLint("MissingPermission")
    private fun startConnect() {
        connectBtn.isEnabled = false
        disconnectBtn.isEnabled = true
        if (pairing.hasPair) {
            log("Using saved pair: L=${pairing.leftAddress} R=${pairing.rightAddress}")
            connectByAddress(pairing.leftAddress!!, pairing.rightAddress!!)
        } else {
            log("No saved pair — starting scan")
            startScan()
        }
    }

    @SuppressLint("MissingPermission")
    private fun startScan() {
        setStatus("Scanning…")
        val s = BleScanner(this)
        scanner = s
        s.start { event ->
            when (event) {
                is BleScanner.Event.FoundPair -> {
                    runOnUiThread {
                        log("Scan found pair: L=${event.left.address} R=${event.right.address}")
                        scanner = null
                        connectByAddress(event.left.address, event.right.address)
                    }
                }
                is BleScanner.Event.Failure -> {
                    log("Scan failed: ${event.reason}")
                    setStatus("Scan failed")
                    runOnUiThread { connectBtn.isEnabled = true; disconnectBtn.isEnabled = false }
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun connectByAddress(leftAddr: String, rightAddr: String) {
        setStatus("Connecting L+R")
        val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as android.bluetooth.BluetoothManager).adapter
        val leftDev = adapter.getRemoteDevice(leftAddr)
        val rightDev = adapter.getRemoteDevice(rightAddr)
        val lc = BleProbeClient(this, Side.Left)
        val rc = BleProbeClient(this, Side.Right)
        leftBle = lc
        rightBle = rc
        leftStateJob = scope.launch { lc.state.collect { onLensState(Side.Left, it) } }
        rightStateJob = scope.launch { rc.state.collect { onLensState(Side.Right, it) } }
        leftNotifyJob = scope.launch { lc.notifies.collect { onNotify(Side.Left, it) } }
        rightNotifyJob = scope.launch { rc.notifies.collect { onNotify(Side.Right, it) } }
        lc.connectTo(leftDev)
        rc.connectTo(rightDev)
    }

    private fun onLensState(side: Side, s: ConnectionState) {
        val label = when (s) {
            is ConnectionState.Idle -> "idle"
            is ConnectionState.Scanning -> "scanning"
            is ConnectionState.Connecting -> "connecting"
            is ConnectionState.GattConnected -> "gatt-connected"
            is ConnectionState.Authenticating -> "authenticating"
            is ConnectionState.Ready -> "READY"
            is ConnectionState.Disconnected -> "disconnected (${s.reason})"
            is ConnectionState.Error -> "ERROR (${s.message})"
        }
        log("[$side] state → $label")
        if (s is ConnectionState.Ready) {
            if (side == Side.Left) leftReady = true else rightReady = true
            if (leftReady && rightReady) {
                setStatus("Auth'd. Notify subscriptions active on every char with notify property.")
                runOnUiThread { listCharsBtn.isEnabled = true }
                // Auto-dump char tree on Ready so the log starts with a map.
                dumpCharsToLog()
            } else {
                setStatus("${if (leftReady) "L✓" else "L?"} ${if (rightReady) "R✓" else "R?"}")
            }
        }
        if (s is ConnectionState.Error || s is ConnectionState.Disconnected) {
            if (side == Side.Left) leftReady = false else rightReady = false
        }
    }

    private fun onNotify(side: Side, n: BleProbeClient.RawNotify) {
        // Log the FULL byte payload as hex. Also include a parsed header
        // if it's an AA-framed packet for easier reading.
        val hex = n.bytes.joinToString("") { "%02x".format(it) }
        val parsed = parseAaFrameHeader(n.bytes)
        val suffix = if (parsed != null) " | $parsed" else ""
        log("[$side notify ${shortUuid(n.charUuid)}] ${n.bytes.size}B  $hex$suffix")
    }

    private fun dumpCharsToLog() {
        val l = leftBle
        val r = rightBle
        log("=== Char dump (L) ===")
        if (l != null) for (line in l.discoveryDump.lines()) log("[L] $line")
        log("=== Char dump (R) ===")
        if (r != null) for (line in r.discoveryDump.lines()) log("[R] $line")
    }

    // ============================================================
    // Parsing helpers
    // ============================================================

    /** If `bytes` looks like an AA-framed packet, return a short
     *  diagnostic string. Otherwise null. */
    private fun parseAaFrameHeader(b: ByteArray): String? {
        if (b.size < 8) return null
        if (b[0] != 0xAA.toByte()) return null
        val type = b[1].toInt() and 0xFF
        val typeLabel = when (type) {
            0x21 -> "CMD"
            0x12 -> "RSP"
            else -> "T${"%02x".format(type)}"
        }
        val seq = b[2].toInt() and 0xFF
        val len = b[3].toInt() and 0xFF
        val pktTot = b[4].toInt() and 0xFF
        val pktSer = b[5].toInt() and 0xFF
        val svcHi = b[6].toInt() and 0xFF
        val svcLo = b[7].toInt() and 0xFF
        val service = "%02x-%02x".format(svcHi, svcLo)
        return "$typeLabel seq=${"%02x".format(seq)} len=${"%02x".format(len)} ${pktTot}/${pktSer} svc=$service"
    }

    /** Last 4 hex chars of a UUID for short logging. */
    private fun shortUuid(u: java.util.UUID): String {
        val full = u.toString()
        return full.substringAfterLast("-").take(4) + "/" + full.substring(4, 8)
    }

    // ============================================================
    // Lifecycle
    // ============================================================

    @SuppressLint("MissingPermission")
    private fun disconnect() {
        log("Disconnect requested")
        scanner?.stop()
        scanner = null
        leftStateJob?.cancel(); leftStateJob = null
        rightStateJob?.cancel(); rightStateJob = null
        leftNotifyJob?.cancel(); leftNotifyJob = null
        rightNotifyJob?.cancel(); rightNotifyJob = null
        leftBle?.shutdownBle()
        rightBle?.shutdownBle()
        leftBle = null
        rightBle = null
        leftReady = false
        rightReady = false
        setStatus("Disconnected")
        runOnUiThread {
            connectBtn.isEnabled = true
            disconnectBtn.isEnabled = false
            listCharsBtn.isEnabled = false
        }
        flushLog()
        log("Log saved: ${logFile?.absolutePath}")
    }

    override fun onDestroy() {
        super.onDestroy()
        disconnect()
        try {
            connection?.shutdown()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "ws shutdown failed", e)
        }
        connection = null
        try {
            logWriter?.flush()
            logWriter?.close()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "log file close failed", e)
        }
        scope.cancel()
    }

    companion object {
        const val TAG = "G2CCProbe"
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(10))
            .readTimeout(Duration.ofSeconds(10))
            .build()
    }
}
