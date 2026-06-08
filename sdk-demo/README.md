# G2 Capability Demonstrator (`g2cap`)

An Even Hub **SDK app** (web/TS, runs inside the Even App's WebView) that steps through **every
display + input capability** the `@evenrealities/even_hub_sdk` exposes. Its purpose is **reverse
engineering**: load it in the Even App, run a **BTSnoop** while exercising each capability, then
decode how each SDK call maps to the `e0-XX` BLE wire frames our custom renderer
(`android/.../render/DisplayProto.kt`) targets.

Background + the full plan: `../docs/SDK_CAPABILITY_MAP.md`. Scope is **display + input only**
(no mic/IMU/device-status — see that doc + memory `g2-ble-display-input-only`).

## How it works on-glass

A **group menu** → **step-through** model. Each capability is exercised in isolation, and every
test's parameters are baked into container **names + on-screen text**, so the capture is
**self-documenting** (you can tell which test a frame belongs to from the bytes).

Controls (the same on every screen):

| Gesture | Action |
|---|---|
| **double-tap** (global) | next step; past a group's end → back to the menu |
| **tap / scroll / list-select** | interact with the page's focusable container — **this is what we capture** |
| from the **MENU**: tap a group | enter it |

The top **nav bar** always shows `G2CAP <group> <step/total> <label>` and the last input event.

## Groups (what each decodes)

| Group | Steps | Wire features it reveals |
|---|---|---|
| **INPUT** | echo gestures (focusable body) | `e0-01` input vocab: tap / scroll-top / scroll-bottom / double-tap + **source** (R-temple/L-temple/ring) + the `isEventCapture` mechanism |
| **TEXT** | plain, 3 styling variants, multi-3, multi-8cap | text container schema + **border width/color/radius + padding** fields; the 8-text-container cap |
| **UPGRADE** | setup, full replace, partial off4/len4 | `f1=5` text-update; **contentOffset/contentLength** (partial replace — confirms/corrects our `f3/f4`) |
| **LIST** | list5 (sel-border, auto width), list20 (no border, fixed width) | **list/menu container wire format** + item selection events (the ★★★ gap) |
| **IMAGE** | 200×100 bands, 288×144 max, solid, 4 tiles | `f1=3` image-push via the SDK path + the **input image format** + the 4-image cap |
| **MIXED+RAMP** | text+list+image, ramp-12 | wrapper ordering with all 3 types; the 12-container / 8-text / 4-image caps together |
| **EXIT** | shutdown(1) confirm, shutdown(0) now | `f1=9` exit + `exitMode` semantics (the frame we currently "never send") |

## Run it (on the PC)

```bash
cd /home/user/G2CC/sdk-demo
npm install
npm run dev        # serves the app on 0.0.0.0:5173
# in another shell:
npm run qr         # prints a QR for http://100.107.139.121:5173 — scan it in the Even App
```

Hot-reload: edit `src/`, the WebView reloads. (If `100.107.139.121` isn't the right address for
your phone, run `npx evenhub qr --url "http://<PC-IP>:5173"`.)

For a **stable install** instead of the dev server: `npm run pack` → `g2cap.ehpk`, then install
that through the Even App.

## Capture procedure (do one GROUP per capture — keep them short)

Per memory `btsnoop-capture-gotcha`, long/multi-app captures get truncated/evicted. So:

1. Android **Developer Options → Bluetooth HCI snoop log = Enabled** (NOT Filtered), then toggle
   **Bluetooth OFF then ON** (the GMS filter flag is read at BT-stack init).
2. Launch `g2cap` in the Even App (cold) → you're at the **MENU**.
3. Tap into **one group**, double-tap through its steps slowly, doing the on-screen gestures.
   Narrate (which step / what you see) — only your eyes confirm paint.
4. Stop, pull the bug-report, extract `btsnoop_hci.log` (NOT `btsnooz`).
5. Repeat for the next group (fresh capture).

Decode on the PC with `../scripts/btsnoop_parse.py` (verify `orig_len == incl_len` first — it
warns if the snoop is filtered). Then we extend `DisplayProto.kt`/`Scene.kt` to emit the new
primitives.

## ⚠ Image input format is a HYPOTHESIS

`updateImageRawData` is converted to gray4 by the Even App **host**; the SDK never states the
input pixel format. `src/images.ts` sends **raw 8-bit grayscale** (`FORMAT = 'gray8'`) as v1. If
the IMAGE group reports `imageToGray4Failed` / `imageSizeInvalid` (shown on the nav line), change
`FORMAT` in `src/images.ts` to `'gray4'`, `'bmp4'`, or `'rgba'` and recapture. The whole point of
the IMAGE group is to learn which one the host accepts and what it puts on the wire.
