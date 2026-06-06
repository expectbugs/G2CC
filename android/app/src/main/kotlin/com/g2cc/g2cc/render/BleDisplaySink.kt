package com.g2cc.g2cc.render

import com.g2cc.g2cc.ble.G2BleClient

/**
 * [DisplaySink] backed by a lens's BLE write queue. By the proven convention, display writes
 * go to the **R lens only** (the firmware mirrors R→L internally), so construct this with the
 * right-lens [G2BleClient]. Maps the renderer's paced packet batch straight onto
 * `G2BleClient.queueWrites`, which applies the per-packet pacing and reports true success.
 */
class BleDisplaySink(private val client: G2BleClient) : DisplaySink {
    override fun write(
        packets: List<ByteArray>,
        delaysAfterMs: List<Long>,
        label: String,
        onComplete: (Boolean) -> Unit,
    ) {
        client.queueWrites(packets, label, delaysAfterMs, onComplete)
    }
}
