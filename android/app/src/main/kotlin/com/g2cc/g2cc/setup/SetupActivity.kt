package com.g2cc.g2cc.setup

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.g2cc.g2cc.R
import com.g2cc.g2cc.databinding.ActivitySetupBinding
import com.g2cc.g2cc.storage.Prefs

/**
 * One-time setup flow:
 *  1. Permissions explainer (delegated to MainActivity's request flow).
 *  2. Battery-optimization exemption.
 *  3. Server URL + auth token entry. The setup page on the server (g2cc-server
 *     /setup) shows multi-endpoint QR codes; the user pastes any one URL here
 *     (e.g. `http://100.107.139.121:7300/?token=<uuid>#token=<uuid>`).
 *
 * Phase 4: text-paste only. Phase 6 may add an in-app camera QR scanner via
 * ZXing once the dependency tree justifies the additional camera permission
 * scope.
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding
    private lateinit var prefs: Prefs

    private val battOptLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { _ ->
        refreshBattState()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(applicationContext)

        binding.battOptButton.setOnClickListener {
            val intent = BatteryOptimization.requestIntent(packageName)
            try {
                battOptLauncher.launch(intent)
            } catch (e: Exception) {
                // LOUD: log + fall back to the settings list. Don't silently swallow.
                Log.w(TAG, "direct battery-opt request failed; falling back to settings list", e)
                battOptLauncher.launch(BatteryOptimization.settingsIntent())
            }
        }

        binding.saveButton.setOnClickListener { saveFromForm() }
        binding.pasteUrlButton.setOnClickListener { pasteAndParseUrl() }

        // Pre-populate from existing prefs.
        prefs.serverUrl?.let { binding.urlField.setText(it) }
        prefs.authToken?.let { binding.tokenField.setText(it) }
        refreshBattState()
    }

    private fun refreshBattState() {
        val ok = BatteryOptimization.isExempt(this)
        binding.battStatus.text = getString(
            if (ok) R.string.setup_batt_ok else R.string.setup_batt_pending,
        )
    }

    private fun pasteAndParseUrl() {
        val cm = getSystemService(android.content.ClipboardManager::class.java)
        val raw = cm?.primaryClip?.getItemAt(0)?.text?.toString().orEmpty().trim()
        if (raw.isEmpty()) {
            toast(R.string.setup_clipboard_empty)
            return
        }
        val parsed = parseSetupUrl(raw)
        if (parsed == null) {
            toast(R.string.setup_url_invalid)
            return
        }
        val (url, token) = parsed
        binding.urlField.setText(url)
        binding.tokenField.setText(token)
    }

    private fun saveFromForm() {
        val url = binding.urlField.text.toString().trim()
        val token = binding.tokenField.text.toString().trim()
        if (url.isEmpty() || token.isEmpty()) {
            toast(R.string.setup_missing_fields)
            return
        }
        prefs.serverUrl = url
        prefs.authToken = token
        toast(R.string.setup_saved)
        finish()
    }

    private fun toast(@androidx.annotation.StringRes id: Int) {
        Toast.makeText(this, id, Toast.LENGTH_SHORT).show()
    }

    private fun parseSetupUrl(raw: String): Pair<String, String>? {
        // Expected: http(s)://host:port/?token=<uuid>#token=<uuid>
        // We accept either ?token= or #token=; either is valid (g2aria's setup-page
        // duplicates into both for WebView strip-resilience).
        val uri = try { Uri.parse(raw) } catch (e: Exception) {
            Log.w(TAG, "Uri.parse failed", e); return null
        }
        if (uri.scheme !in setOf("http", "https", "ws", "wss")) return null
        val authority = uri.authority ?: return null

        val token = uri.getQueryParameter("token")
            ?: uri.fragment?.substringAfter("token=", "")?.takeIf { it.isNotEmpty() }
            ?: return null

        // Convert http→ws / https→wss for storage; ConnectionManager (Phase 6)
        // expects a ws(s) URL.
        val scheme = when (uri.scheme) {
            "http" -> "ws"
            "https" -> "wss"
            else -> uri.scheme!!
        }
        return "$scheme://$authority/ws" to token
    }

    companion object {
        const val TAG = "G2CCSetup"
    }
}
