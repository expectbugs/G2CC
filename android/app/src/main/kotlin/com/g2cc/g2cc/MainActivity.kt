package com.g2cc.g2cc

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.g2cc.g2cc.databinding.ActivityMainBinding
import com.g2cc.g2cc.service.G2CCService
import com.g2cc.g2cc.setup.BatteryOptimization
import com.g2cc.g2cc.setup.SetupActivity
import com.g2cc.g2cc.storage.Prefs

/** Top-level entry. Status display + a "Start service" button + a "Setup" button.
 *  Real BLE / WebSocket UI lands in Phase 6. */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        val allGranted = grants.values.all { it }
        if (allGranted) {
            startServiceIfConfigured()
        } else {
            val missing = grants.filterValues { !it }.keys
            binding.statusText.text = getString(R.string.status_perm_missing, missing.joinToString())
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(applicationContext)

        binding.setupButton.setOnClickListener {
            startActivity(Intent(this, SetupActivity::class.java))
        }
        binding.startButton.setOnClickListener {
            requestAndStart()
        }
        binding.stopButton.setOnClickListener {
            G2CCService.stop(this)
            refreshStatus()
        }
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun refreshStatus() {
        val configured = prefs.serverUrl != null && prefs.authToken != null
        val battOk = BatteryOptimization.isExempt(this)
        val running = G2CCService.isRunning
        binding.statusText.text = buildString {
            append(getString(R.string.status_running, if (running) "yes" else "no"))
            append('\n')
            append(getString(R.string.status_configured, if (configured) "yes" else "no"))
            append('\n')
            append(getString(R.string.status_battery_exempt, if (battOk) "yes" else "no"))
            prefs.serverUrl?.let { append("\nserver: $it") }
        }
    }

    private fun requestAndStart() {
        val needed = mutableListOf<String>().apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_CONNECT)
                add(Manifest.permission.BLUETOOTH_SCAN)
            } else {
                @Suppress("DEPRECATION")
                add(Manifest.permission.ACCESS_FINE_LOCATION)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
            // Phase 8: RECORD_AUDIO required for DJI USB capture + phone-mic fallback.
            add(Manifest.permission.RECORD_AUDIO)
        }
        val toRequest = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (toRequest.isEmpty()) {
            startServiceIfConfigured()
        } else {
            permissionLauncher.launch(toRequest.toTypedArray())
        }
    }

    private fun startServiceIfConfigured() {
        if (prefs.serverUrl == null || prefs.authToken == null) {
            binding.statusText.text = getString(R.string.status_unconfigured)
            return
        }
        if (!BatteryOptimization.isExempt(this)) {
            // LOUD: surface the missing exemption rather than silently starting a
            // service that will be killed by doze later.
            binding.statusText.text = getString(R.string.status_battery_required)
            return
        }
        G2CCService.start(this)
        refreshStatus()
    }
}
