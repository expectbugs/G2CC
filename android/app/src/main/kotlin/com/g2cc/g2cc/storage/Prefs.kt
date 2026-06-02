package com.g2cc.g2cc.storage

import android.content.Context
import android.content.SharedPreferences

/**
 * Persistent server URL + auth token. Phase 4 keeps this tiny — just the two
 * fields needed to start the foreground service. Phase 5 adds bonded-glasses
 * BLE address; Phase 6 may add per-endpoint priorities.
 *
 * Backed by SharedPreferences. The setup-page QR contains both values; setup
 * activity parses + persists.
 */
class Prefs(context: Context) {
    private val sp: SharedPreferences =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString(KEY_URL, null)
        set(value) { sp.edit().putString(KEY_URL, value).apply() }

    var authToken: String?
        get() = sp.getString(KEY_TOKEN, null)
        set(value) { sp.edit().putString(KEY_TOKEN, value).apply() }

    /** 4th-pass review LOW: atomic setup-time save. Writes BOTH url + token
     *  in a single edit + commit() (synchronous, durable before return).
     *  Use this for the setup flow where partial persistence (url saved,
     *  token not) would leave BootReceiver in an unstartable state if the
     *  OS killed the process between the two field-setter apply() calls. */
    fun saveServerAndToken(url: String?, token: String?): Boolean {
        return sp.edit()
            .putString(KEY_URL, url)
            .putString(KEY_TOKEN, token)
            .commit()
    }

    fun clear() {
        sp.edit().clear().apply()
    }

    companion object {
        private const val FILE = "g2cc-prefs"
        private const val KEY_URL = "server_url"
        private const val KEY_TOKEN = "auth_token"
    }
}
