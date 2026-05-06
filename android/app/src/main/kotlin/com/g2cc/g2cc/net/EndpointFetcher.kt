package com.g2cc.g2cc.net

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Fetches the multi-endpoint JSON from `<bootstrap>/endpoints`. The Android
 * client refetches on each successful auth so it always has the current
 * priority-sorted list (Tailscale → LAN → other).
 *
 * Mirrors the g2aria connection.ts §"ENDPOINT REFRESH" pattern (defence #4 of 5).
 *
 * NO TIMEOUTS on the HTTP call beyond OkHttp's built-in connect/read timeouts —
 * those are TCP-level network failure timeouts (transport hygiene), not I/O
 * timeouts on a long-running operation. The configured values (10s / 10s)
 * are aligned with mobile-network reality, NOT arbitrary clock-kills.
 */
class EndpointFetcher(private val httpClient: OkHttpClient = defaultClient()) {

    @Serializable
    data class EndpointJson(
        val url: String,
        val label: String,
        @SerialName("ifaceName") val ifaceName: String,
        val address: String,
        val priority: Int,
    )

    @Serializable
    data class Reply(val endpoints: List<EndpointJson>)

    /** Fetch the endpoint list. Returns the priority-sorted URLs (low priority = highest preference)
     *  on success; null + loud log on failure. */
    suspend fun fetch(bootstrapUrl: String, authToken: String): List<String>? = withContext(Dispatchers.IO) {
        // Convert ws(s)://host:port/ws → http(s)://host:port/endpoints
        val httpUrl = bootstrapUrl
            .replace("ws://", "http://")
            .replace("wss://", "https://")
            .removeSuffix("/ws")
            .trimEnd('/') + "/endpoints"
        val request = Request.Builder()
            .url(httpUrl)
            .addHeader("Authorization", "Bearer $authToken")
            .build()
        try {
            httpClient.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "fetch $httpUrl failed code=${resp.code} message=${resp.message}")
                    return@withContext null
                }
                val body = resp.body?.string() ?: run {
                    Log.w(TAG, "fetch $httpUrl returned empty body")
                    return@withContext null
                }
                val reply = WsJson.codec.decodeFromString(Reply.serializer(), body)
                reply.endpoints.sortedBy { it.priority }.map { it.url }
            }
        } catch (e: Exception) {
            // LOUD: log the failure cause; caller can re-try or fall back to current endpoint.
            Log.w(TAG, "fetch $httpUrl threw", e)
            null
        }
    }

    companion object {
        const val TAG = "G2CCEndpointFetcher"

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            // Network-transport timeouts only. NOT I/O-operation timeouts.
            .connectTimeout(java.time.Duration.ofSeconds(10))
            .readTimeout(java.time.Duration.ofSeconds(10))
            .build()
    }
}
