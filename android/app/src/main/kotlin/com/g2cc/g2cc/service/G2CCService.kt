package com.g2cc.g2cc.service

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.g2cc.g2cc.G2CCApp
import com.g2cc.g2cc.G2Pipeline
import com.g2cc.g2cc.MainActivity
import com.g2cc.g2cc.R
import com.g2cc.g2cc.ble.PairingState
import com.g2cc.g2cc.state.AppState
import com.g2cc.g2cc.storage.Prefs
import kotlinx.coroutines.launch

/**
 * Foreground service of type connectedDevice.
 *
 * Phase 4 scope: starts and stays alive. Updates the status notification when
 * the state machine transitions. NO BLE work, NO WebSocket — those are
 * Phases 5 and 6 respectively.
 *
 * Hard rules:
 *  - NO `withTimeout` on any background work; service supervision is via
 *    state-machine events, not arbitrary clock thresholds.
 *  - NO `catch (e: Exception) {}` swallows; failures get logged loudly.
 */
class G2CCService : LifecycleService() {

    private lateinit var pipeline: G2Pipeline
    private var btStateReceiver: BluetoothStateReceiver? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        Log.i(TAG, "onCreate")
        startInForeground()

        val prefs = Prefs(applicationContext)
        val pairing = PairingState(applicationContext)
        pipeline = G2Pipeline(applicationContext, prefs, pairing)

        // Register the BT state receiver dynamically. Manifest declaration
        // wouldn't work on Android 8+ for this implicit broadcast.
        val receiver = BluetoothStateReceiver(pipeline)
        val filter = android.content.IntentFilter(android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }
        btStateReceiver = receiver

        // React to state-machine transitions by updating the notification.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                pipeline.state.flow.collect { current -> updateNotification(current, pipeline.bleStatus.value) }
            }
        }
        // Also update the notification when BLE status changes so Adam can see
        // pairing progress without the HUD (and without USB/adb logcat access).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                pipeline.bleStatus.collect { ble -> updateNotification(pipeline.state.current, ble) }
            }
        }

        // Start the WebSocket connection.
        pipeline.start()
        // Bug fix #1: kick off the BLE scan-and-connect now that the pipeline
        // exists. Permissions for BLUETOOTH_SCAN/CONNECT must be granted
        // beforehand by MainActivity; if not, scanAndConnect logs loudly and
        // transitions state to ERROR.
        pipeline.scanAndConnect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        Log.i(TAG, "onStartCommand action=${intent?.action}")
        // Phase 8: dispatch Tasker / Assistant / adb-broadcast actions.
        val action = intent?.action
        if (action != null && ::pipeline.isInitialized) {
            when (action) {
                ACTION_START_RECORDING -> pipeline.startRecording()
                ACTION_STOP_RECORDING -> pipeline.stopRecording()
                ACTION_SHOW_DIRECTORY_PICKER -> {
                    // Switch dispatch target to "cc" then ask for the picker.
                    pipeline.send(com.g2cc.g2cc.net.ClientMessage.DispatchTargetSelect("cc"))
                }
                ACTION_SWITCH_DISPATCH_TARGET -> {
                    val targetId = intent.getStringExtra(EXTRA_TARGET_ID)
                    if (targetId != null) {
                        pipeline.send(com.g2cc.g2cc.net.ClientMessage.DispatchTargetSelect(targetId))
                    } else {
                        Log.w(TAG, "SWITCH_DISPATCH_TARGET missing target_id extra")
                    }
                }
            }
        }
        // START_STICKY: Android relaunches us after death (subject to battery-opt exemption).
        return START_STICKY
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy")
        running = false
        btStateReceiver?.let { runCatching { unregisterReceiver(it) } }
        btStateReceiver = null
        if (::pipeline.isInitialized) pipeline.stop()
        super.onDestroy()
    }

    private fun startInForeground() {
        val launchIntent = Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = baseNotification(getString(R.string.fg_state_idle), pi).build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun updateNotification(state: AppState, bleStatus: String = "?") {
        val launchIntent = Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = "${state.label(this)}  |  BLE: $bleStatus"
        val notif = baseNotification(text, pi).build()
        val nm = getSystemService(android.app.NotificationManager::class.java) ?: return
        nm.notify(NOTIF_ID, notif)
    }

    private fun baseNotification(text: String, contentIntent: PendingIntent): NotificationCompat.Builder =
        NotificationCompat.Builder(this, G2CCApp.CHANNEL_ID)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.fg_title))
            .setContentText(text)
            .setContentIntent(contentIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)

    companion object {
        const val TAG = "G2CCService"
        private const val NOTIF_ID = 0xCC2C
        // Process-level flag — survives configuration changes; cleared in onDestroy.
        // Used by MainActivity for status display. Volatile so threads see the
        // latest value without an explicit barrier.
        @Volatile
        var running: Boolean = false
            private set

        val isRunning: Boolean get() = running

        fun start(context: Context) {
            val intent = Intent(context, G2CCService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                @Suppress("DEPRECATION")
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, G2CCService::class.java))
        }

        /** Phase 8: route a Tasker / Assistant action through the service so
         *  G2Pipeline can dispatch it. Starts the service if it isn't running. */
        fun dispatchAction(context: Context, action: String, extras: android.os.Bundle? = null) {
            val intent = Intent(context, G2CCService::class.java).apply {
                this.action = action
                if (extras != null) putExtras(extras)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                @Suppress("DEPRECATION")
                context.startService(intent)
            }
        }

        // Action constants — duplicated from IntentReceiver so the receiver doesn't
        // need to import the service constants.
        const val ACTION_START_RECORDING = "com.g2cc.intent.action.START_RECORDING"
        const val ACTION_STOP_RECORDING = "com.g2cc.intent.action.STOP_RECORDING"
        const val ACTION_SHOW_DIRECTORY_PICKER = "com.g2cc.intent.action.SHOW_DIRECTORY_PICKER"
        const val ACTION_SWITCH_DISPATCH_TARGET = "com.g2cc.intent.action.SWITCH_DISPATCH_TARGET"
        const val EXTRA_TARGET_ID = "target_id"
    }
}
