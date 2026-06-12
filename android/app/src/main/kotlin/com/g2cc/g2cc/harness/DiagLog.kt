package com.g2cc.g2cc.harness

import android.util.Log
import com.g2cc.g2cc.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/**
 * Verbose diagnostics sink for the display harness. EVERY project-relevant event — BLE state
 * transitions, negotiated MTU/PHY/conn-params, each renderer op + write result, ring input
 * events, errors, and every test step — is routed through [log]. Always mirrored to logcat;
 * when [enabled] (the Diag checkbox), lines are batched and POSTed to the server's `/diag`
 * endpoint (Bearer-gated) so the full trace lands in a log on the home PC.
 *
 * Best-effort upload: a failed POST is logged loudly to logcat and the batch dropped (diag
 * must never block or crash the harness) — it is not silently swallowed.
 */
object DiagLog {
    @Volatile var enabled = false

    private val queue = ConcurrentLinkedQueue<String>()
    private val seq = AtomicInteger(0)
    // ThreadLocal (review 2026-06-11b): log() runs on main, OkHttp socket
    // threads, the BLE notify thread and the mic IO thread — SimpleDateFormat
    // is NOT thread-safe (garbled timestamps; rare AIOOBE that would propagate
    // into whatever callback was logging).
    private val fmt = object : ThreadLocal<SimpleDateFormat>() {
        override fun initialValue() = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    }
    private val http = OkHttpClient()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val url = "http://${BuildConfig.SERVER_HOST}:${BuildConfig.SERVER_PORT}/diag"
    private var pump: Job? = null

    fun log(tag: String, msg: String) {
        val line = "${fmt.get()!!.format(Date())} #${seq.incrementAndGet()} [$tag] $msg"
        Log.i(TAG, line)
        if (enabled) queue.add(line)
    }

    /** Start the background batch-pump (idempotent). Call once from the Activity scope. */
    fun start(scope: CoroutineScope) {
        if (pump?.isActive == true) return
        pump = scope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(1000)        // batch cadence (pacing, not an operation timeout)
                flush()
            }
        }
    }

    fun stop() {
        pump?.cancel(); pump = null
    }

    private fun flush() {
        if (queue.isEmpty()) return
        val token = BuildConfig.AUTH_TOKEN
        if (token.isEmpty()) {
            Log.w(TAG, "diag POST skipped — no AUTH_TOKEN baked into this build")
            queue.clear(); return
        }
        val batch = ArrayList<String>(200)
        while (batch.size < 200) { val l = queue.poll() ?: break; batch.add(l) }
        if (batch.isEmpty()) return
        val arr = JSONArray(); for (l in batch) arr.put(l)
        val body = JSONObject().put("lines", arr).toString().toRequestBody(jsonType)
        val req = Request.Builder().url(url).header("Authorization", "Bearer $token").post(body).build()
        try {
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) Log.w(TAG, "diag POST http ${resp.code} — dropped ${batch.size} lines")
            }
        } catch (e: IOException) {
            Log.w(TAG, "diag POST failed (${e.message}) — dropped ${batch.size} lines")
        }
    }

    const val TAG = "G2CCHarness"
}
