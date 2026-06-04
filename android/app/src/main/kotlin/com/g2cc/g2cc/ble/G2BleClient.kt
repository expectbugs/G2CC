package com.g2cc.g2cc.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.content.Context
import android.os.Build
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

    // @Volatile: written on the main thread (isRequiredServiceSupported /
    // onServicesInvalidated — Nordic BleManager callbacks run on the main
    // looper) but READ from Dispatchers.Default coroutines (sendPacket /
    // queueWrites, driven by G2Pipeline's heartbeat + render). Without the
    // happens-before edge a background coroutine could observe a stale char
    // reference across a reconnect rebuild. Matches the @Volatile diagnostic
    // fields above.
    @Volatile private var writeChar: BluetoothGattCharacteristic? = null
    @Volatile private var notifyChar: BluetoothGattCharacteristic? = null
    // Probe support — display-service char (0x6402 under parent 0x6450).
    // Discovered opportunistically; null if the firmware doesn't expose it
    // on this connection. Probe activity calls [sendDisplayPacket] / collects
    // [displayNotifies] to test raw-display + raw-input hypotheses without
    // touching the existing teleprompter path.
    @Volatile private var displayChar: BluetoothGattCharacteristic? = null

    // Reassembles multi-packet (PktTot > 1) notify frames before EventParser.
    // Single-packet frames (the only kind observed today) pass straight through.
    // Touched only from the notify callback (single thread).
    private val reassembler = FrameReassembler()
    private val _displayNotifies = MutableSharedFlow<ByteArray>(extraBufferCapacity = 32)
    val displayNotifies: SharedFlow<ByteArray> = _displayNotifies.asSharedFlow()
    /** True after a successful service-discovery that found 0x6402. Probes
     *  using [sendDisplayPacket] will no-op (and Log.w) until this is true. */
    val isDisplayCharAvailable: Boolean get() = displayChar != null

    /** Diagnostic: count of notification packets received, and hex of last one's
     *  first 24 bytes. Read by G2Pipeline after Hud.render onComplete fires so
     *  we can tell whether the glasses are responding to our writes at all. */
    val notifyCount = java.util.concurrent.atomic.AtomicInteger(0)
    @Volatile var lastNotifyHex: String = "(none)"
        private set

    /** Diagnostic: actual MTU + PHY negotiated. Surfaced by G2Pipeline so we
     *  can see whether the glasses accepted our 2M PHY / MTU 512 / LOW_POWER
     *  requests or fell back to defaults. */
    @Volatile var lastMtu: Int = -1
        private set
    @Volatile var lastPhy: String = "(unknown)"
        private set
    @Volatile var lastConnParams: String = "(unknown)"
        private set
    /** Last BLE disconnect reason code (Android BluetoothGatt status — e.g.
     *  0x08 = supervision timeout, 0x16 = connection terminated by local
     *  host, 0x13 = remote user terminated). -1 = no disconnect seen yet. */
    @Volatile var lastDisconnectReason: Int = -1
    @Volatile var lastDisconnectAtMs: Long = 0L

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
                lastDisconnectReason = reason
                lastDisconnectAtMs = System.currentTimeMillis()
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
                lastDisconnectReason = reason
                lastDisconnectAtMs = System.currentTimeMillis()
                Log.w(TAG, "[$side] disconnected ${device.address} reason=$reason")
            }
        }
    }

    @SuppressLint("MissingPermission")
    fun connectTo(device: BluetoothDevice) {
        connect(device)
            .useAutoConnect(true)        // Nordic library handles reconnect on disconnect
            // Phase D resilience: more aggressive retry config so a body-block
            // (BLE 2.4 GHz is heavily absorbed by the human body — walking
            // with the phone in the pocket and glasses on the face puts the
            // body in the line of sight) doesn't give up before the body
            // moves out of the way. Was retry(3, 200) = 600 ms total; now
            // retry(10, 500) = 5 s total. Combined with useAutoConnect's
            // background passive scan, recovery should be near-instant once
            // line-of-sight resumes.
            .retry(10, 500)
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

    /** Diagnostic — populated by isRequiredServiceSupported. Read by
     *  G2Pipeline.observeBleHealth on Disconnected to surface in bleStatus
     *  so we can tell whether firmware UUIDs drifted from i-soxi's reference. */
    @Volatile var lastDiagnostic: String = "(no connection yet)"
        private set

    override fun isRequiredServiceSupported(gatt: BluetoothGatt): Boolean {
        val services = gatt.services
        // Full enumeration: every service AND its characteristics with properties.
        val deepDump = services.joinToString(" || ") { svc ->
            val chars = svc.characteristics.joinToString(",") { ch ->
                val props = mutableListOf<String>()
                val p = ch.properties
                if (p and android.bluetooth.BluetoothGattCharacteristic.PROPERTY_READ != 0) props += "r"
                if (p and android.bluetooth.BluetoothGattCharacteristic.PROPERTY_WRITE != 0) props += "w"
                if (p and android.bluetooth.BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) props += "W"
                if (p and android.bluetooth.BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) props += "n"
                if (p and android.bluetooth.BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) props += "i"
                "${ch.uuid}/${props.joinToString("")}"
            }
            "${svc.uuid}=[${chars.ifEmpty { "(no chars)" }}]"
        }
        Log.i(TAG, "[$side] deep service dump: $deepDump")
        // Pre-stamp lastDiagnostic with the deep dump so even if the failure
        // path below runs first, observeBleHealth picks up the full info.
        // (The prior version preemptively set state=Error which short-circuited
        // observeBleHealth into reading the stale initial "(no connection yet)".)
        lastDiagnostic = "DEEP: $deepDump"

        val service = gatt.getService(G2Constants.SERVICE)
        if (service == null) {
            // Firmware drift OR completely-different service family. Append the
            // miss reason to the deep dump so we have BOTH pieces in one diag line.
            lastDiagnostic = "no G2 svc (${G2Constants.SERVICE}); $deepDump"
            Log.w(TAG, "[$side] G2 service ${G2Constants.SERVICE} not found; have: $deepDump")
            // Promote to Error so observeBleHealth sees the diagnostic via state flow
            // (instead of just the bare Disconnected with no context).
            _state.value = ConnectionState.Error(side, lastDiagnostic)
            return false
        }

        // Service was found — also enumerate its characteristics so we know
        // the full surface even if the write/notify suffixes shifted too.
        val charUuids = service.characteristics.map { it.uuid.toString() }
        writeChar = service.getCharacteristic(G2Constants.CHAR_WRITE)
        notifyChar = service.getCharacteristic(G2Constants.CHAR_NOTIFY)
        if (writeChar == null) {
            lastDiagnostic = "no write char (5401); svc chars=[${charUuids.joinToString()}]"
            Log.w(TAG, "[$side] write characteristic ${G2Constants.CHAR_WRITE} not found in svc; chars: $charUuids")
            _state.value = ConnectionState.Error(side, lastDiagnostic)
            return false
        }
        if (notifyChar == null) {
            lastDiagnostic = "no notify char (5402); svc chars=[${charUuids.joinToString()}]"
            Log.w(TAG, "[$side] notify characteristic ${G2Constants.CHAR_NOTIFY} not found in svc; chars: $charUuids")
            _state.value = ConnectionState.Error(side, lastDiagnostic)
            return false
        }
        // Probe support: opportunistically look up the display char on its
        // parent service (0x6450). NOT required for normal operation — failure
        // is non-fatal, just logged.
        val displaySvc = gatt.getService(G2Constants.SERVICE_DISPLAY)
        if (displaySvc != null) {
            displayChar = displaySvc.getCharacteristic(G2Constants.CHAR_DISPLAY)
            if (displayChar == null) {
                Log.i(TAG, "[$side] display service 6450 found, but char 6402 missing")
            } else {
                Log.i(TAG, "[$side] display char 6402 discovered (probe mode capable)")
            }
        } else {
            Log.i(TAG, "[$side] display service 6450 not found (firmware may not expose it)")
        }
        lastDiagnostic = "svc+chars ok"
        return true
    }

    override fun initialize() {
        // PROTOCOL_NOTES.md §"BLE Services" — request MTU 512 for write packets.
        requestMtu(G2Constants.ConnectionParams.MTU)
            .with { _, mtu ->
                Log.i(TAG, "[$side] MTU negotiated=$mtu")
                lastMtu = mtu
            }
            .enqueue()

        // Phase D resilience iter 2: switched LOW_POWER → BALANCED. LOW_POWER
        // negotiated `latency=2` meaning the peripheral could skip up to 2
        // intervals = ~372 ms between packets. During movement (which Adam
        // reported as still-janky even with phone in hand), that long quiet
        // window means a body block landing mid-window propagates as a full
        // packet loss. BALANCED uses ~30-50 ms interval + latency=0, giving
        // steady-state packet flow with much more retry opportunity per
        // second — better empirical match for an active user.
        requestConnectionPriority(android.bluetooth.BluetoothGatt.CONNECTION_PRIORITY_BALANCED)
            .with { _, interval, latency, supervision ->
                Log.i(TAG, "[$side] conn-params updated: interval=$interval latency=$latency supervision=$supervision")
                lastConnParams = "intv=$interval lat=$latency sup=$supervision"
            }
            .enqueue()
        // Defense in depth: also override onConnectionUpdated so we capture
        // ALL parameter updates, not just the one that completes the
        // requestConnectionPriority callback. The G2 firmware sometimes
        // updates params after auth completes (the callback for our request
        // may have already fired with stale values).

        // Request 2M PHY. Pixel 10a + BT 5.3 supports it; the G2 may or may
        // not. If the peripheral rejects, we fall back to 1M silently —
        // setPreferredPhy is a hint. 2M PHY doubles data rate = half the
        // air time per packet = less vulnerable to interference / blockage.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            setPreferredPhy(
                android.bluetooth.BluetoothDevice.PHY_LE_2M_MASK,
                android.bluetooth.BluetoothDevice.PHY_LE_2M_MASK,
                android.bluetooth.BluetoothDevice.PHY_OPTION_NO_PREFERRED,
            ).with { _, txPhy, rxPhy ->
                Log.i(TAG, "[$side] PHY negotiated tx=$txPhy rx=$rxPhy")
                lastPhy = "tx=$txPhy rx=$rxPhy"
            }.enqueue()
        }

        // Enable notifications on 0x5402.
        notifyChar?.let { char ->
            setNotificationCallback(char).with { _, data ->
                val raw = data.value ?: return@with
                notifyCount.incrementAndGet()
                lastNotifyHex = raw.take(24).joinToString("") { "%02x".format(it) }
                // Reassemble multi-packet frames (PktTot > 1) before parsing.
                // Without this a fragmented frame CRC-fails per fragment and is
                // silently lost as Malformed. Single-packet frames pass through.
                val out = reassembler.offer(raw)
                out.warning?.let { Log.w(TAG, "[$side] notify reassembly: $it") }
                val frame = out.deliver ?: return@with
                val ev = EventParser.parse(frame)
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
        // Probe support: subscribe to 0x6402 notify if the char exists and
        // advertises notify property. The probe activity collects from
        // displayNotifies to see what the display char emits when activated.
        displayChar?.let { char ->
            val hasNotify = (char.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
            if (hasNotify) {
                setNotificationCallback(char).with { _, data ->
                    val raw = data.value ?: return@with
                    if (!_displayNotifies.tryEmit(raw)) {
                        Log.w(TAG, "[$side] displayNotifies SharedFlow buffer overflow — dropped")
                    }
                }
                enableNotifications(char)
                    .fail { _, status -> Log.w(TAG, "[$side] enableNotifications(6402) status=$status") }
                    .enqueue()
                Log.i(TAG, "[$side] subscribed to 0x6402 notify (probe mode)")
            } else {
                Log.i(TAG, "[$side] 0x6402 char does not advertise notify property; write-only")
            }
        }
    }

    override fun onServicesInvalidated() {
        writeChar = null
        notifyChar = null
        displayChar = null
    }

    /** Probe-only: write a raw payload to characteristic 0x6402 (display
     *  channel) WITHOUT the AA-frame envelope or any feature activation.
     *  Used by ProbeActivity to test whether the display channel accepts
     *  arbitrary writes. No-op + Log.w if the char wasn't discovered.
     *
     *  Returns true on enqueue success — actual delivery surfaces via
     *  the BluetoothGatt callback chain (no return value here). */
    @SuppressLint("MissingPermission")
    fun sendDisplayPacket(packet: ByteArray, label: String = "probe"): Boolean {
        val char = displayChar ?: run {
            Log.w(TAG, "[$side] sendDisplayPacket($label) — 0x6402 not available; firmware may have moved or hidden it")
            return false
        }
        writeCharacteristic(
            char,
            packet,
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
        ).fail { _, status ->
            Log.e(TAG, "[$side] sendDisplayPacket($label) status=$status (${packet.size} bytes)")
        }.enqueue()
        Log.i(TAG, "[$side] sendDisplayPacket($label) — ${packet.size} bytes enqueued")
        return true
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
     *  best-effort definition of "reached").
     *
     *  `delaysAfterMs[i]` is the delay (ms) inserted AFTER packet i. Per
     *  PROTOCOL_NOTES.md §"Teleprompter — the HUD text primitive" and the
     *  i-soxi teleprompter.py example, the G2 firmware needs inter-packet
     *  pacing (0.1s–0.5s between teleprompter packets) — without it the writes
     *  reach the BLE stack faster than the glasses can process them, take-over
     *  succeeds but content doesn't render. If shorter than packets.size,
     *  remaining slots default to 0 ms (no delay). Allowed under the no-timeouts
     *  rule: this is BLE transport-level pacing, not a clock kill. */
    @SuppressLint("MissingPermission")
    fun queueWrites(
        packets: List<ByteArray>,
        label: String = "queue",
        delaysAfterMs: List<Long> = emptyList(),
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
        for ((idx, packet) in packets.withIndex()) {
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
            val delay = delaysAfterMs.getOrNull(idx) ?: 0L
            if (delay > 0L) {
                q.add(sleep(delay))
            }
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
