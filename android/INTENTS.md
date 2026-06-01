# G2CC Tasker / Assistant Intent Surface

The G2CC Android app exposes a small set of broadcast actions so other automations on the phone (Tasker, Assistant routines, Bixby routines, `adb shell am broadcast`) can drive it without UI.

All actions are **explicit** (no implicit state inference). All accepted actions are **logged** in logcat under tag `G2CCIntent` so wiring can be verified end-to-end.

## Actions

| Action | Phase active | Purpose | Extras |
|--------|--------------|---------|--------|
| `com.g2cc.intent.action.PING` | 4 | Health probe; logs that the receiver got the broadcast and reports whether the service is running. | — |
| `com.g2cc.intent.action.START_RECORDING` | 8 | Open the audio capture stream (DJI or phone-mic fallback). HUD shows "Recording…". | — |
| `com.g2cc.intent.action.STOP_RECORDING` | 8 | Close the audio stream and queue for ASR. | — |
| `com.g2cc.intent.action.SHOW_DIRECTORY_PICKER` | 6 | Render the `/home/user/*` directory picker on the HUD. | — |
| `com.g2cc.intent.action.SWITCH_DISPATCH_TARGET` | 9 | Switch dispatch target (e.g. between vanilla CC and a swarm specialist when both exist). | `target_id` (string) |

All actions targeting Phase ≥5 are accepted in Phase 4 and logged but produce no behavioral change yet — placeholders so Tasker integration can be configured ahead of the underlying functionality landing.

## Testing via adb

```bash
adb shell am broadcast -a com.g2cc.intent.action.PING
# logcat: G2CCIntent: received action=com.g2cc.intent.action.PING extras=null
# logcat: G2CCIntent: PING (service running=true)

adb shell am broadcast -a com.g2cc.intent.action.START_RECORDING
adb shell am broadcast -a com.g2cc.intent.action.STOP_RECORDING

adb shell am broadcast -a com.g2cc.intent.action.SWITCH_DISPATCH_TARGET --es target_id swarm-code
```

## Tasker recipe templates

**"Open Claude Code in <project>"** — bound to a hot-corner gesture or the volume rocker:

1. Action: Send Intent
2. Action: `com.g2cc.intent.action.SHOW_DIRECTORY_PICKER`
3. Target: Broadcast Receiver
4. (Adam picks the directory on the HUD via tap-scroll.)

**"Start recording"** — bound to e.g. "OK Google, talk to G2CC":

1. Action: Send Intent
2. Action: `com.g2cc.intent.action.START_RECORDING`
3. Target: Broadcast Receiver

## Security note + threat model

The receiver is `exported="true"` with **no** `android:permission` attribute — any installed app can broadcast these actions. The third-pass code review flagged this (finding A-Medium #10). Adam's call after weighing the tradeoffs: **leave open**, explicitly documented here.

### Why open

1. **Sideloaded only** — no Play Store distribution. The APK only lands on Adam's single Pixel 10a via USB ADB.
2. **Curated install set** — the threat model is "what apps does Adam install." That set is small and known.
3. **Tasker integration is the point** — a signature-level permission would require signing Tasker (or a custom plugin) with the G2CC release cert, which adds friction without addressing a real attacker.
4. **Action surface is minimal** — actions are pure side-effect triggers (start/stop record, show picker, switch target). No untrusted input is consumed; at most a string `target_id` extra. Phase 4's stub handlers don't write to any persistent state from intent payloads.

### When this should be tightened

If any of these become false, add the signature-level permission immediately:

- Broader distribution (sharing the APK beyond Adam's phone)
- An untrusted app gets installed
- Future actions consume free-form input that reaches the dispatcher (e.g. a hypothetical `INVOKE_SPECIALIST` with a prompt extra — that would let any app drive Claude Code with arbitrary text)

### Tightening recipe

Add to `AndroidManifest.xml`:

```xml
<permission android:name="com.g2cc.permission.CONTROL"
            android:protectionLevel="signature" />

<receiver android:name=".intents.IntentReceiver"
          android:exported="true"
          android:permission="com.g2cc.permission.CONTROL">
  ...
</receiver>
```

Then re-sign Tasker (or build a Tasker plugin signed with the G2CC cert) so it can hold the new permission.

### Payload validation discipline

When new actions land later (Phase 6 may add `OPEN_PROJECT` with a path payload, Phase 9 may add `INVOKE_SPECIALIST` with target id + free-form prompt), every new payload field gets explicit validation at the receiver — no implicit deserialization, no silent failure on bad input. If a future action consumes free-form text, the tightening recipe above becomes mandatory.
