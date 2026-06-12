# G2CC Tasker / Assistant Intent Surface

**Re-audited 2026-06-11 (upgrades Phase 9, APK v1.7).** Finding: the receiver had silently
fallen OUT of the manifest along with the parked `G2CCService` it referenced — the whole
surface documented below was dead. v1.7 re-registers `IntentReceiver` in the manifest and
rewires it to `ConnectionService`. The DE architecture also obsoleted most of the actions:
dictation is **server-initiated** (glasses menu `Dictate`/`Ask` → `audio_request` → phone
mic) and the DE owns all UI, so phone-initiated recording/picker triggers no longer have a
meaning. They are kept as **deprecated-with-log** so existing Tasker wiring fails loudly in
logcat instead of silently.

All accepted actions are **logged** in logcat under tag `G2CCIntent`.

## Actions (v1.7)

| Action | Status | Behavior |
|--------|--------|----------|
| `com.g2cc.intent.action.PING` | **LIVE** | Logs receipt + whether `ConnectionService` is running. |
| `com.g2cc.intent.action.START_RECORDING` | DEPRECATED | Logs a deprecation warning. DE dictation is server-initiated via the glasses menu; no phone-side recording path exists (and the prime directive wants none). |
| `com.g2cc.intent.action.STOP_RECORDING` | DEPRECATED | Logs a deprecation warning (same rationale). |
| `com.g2cc.intent.action.SHOW_DIRECTORY_PICKER` | DEPRECATED | Logs a deprecation warning. The DE owns the picker (CC window root level). |
| `com.g2cc.intent.action.SWITCH_DISPATCH_TARGET` | DEPRECATED | Logs a deprecation warning. Dispatch is a server concern (Options menu / future swarm). |

Deprecated actions stay in the manifest filter so they keep LOGGING — removing them would
turn a stale Tasker recipe into a silent no-op, which violates the loud-failure rule.

**⚠ Implicit broadcasts do NOT reach manifest receivers on Android 8+** (review
2026-06-11b): a broadcast without an explicit package/component is suppressed by the OS
for manifest-declared receivers ("Background execution not allowed" in the system log —
our receiver never runs, so the loud-logging promise above only holds for EXPLICIT
sends). Tasker recipes MUST set the Package field to `com.g2cc.g2cc` (or Component
`com.g2cc.g2cc/.intents.IntentReceiver`); adb tests MUST pass `-p` or `-n` as below.

## Testing via adb

```bash
adb shell am broadcast -p com.g2cc.g2cc -a com.g2cc.intent.action.PING
# logcat: G2CCIntent: received action=com.g2cc.intent.action.PING extras=null
# logcat: G2CCIntent: PING (service running=true)

adb shell am broadcast -p com.g2cc.g2cc -a com.g2cc.intent.action.START_RECORDING
# logcat: G2CCIntent: ...START_RECORDING is DEPRECATED since v1.7 — DE dictation is server-initiated...
```

## Future re-expansion

When a phone-side trigger becomes genuinely useful again (e.g. a Tasker hot-corner that
asks the SERVER to start a dictation — equivalent to tapping `Ask` on the glasses), the
right shape is a new explicit action that forwards a REQUEST to the server over the WS
(`ConnectionService.instance`), never a parallel phone-side pipeline. Every new payload
field gets explicit validation at the receiver; if a future action carries free-form text
that reaches the dispatcher, the signature-permission tightening below becomes mandatory.

## Security note + threat model

The receiver is `exported="true"` with **no** `android:permission` attribute — any installed
app can broadcast these actions. The third-pass code review flagged this (finding A-Medium
#10). Adam's call after weighing the tradeoffs: **leave open**, explicitly documented here.

### Why open

1. **Sideloaded only** — no Play Store distribution. The APK only lands on Adam's single
   Pixel 10a via USB ADB / the /setup page.
2. **Curated install set** — the threat model is "what apps does Adam install." Small, known.
3. **Tasker integration is the point** — a signature-level permission would require signing
   Tasker (or a custom plugin) with the G2CC release cert, friction without a real attacker.
4. **Action surface is minimal** — v1.7: one health probe + four deprecation logs. No
   untrusted input reaches any state.

### When this should be tightened

If any of these become false, add the signature-level permission immediately:

- Broader distribution (sharing the APK beyond Adam's phone)
- An untrusted app gets installed
- A future action consumes free-form input that reaches the dispatcher

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

Then re-sign Tasker (or build a Tasker plugin signed with the G2CC cert) so it can hold the
new permission.
