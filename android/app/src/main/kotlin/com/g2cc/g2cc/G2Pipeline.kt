package com.g2cc.g2cc

import android.content.Context
import android.util.Log
import com.g2cc.g2cc.audio.AudioStreamer
import com.g2cc.g2cc.audio.MicCapture
import com.g2cc.g2cc.ble.AckEmitter
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.time.Duration

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
 * Phase 7 wires the confirm-on-hud round-trip + BLE ack via AckEmitter.
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

    var leftBle: G2BleClient? = null
    var rightBle: G2BleClient? = null
    private var hud: Hud? = null
    private var menu: MenuController? = null
    private var confirmation: ConfirmationFlow? = null
    private var connection: ConnectionManager? = null
    private var streamer: AudioStreamer? = null

    /** Bug fix #1 wiring: scan for the G2 lens pair, connect both, and install
     *  the BLE clients into the pipeline. Idempotent — calling twice is a no-op
     *  if BLE clients are already installed. */
    @android.annotation.SuppressLint("MissingPermission")
    fun scanAndConnect() {
        if (leftBle != null && rightBle != null) {
            Log.i(TAG, "scanAndConnect: BLE already installed")
            return
        }
        val scanner = BleScanner(context)
        scanner.start { event ->
            when (event) {
                is BleScanner.Event.FoundPair -> {
                    scanner.stop()
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
                    Log.w(TAG, "scan failure: ${event.reason}")
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
        scope.launch { collectEventsDebounced(left.events) }
        scope.launch { collectEventsDebounced(right.events) }
    }

    @Volatile private var lastTapAt: Long = 0L
    @Volatile private var lastDoubleTapAt: Long = 0L
    @Volatile private var lastScrollUpAt: Long = 0L
    @Volatile private var lastScrollDownAt: Long = 0L

    private suspend fun collectEventsDebounced(events: kotlinx.coroutines.flow.Flow<EventParser.Event>) {
        events.collect { event ->
            val now = System.currentTimeMillis()
            when (event) {
                is EventParser.Event.Tap -> {
                    if (now - lastTapAt >= EVENT_DEBOUNCE_MS) {
                        lastTapAt = now
                        onTap()
                    }
                }
                is EventParser.Event.DoubleTap -> {
                    if (now - lastDoubleTapAt >= EVENT_DEBOUNCE_MS) {
                        lastDoubleTapAt = now
                        onDoubleTap()
                    }
                }
                is EventParser.Event.ScrollUp -> {
                    if (now - lastScrollUpAt >= EVENT_DEBOUNCE_MS) {
                        lastScrollUpAt = now
                        // Firmware-native scroll handles teleprompter pages; no app action.
                    }
                }
                is EventParser.Event.ScrollDown -> {
                    if (now - lastScrollDownAt >= EVENT_DEBOUNCE_MS) {
                        lastScrollDownAt = now
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

    /** Phase 7 hookpoint: emit BLE-ack signals back to the server's Channel Router.
     *  AckEmitter logs today; Phase 7 wires the BleAckMsg send path through ConnectionManager. */
    fun emitAck(messageId: String, verified: Boolean, reason: String? = null) {
        if (verified) AckEmitter.markVerified(messageId)
        else AckEmitter.markUnverified(messageId, reason ?: "(no reason)")
        val cm = connection ?: return
        cm.send(ClientMessage.BleAck(
            messageId = messageId,
            status = if (verified) "verified" else "unverified",
            reason = reason,
        ))
    }

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
