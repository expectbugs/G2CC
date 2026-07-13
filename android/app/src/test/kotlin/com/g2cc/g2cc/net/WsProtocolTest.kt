package com.g2cc.g2cc.net

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Wire-shape proofs for the multi-surface (2026-07-13) protocol additions.
 * The load-bearing one: `os_attach` with a null surface must encode to the
 * BYTE-EXACT pre-1.18 shape `{"type":"os_attach"}` (encodeDefaults=false +
 * explicitNulls=false in [WsJson]) so an old server sees the legacy message.
 */
class WsProtocolTest {

    private fun enc(m: ClientMessage): String =
        WsJson.codec.encodeToString(ClientMessage.serializer(), m)

    private fun decServer(json: String): ServerMessage =
        WsJson.codec.decodeFromString(ServerMessage.serializer(), json)

    // ---------------------------------------------------------------- os_attach

    @Test
    fun `os_attach with null surface keeps the legacy bare wire shape byte-exactly`() {
        assertEquals("""{"type":"os_attach"}""", enc(ClientMessage.OsAttach()))
        assertEquals("""{"type":"os_attach"}""", enc(ClientMessage.OsAttach(surface = null)))
    }

    @Test
    fun `os_attach carries the surface when set`() {
        assertEquals("""{"type":"os_attach","surface":"phone"}""", enc(ClientMessage.OsAttach(surface = "phone")))
    }

    // ---------------------------------------------------------------- input event 'text'

    @Test
    fun `input text encodes lean and round-trips`() {
        val msg = ClientMessage.Input(event = "text", text = "hi")
        val json = enc(msg)
        assertEquals("""{"type":"input","event":"text","text":"hi"}""", json)
        assertEquals(msg, WsJson.codec.decodeFromString(ClientMessage.serializer(), json))
    }

    @Test
    fun `input text is never truncated — a long paragraph round-trips whole`() {
        val long = buildString { repeat(10_000) { append(('a' + (it % 26))) } }
        val back = WsJson.codec.decodeFromString(
            ClientMessage.serializer(),
            enc(ClientMessage.Input(event = "text", text = long)),
        ) as ClientMessage.Input
        assertEquals(10_000, back.text!!.length)
        assertEquals(long, back.text)
    }

    @Test
    fun `plain input events still omit the text field`() {
        assertEquals("""{"type":"input","event":"tap"}""", enc(ClientMessage.Input(event = "tap")))
    }

    // ---------------------------------------------------------------- reset / resets from the server

    @Test
    fun `reset hard encodes`() {
        assertEquals("""{"type":"reset","kind":"hard"}""", enc(ClientMessage.Reset(kind = "hard")))
        assertEquals("""{"type":"reset","kind":"soft"}""", enc(ClientMessage.Reset(kind = "soft")))
    }

    @Test
    fun `glasses_reset decodes to the object`() {
        assertEquals(ServerMessage.GlassesReset, decServer("""{"type":"glasses_reset"}"""))
    }

    @Test
    fun `hard_reset decodes to the object`() {
        assertEquals(ServerMessage.HardReset, decServer("""{"type":"hard_reset"}"""))
    }

    // ---------------------------------------------------------------- client_hb g2Connected

    @Test
    fun `client_hb omits g2Connected when unset — the pre-1_18 shape`() {
        assertEquals("""{"type":"client_hb","now":5}""", enc(ClientMessage.ClientHb(now = 5)))
    }

    @Test
    fun `client_hb carries g2Connected when reported`() {
        assertEquals(
            """{"type":"client_hb","now":5,"g2Connected":true}""",
            enc(ClientMessage.ClientHb(now = 5, g2Connected = true)),
        )
        assertEquals(
            """{"type":"client_hb","now":5,"g2Connected":false}""",
            enc(ClientMessage.ClientHb(now = 5, g2Connected = false)),
        )
    }
}
