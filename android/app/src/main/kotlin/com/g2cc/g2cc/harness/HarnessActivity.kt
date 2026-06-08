package com.g2cc.g2cc.harness

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.IBinder
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
import com.g2cc.g2cc.render.Scene
import com.g2cc.g2cc.service.ConnectionService
import com.g2cc.g2cc.setup.BatteryOptimization
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Thin UI client for [ConnectionService].
 *
 * The connection loop (BLE scan/auth, renderer, keepalive, 80-00 sync, watchdog, ~80 s
 * renewal, clock, the conflated render pump, server-mode WS, and auto-recovery) lives in
 * the foreground service so it survives the harness being backgrounded / pocketed / hidden
 * behind the SSH terminal — the whole point of the recovery fix. This Activity just builds
 * the UI, binds to observe the service's [kotlinx.coroutines.flow.StateFlow]s, forwards
 * button taps as commands, and renders the on-phone expected-mirror.
 *
 *  - **Connect**: request perms + battery-opt exemption, then start+connect the service.
 *  - **Test / Server / Disconnect**: forwarded to the service.
 *  - **Diag**: toggles [DiagLog.enabled] (the service owns the upload pump).
 *
 * Token + Tailscale server are baked in via BuildConfig (gitignored).
 */
class HarnessActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var connectBtn: Button
    private lateinit var testBtn: Button
    private lateinit var serverBtn: Button
    private lateinit var disconnectBtn: Button
    private lateinit var diagCheck: CheckBox
    private lateinit var boundsCheck: CheckBox
    private lateinit var mirror: ImageView

    private var svc: ConnectionService? = null
    private var bound = false
    private val uiJobs = mutableListOf<Job>()
    private var lastScene: Scene? = null   // re-render the mirror when the bounds toggle flips

    private data class Btns(val launched: Boolean, val connecting: Boolean, val serverMode: Boolean, val testing: Boolean)

    private val serviceConn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val s = (binder as? ConnectionService.LocalBinder)?.service ?: return
            svc = s
            bound = true
            DiagLog.log("svc", "bound to ConnectionService")
            observeService(s)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            DiagLog.log("svc", "ConnectionService disconnected (process gone?)")
            svc = null
            bound = false
        }
    }

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { _ ->
        // POST_NOTIFICATIONS denial is non-fatal (the FG-service notification is exempt);
        // only the BLE perms gate the connect.
        val stillMissing = missingBlePermissions()
        if (stillMissing.isEmpty()) proceedConnect()
        else setStatus("BLE permissions denied: ${stillMissing.joinToString()}")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        DiagLog.log("app", "harness onCreate — server ${BuildConfig.SERVER_HOST}:${BuildConfig.SERVER_PORT}, token=${if (BuildConfig.AUTH_TOKEN.isEmpty()) "MISSING" else "set"}")
        diagCheck.setOnCheckedChangeListener { _, c ->
            DiagLog.enabled = c
            DiagLog.log("ui", "Diag streaming ${if (c) "ON" else "OFF"}")
        }
        boundsCheck.setOnCheckedChangeListener { _, _ -> updateMirror(lastScene) }
        connectBtn.setOnClickListener { DiagLog.log("btn", "Connect tapped"); onConnectTap() }
        testBtn.setOnClickListener { DiagLog.log("btn", "Test tapped"); svc?.runTest() }
        serverBtn.setOnClickListener { DiagLog.log("btn", "Server tapped"); svc?.enterServerMode() }
        disconnectBtn.setOnClickListener { DiagLog.log("btn", "Disconnect tapped (MANUAL)"); onDisconnectTap() }
        applyButtons(Btns(false, false, false, false))
        updateMirror(null)
    }

    override fun onStart() {
        super.onStart()
        // Re-attach to an already-running service (e.g. the app was reopened while the
        // service kept the session alive in the background). flag 0 → observe only; do
        // NOT create the service just by opening the app.
        if (ConnectionService.isRunning && !bound) bindToService(autoCreate = false)
    }

    override fun onStop() {
        // Stop OBSERVING; the started/foreground service keeps running in the background.
        unbindAndClear()
        super.onStop()
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

    private fun applyButtons(b: Btns) {
        connectBtn.isEnabled = !b.launched && !b.connecting
        testBtn.isEnabled = b.launched && !b.serverMode && !b.testing
        serverBtn.isEnabled = b.launched && !b.serverMode
        disconnectBtn.isEnabled = b.launched || b.connecting
    }

    private fun updateMirror(s: Scene?) {
        mirror.setImageBitmap(ExpectedMirror.render(s, boundsCheck.isChecked))
    }

    // ----------------------------------------------------------------- service binding + observe

    private fun observeService(s: ConnectionService) {
        uiJobs.forEach { it.cancel() }; uiJobs.clear()
        uiJobs += lifecycleScope.launch { s.status.collect { setStatus(it) } }
        uiJobs += lifecycleScope.launch { s.sceneFlow.collect { lastScene = it; updateMirror(it) } }
        uiJobs += lifecycleScope.launch {
            combine(s.launched, s.connecting, s.serverMode, s.testing) { l, c, sm, t -> Btns(l, c, sm, t) }
                .collect { applyButtons(it) }
        }
    }

    private fun bindToService(autoCreate: Boolean) {
        if (bound) return
        val flags = if (autoCreate) Context.BIND_AUTO_CREATE else 0
        try {
            if (!bindService(Intent(this, ConnectionService::class.java), serviceConn, flags)) {
                DiagLog.log("svc", "bindService returned false (service not running?)")
            }
        } catch (e: Exception) {
            DiagLog.log("svc", "bindService failed: $e")
            setStatus("Service bind failed: ${e.message}")
        }
    }

    private fun unbindAndClear() {
        uiJobs.forEach { it.cancel() }; uiJobs.clear()
        if (bound) {
            try {
                unbindService(serviceConn)
            } catch (e: IllegalArgumentException) {
                // Not actually bound (e.g. service already gone) — benign, log don't crash.
                DiagLog.log("svc", "unbind: not bound ($e)")
            }
            bound = false
        }
        svc = null
    }

    // ----------------------------------------------------------------- commands

    private fun onConnectTap() {
        val toRequest = permsToRequest()
        if (toRequest.isNotEmpty()) {
            DiagLog.log("perm", "requesting ${toRequest.joinToString()}")
            permLauncher.launch(toRequest.toTypedArray())
            return
        }
        proceedConnect()
    }

    private fun proceedConnect() {
        // Battery-opt exemption is REQUIRED — without it Doze kills even the FG service.
        // Prompt (non-blocking) if not yet granted; surface the risk, don't block the user.
        if (!BatteryOptimization.isExempt(this)) {
            DiagLog.log("setup", "battery-opt NOT exempt — prompting (Doze can kill the FG service without it)")
            setStatus("Grant battery-optimization exemption so the service survives Doze, then it'll connect…")
            try {
                startActivity(BatteryOptimization.requestIntent(packageName))
            } catch (e: Exception) {
                try {
                    startActivity(BatteryOptimization.settingsIntent())
                } catch (e2: Exception) {
                    DiagLog.log("setup", "battery-opt prompt failed: $e2")
                }
            }
        }
        ConnectionService.startAndConnect(this)
        bindToService(autoCreate = true)
    }

    private fun onDisconnectTap() {
        val s = svc
        if (s != null) s.disconnect() else DiagLog.log("conn", "disconnect tapped but service not bound")
        unbindAndClear()
        setStatus("Disconnected.")
        lastScene = null
        updateMirror(null)
        applyButtons(Btns(false, false, false, false))
    }

    // ----------------------------------------------------------------- permissions

    private fun blePermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun missingBlePermissions(): List<String> =
        blePermissions().filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }

    /** BLE perms (the connect gate) + POST_NOTIFICATIONS on API 33+ (best-effort, non-gating). */
    private fun permsToRequest(): List<String> {
        val l = missingBlePermissions().toMutableList()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            l += Manifest.permission.POST_NOTIFICATIONS
        }
        return l
    }
}
