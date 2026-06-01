# G2CC Holds — deferred work catalog

What's NOT in Phases 0-9, and why. Each entry has a **trigger** (what unlocks
it), a **scope** (what gets done when triggered), and a **cost** (size of
work).

---

## Hardware-test gates (Adam runs these on physical hardware)

### H1. Phase 4 — 8-hour foreground service survival test

**Trigger:** Adam sideloads the APK to the Pixel 10a and carries it for a
full work day.
**Scope:** confirms the foreground service of type `connectedDevice`
+ battery-optimization exemption is sufficient for survival across screen-off
+ Doze. Documented in `/home/user/G2CC/android/README.md` §"Phase 4
verification gate".
**Cost:** 1 work day calendar time, near-zero engineering time.
**If it fails:** investigate Doze policy / OEM modifications. Service that
gets killed in pocket has zero value regardless of BLE polish.

### H2. Phase 5 — BLE driver hardware test

**Trigger:** Adam has the G2 glasses charged + paired-to-Even-app once
recently (so we know hardware health is OK), and authorizes the BLE
connection test (per CLAUDE.md "Don't experiment with bonding flows
without saying so first").
**Scope:** runs the i-soxi `examples/teleprompter/teleprompter.py` end-to-end
first (sanity-check the protocol clone hasn't drifted post-firmware), then
sideloads the G2CC APK and:
  - confirms both lenses scan + auth (7-packet handshake works)
  - confirms a test display frame ("hello G2") renders
  - confirms the unpair-and-repair recovery flow
  - reverse-engineers the actual byte format for tap / double-tap / scroll
    events (Phase 5 ships `EventParser` returning `Unknown` for these — see
    PROTOCOL_NOTES.md §"Open research items" #1)
**Cost:** ~1-2 days, including the input-event RE work.
**If it fails:** firmware drift since i-soxi commit `b227335` is the most
likely cause. Fresh BTSnoop captures + i-soxi PRs are the path forward.

### H3. Phase 6 — WebSocket end-to-end test

**Trigger:** H2 passes (we have a working BLE driver to render on).
**Scope:** sideload + test:
  - tap → menu → Claude Code → directory picker (scrollable, no truncation)
  - pick `/home/user/aria` → server spawns CC there → first prompt
  - 5-defence reconnect tests (pull server plug 35s; block Tailscale)
  - reload-on-stuck (pause server 100s; phone restarts service)
**Cost:** ~half a day.

### H4. Phase 7 — confirm_on_hud round-trip

**Trigger:** H3 passes.
**Scope:** the test fixture in `ws-smoke.mjs` already covers the wire shape;
H4 confirms the actual gesture-to-confirmation works on real glasses.
  - server sends `confirm_on_hud("Delete /tmp/foo?")`
  - tap on glasses → server receives `confirmed`
  - double-tap on glasses → server receives `rejected`
  - disconnect-mid-confirm → server's promise loudly rejects with
    "Disconnected before confirmation"
**Cost:** ~hour.

### H5. Phase 8 — DJI captures + audio pipeline tuning

**Trigger:** Adam is back at the machine with the DJI receiver.
**Scope:** the default pipeline shifted from two-mic NLMS to single-mic
learned-profile after the May 28 phone-recording analysis showed textbook
stationarity (PSD drift 0.4 ± 1.4 dB over 60 s, 2.96 s cycle). H5 now is:
  1. Plug in DJI TX2 only (mono collar mic; NC off; auto-gain off; 32-bit float)
  2. Record ~30-60 s of noise alone with the machine running:
     `audio/tools/capture.py noise --mono` (no voice)
  3. Learn the production profile:
     `audio/tools/learn_noise_profile.py samples/noise-<ts>.wav \
        --output audio/profiles/machine.npz`
     (replaces the prototyping profile learned from the phone recording)
  4. Record ~30 s of speech against the machine for validation:
     `audio/tools/capture.py voice_plus_machine --mono`
  5. Run the pipeline against the validation capture:
       - notch_filter at profile['peak_freqs']
       - wiener_subtract with profile['noise_psd'], alpha=1.5 default
       - DeepFilterNet polish
       - faster-whisper
     Confirm WER is meaningfully better than the unprocessed baseline.
  6. If residual machine noise is audible, raise alpha to 2.0-2.5 (sweep
     showed +1-2 dB more reduction per +0.5 alpha at <0.2 dB extra speech
     impact on a +18 dB SNR signal).
  7. Then swap to Parakeet (after H6 below).
**Cost:** ~1 day. Simpler than the original two-mic NLMS workflow because
no reference mic alignment, no μ/taps sweep, no DJI NC-on-both-TX verification.
**Fallback:** `pipeline/nlms.py` is still in-tree if the single-mic path
underperforms in practice (e.g. additional non-stationary noise sources).

### H6. Phase 8 — NeMo install + Parakeet swap

**Trigger:** H5 has clean ANC working with faster-whisper.
**Scope:**
  1. Re-verify CUDA driver + nvcc version (Phase 0 noted divergence between
     nvidia-smi 13.2 and nvcc 12.9 — confirm what's installed today)
  2. Uncomment `nemo_toolkit[asr]` in `audio/requirements.txt`
  3. `audio/venv/bin/pip install -r audio/requirements.txt`. ~3GB download.
  4. Validate parakeet_engine.py against a clean LibriSpeech sample —
     **before plugging into the live mic path**. Reference WER 1.69%; allow
     small variance.
  5. If LibriSpeech result is way off (>3% WER), the wrapper contract is
     wrong: input shape, sample rate, return-value field names. Fix before
     proceeding.
  6. Switch `config.stt.engine` to `'parakeet'`.
  7. Re-evaluate ANC + Parakeet on `voice_plus_machine.wav`.
**Cost:** ~half a day if no contract issues; otherwise debugging time.

### H7. Phase 8 — full speak/see/confirm on glasses

**Trigger:** H5+H6 done; H2-H4 passing.
**Scope:** Adam at machine. Tap-to-record opens DJI USB stream from MicCapture;
tap-to-stop closes; transcript appears scrollably on HUD; tap=confirm dispatches
to active CC session; double-tap=reject re-opens.
**Cost:** ~hour for happy-path; iteration on edge cases (USB unplug
mid-stream, network blip mid-transcript) extends.

---

## Swarm-gated work (waits for `aria2/overhaul.md` to ship)

### S1. Swarm Code/Engineering specialist as dispatch target

**Trigger:** `aria2/overhaul.md` §5.16 implementation lands in production
(swarm Code specialist subprocess available with stream-json contract).
**Scope:** add `SwarmCodeDispatcher` class wrapping the swarm specialist's
subprocess, wire into `dispatch.ts` `DISPATCH_TARGETS`. Server-side change
only; Android app unchanged. See `docs/DISPATCH.md` for the exact steps.
**Cost:** ~half a day if the swarm specialist's stream-json shape exactly
matches CC's; otherwise a slightly heavier port to translate event shapes.

### S2. Swarm full-pipeline as dispatch target

**Trigger:** swarm full-pipeline (`overhaul.md` §1) running.
**Scope:** add `SwarmFullDispatcher` with `flow: 'immediate'` (no directory
picker). User taps "Ask ARIA anything" from the menu, speaks/types prompt,
swarm replies on HUD.
**Cost:** ~half a day, similar to S1.

### S3. Cross-specialist HUD confirmation routing via Channel Router

**Trigger:** swarm specialists exist that need HITL confirmation.
**Scope:** Health, Calendar, Communications, etc. specialists invoke the
Channel Router with `channel: 'hud'` for a confirmation gate. The Router
calls into the same `confirmOnHud()` server-side path that CC uses today.
No Android changes needed.
**Cost:** ~hour each on the server side; per-specialist integration work
lives in the swarm repo.

### S4. Repoint `aria2/core/hud.py` to G2CC's BLE endpoint

**Trigger:** `aria2/IMPLEMENTATION.md` §4.9 — when the G2CC app ships and
the swarm needs HUD confirmation.
**Scope:** `core/hud.py` (in aria2) currently calls into g2aria's HTTP
endpoint. Swap it to send `confirm_on_hud` messages over the G2CC server's
WebSocket. Once verified, **g2aria can be retired.**
**Cost:** ~half a day.

---

## Code-only deferred work

### C1. EventParser refinement for tap/double-tap/scroll bytes

**Trigger:** H2 (Phase 5 hardware test) reverse-engineers the actual BLE
event format.
**Scope:** update `EventParser.kt` `parse()` to return `Tap`, `DoubleTap`,
`ScrollUp`, `ScrollDown` for the appropriate byte patterns. Today returns
`Unknown` for all valid frames so the bytes get logged for inspection.
**Cost:** ~hour after the bytes are identified.

### C2. AUTH_TIMEOUT_MS interpretation final review

**Trigger:** any time before production.
**Scope:** Phase 0's `FORBIDDEN_PATTERN_AUDIT.md` §A documents the
interpretation: "5-second auth-window security guard, not an I/O timeout
on a long-running operation". Confirmed reasonable but worth a final pass
when reviewing the rules-compliance of the codebase.
**Cost:** minutes.

### C3. Background-alerts UI rendering on HUD

**Trigger:** Phase 8/9 polish.
**Scope:** the server already emits `BackgroundAlertMsg` when a non-active
session needs attention (permission/complete/error). Phase 6 receives them
but doesn't render. Add a status-bar indicator (e.g. `⚠1`) like g2code does.
**Cost:** ~hour.

### C4. Tool-result display polish

**Trigger:** Phase 9 polish.
**Scope:** today, full tool_result content is appended to scrollback (no
truncation). For long outputs (e.g. `find /` listings), the user has to
scroll a lot. Phase 9 polish could add a "show first/last N lines + tap
to expand" option that's still no-truncation-compliant (the full content
is reachable via "tap to expand").
**Cost:** ~half a day if implemented carefully.

### C5. Quick-prompts menu

**Trigger:** Phase 9 polish.
**Scope:** g2code had a `quickPrompts` array in config (e.g. "What's the
current status?", "Run the tests"). G2CC dropped this from the config in
Phase 2A; Phase 9 may reintroduce as a sub-menu after the directory picker.
**Cost:** ~hour, mostly UX.

---

## Summary

The buildable-now bucket is fully shipped (Phases 0-9). Everything in this
file is either:
  - Hardware-gated (Adam runs on real Pixel 10a + glasses + DJI mic)
  - Swarm-gated (waits for `aria2/overhaul.md` implementation)
  - Pure polish (no functional impact on the speak/see/confirm primary flow)

None of it blocks the primary use case: hands-free Claude Code dispatch from
the G2 glasses while at the machine.
