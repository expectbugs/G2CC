package com.g2cc.g2cc.probe

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.util.TypedValue
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import com.g2cc.g2cc.ble.BleScanner
import com.g2cc.g2cc.ble.ConnectionState
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.PairingState
import com.g2cc.g2cc.ble.Side
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Standalone activity for testing the `0x6402` raw display + `0x01-01` raw
 * input hypothesis.
 *
 * Background: after the Phase Y hardware test failed (News mode is a sub-
 * feature of the default HUD, not a self-contained takeover) and Adam's
 * report that teleprompter mode consumes ring inputs as font-size/scroll
 * controls, we need a path to take over the glasses fully. The `0x6402`
 * characteristic is documented as "Display Rendering, 204-byte packets,
 * unknown structure" — if we can write to it directly WITHOUT activating
 * Teleprompter (which captures all inputs), AND ring events on `0x01-01`
 * notify continue to reach us, we have raw display + raw input.
 *
 * This activity does NOT use the foreground service. It's a one-shot
 * experimental flow:
 *   1. Adam taps Connect
 *   2. Scan (or use saved-pair address) → BLE connect both lenses
 *   3. Run the 7-packet auth handshake (reused from production G2BleClient)
 *   4. After both lenses Ready, run a probe sequence on the R lens:
 *      - Send a series of writes to 0x6402 with different sizes / patterns
 *      - Subscribe to all notifies on 0x5402 + 0x6402
 *      - 30-second observation window so Adam can try ring scroll/tap
 *   5. All BLE events + probe activity log live to the on-screen TextView
 *
 * Adam observes:
 *   - Did anything appear on the glasses for each probe?
 *   - Did ring scroll/tap events log during the observation window?
 *
 * No foreground service, no audio, no menu, no Phase Ω. Just BLE +
 * controlled writes + logging. Clean revert: uninstall this APK, reinstall
 * the real G2CC.
 */
class ProbeActivity : ComponentActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var statusText: TextView
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var connectBtn: Button
    private lateinit var probeBtn: Button
    private lateinit var disconnectBtn: Button
    private lateinit var pairing: PairingState

    private var leftBle: G2BleClient? = null
    private var rightBle: G2BleClient? = null
    private var scanner: BleScanner? = null
    private var leftStateJob: Job? = null
    private var rightStateJob: Job? = null
    private var leftEventJob: Job? = null
    private var rightEventJob: Job? = null
    private var leftDisplayJob: Job? = null
    private var rightDisplayJob: Job? = null
    private var probeJob: Job? = null

    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pairing = PairingState(applicationContext)
        setContentView(buildUi())
        log("ProbeActivity ready. Tap Connect to start.")
        log("Saved pair: L=${pairing.leftAddress ?: "(none)"} R=${pairing.rightAddress ?: "(none)"}")
        if (!hasRequiredPermissions()) {
            log("WARN: BLE permissions not granted yet — grant via the main G2CC app first, then re-launch Probe.")
        }
    }

    private fun buildUi(): ViewGroup {
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            setPadding(24, 24, 24, 24)
        }
        statusText = TextView(this).apply {
            text = "Status: Disconnected"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setPadding(0, 0, 0, 16)
        }
        outer.addView(statusText)

        val buttonRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        connectBtn = Button(this).apply {
            text = "Connect"
            setOnClickListener { startConnect() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        probeBtn = Button(this).apply {
            text = "Probe"
            isEnabled = false
            setOnClickListener { startProbeSequence() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        disconnectBtn = Button(this).apply {
            text = "Disconnect"
            isEnabled = false
            setOnClickListener { disconnect() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        buttonRow.addView(connectBtn)
        buttonRow.addView(probeBtn)
        buttonRow.addView(disconnectBtn)
        outer.addView(buttonRow)

        logScroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            )
            setPadding(0, 16, 0, 0)
        }
        logText = TextView(this).apply {
            setTextColor(Color.argb(255, 200, 230, 200))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            typeface = android.graphics.Typeface.MONOSPACE
            movementMethod = ScrollingMovementMethod()
        }
        logScroll.addView(logText)
        outer.addView(logScroll)
        return outer
    }

    private fun log(s: String) {
        val ts = timeFmt.format(Date())
        runOnUiThread {
            logText.append("[$ts] $s\n")
            logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    private fun setStatus(s: String) {
        runOnUiThread { statusText.text = "Status: $s" }
    }

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
            log("Using saved pair addresses: L=${pairing.leftAddress} R=${pairing.rightAddress}")
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
        val lc = G2BleClient(this, Side.Left)
        val rc = G2BleClient(this, Side.Right)
        leftBle = lc
        rightBle = rc
        // Watch state for both lenses. When both reach Ready, enable Probe.
        leftStateJob = scope.launch { lc.state.collect { onLensState(Side.Left, it) } }
        rightStateJob = scope.launch { rc.state.collect { onLensState(Side.Right, it) } }
        // Watch ring events — every parsed Event prints with class name + raw notify hex.
        leftEventJob = scope.launch { lc.events.collect { log("[L 5402] event ${it::class.simpleName} | lastNotifyHex=${lc.lastNotifyHex}") } }
        rightEventJob = scope.launch { rc.events.collect { log("[R 5402] event ${it::class.simpleName} | lastNotifyHex=${rc.lastNotifyHex}") } }
        // Watch display-char notifies if any.
        leftDisplayJob = scope.launch { lc.displayNotifies.collect { log("[L 6402] notify ${it.size}B ${hex(it)}") } }
        rightDisplayJob = scope.launch { rc.displayNotifies.collect { log("[R 6402] notify ${it.size}B ${hex(it)}") } }
        lc.connectTo(leftDev)
        rc.connectTo(rightDev)
    }

    private var leftReady = false
    private var rightReady = false

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
                setStatus("Both lenses Auth'd. Tap Probe to run sequence.")
                val rc = rightBle
                log("Display char availability: L=${leftBle?.isDisplayCharAvailable} R=${rc?.isDisplayCharAvailable}")
                runOnUiThread { probeBtn.isEnabled = true }
            } else {
                setStatus("${if (leftReady) "L✓" else "L?"} ${if (rightReady) "R✓" else "R?"}")
            }
        }
        if (s is ConnectionState.Error || s is ConnectionState.Disconnected) {
            if (side == Side.Left) leftReady = false else rightReady = false
        }
    }

    private fun startProbeSequence() {
        probeBtn.isEnabled = false
        probeJob?.cancel()
        probeJob = scope.launch(Dispatchers.Default) {
            runProbeSequence()
            withContext(Dispatchers.Main) {
                setStatus("Probe done. Try ring scroll/tap; watch log.")
                probeBtn.isEnabled = true
            }
        }
    }

    private suspend fun runProbeSequence() {
        val rc = rightBle
        if (rc == null) {
            log("Probe abort: right lens null")
            return
        }
        if (!rc.isDisplayCharAvailable) {
            log("WARN: R lens display char (0x6402) NOT available — probe writes will no-op")
            log("Service-discovery dump for R: ${rc.lastDiagnostic}")
            // Still run the observation window so we can see if ring events come through.
        }
        log("=== Probe sequence start ===")
        // Brief settle so the log starts with no ambient writes mixed in.
        delay(2_000)
        val patterns = listOf(
            "A_zeros_32"   to ByteArray(32) { 0x00 },
            "B_ffs_32"     to ByteArray(32) { 0xFF.toByte() },
            "C_alt_64"     to ByteArray(64) { i -> if (i % 2 == 0) 0xAA.toByte() else 0x55.toByte() },
            "D_zeros_204"  to ByteArray(204) { 0x00 },
            "E_aa_frame"   to buildAaFrameProbe(),
            "F_ramp_128"   to ByteArray(128) { i -> (i and 0xFF).toByte() },
        )
        for ((label, bytes) in patterns) {
            log("--- Probe $label (${bytes.size}B): ${hex(bytes.take(16).toByteArray())}${if (bytes.size > 16) "…" else ""}")
            val ok = rc.sendDisplayPacket(bytes, label)
            log("Probe $label enqueued=$ok")
            delay(3_000)        // give Adam time to observe
        }
        log("=== Probe writes done — opening 30s ring-input observation window ===")
        log("Now try ring scroll up, scroll down, and tap. All notifies will log.")
        delay(30_000)
        log("=== Observation window closed ===")
    }

    /** A test packet shaped like the standard AA-framed envelope, in case
     *  0x6402 uses the same wire format as 0x5401. Service ID set to
     *  0x0000 so it doesn't activate any known feature. */
    private fun buildAaFrameProbe(): ByteArray {
        // Header: AA 21 [seq] [len+2] [pkt_tot=1] [pkt_ser=1] [svc_hi=00] [svc_lo=00]
        // Payload: 16 bytes of 0x42 ("test marker")
        val payload = ByteArray(16) { 0x42 }
        val header = byteArrayOf(
            0xAA.toByte(),
            0x21,
            0x99.toByte(),
            (payload.size + 2).toByte(),
            0x01,
            0x01,
            0x00,
            0x00,
        )
        // CRC: skip the proper computation for this experimental probe — just
        // append two arbitrary bytes. If the firmware validates CRC, this will
        // be rejected (which is itself useful diagnostic info).
        return header + payload + byteArrayOf(0xDE.toByte(), 0xAD.toByte())
    }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    @SuppressLint("MissingPermission")
    private fun disconnect() {
        log("Disconnect requested")
        probeJob?.cancel()
        scanner?.stop()
        scanner = null
        leftStateJob?.cancel(); leftStateJob = null
        rightStateJob?.cancel(); rightStateJob = null
        leftEventJob?.cancel(); leftEventJob = null
        rightEventJob?.cancel(); rightEventJob = null
        leftDisplayJob?.cancel(); leftDisplayJob = null
        rightDisplayJob?.cancel(); rightDisplayJob = null
        leftBle?.shutdownBle()
        rightBle?.shutdownBle()
        leftBle = null
        rightBle = null
        leftReady = false
        rightReady = false
        setStatus("Disconnected")
        connectBtn.isEnabled = true
        probeBtn.isEnabled = false
        disconnectBtn.isEnabled = false
    }

    override fun onDestroy() {
        super.onDestroy()
        disconnect()
        scope.cancel()
    }

    companion object {
        const val TAG = "G2CCProbe"
    }
}
