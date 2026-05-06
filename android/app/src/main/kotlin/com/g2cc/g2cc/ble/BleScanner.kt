package com.g2cc.g2cc.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicReference

/**
 * BLE scanner that finds the Even G2 lens pair.
 *
 * Per /home/user/G2CC/docs/PROTOCOL_NOTES.md §"Device naming — DUAL GLASS",
 * G2 advertises as TWO devices:
 *   "Even G2_XX_L_YYYYYY" (left)
 *   "Even G2_XX_R_YYYYYY" (right)
 *
 * Strategy:
 *   1. Use BluetoothLeScanner with no filter (we name-match in the callback;
 *      ScanFilter doesn't support prefix matching).
 *   2. As results come in, classify by `_L_` / `_R_` infix.
 *   3. When both sides have been seen, invoke `onResult` exactly once with
 *      the two BluetoothDevice handles.
 *   4. Caller (G2Pipeline) instantiates G2BleClient × 2 and connects.
 *
 * Concurrency: scan results arrive on the BLE handler thread; multiple results
 * may be processed before we can clear `onResult`. AtomicReference + getAndSet
 * ensures exactly one callback invocation wins (bug-fix-pass-2 #1).
 *
 * Permission gating (bug-fix-pass-2 #4):
 *   - API 31+: BLUETOOTH_SCAN
 *   - API 29-30: ACCESS_FINE_LOCATION (BLE scanning legacy requirement)
 */
class BleScanner(private val context: Context) {

    sealed interface Event {
        data class FoundPair(val left: BluetoothDevice, val right: BluetoothDevice) : Event
        data class Failure(val reason: String) : Event
    }

    private val scanCallbackRef = AtomicReference<ScanCallback?>(null)
    private val onResultRef = AtomicReference<((Event) -> Unit)?>(null)
    private val seenLeft = AtomicReference<BluetoothDevice?>(null)
    private val seenRight = AtomicReference<BluetoothDevice?>(null)

    /** Start scanning. Calls `onResult` exactly once when both lenses are seen
     *  OR a failure occurs. The scanner self-stops on FoundPair / failure;
     *  callers that need to abort early call `stop()` explicitly. */
    @SuppressLint("MissingPermission")
    fun start(onResult: (Event) -> Unit) {
        if (scanCallbackRef.get() != null) {
            onResult(Event.Failure("scan already in progress"))
            return
        }
        val perm = checkPermissions()
        if (perm != null) {
            onResult(Event.Failure(perm))
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

        onResultRef.set(onResult)
        seenLeft.set(null)
        seenRight.set(null)

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device
                val name = result.scanRecord?.deviceName ?: try {
                    device.name
                } catch (e: SecurityException) {
                    null
                } ?: return
                if (!name.startsWith(G2Constants.NAME_PREFIX)) return

                when {
                    G2Constants.NAME_LEFT_INFIX in name -> {
                        if (seenLeft.compareAndSet(null, device)) {
                            Log.i(TAG, "found L: name=$name addr=${device.address}")
                        }
                    }
                    G2Constants.NAME_RIGHT_INFIX in name -> {
                        if (seenRight.compareAndSet(null, device)) {
                            Log.i(TAG, "found R: name=$name addr=${device.address}")
                        }
                    }
                }

                val left = seenLeft.get()
                val right = seenRight.get()
                if (left != null && right != null) {
                    // Atomic getAndSet ensures the callback fires at most once
                    // even if multiple scan results race here.
                    val cb = onResultRef.getAndSet(null) ?: return
                    stopInternal()
                    cb(Event.FoundPair(left, right))
                }
            }

            override fun onScanFailed(errorCode: Int) {
                val cb = onResultRef.getAndSet(null) ?: return
                stopInternal()                       // bug-fix-pass-2 #3: clean up on failure
                cb(Event.Failure("scan failed errorCode=$errorCode"))
            }
        }
        scanCallbackRef.set(callback)

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        try {
            // bug-fix-pass-2 #5: pass an empty filter list; we name-match in the
            // callback. ScanFilter doesn't support prefix matching, and filtering
            // on the service UUID is unverified (G2 may not advertise it in scan
            // response data per PROTOCOL_NOTES.md §"Open research items").
            adapter.bluetoothLeScanner?.startScan(emptyList(), settings, callback)
                ?: run {
                    onResultRef.set(null)
                    scanCallbackRef.set(null)
                    onResult(Event.Failure("bluetoothLeScanner is null"))
                    return
                }
            Log.i(TAG, "scan started; looking for ${G2Constants.NAME_PREFIX}")
        } catch (e: SecurityException) {
            Log.e(TAG, "startScan threw SecurityException", e)
            scanCallbackRef.set(null)
            val cb = onResultRef.getAndSet(null) ?: return
            cb(Event.Failure("startScan SecurityException: ${e.message}"))
        }
    }

    /** Stop the in-flight scan and drop any pending callback. Safe to call multiple times. */
    fun stop() {
        // If a caller called `stop()` before the scan resolved, drop the pending callback
        // so it doesn't fire late.
        onResultRef.set(null)
        stopInternal()
    }

    @SuppressLint("MissingPermission")
    private fun stopInternal() {
        val cb = scanCallbackRef.getAndSet(null) ?: return
        try {
            val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
            adapter?.bluetoothLeScanner?.stopScan(cb)
            Log.i(TAG, "scan stopped")
        } catch (e: SecurityException) {
            Log.w(TAG, "stopScan threw SecurityException", e)
        }
    }

    /** Returns null if all required permissions are granted; otherwise an error message. */
    private fun checkPermissions(): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // API 31+: BLUETOOTH_SCAN required.
            if (ContextCompat.checkSelfPermission(
                    context, Manifest.permission.BLUETOOTH_SCAN,
                ) != PackageManager.PERMISSION_GRANTED
            ) return "BLUETOOTH_SCAN permission not granted"
        } else {
            // API 29-30: ACCESS_FINE_LOCATION required for BLE scanning.
            if (ContextCompat.checkSelfPermission(
                    context, Manifest.permission.ACCESS_FINE_LOCATION,
                ) != PackageManager.PERMISSION_GRANTED
            ) return "ACCESS_FINE_LOCATION permission not granted (required for BLE scan on API < 31)"
        }
        return null
    }

    companion object {
        const val TAG = "G2CCBleScanner"
    }
}
