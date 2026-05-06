# G2CC Android App

Direct-BLE companion for Even G2 glasses + WebSocket bridge to the G2CC server.

**Phase 4 ships only the platform plumbing**: foreground service, battery-optimization-exemption flow, permission requests, BootReceiver auto-restart, Tasker integration surface, state machine placeholder. **No BLE driver, no WebSocket client, no HUD rendering yet** — those are Phases 5, 6, and beyond.

This file covers building, sideloading, and verifying Phase 4 end-to-end before authorizing Phase 5.

## Layout

```
android/
  build.gradle.kts                    top-level Gradle config
  settings.gradle.kts
  gradle.properties
  gradle/wrapper/gradle-wrapper.properties
  gradle/libs.versions.toml           version catalog (single source of truth)
  app/
    build.gradle.kts
    proguard-rules.pro
    src/main/
      AndroidManifest.xml
      kotlin/com/g2cc/g2cc/
        G2CCApp.kt                    Application; FG notification channel
        MainActivity.kt               status display + start/stop service
        service/G2CCService.kt        FG service (connectedDevice type)
        service/BootReceiver.kt       auto-start on boot / app update
        state/AppState.kt             enum + transition rules (placeholder)
        state/StateMachine.kt         coroutine-flow-backed holder
        intents/IntentReceiver.kt     Tasker / Assistant entry surface
        setup/SetupActivity.kt        battery-opt + URL/token paste
        setup/BatteryOptimization.kt  helper for the exemption flow
        storage/Prefs.kt              SharedPreferences-backed config
        net/, hud/                    empty (Phase 5/6)
      res/
        values/{strings,themes,colors}.xml
        layout/{activity_main,activity_setup}.xml
        drawable/ic_notification.xml
        xml/{backup_rules,data_extraction_rules}.xml
        mipmap-anydpi-v26/ic_launcher.xml
  INTENTS.md                          Tasker integration reference
  README.md                           this file
```

## Building

The build host (`/home/user/`) does **not** have Android Studio installed; the
project is structured to be opened on a different machine, OR Android Studio
can be installed here later via Portage (`emerge dev-util/android-studio`)
once the rest of Phases 4-6 are queued.

To build elsewhere (macOS / another Linux box):

```bash
# Open the android/ directory in Android Studio Iguana (2024.2.1) or later.
# Or from the CLI:
./gradlew :app:assembleDebug

# Output:
# app/build/outputs/apk/debug/app-debug.apk
```

`./gradlew` will be created on first import (Android Studio offers to do it automatically), or:

```bash
gradle wrapper --gradle-version 8.10.2
```

(requires a system Gradle install).

## Sideloading to Pixel 10a

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.g2cc.g2cc/.MainActivity
```

## Phase 4 verification gate

Before authorizing Phase 5 (BLE driver), confirm each of these on the actual Pixel 10a:

1. **First launch UX**
   - Tap "Setup" — Setup activity opens.
   - Tap "Request exemption" — system battery-optimization dialog appears; approve. Returning to Setup shows "Exempt ✓".
   - Paste a URL from `http://<server>:7300/setup` (or hand-type for now); tap Save.
   - Back to Main; status shows `configured: yes`, `battery exempt: yes`.

2. **Service lifecycle**
   - Tap "Start service" — permission dialogs appear (BLUETOOTH_CONNECT/SCAN, POST_NOTIFICATIONS); approve all.
   - Persistent notification "G2CC — Booting…" appears.
   - Logcat: `G2CCService: onCreate`, `G2CCState: transition: BOOTING -> ...`.
   - `adb shell dumpsys activity services | grep G2CC` shows the service running.

3. **Survives the workday**
   - Toggle screen off; lock the phone; carry it for 8 hours.
   - At end of day, `adb shell dumpsys activity services | grep G2CC` still shows the service.
   - **If it was killed**, Phase 4 fails the gate — investigate Doze policy, OEM modifications, etc., before proceeding.

4. **BootReceiver**
   - `adb reboot` (or restart phone manually).
   - Within 30s of boot completing, `adb shell dumpsys activity services | grep G2CC` shows the service auto-started.
   - Logcat: `G2CCBootReceiver: onReceive action=android.intent.action.BOOT_COMPLETED`.

5. **Tasker / adb intents**
   - `adb shell am broadcast -a com.g2cc.intent.action.PING`
   - Logcat: `G2CCIntent: received action=com.g2cc.intent.action.PING ...`
   - `G2CCIntent: PING (service running=true)`.
   - Repeat for each documented action; verify logs.

6. **Reinstall preserves config**
   - Uninstall.
   - Reinstall.
   - Open app; Setup shows the previously-saved URL + token (via cloud backup rules in `data_extraction_rules.xml`). If not, re-paste.

7. **CI grep gates** (run from `/home/user/G2CC/android/`):
   ```bash
   rg "withTimeout|withTimeoutOrNull" app/src/main/        # must be empty
   rg "Thread\.sleep" app/src/main/                        # must be empty
   rg "catch\s*\([^)]*\)\s*\{\s*\}" app/src/main/          # must be empty (no swallows)
   ```

When all seven pass, Phase 4 is complete and Phase 5 can be authorized.

## Hard rules in this layer

From the project's three absolute rules:

- **No `withTimeout` / `withTimeoutOrNull`** wrapping BLE / WebSocket / capture / display I/O. The state machine is event-driven; external signals drive transitions, not arbitrary clock thresholds. (Phase 4 doesn't have any of these I/O paths yet — but the rule is locked in here so Phase 5/6 inherit it from a clean baseline.)
- **No `catch (e: Exception) {}` swallows.** Failures are logged loudly via `android.util.Log` at WARN/ERROR level. Recoverable conditions log at INFO with explicit context.
- **No fixed-N truncation** of user-facing strings. Phase 6's HUD scrolls; Phase 4's debug status display in `MainActivity.statusText` already uses multi-line natural wrapping.
- **No `Thread.sleep` in service code.** Use coroutine `delay()` only where genuinely time-driven (e.g. retry backoff), and only in concert with cancellable scopes.
- **BLE writes that don't check the callback status** — Phase 5 will be vigilant about this. Phase 4 has no BLE code, so the rule is just queued as a pull-request lint.

## Inheritance lineage

Maps to the source files this code was ported from. See `/home/user/G2CC/docs/INHERITANCE_MAP.md` for the full table. Phase 4-relevant rows:

- `state/AppState.kt`, `state/StateMachine.kt` — placeholder; will get real wiring in Phase 6 from `g2code/app/src/state.ts`.
- `MainActivity.kt`, `setup/SetupActivity.kt` — UX shape inherited from g2code's main.ts but rebuilt natively (the Even Hub WebView client gets retired entirely).
- The 5-defence reconnect pattern from `g2aria/app/src/connection.ts` lands in Phase 6 as `net/ConnectionManager.kt`.
- BLE driver lands in Phase 5 against `/home/user/G2CC/docs/PROTOCOL_NOTES.md`.

## Phase 5 prep

Before Phase 5 starts:

1. Confirm the i-soxi protocol clone's commit SHA is still current:
   ```bash
   cd "/home/user/G2 Custom/even-g2-protocol" && git pull && git rev-parse HEAD
   ```
   Update `/home/user/G2CC/docs/PROTOCOL_NOTES.md` if the SHA has moved.
2. Charge the G2 glasses; confirm both lenses pair via the official Even Realities app first (so we know the hardware is healthy before debugging our own BLE code).
3. Run the i-soxi `examples/teleprompter/teleprompter.py` end-to-end (cloned at `/home/user/G2 Custom/even-g2-protocol/examples/teleprompter/`):
   ```bash
   cd "/home/user/G2 Custom/even-g2-protocol/examples/teleprompter"
   /home/user/G2CC/audio/venv/bin/pip install bleak
   /home/user/G2CC/audio/venv/bin/python teleprompter.py "hello G2"
   ```
   If this fails, the protocol clone is the wrong reference (firmware drift) and Phase 5 needs to start with fresh BTSnoop captures, not Kotlin code.
