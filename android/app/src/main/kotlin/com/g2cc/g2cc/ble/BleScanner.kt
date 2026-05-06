package com.g2cc.g2cc.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * BLE scanner that finds the Even G2 lens pair.
 *
 * Per /home/user/G2CC/docs/PROTOCOL_NOTES.md §"Device naming — DUAL GLASS",
 * G2 advertises as TWO devices:
 *   "Even G2_XX_L_YYYYYY" (left)
 *   "Even G2_XX_R_YYYYYY" (right)
 *
 * Strategy:
 *   1. Use BluetoothLeScanner with ScanFilter matching the device-name prefix.
 *   2. As results come in, classify by `_L_` / `_R_` infix.
 *   3. When both sides have been seen, invoke `onPair` with the two
 *      BluetoothDevice handles.
 *   4. Caller (G2Pipeline) instantiates G2BleClient × 2 and connects.
 *
 * If the saved PairingState already has both addresses, we can short-circuit
 * scanning and connect directly. The scanner is still useful when the saved
 * pair isn't reachable (e.g. brand-new setup, or after a factory reset).
 */
class BleScanner(private val context: Context) {

    sealed interface Event {
        data class FoundPair(val left: BluetoothDevice, val right: BluetoothDevice) : Event
        data class Failure(val reason: String) : Event
    }

    private var scanCallback: ScanCallback? = null
    private var seenLeft: BluetoothDevice? = null
    private var seenRight: BluetoothDevice? = null
    private var onResult: ((Event) -> Unit)? = null

    /** Start scanning. Calls `onResult` exactly once when both lenses are seen
     *  OR a failure occurs. Caller MUST call `stop()` to release the scan. */
    @SuppressLint("MissingPermission")
    fun start(onResult: (Event) -> Unit) {
        if (scanCallback != null) {
            onResult(Event.Failure("scan already in progress"))
            return
        }
        if (!hasScanPermission()) {
            onResult(Event.Failure("BLUETOOTH_SCAN permission not granted"))
            return
        }
        val manager = context.getSystemService(BluetoothManager::class.java) ?: run {
            onResult(Event.Failure("BluetoothManager unavailable"))
            return
        }
        val adapter: BluetoothAdapter = manager.adapter ?: run {
            onResult(Event.Failure("Bluetooth adapter not available"))
            return
        }
        if (!adapter.isEnabled) {
            onResult(Event.Failure("Bluetooth is off — enable in Settings"))
            return
        }

        this.onResult = onResult
        seenLeft = null
        seenRight = null

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device
                val name = result.scanRecord?.deviceName ?: device.name ?: return
                if (!name.startsWith(G2Constants.NAME_PREFIX)) return

                when {
                    G2Constants.NAME_LEFT_INFIX in name && seenLeft == null -> {
                        seenLeft = device
                        Log.i(TAG, "found L: name=$name addr=${device.address}")
                    }
                    G2Constants.NAME_RIGHT_INFIX in name && seenRight == null -> {
                        seenRight = device
                        Log.i(TAG, "found R: name=$name addr=${device.address}")
                    }
                }

                val left = seenLeft
                val right = seenRight
                if (left != null && right != null) {
                    val cb = this@BleScanner.onResult
                    this@BleScanner.onResult = null
                    cb?.invoke(Event.FoundPair(left, right))
                }
            }

            override fun onScanFailed(errorCode: Int) {
                val cb = this@BleScanner.onResult
                this@BleScanner.onResult = null
                cb?.invoke(Event.Failure("scan failed errorCode=$errorCode"))
            }
        }
        scanCallback = callback

        // Filter on name prefix so we don't pay the cost of scanning every
        // BLE device in range. ScanSettings.SCAN_MODE_LOW_LATENCY for fast
        // discovery — the scan is ephemeral (stopped on FoundPair).
        val filters = listOf(
            ScanFilter.Builder().setDeviceName(null).build(),  // accept all (we name-filter in the callback for prefix matching)
        )
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        try {
            adapter.bluetoothLeScanner?.startScan(filters, settings, callback)
                ?: run {
                    val cb = this.onResult
                    this.onResult = null
                    cb?.invoke(Event.Failure("bluetoothLeScanner is null"))
                    return
                }
            Log.i(TAG, "scan started; looking for $${G2Constants.NAME_PREFIX}")
        } catch (e: SecurityException) {
            // LOUD failure — surface, never silent.
            Log.e(TAG, "startScan threw SecurityException", e)
            val cb = this.onResult
            this.onResult = null
            cb?.invoke(Event.Failure("startScan SecurityException: ${e.message}"))
        }
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        val cb = scanCallback ?: return
        scanCallback = null
        try {
            val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
            adapter?.bluetoothLeScanner?.stopScan(cb)
            Log.i(TAG, "scan stopped")
        } catch (e: SecurityException) {
            Log.w(TAG, "stopScan threw SecurityException", e)
        }
    }

    private fun hasScanPermission(): Boolean {
        // BLUETOOTH_SCAN required on API 31+. On earlier APIs, location was the
        // gate (handled at install time via the maxSdkVersion=30 declaration).
        return ContextCompat.checkSelfPermission(
            context, Manifest.permission.BLUETOOTH_SCAN,
        ) == PackageManager.PERMISSION_GRANTED
    }

    companion object {
        const val TAG = "G2CCBleScanner"
    }
}
