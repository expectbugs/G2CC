package com.g2cc.g2cc.probe

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.content.Context
import android.util.Log
import com.g2cc.g2cc.ble.AuthSequence
import com.g2cc.g2cc.ble.ConnectionState
import com.g2cc.g2cc.ble.G2Constants
import com.g2cc.g2cc.ble.Side
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import no.nordicsemi.android.ble.BleManager
import no.nordicsemi.android.ble.observer.ConnectionObserver
import java.util.UUID

/**
 * Permissive BLE client for protocol probing.
 *
 * Unlike production [com.g2cc.g2cc.ble.G2BleClient] which only discovers
 * the canonical write+notify chars on service `0x5450`, this client:
 *
 *   - Walks **every service + every characteristic** on connect and
 *     records them in [discoveredChars] with property strings
 *   - Subscribes to **every characteristic that advertises notify** (or
 *     indicate) — not just the ones we currently know to be useful
 *   - Exposes a unified [notifies] flow emitting [RawNotify] tuples that
 *     include the originating characteristic UUID, full untruncated raw
 *     bytes, and a timestamp
 *   - Exposes [sendToChar] for write operations to ANY discovered
 *     characteristic (not just `0x5401`)
 *
 * Reuses the production auth handshake from [AuthSequence] — same 7-packet
 * sequence to `0x5401`, no protocol change.
 *
 * Intended for the standalone Probe activity; not used by the main G2CC
 * pipeline.
 */
class BleProbeClient(
    context: Context,
    val side: Side,
) : BleManager(context) {

    /** One BLE notify event: which characteristic emitted it, what bytes,
     *  and when (ms since epoch, system clock). */
    data class RawNotify(
        val charUuid: UUID,
        val bytes: ByteArray,
        val timestampMs: Long,
    )

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _notifies = MutableSharedFlow<RawNotify>(extraBufferCapacity = 128)
    val notifies: SharedFlow<RawNotify> = _notifies.asSharedFlow()

    /** Map of every discovered characteristic by UUID. Populated in
     *  [isRequiredServiceSupported] and cleared in [onServicesInvalidated]. */
    val discoveredChars = LinkedHashMap<UUID, BluetoothGattCharacteristic>()

    /** Human-readable text dump of the service tree, populated on discovery.
     *  Useful for diagnostic logging. */
    @Volatile var discoveryDump: String = "(no discovery yet)"
        private set

    @Volatile var lastMtu: Int = -1
        private set

    private var writeChar: BluetoothGattCharacteristic? = null

    init {
        connectionObserver = object : ConnectionObserver {
            override fun onDeviceConnecting(device: BluetoothDevice) {
                _state.value = ConnectionState.Connecting(side)
                Log.i(TAG, "[$side] connecting to ${device.address}")
            }
            override fun onDeviceConnected(device: BluetoothDevice) {
                _state.value = ConnectionState.GattConnected(side)
                Log.i(TAG, "[$side] gatt connected to ${device.address}")
            }
            override fun onDeviceFailedToConnect(device: BluetoothDevice, reason: Int) {
                _state.value = ConnectionState.Error(side, "failed reason=$reason")
                Log.w(TAG, "[$side] failed to connect: $reason")
            }
            override fun onDeviceReady(device: BluetoothDevice) {
                Log.i(TAG, "[$side] gatt services discovered; running auth")
                runAuthHandshake()
            }
            override fun onDeviceDisconnecting(device: BluetoothDevice) {
                Log.i(TAG, "[$side] disconnecting")
            }
            override fun onDeviceDisconnected(device: BluetoothDevice, reason: Int) {
                _state.value = ConnectionState.Disconnected(side, "reason=$reason")
                Log.w(TAG, "[$side] disconnected reason=$reason")
            }
        }
    }

    @SuppressLint("MissingPermission")
    fun connectTo(device: BluetoothDevice) {
        connect(device).useAutoConnect(true).retry(10, 500).enqueue()
    }

    @SuppressLint("MissingPermission")
    fun shutdownBle() {
        disconnect().enqueue()
    }

    override fun isRequiredServiceSupported(gatt: BluetoothGatt): Boolean {
        discoveredChars.clear()
        val sb = StringBuilder()
        for (svc in gatt.services) {
            sb.append("svc ${svc.uuid}\n")
            for (char in svc.characteristics) {
                discoveredChars[char.uuid] = char
                sb.append("  char ${char.uuid} [${describeProps(char.properties)}]\n")
            }
        }
        discoveryDump = sb.toString().trimEnd()
        Log.i(TAG, "[$side] discovered ${discoveredChars.size} chars across ${gatt.services.size} services")
        writeChar = discoveredChars[G2Constants.CHAR_WRITE]
        if (writeChar == null) {
            Log.w(TAG, "[$side] CRITICAL: write char ${G2Constants.CHAR_WRITE} not found — auth impossible")
            return false
        }
        return true
    }

    override fun onServicesInvalidated() {
        discoveredChars.clear()
        writeChar = null
        discoveryDump = "(services invalidated)"
    }

    override fun initialize() {
        // Standard MTU + balanced conn priority — same as G2BleClient.
        requestMtu(G2Constants.ConnectionParams.MTU)
            .with { _, mtu ->
                lastMtu = mtu
                Log.i(TAG, "[$side] MTU=$mtu")
            }
            .enqueue()
        requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_BALANCED).enqueue()

        // Subscribe to EVERY notify-capable characteristic. This is the
        // headline difference vs G2BleClient — we don't know in advance
        // which channels will carry the events we're trying to capture.
        for ((uuid, char) in discoveredChars) {
            val props = char.properties
            val hasNotify = (props and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
            val hasIndicate = (props and BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
            if (hasNotify || hasIndicate) {
                setNotificationCallback(char).with { _, data ->
                    val raw = data.value ?: return@with
                    val event = RawNotify(uuid, raw, System.currentTimeMillis())
                    if (!_notifies.tryEmit(event)) {
                        Log.w(TAG, "[$side] notify flow overflow — dropped ${raw.size}B from $uuid")
                    }
                }
                enableNotifications(char)
                    .fail { _, status -> Log.w(TAG, "[$side] enableNotify($uuid) status=$status") }
                    .enqueue()
                Log.i(TAG, "[$side] subscribed to $uuid")
            }
        }
    }

    /** Run the 7-packet auth handshake (same shape as G2BleClient). */
    @SuppressLint("MissingPermission")
    private fun runAuthHandshake() {
        val char = writeChar ?: run {
            _state.value = ConnectionState.Error(side, "auth: write char unavailable")
            return
        }
        _state.value = ConnectionState.Authenticating(side)
        val timestamp = System.currentTimeMillis() / 1000L
        val packets = AuthSequence.build(timestamp)
        val q = beginAtomicRequestQueue()
        for ((idx, packet) in packets.withIndex()) {
            q.add(
                writeCharacteristic(
                    char,
                    packet,
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
                ).fail { _, status ->
                    _state.value = ConnectionState.Error(side, "auth packet ${idx + 1} status=$status")
                    Log.e(TAG, "[$side] auth packet ${idx + 1} status=$status")
                },
            )
        }
        q.done {
            _state.value = ConnectionState.Ready(side)
            Log.i(TAG, "[$side] auth done; ready")
        }.enqueue()
    }

    /** Write arbitrary bytes to ANY discovered characteristic.
     *  Returns true if enqueued (char exists + writable), false otherwise.
     *  Failure status comes through logcat. */
    @SuppressLint("MissingPermission")
    fun sendToChar(uuid: UUID, bytes: ByteArray, label: String = "raw"): Boolean {
        val char = discoveredChars[uuid] ?: run {
            Log.w(TAG, "[$side] sendToChar($label) — uuid=$uuid not discovered")
            return false
        }
        val props = char.properties
        val canWriteNoResp = (props and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
        val canWrite = (props and BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
        if (!canWriteNoResp && !canWrite) {
            Log.w(TAG, "[$side] sendToChar($label) — uuid=$uuid is not writable; props=${describeProps(props)}")
            return false
        }
        val writeType = if (canWriteNoResp) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
        writeCharacteristic(char, bytes, writeType)
            .fail { _, status -> Log.e(TAG, "[$side] sendToChar($label) status=$status (${bytes.size}B to $uuid)") }
            .enqueue()
        Log.i(TAG, "[$side] sendToChar($label) — ${bytes.size}B to $uuid")
        return true
    }

    private fun describeProps(p: Int): String {
        val parts = mutableListOf<String>()
        if (p and BluetoothGattCharacteristic.PROPERTY_READ != 0) parts += "r"
        if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) parts += "w"
        if (p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) parts += "W"
        if (p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) parts += "n"
        if (p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) parts += "i"
        if (parts.isEmpty()) parts += "?"
        return parts.joinToString("")
    }

    companion object {
        const val TAG = "G2CCProbeBle"
    }
}
