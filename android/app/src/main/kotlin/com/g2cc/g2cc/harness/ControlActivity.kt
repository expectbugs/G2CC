package com.g2cc.g2cc.harness

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Color
import android.os.Bundle
import android.os.IBinder
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.service.ConnectionService
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Phone control mode (multi-surface 2026-07-13, APK v1.18): the phone BECOMES
 * the glasses — a landscape-fullscreen [ControlMirrorView] fills the screen and
 * tap / double-tap / drag drive the SAME OS session (ring parity), plus a
 * summonable keyboard for typed text (`input{event:'text'}` — Enter IS the
 * confirm). Works with NO glasses: onStart enters the service's control mode,
 * which runs the WS + mirror renderer-less.
 *
 * Overlay chrome (all programmatic Views — house style, no Compose):
 *  - slim status line top-left ([ConnectionService.status]) + a RED error line
 *    for control failures (input dropped / send failed) — loud, never silent;
 *  - bottom-right buttons: ⌨ keyboard toggle, ⟳ Soft Reset, ⏻ Hard Reset —
 *    both resets behind an AlertDialog confirm (stray-tap safety, the Scout
 *    on-glass lesson);
 *  - a hidden bottom input row (EditText imeOptions=actionSend + Send) the ⌨
 *    button summons; failed sends KEEP the text (no data loss, red status).
 *
 * The harness stays the diagnostics screen; this Activity is display+input only.
 */
class ControlActivity : AppCompatActivity() {

    private lateinit var mirror: ControlMirrorView
    private lateinit var statusText: TextView
    private lateinit var errorText: TextView
    private lateinit var inputRow: LinearLayout
    private lateinit var input: EditText

    private var svc: ConnectionService? = null
    private var bound = false
    private val uiJobs = mutableListOf<Job>()

    private val serviceConn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val s = (binder as? ConnectionService.LocalBinder)?.service ?: return
            svc = s
            bound = true
            DiagLog.log("ctrl", "ControlActivity bound to ConnectionService")
            observeService(s)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            DiagLog.log("ctrl", "ConnectionService disconnected (process gone?)")
            svc = null
            bound = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        // Fullscreen immersive: the mirror IS the screen. Bars come back with a
        // swipe and auto-hide again (transient behavior).
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, mirror).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        DiagLog.log("ctrl", "control activity onCreate")
    }

    override fun onStart() {
        super.onStart()
        // Control mode must work with no glasses: start (or poke) the FG service
        // in control mode, then bind to observe — the HarnessActivity pattern.
        ConnectionService.startForControl(this)
        bindToService()
    }

    override fun onStop() {
        // Stop observing; the FG service (and the OS session) keeps running.
        unbindAndClear()
        super.onStop()
    }

    // ----------------------------------------------------------------- UI

    private fun buildUi(): ViewGroup {
        val dp = resources.displayMetrics.density
        val pad = (8 * dp).toInt()
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        mirror = ControlMirrorView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
            )
            onInput = { sendInput(it) }
        }
        root.addView(mirror)

        // Slim status column, top-left: service status + a red control-error line.
        statusText = TextView(this).apply {
            setTextColor(Color.parseColor("#9aa0a6"))
            textSize = 12f
            text = "binding…"
        }
        errorText = TextView(this).apply {
            setTextColor(Color.parseColor("#ff5252"))
            textSize = 12f
            visibility = View.GONE
        }
        val statusCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, pad / 2)
            setBackgroundColor(Color.parseColor("#66000000"))
            addView(statusText)
            addView(errorText)
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.START,
            )
        }
        root.addView(statusCol)

        // Overlay buttons, bottom-right: keyboard toggle + the two resets.
        fun overlayButton(glyph: String, describe: String, onTap: () -> Unit) = Button(this).apply {
            text = glyph
            textSize = 16f
            contentDescription = describe
            minWidth = (48 * dp).toInt()
            minimumWidth = (48 * dp).toInt()
            alpha = 0.75f
            setOnClickListener { onTap() }
        }
        val kbdBtn = overlayButton("⌨", "Toggle keyboard") { toggleKeyboard() }
        val softBtn = overlayButton("⟳", "Soft Reset — refresh the glasses connection") { confirmSoftReset() }
        val hardBtn = overlayButton("⏻", "Hard Reset — restart the whole G2CC system") { confirmHardReset() }
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(kbdBtn); addView(softBtn); addView(hardBtn)
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END,
            ).apply { setMargins(0, 0, pad, pad) }
        }
        root.addView(btnRow)

        // Summonable typed-text row (hidden until ⌨). Enter/Send → input{event:'text'}.
        input = EditText(this).apply {
            hint = "type to the active window…"
            setHintTextColor(Color.parseColor("#5f6368"))
            setTextColor(Color.WHITE)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
            // actionSend + NO extract/fullscreen so the landscape IME keeps the
            // mirror + this row visible instead of a fullscreen editor.
            imeOptions = EditorInfo.IME_ACTION_SEND or
                EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
            maxLines = 3
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEND) { sendTyped(); true } else false
            }
        }
        val sendBtn = Button(this).apply {
            text = "Send"
            setOnClickListener { sendTyped() }
        }
        inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#cc101014"))
            setPadding(pad, pad / 2, pad, pad / 2)
            addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(sendBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            )
        }
        root.addView(inputRow)

        // Keep the input row above the IME (edge-to-edge window → manual inset).
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            inputRow.translationY = -ime.bottom.toFloat()
            insets
        }
        return root
    }

    // ----------------------------------------------------------------- commands

    /** Touch input → service. False (no WS) → red status; success clears it. */
    private fun sendInput(msg: ClientMessage.Input) {
        val s = svc
        val ok = s?.sendControlInput(msg) == true
        if (!ok) {
            showError(if (s == null) "input dropped — service not bound" else "input dropped — WS reconnecting")
        } else {
            clearError()
        }
    }

    /** Typed line → input{event:'text'}. The text is kept on failure — a
     *  reconnect blip must never eat a typed prompt (no silent data loss). */
    private fun sendTyped() {
        val text = input.text.toString()
        if (text.isEmpty()) return
        val s = svc
        val ok = s?.sendTextInput(text) == true
        if (ok) {
            input.setText("")
            clearError()
        } else {
            showError(if (s == null) "send failed — service not bound (text kept)" else "send failed — WS reconnecting (text kept)")
        }
    }

    private fun toggleKeyboard() {
        if (inputRow.visibility == View.VISIBLE) {
            WindowInsetsControllerCompat(window, input).hide(WindowInsetsCompat.Type.ime())
            inputRow.visibility = View.GONE
        } else {
            inputRow.visibility = View.VISIBLE
            input.requestFocus()
            WindowInsetsControllerCompat(window, input).show(WindowInsetsCompat.Type.ime())
        }
    }

    /** Both resets confirm first — stray-tap safety on a fullscreen touch surface. */
    private fun confirmSoftReset() {
        AlertDialog.Builder(this)
            .setTitle("Soft Reset")
            .setMessage("Refresh the glasses BLE connection? The session and this mirror keep running.")
            .setPositiveButton("Reset") { _, _ ->
                val s = svc
                if (s == null) showError("soft reset failed — service not bound")
                else { clearError(); s.softReset() }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun confirmHardReset() {
        AlertDialog.Builder(this)
            .setTitle("Hard Reset")
            .setMessage(
                "Restart the ENTIRE G2CC system to a clean state?\n\n" +
                    "All durable data is kept — reader positions, timers, history, " +
                    "CC session resume. Only live state resets (boots at Main).",
            )
            .setPositiveButton("Hard Reset") { _, _ ->
                val s = svc
                if (s == null) showError("hard reset failed — service not bound")
                else { clearError(); s.requestHardReset() }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showError(msg: String) {
        DiagLog.log("ctrl", "ERROR line: $msg")
        errorText.text = msg
        errorText.visibility = View.VISIBLE
    }

    private fun clearError() {
        if (errorText.visibility != View.GONE) {
            errorText.visibility = View.GONE
            errorText.text = ""
        }
    }

    // ----------------------------------------------------------------- service binding + observe

    private fun observeService(s: ConnectionService) {
        uiJobs.forEach { it.cancel() }; uiJobs.clear()
        uiJobs += lifecycleScope.launch { s.status.collect { statusText.text = it } }
        uiJobs += lifecycleScope.launch {
            s.sceneFlow.collect { sc ->
                // One render feeds BOTH pixels and hit-testing (outlines OFF —
                // the mirror matches the glasses; MirrorGeometry aligns rows).
                mirror.setScene(sc, ExpectedMirror.render(sc, outlines = false))
            }
        }
    }

    private fun bindToService() {
        if (bound) return
        try {
            if (!bindService(Intent(this, ConnectionService::class.java), serviceConn, Context.BIND_AUTO_CREATE)) {
                DiagLog.log("ctrl", "bindService returned false")
                showError("service bind failed")
            }
        } catch (e: Exception) {
            DiagLog.log("ctrl", "bindService failed: $e")
            showError("service bind failed: ${e.message}")
        }
    }

    private fun unbindAndClear() {
        uiJobs.forEach { it.cancel() }; uiJobs.clear()
        if (bound) {
            try {
                unbindService(serviceConn)
            } catch (e: IllegalArgumentException) {
                DiagLog.log("ctrl", "unbind: not bound ($e)")
            }
            bound = false
        }
        svc = null
    }
}
