package com.g2cc.g2cc.ble

/**
 * BLE connection state. Sealed for exhaustive `when` matching.
 *
 * Phase 5 placeholder; Phase 6 wires the state machine's transitions to
 * real BLE callbacks and HUD updates.
 */
sealed interface ConnectionState {

    /** Not currently scanning or connected. */
    data object Idle : ConnectionState

    /** Scanning for advertisements with name pattern "Even G2_*". */
    data object Scanning : ConnectionState

    /** Connecting to one or both lenses (BLE GATT). */
    data class Connecting(val side: Side) : ConnectionState

    /** GATT connected but auth handshake not yet complete. */
    data class GattConnected(val side: Side) : ConnectionState

    /** Auth handshake in progress (sending the 7 packets, awaiting response). */
    data class Authenticating(val side: Side) : ConnectionState

    /** Authenticated; ready for feature service traffic. */
    data class Ready(val side: Side) : ConnectionState

    /** Disconnected — may be reconnecting in the background. */
    data class Disconnected(val side: Side, val reason: String) : ConnectionState

    /** Loud-and-proud failure state. */
    data class Error(val side: Side?, val message: String, val cause: Throwable? = null) : ConnectionState
}

/** Which lens of the dual-glass G2 pair. PROTOCOL_NOTES.md §"Device naming". */
enum class Side { Left, Right }
