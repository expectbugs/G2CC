package com.g2cc.g2cc

import android.content.Context
import android.util.Log
import com.g2cc.g2cc.audio.AudioStreamer
import com.g2cc.g2cc.audio.MicCapture
import com.g2cc.g2cc.ble.BleScanner
import com.g2cc.g2cc.ble.EventParser
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.PairingState
import com.g2cc.g2cc.ble.Side
import com.g2cc.g2cc.hud.ConfirmationFlow
import com.g2cc.g2cc.hud.Hud
import com.g2cc.g2cc.hud.MenuController
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager
import com.g2cc.g2cc.net.EndpointFetcher
import com.g2cc.g2cc.net.ServerMessage
import com.g2cc.g2cc.state.AppState
import com.g2cc.g2cc.state.StateMachine
import com.g2cc.g2cc.storage.Prefs
import com.g2cc.g2cc.ble.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.time.Duration
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Top-level Phase 6 integration: ConnectionManager ↔ HUD ↔ BLE clients.
 *
 * Lifecycle is driven by the foreground service (G2CCService). This class
 * owns the WebSocket connection and the HUD renderer; the BLE clients are
 * passed in (the service decides when to scan + connect to glasses, which
 * is a hardware-gated step per Phase 5 README).
 *
 * Phase 6 ships the message pipeline:
 *   - ConnectionManager.events → if Output/TextDelta → hud.render()
 *   - ConnectionManager.events → if DispatchTargetList → menu.dispatchTargets = ...
 *   - ConnectionManager.events → if DirectoryListReply → menu.directories = ...
 *   - ConnectionManager.events → if ConfirmOnHud → render + await tap (Phase 7)
 *
 * Phase 7 wires the confirm-on-hud round-trip; the BLE ack is sent inline
 * from ConfirmationFlow.onConfirmRequest after hud.render drains (the prior
 * AckEmitter stub was obsoleted and deleted in the third-pass cleanup).
 * Phase 8 wires the audio capture path.
 */
class G2Pipeline(
    private val context: Context,
    private val prefs: Prefs,
    private val pairing: PairingState,
    private val httpClient: OkHttpClient = defaultHttpClient(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val state = StateMachine()

    // Visible BLE state for the foreground-service notification + diagnostics.
    // Updated from observeBleHealth as the per-lens ConnectionState flows
    // change. Without this, the only signal of BLE state is the per-lens flows
    // (not collected by anything except observeBleHealth itself) — Adam has no
    // way to tell if pairing succeeded.
    //
    // Also: a coroutine started in start() forwards every change here to the
    // server as a DiagMsg, so the notification doesn't have to be the only
    // observable surface (it updates too fast for a human to read by eye).
    private val _bleStatus = MutableStateFlow("scanning")
    val bleStatus: StateFlow<String> = _bleStatus.asStateFlow()

    var leftBle: G2BleClient? = null
    var rightBle: G2BleClient? = null
    private var hud: Hud? = null
    private var menu: MenuController? = null
    private var confirmation: ConfirmationFlow? = null
    private var connection: ConnectionManager? = null
    private var streamer: AudioStreamer? = null
    // AtomicReference so writes from the BLE handler thread (scan callback) are
    // visible from the main thread (stop()) without a torn-reference race.
    private val bleScannerRef = AtomicReference<BleScanner?>(null)
    // Collector job handles — stored so installBleClients can cancel before
    // re-launching on a re-install (e.g. post-reconnect after BLE disconnect).
    // Without this, every re-install leaks a coroutine that keeps firing
    // onTap/onDoubleTap from the OLD flow.
    private var leftCollectorJob: Job? = null
    private var rightCollectorJob: Job? = null

    // Heartbeat job — keeps the teleprompter HUD session alive against the
    // ~10-second firmware idle timeout (confirmed 2026-06-01: render
    // succeeded, text displayed, session terminated 10 s later with no
    // intervening packets). Periodically re-issues sync_trigger which is the
    // lightest known teleprompter-flow packet. Allowed under the no-timeouts
    // rule (annotated as HB pacing, not a clock-kill).
    private var heartbeatJob: Job? = null
    private val heartbeatSeq = java.util.concurrent.atomic.AtomicInteger(0xF0)
    private val heartbeatMsgId = java.util.concurrent.atomic.AtomicInteger(0xF000)
    private val heartbeatTickCount = java.util.concurrent.atomic.AtomicInteger(0)

    /** Scan or directed-connect to the G2 lens pair, then install BLE clients.
     *  Idempotent — calling twice is a no-op if BLE clients are already installed.
     *
     *  Spec compliance fix: if a saved pair exists in PairingState (CLAUDE.md
     *  "BLE bonding state survives across app restarts"), do a DIRECTED connect
     *  via BluetoothAdapter.getRemoteDevice() and skip the scan entirely.
     *  Falls back to scan only if the directed connect throws (e.g. invalid
     *  saved address, BT not enabled). Saves battery + reconnect latency on
     *  every wake-from-Doze.
     */
    @android.annotation.SuppressLint("MissingPermission")
    fun scanAndConnect() {
        if (leftBle != null && rightBle != null) {
            Log.i(TAG, "scanAndConnect: BLE already installed")
            return
        }
        if (bleScannerRef.get() != null) {
            Log.i(TAG, "scanAndConnect: scan already in progress")
            return
        }

        // Directed-connect path: skip scan if we know the addresses.
        if (pairing.hasPair) {
            try {
                val btMgr = context.getSystemService(Context.BLUETOOTH_SERVICE)
                    as? android.bluetooth.BluetoothManager
                val adapter = btMgr?.adapter
                if (adapter != null && adapter.isEnabled) {
                    val leftDevice = adapter.getRemoteDevice(pairing.leftAddress!!)
                    val rightDevice = adapter.getRemoteDevice(pairing.rightAddress!!)
                    val leftClient = G2BleClient(context, Side.Left)
                    val rightClient = G2BleClient(context, Side.Right)
                    leftClient.connectTo(leftDevice)
                    rightClient.connectTo(rightDevice)
                    Log.i(TAG, "scanAndConnect: directed connect L=${pairing.leftAddress} R=${pairing.rightAddress}")
                    installBleClients(leftClient, rightClient)
                    return
                } else {
                    Log.w(TAG, "scanAndConnect: BT adapter unavailable for directed connect, falling back to scan")
                }
            } catch (e: Exception) {
                Log.w(TAG, "scanAndConnect: directed-connect threw, falling back to scan", e)
            }
        }

        // Scan path (no saved pair OR directed-connect failed).
        _bleStatus.value = "scanning"
        val scanner = BleScanner(context)
        bleScannerRef.set(scanner)
        scanner.start { event ->
            when (event) {
                is BleScanner.Event.FoundPair -> {
                    bleScannerRef.set(null)            // scanner self-stopped; drop reference
                    _bleStatus.value = "found pair"
                    val leftClient = G2BleClient(context, Side.Left)
                    val rightClient = G2BleClient(context, Side.Right)
                    leftClient.connectTo(event.left)
                    rightClient.connectTo(event.right)
                    val leftName = try { event.left.name ?: "" } catch (e: SecurityException) { "" }
                    val rightName = try { event.right.name ?: "" } catch (e: SecurityException) { "" }
                    pairing.setForSide(Side.Left, event.left.address, leftName)
                    pairing.setForSide(Side.Right, event.right.address, rightName)
                    installBleClients(leftClient, rightClient)
                }
                is BleScanner.Event.Failure -> {
                    bleScannerRef.set(null)            // scanner self-stopped on failure
                    Log.w(TAG, "scan failure: ${event.reason}")
                    _bleStatus.value = "scan failed: ${event.reason}"
                    state.transition(AppState.ERROR)
                }
            }
        }
    }

    /** Install the connected BLE clients (one per lens). Wires:
     *   - Hud + MenuController + ConfirmationFlow against the new clients
     *   - BLE input events from BOTH lenses, debounced to dedup paired emissions
     *
     *  Phase 7 fix #10: subscribe to BOTH sides. PROTOCOL_NOTES.md §"Open
     *  research items" #3 notes we don't yet know whether both lenses emit
     *  the same input event or only one — debounce by EVENT_DEBOUNCE_MS so a
     *  paired emission doesn't fire onTap twice. */
    fun installBleClients(left: G2BleClient, right: G2BleClient) {
        leftBle = left
        rightBle = right
        val newHud = Hud(left, right)
        hud = newHud
        connection?.let {
            menu = MenuController(newHud, it)
            confirmation = ConfirmationFlow(newHud, it)
        }
        // Cancel any prior collectors so a re-install (e.g. after BLE disconnect
        // + reconnect) doesn't stack a second pair, double-firing every onTap.
        leftCollectorJob?.cancel()
        rightCollectorJob?.cancel()
        leftCollectorJob = scope.launch { collectEventsDebounced(left.events) }
        rightCollectorJob = scope.launch { collectEventsDebounced(right.events) }
        // 4th-pass F1 (Android): observe both lenses' ConnectionState. The prior
        // implementation called connectTo(...) + returned without watching for
        // async connect failures — if a saved address was stale (glasses off,
        // out of range, mac changed), getRemoteDevice would succeed but Nordic
        // would emit onDeviceFailedToConnect → state flow → ConnectionState.Error
        // with no observer, leaving the pipeline stuck in "leftBle/rightBle
        // installed" state forever. Now: if either side hits Error or
        // Disconnected without ever reaching Ready, tear down + retry.
        observeBleHealth(left, right)
    }

    private fun observeBleHealth(left: G2BleClient, right: G2BleClient) {
        scope.launch {
            var leftReady = false
            var rightReady = false
            var helloRendered = false
            _bleStatus.value = "connecting L+R"

            fun updateStatus(side: String, s: ConnectionState) {
                val lStr = if (leftReady) "L✓" else "L:${stateLabel(s.takeIf { side == "L" } ?: left.state.value)}"
                val rStr = if (rightReady) "R✓" else "R:${stateLabel(s.takeIf { side == "R" } ?: right.state.value)}"
                _bleStatus.value = if (leftReady && rightReady) "ready" else "$lStr $rStr"
            }
            fun maybeRenderHello() {
                if (leftReady && rightReady && !helloRendered) {
                    helloRendered = true
                    Log.i(TAG, "Both lenses Ready — rendering HUD hello")
                    // Visible BLE-paired confirmation. Phase 9 polish can replace
                    // this with a richer first-frame; for H2 sanity this is the
                    // milestone that proves the 7-packet auth handshake worked.
                    val h = hud
                    val l = leftBle
                    val r = rightBle
                    val conn = connection
                    if (h == null) {
                        conn?.send(ClientMessage.Diag("hud: NULL when ready! cannot render hello"))
                    } else {
                        val notifyBefore = "L=${l?.notifyCount?.get() ?: -1} R=${r?.notifyCount?.get() ?: -1}"
                        val pageCount = h.render("G2CC paired\nL+R authed\n(idle)") { ok ->
                            val lCount = l?.notifyCount?.get() ?: -1
                            val rCount = r?.notifyCount?.get() ?: -1
                            val lHex = l?.lastNotifyHex ?: "(no client)"
                            val rHex = r?.lastNotifyHex ?: "(no client)"
                            connection?.send(ClientMessage.Diag(
                                "hud: hello-done ok=$ok | notify: $notifyBefore → L=$lCount R=$rCount | lastHex L=$lHex R=$rHex"
                            ))
                            // Kick off heartbeat once the render is on screen.
                            if (ok) startHeartbeat()
                        }
                        conn?.send(ClientMessage.Diag("hud: hello-render pages=$pageCount | notify-before $notifyBefore"))
                    }
                }
            }

            // Per-side watcher; coalesces into the outer launch via the shared
            // state vars. As soon as Ready fires, that side is considered
            // healthy. If a side flips to Error / Disconnected BEFORE Ready,
            // treat the install as failed and reset.
            launch {
                left.state.collect { s ->
                    when (s) {
                        is ConnectionState.Ready -> { leftReady = true; updateStatus("L", s); maybeRenderHello() }
                        is ConnectionState.Error,
                        is ConnectionState.Disconnected -> {
                            if (!leftReady) {
                                _bleStatus.value = "L fail: ${left.lastDiagnostic}"
                                onInstallFailure("L", s)
                            }
                        }
                        else -> { updateStatus("L", s) }
                    }
                }
            }
            launch {
                right.state.collect { s ->
                    when (s) {
                        is ConnectionState.Ready -> { rightReady = true; updateStatus("R", s); maybeRenderHello() }
                        is ConnectionState.Error,
                        is ConnectionState.Disconnected -> {
                            if (!rightReady) {
                                _bleStatus.value = "R fail: ${right.lastDiagnostic}"
                                onInstallFailure("R", s)
                            }
                        }
                        else -> { updateStatus("R", s) }
                    }
                }
            }
        }
    }

    private fun stateLabel(s: ConnectionState): String = when (s) {
        is ConnectionState.Idle -> "idle"
        is ConnectionState.Scanning -> "scan"
        is ConnectionState.Connecting -> "conn"
        is ConnectionState.GattConnected -> "gatt"
        is ConnectionState.Authenticating -> "auth"
        is ConnectionState.Ready -> "ok"
        is ConnectionState.Disconnected -> "disc"
        is ConnectionState.Error -> "err"
    }

    /** Keep the teleprompter HUD session alive. Without periodic packets the
     *  G2 firmware ends the session ~10 s after the last activity, blanks the
     *  screen, and the "connection lost" toast appears on the glasses
     *  (confirmed 2026-06-01 on Adam's pair).
     *
     *  This is an empirical guess at the keepalive — i-soxi docs don't
     *  document a heartbeat, and the teleprompter.py example just disconnects
     *  after rendering. We re-issue sync_trigger (service 0x80-00 type=0x0E,
     *  the lightest known teleprompter-flow packet) every 5 seconds.
     *
     *  HB annotation: per CLAUDE.md "no-timeouts rule" exception list,
     *  heartbeat pacing is allowed (it's not a clock-kill on an operation).
     *  Cadence chosen at half of the observed 10 s timeout to give margin. */
    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatTickCount.set(0)
        heartbeatJob = scope.launch {
            connection?.send(ClientMessage.Diag("hb: started (cadence=5s, packet=sync_trigger)"))
            try {
                while (kotlinx.coroutines.currentCoroutineContext()[Job]?.isActive == true) {
                    kotlinx.coroutines.delay(5_000L)
                    val l = leftBle ?: break
                    val r = rightBle ?: break
                    val seq = heartbeatSeq.getAndIncrement() and 0xFF
                    val msgId = heartbeatMsgId.getAndIncrement() and 0xFFFF
                    val pkt = com.g2cc.g2cc.ble.Teleprompter.buildSyncTrigger(seq, msgId)
                    l.sendPacket(pkt, "HB:L")
                    r.sendPacket(pkt, "HB:R")
                    val tick = heartbeatTickCount.incrementAndGet()
                    // Emit a diag every tick so we can see if the heartbeat is
                    // firing AND notice the moment it stops.
                    connection?.send(ClientMessage.Diag(
                        "hb: tick=$tick | notify L=${l.notifyCount.get()} R=${r.notifyCount.get()}"
                    ))
                }
            } finally {
                connection?.send(ClientMessage.Diag("hb: stopped after ${heartbeatTickCount.get()} ticks"))
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun onInstallFailure(side: String, state: ConnectionState) {
        Log.w(TAG, "[$side] connect failed before Ready (state=$state) — tearing down and retrying via scan")
        stopHeartbeat()
        // Tear down current install so scanAndConnect() can rebuild.
        leftBle?.shutdownBle()
        rightBle?.shutdownBle()
        leftBle = null
        rightBle = null
        leftCollectorJob?.cancel(); leftCollectorJob = null
        rightCollectorJob?.cancel(); rightCollectorJob = null
        // Clear stale PairingState — directed-connect just failed against it,
        // and the next scanAndConnect will fall through to scan + re-learn.
        pairing.clear()
        // Schedule the retry (don't recurse into scanAndConnect synchronously —
        // we're inside a state.collect on the lens, holding its coroutine).
        scope.launch {
            // The state.collect coroutines will naturally drift away from the
            // freshly-nulled leftBle/rightBle; nothing to cancel explicitly.
            this@G2Pipeline.state.transition(AppState.CONNECTING)
            scanAndConnect()
        }
    }

    // AtomicLong + CAS gives us atomic check-then-set so two collectors firing
    // a paired-emission near-simultaneously don't both pass the debounce check.
    // @Volatile alone only provides visibility, not atomicity for the if/set.
    private val lastTapAt = AtomicLong(0L)
    private val lastDoubleTapAt = AtomicLong(0L)
    private val lastScrollUpAt = AtomicLong(0L)
    private val lastScrollDownAt = AtomicLong(0L)

    private suspend fun collectEventsDebounced(events: kotlinx.coroutines.flow.Flow<EventParser.Event>) {
        events.collect { event ->
            val now = System.currentTimeMillis()
            when (event) {
                is EventParser.Event.Tap -> {
                    val prev = lastTapAt.get()
                    if (now - prev >= EVENT_DEBOUNCE_MS && lastTapAt.compareAndSet(prev, now)) {
                        onTap()
                    }
                }
                is EventParser.Event.DoubleTap -> {
                    val prev = lastDoubleTapAt.get()
                    if (now - prev >= EVENT_DEBOUNCE_MS && lastDoubleTapAt.compareAndSet(prev, now)) {
                        onDoubleTap()
                    }
                }
                is EventParser.Event.ScrollUp -> {
                    val prev = lastScrollUpAt.get()
                    if (now - prev >= EVENT_DEBOUNCE_MS) {
                        lastScrollUpAt.compareAndSet(prev, now)
                        // Firmware-native scroll handles teleprompter pages; no app action.
                    }
                }
                is EventParser.Event.ScrollDown -> {
                    val prev = lastScrollDownAt.get()
                    if (now - prev >= EVENT_DEBOUNCE_MS) {
                        lastScrollDownAt.compareAndSet(prev, now)
                    }
                }
                is EventParser.Event.Unknown -> {
                    // Phase 5 hardware testing refines EventParser → these become Tap/DoubleTap.
                    // Logged at DEBUG by EventParser itself; no further action here.
                }
                is EventParser.Event.Malformed -> {
                    Log.w(TAG, "malformed BLE event: ${event.reason}")
                }
            }
        }
    }

    /** Single-tap dispatch:
     *   - confirm pending → confirmed
     *   - recording → stop + send for transcription
     *   - else → start recording */
    fun onTap() {
        if (confirmation?.onTap() == true) return
        val s = streamer ?: run {
            Log.w(TAG, "onTap: streamer not initialized")
            return
        }
        if (s.isStreaming) {
            s.stop()
            state.transition(AppState.AWAITING_TRANSCRIPT)
        } else {
            s.start()
            state.transition(AppState.AWAITING_TRANSCRIPT)
        }
    }

    /** Double-tap dispatch:
     *   - confirm pending → rejected + reopen audio (per spec §6 step 5)
     *   - recording → cancel
     *   - else → show menu */
    fun onDoubleTap() {
        if (confirmation?.onDoubleTap() == true) {
            streamer?.start()
            state.transition(AppState.AWAITING_TRANSCRIPT)
            return
        }
        val s = streamer
        if (s?.isStreaming == true) {
            s.stop()
            state.transition(AppState.IDLE)
        } else {
            menu?.showMenu()
            state.transition(AppState.MENU)
        }
    }

    /** Phase 8 hookpoint: Tasker `START_RECORDING` / `STOP_RECORDING` intents land here. */
    fun startRecording() { streamer?.start() ; state.transition(AppState.AWAITING_TRANSCRIPT) }
    fun stopRecording() { streamer?.stop() ; state.transition(AppState.IDLE) }

    /** Start the WebSocket connection. Idempotent — re-calls re-use the same
     *  ConnectionManager. */
    fun start() {
        if (connection != null) return
        val url = prefs.serverUrl ?: run {
            Log.w(TAG, "start: no server URL configured")
            state.transition(AppState.ERROR)
            return
        }
        val token = prefs.authToken ?: run {
            Log.w(TAG, "start: no auth token configured")
            state.transition(AppState.ERROR)
            return
        }
        state.transition(AppState.CONNECTING)

        val cm = ConnectionManager(
            initialEndpoints = listOf(url),
            authToken = token,
            httpClient = httpClient,
            onMessage = ::dispatchInbound,
            onConnected = {
                state.transition(AppState.AUTHED)
                state.transition(AppState.IDLE)
                // Refresh the endpoint list defence #4.
                scope.launch { refreshEndpoints(cmRef = connection ?: return@launch) }
            },
            onDisconnected = {
                state.transition(AppState.CONNECTING)
                confirmation?.onDisconnected()
            },
            onAuthFailure = { count ->
                Log.w(TAG, "auth failure #$count")
                state.transition(AppState.ERROR)
            },
            onStuckTooLong = {
                Log.w(TAG, "STUCK_RELOAD_MS exceeded — would restart service here (Phase 6 hookpoint)")
                // Phase 7 wires the actual service restart. For now log loudly.
            },
        )
        connection = cm
        // Forward every bleStatus change to the server as a DiagMsg so we have
        // a server-side scrolling log of BLE state during hardware bring-up
        // (the notification cycles too fast to read by eye).
        scope.launch {
            bleStatus.collect { status ->
                cm.send(ClientMessage.Diag("BLE: $status"))
            }
        }
        hud?.let {
            menu = MenuController(it, cm)
            confirmation = ConfirmationFlow(it, cm)
        }
        // Phase 8: wire mic capture path. Streaming starts on user gesture
        // (or Tasker intent); the streamer just owns the audio_start/end +
        // binary-frame plumbing.
        streamer = AudioStreamer(MicCapture(context), cm)
        cm.connect()
    }

    fun stop() {
        bleScannerRef.getAndSet(null)?.stop()
        stopHeartbeat()
        // Tear down GATT connections cleanly so the BLE stack doesn't leak
        // open handles across service restart cycles (foreground service
        // reload-on-stuck per the watchdog).
        leftBle?.shutdownBle()
        rightBle?.shutdownBle()
        leftBle = null
        rightBle = null
        leftCollectorJob?.cancel(); leftCollectorJob = null
        rightCollectorJob?.cancel(); rightCollectorJob = null
        connection?.shutdown()
        connection = null
        scope.cancel()
    }

    /** ConnectionManager surface for outbound messages. */
    fun send(msg: ClientMessage) { connection?.send(msg) }

    private fun dispatchInbound(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.DispatchTargetList -> {
                menu?.dispatchTargets = msg.targets
            }
            is ServerMessage.DirectoryListReply -> {
                menu?.directories = msg.entries
            }
            is ServerMessage.Output -> {
                if (state.current != AppState.STREAMING) state.transition(AppState.STREAMING)
                hud?.render(msg.text)
            }
            is ServerMessage.TextDelta -> {
                // Phase 6 doesn't yet stream incremental updates to the HUD —
                // we wait for Output messages with full pages. Phase 8 may
                // optimize for low-latency streaming.
            }
            is ServerMessage.ResponseComplete -> {
                state.transition(AppState.IDLE)
            }
            is ServerMessage.SessionInfo -> {
                Log.i(TAG, "session_info project=${msg.projectPath} resumed=${msg.resumed} ccId=${msg.ccSessionId}")
            }
            is ServerMessage.ConfirmOnHud -> {
                state.transition(AppState.AWAITING_CONFIRMATION)
                val flow = confirmation
                if (flow == null) {
                    // Loud-and-proud: ConfirmationFlow not constructed (BLE clients
                    // not yet installed). Server-side promise will reject when this
                    // socket closes; for now log so the gap is observable.
                    Log.w(TAG, "confirm_on_hud arrived but ConfirmationFlow not initialized")
                    hud?.render("CONFIRM?\n${msg.text}\n\n(BLE not connected — cannot confirm)")
                } else {
                    flow.onConfirmRequest(msg)
                }
            }
            is ServerMessage.CcError -> {
                state.transition(AppState.ERROR)
                hud?.render("ERROR: ${msg.error}")
            }
            is ServerMessage.SttError -> {
                hud?.render("STT ERROR: ${msg.error}")
            }
            is ServerMessage.Error -> {
                state.transition(AppState.ERROR)
                hud?.render("ERROR: ${msg.message}")
            }
            // Bug fix #6: log loudly instead of silently dropping.
            is ServerMessage.Status -> Log.i(TAG, "status: mode=${msg.mode} ctx=${msg.contextPct}% processing=${msg.isProcessing}")
            is ServerMessage.ToolUse -> Log.i(TAG, "tool_use: ${msg.tool} ${msg.description}")
            is ServerMessage.BackgroundAlertMsg -> Log.i(TAG, "bg_alert: ${msg.alertType} session=${msg.sessionId} ${msg.details ?: ""}")
            is ServerMessage.PermissionRequest -> Log.i(TAG, "permission_request: id=${msg.requestId} tool=${msg.tool}")
            is ServerMessage.SttResult -> Log.i(TAG, "stt_result: \"${msg.text}\"")
            is ServerMessage.SessionList -> Log.i(TAG, "session_list: ${msg.sessions.size} saved")
            is ServerMessage.ActiveSessionList -> Log.i(TAG, "active_session_list: ${msg.sessions.size} active")
            is ServerMessage.RewindResult -> Log.i(TAG, "rewind_result: success=${msg.success} ${msg.summary}")
            is ServerMessage.AuthResult, is ServerMessage.Hb -> {
                // Handled inside ConnectionManager — these don't surface to dispatchInbound.
            }
            is ServerMessage.ConfigSnapshot -> Log.i(TAG, "config_snapshot received")
            is ServerMessage.DispatchTargetSet -> Log.i(TAG, "dispatch_target_set: ${msg.targetId} flow=${msg.flow}")
        }
    }

    private suspend fun refreshEndpoints(cmRef: ConnectionManager) {
        val token = prefs.authToken ?: return
        val bootstrap = prefs.serverUrl ?: return
        val list = EndpointFetcher(httpClient).fetch(bootstrap, token)
        if (list != null && list.isNotEmpty()) {
            Log.i(TAG, "endpoint refresh: ${list.size} endpoints")
            cmRef.setEndpoints(list)
        }
    }

    // Phase 7's emitAck + AckEmitter stub were obsoleted: ConfirmationFlow.kt
    // now sends BleAckMsg inline from its hud.render onComplete callback. The
    // dead code (and AckEmitter.kt) was removed in the third-pass cleanup.

    companion object {
        const val TAG = "G2Pipeline"

        /** Debounce window for paired-lens BLE input events (Phase 7 fix #10). */
        const val EVENT_DEBOUNCE_MS = 300L

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(10))
            .readTimeout(Duration.ofSeconds(10))
            // No callTimeout — that would be an I/O timeout on long operations.
            // OkHttp's connect/read are TCP-level transport limits, not I/O cuts.
            .build()
    }
}
