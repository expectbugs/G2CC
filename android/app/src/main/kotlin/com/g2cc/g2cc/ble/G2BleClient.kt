package com.g2cc.g2cc.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import no.nordicsemi.android.ble.BleManager
import no.nordicsemi.android.ble.observer.ConnectionObserver

/**
 * Per-lens BLE client wrapping Nordic Android-BLE-Library.
 *
 * **Phase 5 — code-only; not yet hardware-validated.** Per CLAUDE.md
 * "BLE testing requires real glasses" + "Don't experiment with bonding flows
 * without saying so first" — Adam runs the connection tests under the
 * hardware-test gate documented in android/README.md §"Phase 5 verification".
 *
 * Hard rules baked in:
 *   - Every BLE write checks the callback status (FORBIDDEN_PATTERN_AUDIT
 *     "BLE writes that don't check the callback status are silent failure").
 *   - Every UUID resolved here cites G2Constants which cites PROTOCOL_NOTES.md.
 *   - No `withTimeoutOrNull` wrapping connection / write / notify calls. The
 *     state machine transitions are event-driven on Nordic library callbacks.
 *   - No `catch (e: Exception) {}` swallows; every failure surfaces via
 *     the `state` flow as ConnectionState.Error or via ConnectionObserver.
 */
class G2BleClient(
    context: Context,
    private val side: Side,
) : BleManager(context) {

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<EventParser.Event>(extraBufferCapacity = 32)
    val events: SharedFlow<EventParser.Event> = _events.asSharedFlow()

    private var writeChar: BluetoothGattCharacteristic? = null
    private var notifyChar: BluetoothGattCharacteristic? = null

    init {
        connectionObserver = object : ConnectionObserver {
            override fun onDeviceConnecting(device: BluetoothDevice) {
                _state.value = ConnectionState.Connecting(side)
                Log.i(TAG, "[$side] connecting to ${device.address}")
            }

            override fun onDeviceConnected(device: BluetoothDevice) {
                _state.value = ConnectionState.GattConnected(side)
                Log.i(TAG, "[$side] connected to ${device.address}")
            }

            override fun onDeviceFailedToConnect(device: BluetoothDevice, reason: Int) {
                _state.value = ConnectionState.Error(side,
                    "failed to connect to ${device.address} reason=$reason")
                Log.w(TAG, "[$side] failed to connect: reason=$reason")
            }

            override fun onDeviceReady(device: BluetoothDevice) {
                Log.i(TAG, "[$side] gatt services discovered; auth handshake next")
                runAuthHandshake()
            }

            override fun onDeviceDisconnecting(device: BluetoothDevice) {
                Log.i(TAG, "[$side] disconnecting from ${device.address}")
            }

            override fun onDeviceDisconnected(device: BluetoothDevice, reason: Int) {
                _state.value = ConnectionState.Disconnected(side, "reason=$reason")
                Log.w(TAG, "[$side] disconnected ${device.address} reason=$reason")
            }
        }
    }

    @SuppressLint("MissingPermission")
    fun connectTo(device: BluetoothDevice) {
        connect(device)
            .useAutoConnect(true)        // Nordic library handles reconnect on disconnect
            .retry(3, 200)               // 3 attempts, 200ms apart on initial connect failure
            .enqueue()
    }

    /** Tear down the GATT connection cleanly. Wired in G2Pipeline.stop() so
     *  service restart cycles don't leak GATT connections. The BleManager's
     *  parent `disconnect()` is final, so we can't override — wrap and enqueue
     *  under a distinct name. */
    @SuppressLint("MissingPermission")
    fun shutdownBle() {
        disconnect().enqueue()
    }

    override fun isRequiredServiceSupported(gatt: BluetoothGatt): Boolean {
        val service = gatt.getService(G2Constants.SERVICE) ?: run {
            Log.w(TAG, "[$side] G2 service ${G2Constants.SERVICE} not found")
            return false
        }
        writeChar = service.getCharacteristic(G2Constants.CHAR_WRITE)
        notifyChar = service.getCharacteristic(G2Constants.CHAR_NOTIFY)
        if (writeChar == null) {
            Log.w(TAG, "[$side] write characteristic ${G2Constants.CHAR_WRITE} not found")
            return false
        }
        if (notifyChar == null) {
            Log.w(TAG, "[$side] notify characteristic ${G2Constants.CHAR_NOTIFY} not found")
            return false
        }
        return true
    }

    override fun initialize() {
        // PROTOCOL_NOTES.md §"BLE Services" — request MTU 512 for write packets.
        requestMtu(G2Constants.ConnectionParams.MTU)
            .with { _, mtu -> Log.i(TAG, "[$side] MTU negotiated=$mtu") }
            .enqueue()

        // Enable notifications on 0x5402.
        notifyChar?.let { char ->
            setNotificationCallback(char).with { _, data ->
                val raw = data.value ?: return@with
                val ev = EventParser.parse(raw)
                // 4th-pass F4: A-H4 (third pass) only covered ConnectionManager;
                // the same silent-drop concern applies here. Log loudly on
                // buffer overflow so a stuck downstream collector is visible.
                if (!_events.tryEmit(ev)) {
                    Log.w(TAG, "[$side] SharedFlow buffer overflow — dropped event ${ev::class.simpleName}")
                }
            }
            enableNotifications(char)
                .fail { _, status -> failLoudly("enableNotifications", status) }
                .enqueue()
        }
    }

    override fun onServicesInvalidated() {
        writeChar = null
        notifyChar = null
    }

    /** Run the 7-packet auth handshake. Each write checks status; failures
     *  transition the state to Error and stop the chain. */
    @SuppressLint("MissingPermission")
    private fun runAuthHandshake() {
        val char = writeChar ?: run {
            _state.value = ConnectionState.Error(side, "auth: write char unavailable")
            return
        }
        _state.value = ConnectionState.Authenticating(side)

        val timestamp = System.currentTimeMillis() / 1000L
        val packets = AuthSequence.build(timestamp)

        // Atomic queue so the seven writes go in order with backpressure.
        val q = beginAtomicRequestQueue()
        for ((idx, packet) in packets.withIndex()) {
            q.add(
                writeCharacteristic(
                    char,
                    packet,
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
                ).fail { _, status ->
                    _state.value = ConnectionState.Error(side, "auth packet ${idx + 1} write failed status=$status")
                    Log.e(TAG, "[$side] auth packet ${idx + 1} write failed status=$status")
                },
            )
        }
        q.done {
            _state.value = ConnectionState.Ready(side)
            Log.i(TAG, "[$side] auth handshake complete; ready")
        }.enqueue()
    }

    /** Phase 6/7 entry: send a single packet (already-built bytes from
     *  Teleprompter/G2Frame). Returns true on enqueue success — actual delivery
     *  status surfaces via the `events` flow when the glasses ack. */
    @SuppressLint("MissingPermission")
    fun sendPacket(packet: ByteArray, label: String = "send") {
        val char = writeChar ?: run {
            Log.w(TAG, "[$side] sendPacket($label) called before write char available")
            return
        }
        writeCharacteristic(
            char,
            packet,
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
        ).fail { _, status ->
            // LOUD: failure surfaces in logcat AND on the state flow so callers can act.
            _state.value = ConnectionState.Error(side, "$label: write status=$status")
            Log.e(TAG, "[$side] $label write failed status=$status")
        }.enqueue()
    }

    /** Phase 7 fix #3: queue a batch of writes atomically and signal completion.
     *  Calls `onComplete(true)` when all writes succeed, `onComplete(false)` on
     *  any failure. Used by Hud.render to know when the BLE write side of a
     *  display update has reached the glasses (within Nordic library's
     *  best-effort definition of "reached"). */
    @SuppressLint("MissingPermission")
    fun queueWrites(
        packets: List<ByteArray>,
        label: String = "queue",
        onComplete: (success: Boolean) -> Unit,
    ) {
        val char = writeChar ?: run {
            Log.w(TAG, "[$side] queueWrites($label) called before write char available")
            onComplete(false)
            return
        }
        if (packets.isEmpty()) {
            onComplete(true)
            return
        }

        var anyFailed = false
        val q = beginAtomicRequestQueue()
        for (packet in packets) {
            q.add(
                writeCharacteristic(
                    char,
                    packet,
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
                ).fail { _, status ->
                    anyFailed = true
                    _state.value = ConnectionState.Error(side, "$label: write status=$status")
                    Log.e(TAG, "[$side] $label write failed status=$status")
                },
            )
        }
        q.done {
            onComplete(!anyFailed)
        }.fail { _, status ->
            Log.e(TAG, "[$side] $label queue failed status=$status")
            onComplete(false)
        }.enqueue()
    }

    override fun log(priority: Int, message: String) {
        Log.println(priority, TAG, "[$side] $message")
    }

    override fun getMinLogPriority(): Int = Log.INFO

    private fun failLoudly(op: String, status: Int) {
        _state.value = ConnectionState.Error(side, "$op failed status=$status")
        Log.e(TAG, "[$side] $op failed status=$status")
    }

    companion object {
        const val TAG = "G2BleClient"
    }
}
