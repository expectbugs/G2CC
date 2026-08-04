package com.g2cc.g2cc.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Earbud wire-family round-trips (2026-08-04) — the Kotlin side of the
 * shared/src/protocol.ts additions. Decode vectors are literal server JSON;
 * encode checks assert the discriminator + additive-optional shape.
 */
class WsProtocolEarbudTest {
    private val json = WsJson.codec

    @Test fun authCarriesCaps() {
        val s = json.encodeToString(ClientMessage.serializer(),
            ClientMessage.Auth("tok", caps = listOf("audio-out", "media-lane", "earbud-buttons")))
        assertTrue(s.contains("\"caps\":[\"audio-out\",\"media-lane\",\"earbud-buttons\"]"))
        assertTrue(s.contains("\"type\":\"auth\""))
    }

    @Test fun configSnapshotMicSourceDecodes() {
        val m = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"config_snapshot","micSource":"earbud"}""") as ServerMessage.ConfigSnapshot
        assertEquals("earbud", m.micSource)
        // Old-server bare shape still decodes (pre-earbud compatibility).
        val bare = json.decodeFromString(ServerMessage.serializer(), """{"type":"config_snapshot"}""") as ServerMessage.ConfigSnapshot
        assertEquals(null, bare.micSource)
    }

    @Test fun speakFamilyDecodes() {
        val start = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"speak_start","id":"spk-1","num":3,"music":"duck","duckDb":-12}""") as ServerMessage.SpeakStart
        assertEquals("spk-1", start.id)
        assertEquals(3L, start.num)
        assertEquals("duck", start.music)
        val end = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"speak_end","id":"spk-1","num":3,"chunks":14,"totalMs":9042.5}""") as ServerMessage.SpeakEnd
        assertEquals(14, end.chunks)
        val cancelAll = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"speak_cancel"}""") as ServerMessage.SpeakCancel
        assertEquals(null, cancelAll.num)
    }

    @Test fun mediaFamilyDecodes() {
        val open = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"media_open","id":"med-1","url":"/media/track/42?token=x&fmt=opus","title":"Dogs","artist":"Pink Floyd"}""") as ServerMessage.MediaOpen
        assertTrue(open.url.startsWith("/media/track/42"))
        val ctl = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"media_ctl","cmd":"duck","value":-12}""") as ServerMessage.MediaCtl
        assertEquals(-12.0, ctl.value!!, 0.0)
        val chime = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"chime","name":"timer"}""") as ServerMessage.Chime
        assertEquals("timer", chime.name)
    }

    @Test fun ackAndEventEncode() {
        val ack = json.encodeToString(ClientMessage.serializer(),
            ClientMessage.SpeakAck("spk-1", "played", route = "8:Pixel Buds 2a"))
        assertTrue(ack.contains("\"type\":\"speak_ack\""))
        assertTrue(ack.contains("\"status\":\"played\""))
        assertTrue(!ack.contains("reason"))   // omitted-null shape (explicitNulls=false)
        val ev = json.encodeToString(ClientMessage.serializer(),
            ClientMessage.MediaEvent("med-1", "ended", posMs = 194000))
        assertTrue(ev.contains("\"type\":\"media_event\""))
        assertTrue(ev.contains("\"state\":\"ended\""))
    }

    @Test fun mediaButtonInputEncodes() {
        val s = json.encodeToString(ClientMessage.serializer(),
            ClientMessage.Input(event = "media_button", button = "next"))
        assertTrue(s.contains("\"event\":\"media_button\""))
        assertTrue(s.contains("\"button\":\"next\""))
    }
}
