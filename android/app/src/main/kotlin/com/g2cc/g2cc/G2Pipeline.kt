package com.g2cc.g2cc

import android.content.Context
import android.util.Log
import com.g2cc.g2cc.audio.AudioStreamer
import com.g2cc.g2cc.audio.MicCapture
import com.g2cc.g2cc.ble.AckEmitter
import com.g2cc.g2cc.ble.EventParser
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.PairingState
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

    /** Phase 5 hookpoint: install the connected BLE clients (one per lens). The
     *  G2CCService scans, finds, and connects on hardware-authorized startup. */
    fun installBleClients(left: G2BleClient, right: G2BleClient) {
        leftBle = left
        rightBle = right
        val newHud = Hud(left, right)
        hud = newHud
        connection?.let {
            menu = MenuController(newHud, it)
            confirmation = ConfirmationFlow(newHud, it)
        }
        // Phase 7: route BLE input events through the event parser to gestures.
        // We subscribe to ONE side (Left). Phase 5 hardware testing will determine
        // whether both lenses emit the same event or only one — adjust as needed.
        scope.launch {
            left.events.collect { event ->
                when (event) {
                    is EventParser.Event.Tap -> onTap()
                    is EventParser.Event.DoubleTap -> onDoubleTap()
                    is EventParser.Event.ScrollUp,
                    is EventParser.Event.ScrollDown -> {
                        // Firmware-native scroll handles teleprompter pages.
                    }
                    is EventParser.Event.Unknown -> {
                        // Phase 5 hardware testing refines EventParser → these become Tap/DoubleTap.
                    }
                    is EventParser.Event.Malformed -> {
                        Log.w(TAG, "malformed BLE event: ${event.reason}")
                    }
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
            else -> {
                // Other types (Status, ToolUse, etc.) are accepted but not yet
                // surfaced to the HUD. Phase 6 polish or Phase 9 may add status-bar
                // rendering using Status messages.
            }
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

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(10))
            .readTimeout(Duration.ofSeconds(10))
            // No callTimeout — that would be an I/O timeout on long operations.
            // OkHttp's connect/read are TCP-level transport limits, not I/O cuts.
            .build()
    }
}
