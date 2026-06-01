package com.g2cc.g2cc.net

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

/**
 * Kotlin port of /home/user/g2aria/app/src/connection.ts (lines 52-359).
 *
 * Five independent defences against the "stuck state" problem:
 *
 *   1. SERVER-SIDE PINGS + APP-LEVEL HB. Server sends `hb` every
 *      HEARTBEAT_INTERVAL_MS; we auto-reply with `client_hb` so the server
 *      detects our JS event-loop / Kotlin coroutine freeze (protocol pongs
 *      fire at the network layer even when the app is paused, so they can't
 *      be trusted as liveness).
 *
 *   2. LIVENESS WATCHDOG. A 5-s tick calls forceReconnect() if no INBOUND
 *      message in LIVENESS_TIMEOUT_MS. Race-safe via a generation counter
 *      (AtomicInteger): handlers bound to an older websocket ignore their
 *      events, so a late old-socket onClosed can't null out the new socket.
 *
 *   3. ENDPOINT ROTATION. On pre-auth failure, rotate through all known
 *      endpoints (Tailscale → LAN → ...) before backing off, so a LAN-IP
 *      change doesn't kill the Tailscale path.
 *
 *   4. ENDPOINT REFRESH. On each successful connect, re-fetch /endpoints
 *      from the bootstrap host (via EndpointFetcher) — always has current
 *      set.
 *
 *   5. LAST-RESORT PROCESS RESTART. If we've been offline for STUCK_RELOAD_MS
 *      despite all the above, restart the foreground service; the new
 *      process re-reads token + endpoints and retries from zero.
 *
 * Constants below mirror /home/user/G2CC/shared/src/constants.ts.
 */
class ConnectionManager(
    initialEndpoints: List<String>,
    private val authToken: String,
    private val httpClient: OkHttpClient,
    /** Called when an inbound message arrives (after auth + non-hb). */
    private val onMessage: (ServerMessage) -> Unit,
    private val onConnected: () -> Unit = {},
    private val onDisconnected: () -> Unit = {},
    private val onAuthFailure: (consecutiveCount: Int) -> Unit = {},
    /** Phase 6 hookpoint — Phase 7 ties this into `process restart` last-resort. */
    private val onStuckTooLong: () -> Unit = {},
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var ws: WebSocket? = null
    private val wsGen = AtomicInteger(0)

    // Mutated from both the OkHttp dispatcher thread (onClosed / onFailure) and
    // from refreshEndpoints (scope.launch on Dispatchers.IO). @Volatile + the
    // safe-index pattern on read prevents IOOBE if endpoints shrinks between
    // a read of `endpoints` and `endpoints[currentEndpointIdx]`.
    @Volatile private var endpoints: List<String> = initialEndpoints
    @Volatile private var currentEndpointIdx = 0
    @Volatile private var endpointsTriedSinceSuccess = 0
    private var reconnectDelayMs = RECONNECT_BASE_MS
    private var consecutiveAuthFailures = 0
    private var lastMessageReceivedAt = System.currentTimeMillis()
    private var lastAuthedAt: Long? = null
    private var offlineSince: Long? = null
    private var attemptCount = 0
    private var reloadAttempted = false

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _events = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    val events: SharedFlow<ServerMessage> = _events.asSharedFlow()

    private var livenessJob: Job? = null
    private var clientHbJob: Job? = null
    private var reconnectJob: Job? = null

    fun setEndpoints(newEndpoints: List<String>) {
        if (newEndpoints.isEmpty()) return
        if (newEndpoints == endpoints) return
        endpoints = newEndpoints
        currentEndpointIdx = min(currentEndpointIdx, endpoints.size - 1)
        endpointsTriedSinceSuccess = 0
    }

    fun connect() {
        // Bug fix #5: don't reconnect if we already have a healthy authed
        // socket. (g2aria's TS check on `readyState === OPEN` doesn't translate
        // directly — OkHttp's WebSocket doesn't expose readyState. Use our
        // `_connected` flag, which flips true on auth_result success.)
        if (ws != null && _connected.value) return
        wsGen.incrementAndGet()
        val myGen = wsGen.get()
        val endpoint = endpoints.getOrNull(currentEndpointIdx) ?: run {
            Log.w(TAG, "connect: no endpoints configured")
            return
        }
        val request = Request.Builder().url(endpoint).build()
        val listener = G2CCListener(myGen)
        Log.i(TAG, "connect[$myGen] -> $endpoint")
        ws = httpClient.newWebSocket(request, listener)
        ensureLivenessWatchdog()
    }

    fun disconnect() {
        reconnectJob?.cancel(); reconnectJob = null
        livenessJob?.cancel(); livenessJob = null
        clientHbJob?.cancel(); clientHbJob = null
        try { ws?.close(1000, "client disconnect") } catch (e: Exception) {
            Log.w(TAG, "close threw", e)
        }
        ws = null
        _connected.value = false
    }

    fun send(msg: ClientMessage) {
        // A-H3: loud-fail on send before the socket is ready. The brief window
        // between _connected.value=false and forceReconnect()'s new socket is a
        // real period where messages used to vanish invisibly.
        val w = ws ?: run {
            Log.w(TAG, "send(${msg::class.simpleName}) before socket ready — message dropped")
            return
        }
        try {
            val text = WsJson.codec.encodeToString(ClientMessage.serializer(), msg)
            // OkHttp's WebSocket.send() returns false when the message couldn't
            // be enqueued — buffer full (16 MiB cap) or socket closing. Used to
            // be silently dropped; surface loudly per LOUD AND PROUD.
            val accepted = w.send(text)
            if (!accepted) {
                Log.w(TAG, "OkHttp.send(${msg::class.simpleName}) returned false — message dropped (buffer full or closing)")
            }
        } catch (e: Exception) {
            Log.w(TAG, "send threw", e)
        }
    }

    /** Send binary frame (Phase 8 audio streaming between audio_start/audio_end). */
    fun sendBinary(payload: ByteArray) {
        // A-H3: same loud-fail logic as send() — audio frames at ~50 Hz are
        // exactly the case where silent drops would be invisible until the
        // server reports "audio too short" with no clue why.
        val w = ws ?: run {
            Log.w(TAG, "sendBinary(${payload.size}B) before socket ready — frame dropped")
            return
        }
        try {
            val accepted = w.send(okio.ByteString.of(*payload))
            if (!accepted) {
                Log.w(TAG, "OkHttp.send(binary ${payload.size}B) returned false — frame dropped (buffer full or closing)")
            }
        } catch (e: Exception) {
            Log.w(TAG, "sendBinary threw", e)
        }
    }

    /** Tear down whatever we think we have and reconnect immediately. Race-safe
     *  via the wsGen bump BEFORE touching the old socket. */
    fun forceReconnect() {
        reconnectJob?.cancel(); reconnectJob = null
        wsGen.incrementAndGet()                       // BEFORE close → late events from old socket bail
        try { ws?.close(4099, "force-reconnect") } catch (e: Exception) {
            Log.w(TAG, "forceReconnect close threw", e)
        }
        ws = null
        _connected.value = false
        clientHbJob?.cancel(); clientHbJob = null
        if (offlineSince == null) offlineSince = System.currentTimeMillis()
        onDisconnected()
        reconnectDelayMs = RECONNECT_BASE_MS
        lastMessageReceivedAt = System.currentTimeMillis()
        connect()
    }

    /** Cleanup. */
    fun shutdown() {
        disconnect()
        scope.cancel()
    }

    private inner class G2CCListener(private val myGen: Int) : WebSocketListener() {
        private fun isStale(): Boolean = wsGen.get() != myGen

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (isStale()) {
                try { webSocket.close(4100, "stale") } catch (e: Exception) { /* expected during reconnect */ }
                return
            }
            lastMessageReceivedAt = System.currentTimeMillis()
            // Send auth FIRST.
            send(ClientMessage.Auth(authToken))
            ensureLivenessWatchdog()
            ensureClientHbTimer()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (isStale()) return
            lastMessageReceivedAt = System.currentTimeMillis()
            val msg = try {
                WsJson.codec.decodeFromString(ServerMessage.serializer(), text)
            } catch (e: Exception) {
                Log.w(TAG, "onMessage parse failed: ${e.message}; raw=${text.take(120)}")
                return
            }
            when (msg) {
                is ServerMessage.AuthResult -> {
                    if (msg.success) {
                        _connected.value = true
                        consecutiveAuthFailures = 0
                        reconnectDelayMs = RECONNECT_BASE_MS
                        endpointsTriedSinceSuccess = 0
                        attemptCount = 0
                        offlineSince = null
                        lastAuthedAt = System.currentTimeMillis()
                        onConnected()
                        Log.i(TAG, "auth success endpoint=${endpoints[currentEndpointIdx]}")
                    } else {
                        consecutiveAuthFailures++
                        onAuthFailure(consecutiveAuthFailures)
                        Log.w(TAG, "auth failed (#$consecutiveAuthFailures): ${msg.error}")
                        // Server closes us with 4003; let onClosed drive the reconnect.
                    }
                }
                is ServerMessage.Hb -> {
                    // Reply immediately so the server knows our event loop is alive.
                    send(ClientMessage.ClientHb(System.currentTimeMillis()))
                }
                else -> {
                    onMessage(msg)
                    // A-H4: tryEmit returns false when the SharedFlow buffer is
                    // full (extraBufferCapacity=64, BufferOverflow.SUSPEND default
                    // → tryEmit drops). Used to be silently dropped; downstream
                    // SharedFlow collectors that are slow would lose protocol
                    // messages invisibly. LOUD AND PROUD.
                    val accepted = _events.tryEmit(msg)
                    if (!accepted) {
                        Log.w(TAG, "SharedFlow buffer overflow — dropped ${msg::class.simpleName} (slow collector?)")
                    }
                }
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            // Phase 6 doesn't expect server→client binary frames; surface loudly if they appear.
            Log.w(TAG, "unexpected binary frame size=${bytes.size}")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // Acknowledge the close handshake.
            try { webSocket.close(code, reason) } catch (e: Exception) { /* expected */ }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (isStale()) return
            val wasConnected = _connected.value
            ws = null
            _connected.value = false
            clientHbJob?.cancel(); clientHbJob = null

            if (offlineSince == null) offlineSince = System.currentTimeMillis()
            attemptCount++

            onDisconnected()

            // Rotate endpoints if we never reached success on this attempt.
            if (!wasConnected && endpoints.size > 1) {
                endpointsTriedSinceSuccess++
                currentEndpointIdx = (currentEndpointIdx + 1) % endpoints.size
            }
            val completedFullRotation =
                !wasConnected && endpointsTriedSinceSuccess >= endpoints.size
            scheduleReconnect(immediate = !completedFullRotation && !wasConnected)
            Log.i(TAG, "closed code=$code reason=\"$reason\" wasConnected=$wasConnected attempt=$attemptCount")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (isStale()) return
            Log.w(TAG, "onFailure ${t.message} response=${response?.code}")
            // onFailure does NOT trigger onClosed; replicate the close path.
            ws = null
            _connected.value = false
            clientHbJob?.cancel(); clientHbJob = null
            if (offlineSince == null) offlineSince = System.currentTimeMillis()
            attemptCount++
            onDisconnected()
            if (endpoints.size > 1) {
                endpointsTriedSinceSuccess++
                currentEndpointIdx = (currentEndpointIdx + 1) % endpoints.size
            }
            scheduleReconnect(immediate = endpointsTriedSinceSuccess < endpoints.size)
        }
    }

    private fun ensureLivenessWatchdog() {
        if (livenessJob?.isActive == true) return
        livenessJob = scope.launch {
            while (true) {
                delay(LIVENESS_CHECK_MS)
                val stuckMs = lastAuthedAt?.let { System.currentTimeMillis() - it } ?: 0L
                if (!_connected.value && lastAuthedAt != null
                    && stuckMs > STUCK_RELOAD_MS && !reloadAttempted) {
                    reloadAttempted = true
                    Log.w(TAG, "stuck for ${stuckMs}ms — invoking onStuckTooLong (last resort)")
                    onStuckTooLong()
                    continue
                }
                if (ws == null) continue
                val silent = System.currentTimeMillis() - lastMessageReceivedAt
                if (silent > LIVENESS_TIMEOUT_MS) {
                    Log.w(TAG, "silent for ${silent}ms — forcing reconnect")
                    forceReconnect()
                }
            }
        }
    }

    /** Proactive client heartbeat in addition to replying to server hbs.
     *  Guarantees app-level activity even if the server's hb is dropped. */
    private fun ensureClientHbTimer() {
        clientHbJob?.cancel()
        val myGen = wsGen.get()
        clientHbJob = scope.launch {
            while (wsGen.get() == myGen) {
                delay(HEARTBEAT_INTERVAL_MS)
                if (wsGen.get() != myGen) break
                send(ClientMessage.ClientHb(System.currentTimeMillis()))
            }
        }
    }

    private fun scheduleReconnect(immediate: Boolean) {
        reconnectJob?.cancel()
        val delayMs = if (immediate) 0L else reconnectDelayMs
        reconnectJob = scope.launch {
            if (delayMs > 0) delay(delayMs)
            if (!immediate) {
                reconnectDelayMs = (reconnectDelayMs.toDouble() * RECONNECT_MULTIPLIER)
                    .toLong().coerceAtMost(RECONNECT_MAX_MS)
            }
            connect()
        }
    }

    companion object {
        const val TAG = "G2CCConnection"

        // Mirrors /home/user/G2CC/shared/src/constants.ts.
        const val HEARTBEAT_INTERVAL_MS = 10_000L
        const val LIVENESS_TIMEOUT_MS = 30_000L
        const val LIVENESS_CHECK_MS = 5_000L
        const val STUCK_RELOAD_MS = 90_000L

        const val RECONNECT_BASE_MS = 1_000L
        const val RECONNECT_MAX_MS = 30_000L
        const val RECONNECT_MULTIPLIER = 1.5
    }
}
