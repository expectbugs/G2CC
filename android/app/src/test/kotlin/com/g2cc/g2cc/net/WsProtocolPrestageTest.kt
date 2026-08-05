package com.g2cc.g2cc.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v1.22 gapless-prestage wire additions (MUSIC_SPEC D5.1, cap media-prestage):
 * media_open.next + media_ctl preload + media_event reason=auto_advanced.
 * Additive-optional both ways — the v1.21 shapes MUST keep decoding unchanged
 * (the compatibility floor).
 */
class WsProtocolPrestageTest {
    private val json = WsJson.codec

    @Test fun mediaOpenNextDecodes() {
        val open = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"media_open","id":"med-7","url":"/media/track/7?fmt=opus","title":"Dogs",
                "next":{"id":"med-8","url":"/media/track/8?fmt=opus","title":"Pigs","artist":"Pink Floyd","durMs":682000}}""",
        ) as ServerMessage.MediaOpen
        assertEquals("med-8", open.next?.id)
        assertEquals("Pigs", open.next?.title)
        assertEquals(682000L, open.next?.durMs)
    }

    @Test fun mediaOpenWithoutNextStillDecodes() {
        // The v1.21 shape — the compatibility floor stays byte-compatible.
        val open = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"media_open","id":"med-1","url":"/media/track/1?fmt=opus","title":"Money"}""",
        ) as ServerMessage.MediaOpen
        assertNull(open.next)
    }

    @Test fun mediaCtlPreloadDecodes() {
        val ctl = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"media_ctl","cmd":"preload","next":{"id":"med-9","url":"/media/track/9?fmt=opus","title":"Sheep"}}""",
        ) as ServerMessage.MediaCtl
        assertEquals("preload", ctl.cmd)
        assertEquals("med-9", ctl.next?.id)
        // Plain transport ctl keeps decoding with next null.
        val pause = json.decodeFromString(ServerMessage.serializer(),
            """{"type":"media_ctl","cmd":"pause"}""") as ServerMessage.MediaCtl
        assertNull(pause.next)
    }

    @Test fun mediaEventAutoAdvancedEncodes() {
        val s = json.encodeToString(ClientMessage.serializer(),
            ClientMessage.MediaEvent("med-8", "playing", 120, reason = "auto_advanced"))
        assertTrue(s.contains("\"type\":\"media_event\""))
        assertTrue(s.contains("\"reason\":\"auto_advanced\""))
        assertTrue(s.contains("\"id\":\"med-8\""))
    }

    @Test fun authAnnouncesPrestageCap() {
        val s = json.encodeToString(ClientMessage.serializer(),
            ClientMessage.Auth("tok", caps = listOf("audio-out", "media-lane", "earbud-buttons", "media-prestage")))
        assertTrue(s.contains("media-prestage"))
    }
}
