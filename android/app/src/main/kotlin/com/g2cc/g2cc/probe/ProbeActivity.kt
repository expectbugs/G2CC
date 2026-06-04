package com.g2cc.g2cc.probe

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.text.method.ScrollingMovementMethod
import android.util.TypedValue
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import com.g2cc.g2cc.ble.BleScanner
import com.g2cc.g2cc.ble.ConnectionState
import com.g2cc.g2cc.ble.G2Constants
import com.g2cc.g2cc.ble.PairingState
import com.g2cc.g2cc.ble.Side
import com.g2cc.g2cc.ble.Teleprompter
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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

    // Send-to-char controls (probe v3)
    private lateinit var modeBtn: Button
    private lateinit var addrLabel: TextView
    private lateinit var sendAddr: EditText
    private lateinit var sendBody: EditText
    private lateinit var sendLBtn: Button
    private lateinit var sendRBtn: Button
    private lateinit var evenHubText: TextView

    private var sendMode = ProbeSend.Mode.FRAME

    /** Phone-side frame sequence for FRAME-mode sends. Auth consumes seq 1–7
     *  per connect (see [AuthSequence]); manual frames continue from 8. Reset
     *  on each fresh connect. Wraps at 0xFF. */
    @Volatile private var txSeq = 8

    // EvenHub replay controls (probe v4)
    private lateinit var autoBtn: Button
    private lateinit var presetLaunchBtn: Button
    private lateinit var presetMenuBtn: Button
    private lateinit var presetDoclistBtn: Button

    /** When armed, the probe replies to the EvenHub launch handshake itself —
     *  no human reaction time required (forgiving timing). On an `e0-01`
     *  launch-request it sends the DocuLens launch-response; on the `e0-00`
     *  launch-ack it sends the G2CC menu. Purely event-driven, no timeouts. */
    @Volatile private var autoRespond = false

    /** Serializes session re-establishment so the cold-launch button and the
     *  heartbeat can't interleave their paced write sequences. */
    private val reestablishMutex = Mutex()

    // Cold launch + keepalive (probe v5)
    private lateinit var coldLaunchBtn: Button
    private lateinit var autoRelaunchBtn: Button

    /** When on, the probe cold-launches G2CC automatically on every R-lens Ready
     *  — so it self-heals after a drop (heavy-persistence test). */
    @Volatile private var autoRelaunch = false

    /** True once our menu is on the glasses — gates the menu-resend keepalive so
     *  we don't push content before a session exists. */
    @Volatile private var sessionActive = false

    /** Rolling single-byte msg-id (100..126) for keepalive / input-response menu
     *  re-sends, so each is a distinct write the firmware can't dedup. */
    @Volatile private var kaMsgId = 100

    /** Session keepalive: 80-00 sync_trigger to BOTH lenses (L→R staggered),
     *  each lens every [HEARTBEAT_CYCLE_MS]. Started on R Ready, cancelled on R
     *  disconnect. The Hub session times out (~10–22s) on missing keepalive even
     *  though BLE stays up. */
    private var heartbeatJob: Job? = null
    @Volatile private var hbSeq = 0x90
    @Volatile private var hbMsgId = 0x60

    /** PARTIAL_WAKE_LOCK so the heartbeat coroutine's delay() fires on schedule
     *  when the screen is off / phone in pocket (Phase D lesson). */
    private var wakeLock: PowerManager.WakeLock? = null

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

        // --- Send-to-characteristic section (probe v3) ---
        outer.addView(TextView(this).apply {
            text = "── Send to characteristic ──"
            setTextColor(Color.argb(255, 120, 160, 255))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, 16, 0, 4)
        })

        modeBtn = Button(this).apply {
            setOnClickListener { toggleSendMode() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        outer.addView(modeBtn)

        addrLabel = TextView(this).apply {
            setTextColor(Color.LTGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        }
        outer.addView(addrLabel)

        sendAddr = EditText(this).apply {
            setText("e0 00")
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = android.graphics.Typeface.MONOSPACE
            isSingleLine = true
        }
        outer.addView(sendAddr)

        outer.addView(TextView(this).apply {
            text = "payload hex (FRAME) / raw bytes (RAW):"
            setTextColor(Color.LTGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setPadding(0, 6, 0, 0)
        })

        sendBody = EditText(this).apply {
            hint = "e.g. 08 11 a2 01 03 08 99 59"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.DKGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = android.graphics.Typeface.MONOSPACE
        }
        outer.addView(sendBody)

        val sendRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        sendLBtn = Button(this).apply {
            text = "Send → L"
            isEnabled = false
            setOnClickListener { onSend(Side.Left) }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        sendRBtn = Button(this).apply {
            text = "Send → R"
            isEnabled = false
            setOnClickListener { onSend(Side.Right) }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        sendRow.addView(sendLBtn)
        sendRow.addView(sendRBtn)
        outer.addView(sendRow)

        // --- EvenHub replay / hijack test (probe v4) ---
        outer.addView(TextView(this).apply {
            text = "── EvenHub replay (Hub-app hijack test) ──"
            setTextColor(Color.argb(255, 120, 160, 255))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, 16, 0, 4)
        })

        autoBtn = Button(this).apply {
            text = "AUTO-RESPOND: OFF"
            isEnabled = false
            setOnClickListener { toggleAuto() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        outer.addView(autoBtn)

        outer.addView(TextView(this).apply {
            text = "manual presets (send to R):"
            setTextColor(Color.LTGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setPadding(0, 6, 0, 0)
        })
        val presetRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        presetLaunchBtn = Button(this).apply {
            text = "DocuLens launch"
            isEnabled = false
            setOnClickListener { sendPreset(Side.Right, "DocuLens-launch", ReplayKit.DOCULENS_LAUNCH) }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        presetMenuBtn = Button(this).apply {
            text = "G2CC menu"
            isEnabled = false
            setOnClickListener { sendPreset(Side.Right, "G2CC-menu", ReplayKit.G2CC_MENU) }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        presetDoclistBtn = Button(this).apply {
            text = "G2CC doclist"
            isEnabled = false
            setOnClickListener { sendPreset(Side.Right, "G2CC-doclist", ReplayKit.G2CC_DOCLIST) }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        presetRow.addView(presetLaunchBtn)
        presetRow.addView(presetMenuBtn)
        presetRow.addView(presetDoclistBtn)
        outer.addView(presetRow)

        // Cold launch (phone-initiated, no glasses menu) + persistence (probe v5)
        val coldRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        coldLaunchBtn = Button(this).apply {
            text = "COLD LAUNCH G2CC"
            isEnabled = false
            setOnClickListener { coldLaunch(Side.Right) }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 2f)
        }
        autoRelaunchBtn = Button(this).apply {
            text = "RELAUNCH: OFF"
            isEnabled = false
            setOnClickListener { toggleAutoRelaunch() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        coldRow.addView(coldLaunchBtn)
        coldRow.addView(autoRelaunchBtn)
        outer.addView(coldRow)

        evenHubText = TextView(this).apply {
            text = "EvenHub (e0-xx): none seen yet"
            setTextColor(Color.argb(255, 255, 210, 120))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(0, 6, 0, 8)
        }
        outer.addView(evenHubText)

        updateSendLabels()

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
        txSeq = 8 // auth re-runs (seq 1–7) on each connect; manual frames resume at 8
        autoRespond = false
        sessionActive = false
        acquireWakeLock() // keep CPU alive so the heartbeat fires on schedule
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
            // Enable this lens's Send button as soon as it authenticates; the
            // EvenHub replay controls send to R, so they unlock on R ready.
            runOnUiThread {
                if (side == Side.Left) {
                    sendLBtn.isEnabled = true
                } else {
                    sendRBtn.isEnabled = true
                    autoBtn.isEnabled = true
                    presetLaunchBtn.isEnabled = true
                    presetMenuBtn.isEnabled = true
                    presetDoclistBtn.isEnabled = true
                    coldLaunchBtn.isEnabled = true
                    autoRelaunchBtn.isEnabled = true
                }
            }
            if (side == Side.Right) {
                startHeartbeat()                         // sync_trigger keepalive to L+R
                if (autoRelaunch) coldLaunch(Side.Right) // self-heal after a drop
            }
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
            if (side == Side.Right) {
                stopHeartbeat()
                sessionActive = false // a fresh Ready can cold-launch cleanly
            }
            runOnUiThread {
                if (side == Side.Left) {
                    sendLBtn.isEnabled = false
                } else {
                    sendRBtn.isEnabled = false
                    autoBtn.isEnabled = false
                    presetLaunchBtn.isEnabled = false
                    presetMenuBtn.isEnabled = false
                    presetDoclistBtn.isEnabled = false
                    coldLaunchBtn.isEnabled = false
                    autoRelaunchBtn.isEnabled = false
                }
            }
        }
    }

    private fun onNotify(side: Side, n: BleProbeClient.RawNotify) {
        // Log the FULL byte payload as hex. Also include a parsed header
        // if it's an AA-framed packet for easier reading.
        val hex = n.bytes.joinToString("") { "%02x".format(it) }
        val parsed = parseAaFrameHeader(n.bytes)
        val suffix = if (parsed != null) " | $parsed" else ""
        log("[$side notify ${shortUuid(n.charUuid)}] ${n.bytes.size}B  $hex$suffix")

        // Surface EvenHub (svc 0xe0-XX) notifies prominently and drive the
        // auto-responder. This is the launch-handshake + input channel
        // (EVENHUB_FINDING.md / decoded 2026-06-03). e0-01 carries launch
        // requests (f1=17) and ring INPUT events (f1=2); e0-00 carries acks.
        val b = n.bytes
        if (b.size >= 8 && b[0] == 0xAA.toByte() && (b[6].toInt() and 0xFF) == 0xE0) {
            val svcLo = b[7].toInt() and 0xFF
            // header(8) + payload + crc(2): payload exists only when size > 10.
            val payload = if (b.size > 10) b.copyOfRange(8, b.size - 2) else ByteArray(0)
            val payloadHex = if (payload.isNotEmpty()) payload.joinToString("") { "%02x".format(it) } else "(none)"
            val f1 = ReplayKit.field1(payload)
            val kind = when {
                svcLo == 0x01 && f1 == ReplayKit.MSGTYPE_LAUNCH_REQUEST -> "LAUNCH-REQ"
                svcLo == 0x01 && f1 == ReplayKit.MSGTYPE_INPUT_EVENT -> "INPUT"
                svcLo == 0x00 && f1 == ReplayKit.MSGTYPE_LAUNCH_ACK -> "LAUNCH-ACK"
                else -> "e0-%02x".format(svcLo)
            }
            val ts = timeFmt.format(Date(n.timestampMs))
            runOnUiThread {
                evenHubText.text = "EvenHub %s @ %s  payload=%s".format(kind, ts, payloadHex)
            }
            log("[$side] *** EvenHub e0-%02x %s — payload=%s ***".format(svcLo, kind, payloadHex))
            maybeAutoRespond(side, svcLo, f1)
        }
    }

    /** Event-driven auto-responder (no timeouts): when armed, a glasses-initiated
     *  launch request (e0-01) triggers the same full cold-launch we'd do from the
     *  button. Acks/inputs are logged in [onNotify] for visibility but don't drive
     *  anything — the heartbeat's full re-establishment is the keepalive. */
    private fun maybeAutoRespond(side: Side, svcLo: Int, f1: Int?) {
        if (autoRespond && svcLo == 0x01 && f1 == ReplayKit.MSGTYPE_LAUNCH_REQUEST && !sessionActive) {
            log("[$side] AUTO ▶ launch-request → cold launch")
            coldLaunch(side)
        }
    }

    // ============================================================
    // Cold launch + keepalive + persistence (probe v5)
    // ============================================================

    /** Phone-INITIATED cold launch — no glasses menu, no e0-01. Runs the full
     *  re-establishment sequence once, then marks the session active so the
     *  heartbeat keeps re-establishing it. */
    private fun coldLaunch(side: Side) {
        val connected = (if (side == Side.Left) leftBle else rightBle) != null
        if (!connected) {
            log("[$side] COLD LAUNCH: not connected")
            return
        }
        log("[$side] COLD LAUNCH — full re-establishment (token ${ReplayKit.DOCULENS_TOKEN})")
        sessionActive = true
        scope.launch { reEstablishSession(side, "cold-launch") }
    }

    private fun toggleAutoRelaunch() {
        autoRelaunch = !autoRelaunch
        runOnUiThread { autoRelaunchBtn.text = if (autoRelaunch) "RELAUNCH: ON" else "RELAUNCH: OFF" }
        log("Auto-relaunch ${if (autoRelaunch) "ON — cold-launch G2CC on every (re)connect" else "OFF"}")
    }

    /** Re-establish the EvenHub session by re-sending the FULL sequence —
     *  display init (COLD_INIT) → launch-response (f1=0) → menu (f1=7) — with
     *  inter-packet pacing. Mirrors the PROVEN teleprompter heartbeat
     *  (Hud.render: display_config→init→content→sync, re-establishing the session
     *  every cycle). Re-sending content ALONE did not satisfy the firmware
     *  (v6: acked but the display still timed out at ~20s); the launch/init is
     *  what re-establishes the session. Pacing is load-bearing
     *  (Hud.kt: "without delays the take-over succeeds but text never renders").
     *  Mutex-guarded so the button and heartbeat can't interleave writes. */
    private suspend fun reEstablishSession(side: Side, reason: String) {
        reestablishMutex.withLock {
            val ble = when (side) {
                Side.Left -> leftBle
                Side.Right -> rightBle
            } ?: return
            kaMsgId = if (kaMsgId >= 126) 100 else kaMsgId + 1
            val frames = ReplayKit.COLD_INIT + listOf(ReplayKit.DOCULENS_LAUNCH, ReplayKit.menuKeepalive(kaMsgId))
            log("[$side] re-establish ($reason): ${frames.size} frames, menu msgid=$kaMsgId")
            for ((i, f) in frames.withIndex()) {
                // Surface GATT write failures to the diag log — NO silent failures
                // in the keepalive path (review finding: was logcat-only before).
                ble.sendToChar(G2Constants.CHAR_WRITE, f, "reest:$reason[$i]") { ok, detail ->
                    if (!ok) log("[$side] *** re-establish[$i] WRITE FAILED: $detail ***")
                }
                delay(REESTABLISH_PACE_MS) // inter-packet pacing — load-bearing (Hud.kt)
            }
        }
    }

    /** Keepalive heartbeat — replicates the Even App's pattern: an 80-00
     *  sync_trigger to BOTH lenses, **L first** then R after a stagger (L is the
     *  quiet "keepalive" lens, R the display lens — Adam's hypothesis is L is what
     *  the firmware watches for liveness), repeated continuously. We run it FASTER
     *  than the Even App's 15s so a connection-lagged beat still lands inside the
     *  firmware's session window — the failure mode Adam has seen for months even
     *  in official apps ("dies when delayed too long"). Pure sync_trigger: no
     *  content re-render, no re-launch. Runs from connect onward; the cold launch
     *  separately establishes the menu. Cancels any prior job on reconnect. */
    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            log("heartbeat: 80-00 sync_trigger L→(${HEARTBEAT_STAGGER_MS / 1000}s)→R, each lens every ${HEARTBEAT_CYCLE_MS / 1000}s")
            var beat = 0
            while (isActive) {
                beat++
                sendSyncTrigger(Side.Left, beat)
                delay(HEARTBEAT_STAGGER_MS)         // L→R stagger, like the Even App
                sendSyncTrigger(Side.Right, beat)
                delay(HEARTBEAT_CYCLE_MS - HEARTBEAT_STAGGER_MS) // HB exception to no-timeouts
            }
        }
    }

    /** Send one 80-00 sync_trigger to [side] with a fresh seq/msgId. Loud on failure. */
    private fun sendSyncTrigger(side: Side, beat: Int) {
        val ble = when (side) {
            Side.Left -> leftBle
            Side.Right -> rightBle
        } ?: return
        val frame = Teleprompter.buildSyncTrigger(hbSeq, hbMsgId)
        hbSeq = (hbSeq + 1) and 0xFF
        hbMsgId = (hbMsgId + 1) and 0x7FFF
        ble.sendToChar(G2Constants.CHAR_WRITE, frame, "hb:$side") { ok, detail ->
            if (!ok) log("[$side] *** hb sync_trigger WRITE FAILED: $detail ***")
        }
        log("[$side] HB#$beat sync_trigger")
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        try {
            val pm = getSystemService(PowerManager::class.java)
            wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "G2CC:ProbeHeartbeat")?.apply {
                setReferenceCounted(false)
                acquire()
            }
            log("wake lock acquired: held=${wakeLock?.isHeld}")
        } catch (e: Exception) {
            log("wake lock acquire failed: ${e.message}")
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            log("wake lock release failed: ${e.message}")
        }
        wakeLock = null
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
    // Send to characteristic (probe v3)
    // ============================================================

    private fun toggleSendMode() {
        sendMode = if (sendMode == ProbeSend.Mode.FRAME) ProbeSend.Mode.RAW else ProbeSend.Mode.FRAME
        // Swap the address default ONLY if it's still the other mode's default
        // (i.e. Adam hasn't typed a custom target) — never clobber his input.
        val cur = sendAddr.text.toString().trim()
        when (sendMode) {
            ProbeSend.Mode.FRAME -> if (cur.isEmpty() || cur == "5401") sendAddr.setText("e0 00")
            ProbeSend.Mode.RAW -> if (cur.isEmpty() || cur == "e0 00") sendAddr.setText("5401")
        }
        updateSendLabels()
        log("Send mode → ${sendMode.name}")
    }

    private fun updateSendLabels() {
        when (sendMode) {
            ProbeSend.Mode.FRAME -> {
                modeBtn.text = "MODE: FRAME — wrap svc+payload (auto seq+CRC)"
                addrLabel.text = "service id, 2 bytes (e.g. e0 00) — wrapped, then written to 0x5401:"
            }
            ProbeSend.Mode.RAW -> {
                modeBtn.text = "MODE: RAW — write bytes verbatim"
                addrLabel.text = "target char suffix (e.g. 5401) or full UUID:"
            }
        }
    }

    private fun onSend(side: Side) {
        val ble = when (side) {
            Side.Left -> leftBle
            Side.Right -> rightBle
        }
        if (ble == null) {
            log("[$side] SEND rejected — not connected")
            return
        }
        val prepared = try {
            ProbeSend.prepare(sendMode, sendAddr.text.toString(), sendBody.text.toString(), txSeq)
        } catch (e: Exception) {
            // Loud, no silent failure — the validation message goes to the log.
            log("[$side] SEND rejected — ${e.message}")
            return
        }
        val wireHex = prepared.bytes.joinToString("") { "%02x".format(it) }
        log("[$side] SEND ${prepared.summary}")
        log("[$side]   bytes: $wireHex")
        val enqueued = ble.sendToChar(
            prepared.charUuid,
            prepared.bytes,
            label = sendMode.name.lowercase(),
        ) { ok, detail ->
            log("[$side] SEND ${if (ok) "OK" else "FAIL"} — $detail")
        }
        // Only advance the frame sequence once a FRAME write actually goes out.
        if (enqueued && sendMode == ProbeSend.Mode.FRAME) {
            txSeq = (txSeq + 1) and 0xFF
        }
    }

    // ============================================================
    // EvenHub replay / auto-responder (probe v4)
    // ============================================================

    private fun toggleAuto() {
        autoRespond = !autoRespond
        runOnUiThread {
            autoBtn.text = if (autoRespond) "AUTO-RESPOND: ON  (now pick DocuLens)" else "AUTO-RESPOND: OFF"
        }
        if (autoRespond) {
            log("Auto-respond ARMED — select DocuLens on the glasses whenever ready; " +
                "the probe will send the launch-response on e0-01 and the menu on the ack. No rush.")
        } else {
            log("Auto-respond disarmed")
        }
    }

    /** Send a canned ReplayKit frame verbatim to the main write char (0x5401).
     *  The e0-XX service id is inside the frame header. */
    private fun sendPreset(side: Side, label: String, frame: ByteArray) {
        val ble = when (side) {
            Side.Left -> leftBle
            Side.Right -> rightBle
        }
        if (ble == null) {
            log("[$side] $label: not connected")
            return
        }
        log("[$side] SEND $label (${frame.size}B): ${frame.joinToString("") { "%02x".format(it) }}")
        ble.sendToChar(G2Constants.CHAR_WRITE, frame, label) { ok, detail ->
            log("[$side] $label ${if (ok) "OK" else "FAIL"} — $detail")
        }
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
        stopHeartbeat()
        releaseWakeLock()
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
        autoRespond = false
        sessionActive = false
        autoRelaunch = false
        setStatus("Disconnected")
        runOnUiThread {
            connectBtn.isEnabled = true
            disconnectBtn.isEnabled = false
            listCharsBtn.isEnabled = false
            sendLBtn.isEnabled = false
            sendRBtn.isEnabled = false
            autoBtn.isEnabled = false
            autoBtn.text = "AUTO-RESPOND: OFF"
            presetLaunchBtn.isEnabled = false
            presetMenuBtn.isEnabled = false
            presetDoclistBtn.isEnabled = false
            coldLaunchBtn.isEnabled = false
            autoRelaunchBtn.isEnabled = false
            autoRelaunchBtn.text = "RELAUNCH: OFF"
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

        /** sync_trigger keepalive cadence. The Even App fires each lens every ~15s
         *  (L, +2s R, +13s, loop). We run each lens every 7s — ~2× the Even App —
         *  so a connection-lagged beat still lands inside the firmware's session
         *  window. HB exception to the no-timeouts rule (CLAUDE.md §Three Rules). */
        const val HEARTBEAT_STAGGER_MS = 2_000L  // L→R gap, matches the Even App
        const val HEARTBEAT_CYCLE_MS = 7_000L    // per-lens interval (Even App ~15s)

        /** Inter-packet pacing inside a re-establishment sequence. The teleprompter
         *  path proved this is load-bearing (Hud.kt: without delays the take-over
         *  succeeds but content never renders). 5 frames × this ≈ 0.75s/cycle. */
        const val REESTABLISH_PACE_MS = 150L
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(10))
            .readTimeout(Duration.ofSeconds(10))
            .build()
    }
}
