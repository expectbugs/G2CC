# Even Hub SDK → G2 Wire Capability Map + Reverse-Engineering Plan

**Created 2026-06-06.** Durable record of the Even Hub SDK capability surface, how it maps to
the `e0-XX` BLE display channel our renderer targets, the SDK↔hardware limit cross-validation,
the agreed scope, and the build→capture→decode→extend plan. Written so a fresh session can
resume if this one drops.

Companion docs: `docs/PROTOCOL_NOTES.md` (decoded wire protocol + hardware-confirmed render
constraints + the msgId rule), `docs/GLASSES_OS.md` (OS vision/plan), `HANDOFF.md` (entry point).
Memories: `g2-ble-display-input-only` (scope), `g2-render-limits`, `g2-display-protocol-decoded`.

---

## 1. The architecture reframe (why BTSnoop is the method)

The Even Hub SDK (`@evenrealities/even_hub_sdk`) is **not a BLE library** — it is a thin
**WebView↔Flutter JSON bridge**. An Even Hub "app" (`.ehpk`) is a web app (HTML/JS, Vite-built)
that runs in a `flutter_inappwebview` WebView **inside the Even App** (Flutter host).

- Web→host calls: `window.flutter_inappwebview.callHandler('evenAppMessage', {method, params})`,
  awaited directly.
- Host→web pushes: `window._listenEvenAppMessage(message)` → re-dispatched as DOM CustomEvents.
- The Flutter host (Even App) owns **all** BLE, protobuf encoding, gray4 conversion,
  fragmentation, and delivery. The SDK does JSON field-mapping only — its own type docs repeat
  *"no protobuf encode/decode"* (index.d.ts:291,462,663,942). Grep of the obfuscated runtime
  confirms zero UUIDs / protobuf / BLE / GATT symbols.

**Consequence:** the SDK source reveals the *complete logical capability set* (the menu of what
the firmware exposes to Hub apps) but **nothing** about the wire bytes. The wire bytes are what
the Even App emits — captured via **BTSnoop**. That traffic rides the **same `e0-XX` Hub-app
channel** (`0x5401` write / `0x5402` notify) our custom renderer already hijacks and drives.

So: **SDK `.d.ts` = the capability menu; BTSnoop of an SDK app exercising each capability = the
wire encoding; together = a complete renderer spec.** That is the whole strategy. (Consistent
with CLAUDE.md "the SDK abstracts away the wire format we need" — we observe its *output*, not
its source.)

---

## 2. SDK + toolchain identity (verified on disk)

| Thing | Value |
|---|---|
| SDK package | `@evenrealities/even_hub_sdk` **0.0.10** |
| SDK on disk | `/home/user/g2code/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts` (exports list at `:1292`; obfuscated JS, but `.d.ts` is clean ground truth, JSDoc mostly Chinese) |
| CLI | `@evenrealities/evenhub-cli` **0.1.11** — `login`, `init`, `pack`, `qr` |
| Simulator | `@evenrealities/evenhub-simulator` **0.7.2** (+ `sim-linux-x64`); has `--automation-port` for scripted UI; "supplement, not replacement for hardware testing" — produces NO BLE |
| Example app | `/home/user/g2code/app/` (g2code = voice-controlled Claude Code client) |

**Dev-load (hot reload, no repack):** `evenhub qr --url "http://100.107.139.121:5173"` →
companion app scans → loads the Vite dev server live in its WebView. Reachable from Adam's phone
over Tailscale. g2code's `npm run qr` = `evenhub qr --http --port 5173`.

**Build + package:** `vite build` → `dist/` (SDK is bundled/inlined, no runtime fetch) →
`evenhub pack app.json dist -o x.ehpk`. The `.ehpk` is a custom binary container (magic ASCII
`EHPK`, version `0100`, deflate/zstd-capable + a final obfuscation layer, **not a zip**, no
crypto) — treat as opaque; we have the source so we never need to unpack it.

**`app.json` manifest schema** (zod-validated by the CLI):
- `package_id` — reverse-DNS, `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`, **no hyphens/underscores**.
- `edition` — `"202601"` (the value `init`/examples emit).
- `name` ≤20 chars · `version` semver · `min_app_version` · `min_sdk_version` (g2code `0.0.10`).
- `entrypoint` — e.g. `index.html`.
- `permissions` — array of `{name, desc(1–300)}`; `name` ∈ `network` (also takes
  `whitelist:string[]`, `["*"]`/empty = unrestricted), `location`, `g2-microphone`,
  `phone-microphone`, `album`, `camera` (camera = no G2 hardware). Older object-form in the
  g2code design docs is stale; array-form is what the current CLI validates.
- `supported_languages` — each ∈ `en de fr es it zh ja ko`.

`evenhub login` (Even Realities account) gates publishing and may gate dev sideload — Adam has
loaded g2code before, so his companion app is already set up.

---

## 3. Complete SDK capability surface (the "ALL functionality" inventory)

Source: `index.d.ts`. Constructors are `constructor(data?: Partial<T>)`; every model has
`toJson()`/`fromJson()`. Items marked **[OUT]** are excluded by scope (§5) but documented so we
know they exist.

### 3.1 Lifecycle / bridge
- `waitForEvenAppBridge(): Promise<EvenAppBridge>` — recommended init (`:1290`).
- `EvenAppBridge.getInstance()`; `get ready`; `callEvenApp(method, params)` — low-level escape hatch.
- `onLaunchSource(cb: (s: 'appMenu'|'glassesMenu') => void)` (`:1220`) — **fires once after
  load, NOT on reload; subscribe early.** Keystone for app-vs-glasses-menu launch
  (see memory `g2cc-app-initiated-goal`). g2code does not use it yet.
- Foreground/exit arrive as `sysEvent` (see 3.3).

### 3.2 Display — page container model (576×288, 4-bit gray, origin top-left)
A "page" = up to **12** containers; **exactly one** must have `isEventCapture=1`.
- `createStartUpPageContainer(c): Promise<StartUpPageCreateResult>` — **call once** (`:1167`).
- `rebuildPageContainer(c): Promise<boolean>` — subsequent full rebuilds; **flickers**, loses
  scroll/selection (`:1169`).
- `shutDownPageContainer(exitMode?): Promise<boolean>` (`:1201`) — `0`=exit now, `1`=show
  exit-confirm foreground layer.
- `textContainerUpgrade(c): Promise<boolean>` (`:1173`) — in-place text, **flicker-free**;
  partial replace via `contentOffset`/`contentLength`; `content` ≤2000.
- `updateImageRawData(d): Promise<ImageRawDataUpdateResult>` (`:1171`) — push gray image bytes
  into an existing image container; host does the gray4 conversion. Docs: prefer simple images,
  **never send concurrently — queue + await**, avoid frequent sends (RAM-limited).

Container properties (geometry in px; all optional):
- `TextContainerProperty` (`:361`) — `xPosition,yPosition,width,height`, `borderWidth(0–5)`,
  `borderColor(0–15/16)`, `borderRadius(0–10)`, `paddingLength(0–32)`, `containerID`,
  `containerName(≤16)`, `isEventCapture(0/1)`, `content(≤1000 at create)`.
- `ListContainerProperty` (`:322`) — same geometry/border set + `itemContainer`, `isEventCapture`.
- `ListItemContainerProperty` (`:299`) — `itemCount(1–20)`, `itemWidth(0=auto)`,
  `isItemSelectBorderEn(0/1)`, `itemName: string[]` (≤20 items, ≤64 chars).
- `ImageContainerProperty` (`:389`) — `xPosition,yPosition`, `width(20–288)`, `height(20–144)`,
  `containerID`, `containerName`. **No borders, cannot capture events.**
- Page builders `CreateStartUpPageContainer`/`RebuildPageContainer` — `containerTotalNum(1–12)`,
  `listObject[]`, `textObject[] (max 8)`, `imageObject[] (max 4)`, `widgetId` (auto-injected).
- `TextContainerUpgrade` (`:924`) — `containerID, containerName, contentOffset, contentLength, content`.
- Reserved image-fragment model `ImageRawDataUpdateFields` (`:416`) — `mapSessionId, mapTotalSize,
  compressMode, mapFragmentIndex, mapFragmentPacketSize, mapRawData` ("reserved", not wired in 0.0.10
  — but `compressMode` hints the firmware may accept compressed images).
- Result enums: `StartUpPageCreateResult` = `success=0/invalid=1/oversize=2/outOfMemory=3`;
  `ImageRawDataUpdateResult` = `success/imageException/imageSizeInvalid/imageToGray4Failed/sendFailed`.

**No typography control whatsoever** — no font family/size/weight/color/alignment. Text is fixed
firmware font, left+top. The ONLY styling is container border (width/16-gray color/radius) +
padding; no background fill.

### 3.3 Input / events
- `onEvenHubEvent(cb: (e: EvenHubEvent) => void)` (`:1266`) — unified stream;
  `EvenHubEvent = { listEvent?, textEvent?, sysEvent?, audioEvent?, jsonData? }` (check which is set).
- `OsEventTypeList` (`:707`): `CLICK=0, SCROLL_TOP=1, SCROLL_BOTTOM=2, DOUBLE_CLICK=3,
  FOREGROUND_ENTER=4, FOREGROUND_EXIT=5, ABNORMAL_EXIT=6, SYSTEM_EXIT=7, IMU_DATA_REPORT=8`.
  Gotcha: `fromJson` normalizes `0`→`undefined`; treat `undefined` as CLICK (g2code input.ts:87).
- `EventSourceType` (`:733`): `DUMMY=0, GLASSES_R=1, RING=2, GLASSES_L=3` — **only on `sysEvent`**
  (can't tell ring vs temple from list/text events).
- `List_ItemEvent` — `containerID, containerName, currentSelectItemName, currentSelectItemIndex, eventType`.
- `Text_ItemEvent` — `containerID, containerName, eventType`.
- `Sys_ItemEvent` — `eventType, eventSource, imuData?, systemExitReasonCode?`.
- The `isEventCapture=1` container routes gesture events; system events (fg/bg/exit, IMU) arrive
  as `sysEvent` regardless.

### 3.4 Storage
- `setLocalStorage(k, v): Promise<boolean>` / `getLocalStorage(k): Promise<string>` — **strings
  only**, App-side, survive WebView restart (browser `localStorage` does NOT). No delete (write `''`).

### 3.5 User / device status — mostly [OUT] (§5)
- `getUserInfo()` → `UserInfo{uid,name,avatar,country}`.
- `getDeviceInfo()` → `DeviceInfo{model(g1/g2/ring1), sn, status}`.
- `onDeviceStatusChanged(cb)` → `DeviceStatus{sn, connectType, isWearing?, batteryLevel?(0–100),
  isCharging?, isInCase?}`. **[OUT]** except battery may be marginally useful later (deferred).

### 3.6 Audio + IMU — [OUT] (§5), documented for completeness
- `audioControl(isOpen): Promise<boolean>` (`:1187`) → PCM via `audioEvent.audioPcm: Uint8Array`
  (g2code comments: 16 kHz, s16 LE, mono, 10 ms frames; no speaker — visual-only device).
- `imuControl(isOpen, reportFrq?: ImuReportPace P100…P1000): Promise<boolean>` (`:1195`) → IMU via
  `sysEvent` `IMU_DATA_REPORT` `imuData{x,y,z}`.

### 3.7 Host error codes
`EvenHubErrorCodeName` includes `APP_REQUEST_UPGRADE_HEARTBEAT_PACKET_SUCCESS` — confirms the host
runs the keepalive automatically (our `f1=12`); the SDK gives no API to send it.

---

## 4. Limits — SDK-documented, cross-validated with our hardware findings

The SDK's documented caps **confirm and explain** the limits we earned the hard way (see
`g2-render-limits`, `PROTOCOL_NOTES.md`):

| Limit | SDK says | Our hardware found | Verdict |
|---|---|---|---|
| Image regions | **max 4** | ≤4 (5th silently drops) | ✓ exact |
| Image size | **W 20–288, H 20–144** | 288×129 paints; 384×192 drops link (reason=3) | ✓ explains it — 384 > 288 W cap |
| Text regions | **max 8** | "8 text rows → blank scene" | ✓ we hit the 8-cap (our earlier "≤6" was confounded by clock+antenna) |
| Total containers | **1–12** | (untested ceiling) | new ceiling |
| Focusable region | **exactly 1 `isEventCapture=1`** | "input needs a focusable region" | ✓ — our `scroll=true` antenna is almost certainly a proxy for this flag |
| Text content | **≤1000 create / ≤2000 upgrade** | (untested) | new limit |
| `containerName` | **≤16 chars** | (untested) | new limit |
| Border color | **0–15 (16-gray)** | unused | new styling axis |

Still UNKNOWN until capture: whether all-black tiles / per-frame packet behavior we observed are
firmware quirks below these SDK limits (our finding: no all-black tile, no per-frame packet cap).

---

## 5. Scope (Adam's ruling, 2026-06-06) — DISPLAY + INPUT only

Memory `g2-ble-display-input-only`. **OUT of scope:**
- **Glasses microphone / any audio over BLE** (`audioControl`/`audioEvent`). DJI Mic 3 ≫ built-in
  mics, AND audio over BLE destabilizes the link (g2code/g2aria disconnect on recordings **>25 s**
  — same family as the atomic-image-burst `reason=3` drop). STT/mic path stays ENTIRELY off the G2
  BLE stream: DJI → phone/USB → server-side STT (spec Part B). G2CC already designed this way.
- **IMU / head-tracking** (`imuControl`).
- **Wear / charging-case / charging detection** (`isWearing`/`isInCase`/`isCharging`) — Adam only
  activates the glasses while wearing them.

---

## 6. SDK → wire mapping (knowns + hypotheses to confirm by capture)

What our renderer emits today (`android/.../render/DisplayProto.kt`): `f1=0` launch, `f1=3`
image-push (raw 4bpp BMP, chunked), `f1=5` text-update, `f1=7` layout, `f1=12` keepalive;
text container (xywh, id, name, scroll, text) + image container (xywh, id, name). **Nothing else.**

| SDK call | Hypothesized wire (CONFIRM) | Note |
|---|---|---|
| `createStartUpPageContainer` | `e0-20 f1=0` launch | likely matches |
| `rebuildPageContainer` | `e0-20 f1=7` layout | likely matches |
| `textContainerUpgrade(contentOffset,contentLength)` | `e0-20 f1=5` text-update | **may explain/correct the `f3/f4` we labeled "scrollOffset/contentHeight" — likely `contentOffset`/`contentLength` (partial replace)** |
| `updateImageRawData` | `e0-20 f1=3` image-push | confirm it's the same raw 4bpp BMP we send, or uses `compressMode` |
| `shutDownPageContainer(exitMode)` | `e0-20 f1=9` | clarifies the `f1=9` we "never send"; 0=now/1=confirm |
| input (`onEvenHubEvent`) | `e0-01 f1=2` | confirm `OsEventTypeList` + `EventSourceType` (R/L/ring) codes |
| `isEventCapture=1` | a dedicated container wire field? | confirm vs our `scroll=true` antenna proxy — could simplify our input model |
| keepalive | `e0-20 f1=12` (host-automatic) | already matched |

### Gap list (post scope-cut), prioritized
- ★★★ **List/menu widget** — native `list` container + item selection (we compose our own, never decoded).
- ★★ **Container styling** — border width/color/radius + padding.
- ★★ **Partial-text update** — `contentOffset`/`contentLength` (efficiency + corrects our f3/f4 read).
- ★★ **Image path confirm** — `updateImageRawData` / `compressMode` vs our raw-BMP path.
- ★★ **Input vocab + source tagging + `isEventCapture`** — nav correctness; firm up gesture codes.
- ★ **Exit semantics** — `shutDownPageContainer` → `f1=9`.

### Image compression — RE'd from the Even App APK (2026-06-07)

Pulled `com.even.sg` **v2.2.2** (matches the glasses firmware 2.2.2.x), extracted
`lib/arm64-v8a/libapp.so` (Flutter AOT, Dart 3.8.0). **CONFIRMED:** the host's `ImageRawDataUpdate`
protobuf really carries the "reserved" fields — `containerID, containerName, mapSessionId,
mapTotalSize, compressMode, mapFragmentIndex, mapFragmentPacketSize, mapRawData` — and
**`compressMode`'s type is an enum `ImageCompressFormat`** (a multi-format selector, NOT a bool).
Field order ⇒ `compressMode` = **inner field 5** of the `e0-20 f1=3` image sub-message — the exact
gap in our decode (we observe inner f1,f2,f3,f4,f6,f7,f8; `DisplayProto.imagePayload` skips 5). So
the image path has an explicit **compression-format flag at the protobuf level**, separate from the
BMP header — which means the v0.8 harness probe (BMP `biCompression` byte only, no f5) likely
**garbles** even if compression is supported: it doesn't raise the f5 flag.

**NOT yet recovered:** the `ImageCompressFormat` integer values/names and the wire payload each
expects. The AOT is stripped — field-name strings survive but are pool-deduplicated/scattered, and
enum int values are code constants. Recovering them needs a full Flutter-AOT reconstruction
(blutter; Dart 3.8.0, toolchain present) OR an empirical hardware sweep of inner-f5 ∈ {1,2,3} with
candidate payloads (we control the wire via our renderer; eyes decide) — **SHIPPED** in harness
**v0.9** (Test → CMP 1–6: baseline + f5∈{1,2,3}×RLE4-BMP + f5=1×RLE4-raw; `DisplayProto.imagePayload`
gained an optional `compressMode`, `G2Renderer.setImageRaw` pushes arbitrary bytes with f5 set).

**v1.0 hardware run (2026-06-07):** NO clean compressed decode. RLE4-BMP + f5∈{1,2,3} → a partial
"staticy underline" that changed per push (the short compressed payload read as a truncated RAW
image → bottom rows blitted as garbage); the target digit never appeared, BUT the uncompressed
control DID paint and the session survived. RLE4-raw (headerless) → nothing. ⇒ **leading hypothesis:
the firmware blits `mapRawData` as raw pixels and does NOT decompress on this direct-BLE path**
(compressMode may be host-side-only / vestigial in fw 2.2.2). **v1.1 = isolation probe**: RLE4-header
-only (no f5) vs f5-only (on a known-good uncompressed image) vs both vs a deliberately truncated
uncompressed buffer — to confirm the raw-blit mechanism and rule out "the f5 field corrupts the parse."

**v1.1 hardware result (2026-06-07, 2 runs, consistent) — DEFINITIVE: NO wire image compression.**
- CMP1/3/6 uncompressed BMP → painted clean (1/3/6). Uncompressed works (and 1→3 proves the tile
  changes when a format decodes — the underlines below are real decode failures, not a stale display).
- CMP2 RLE4-BMP, **no f5** → prev digit + garbled underline. **biCompression header alone does NOT
  trigger RLE4 decode** (RLE bytes blitted as raw bottom rows).
- CMP4 RLE4-BMP **+ f5=1** → same underline. f5 doesn't help.
- CMP3 uncompressed **+ f5=1** → clean "3". **compressMode is harmlessly IGNORED** — if the render
  path branched on f5, f5=1 over raw pixels would have mis-decoded; it painted clean ⇒ the firmware
  doesn't act on compressMode at all on this path.
- CMP5 (truncated BMP) inconclusive/confounded (full-size header → rejected; ~80 s renewal repaint
  muddied run 1) — irrelevant; CMP2/4 settled it.

⇒ **The G2 firmware (2.2.2) blits `mapRawData` as raw 4bpp BMP and does NOT decompress on the
direct-BLE `e0-20 f1=3` path. Uncompressed 4bpp BMP is the only wire image format; no compression
win for our renderer.** `compressMode`/`biCompression` are host-side-only / vestigial on the wire.
A full frame stays ~83 KB / 5–8 s → keep the small-tile + dirty-rect + cheap-text strategy. RESIDUAL
(low priority, don't re-chase without it): a `compressMode` ≥ 2 mapped to a NON-RLE codec (PNG/QOI)
can't be fully ruled out without blutter enumerating `ImageCompressFormat`, but CMP3 (f5 ignored)
makes it unlikely and compression isn't load-bearing. Memory: [[g2-no-wire-image-compression]]. The lone `rle4` /
`BmpCompression` strings are the Dart **`image`** package (adjacent to `package:image/...`), NOT
proof of an `ImageCompressFormat.rle4`. Artifacts: `/tmp/even_sg.xapk`,
`/tmp/even_sg_x/lib/arm64-v8a/{libapp.so,libflutter.so}`, `/tmp/even_app_strings.txt`.

---

## 7. Native services (i-soxi) — parallel context, NOT the SDK/renderer path

The i-soxi repo (`/home/user/G2 Custom/even-g2-protocol/`) documents the Even App's **own native
feature services**, separate from the Hub-app `e0-XX` channel and NOT reachable via the SDK:
teleprompter (`06`), dashboard/calendar (`07`), notifications (`02` + a rich JSON app-whitelist),
**Conversate STT** (`0b`, glasses→phone transcribed text), tasks (`0c`), display-wake (`04`),
auth/sync (`00`/`20`/`01`). Full catalog in `PROTOCOL_NOTES.md` §"Service ID catalog".

⚠ The i-soxi community captures (old firmware, "Tyler's S24") show a 6-byte/no-`0xAA`/single-byte-
service header and a `teleprompter.py` that's a partial reconstruction (time-sync type `0x01` not
`0x80`). **Our `e0-XX` 8-byte `AA`-framed format is hardware-proven on Adam's glasses — trust ours**
for the renderer path. Future SDK-app captures will use the same (current-firmware) framing.

---

## 8. The plan (build → capture → decode → extend)

**Stage 0 — free head-start (no build).** Adam captures a short **g2code** session in Even Hub
(open menu → scroll/select; stream some text). g2code uses `list` + `text` containers WITH borders +
`textContainerUpgrade` + input — so this one capture decodes the ★★★ list widget, ★★ styling,
★★ partial-text, and input for zero build cost, and re-validates our `e0` framing on current
firmware. (g2code also records mic; we ignore those frames per §5 — though seeing audio ride the
e0/BLE channel would incidentally confirm the >25 s disconnect root cause.)

**Stage 1 — capability demonstrator — BUILT 2026-06-06 → `sdk-demo/`.** `g2cap`, a self-contained
Vite/TS Even Hub SDK app covering the full display+input matrix in 7 double-tap-through groups
(INPUT, TEXT, UPGRADE, LIST, IMAGE, MIXED+RAMP, EXIT), self-documenting (test params baked into
container names + on-screen text). `npm run typecheck`/`build`/`pack` all pass; SDK inlined.
Run: `cd sdk-demo && npm install && npm run dev` (Vite on `0.0.0.0:5173`) + `npm run qr`
(QR → load in the Even App over Tailscale `http://100.107.139.121:5173`). Per-group decode map +
capture procedure: `sdk-demo/README.md`. Image input format is a hypothesis (`gray8`) — if the
IMAGE group reports `imageToGray4Failed`, flip `FORMAT` in `sdk-demo/src/images.ts` and recapture.
(No audio/IMU/device-status — §5.)

**Stage 2 — focused captures (Adam runs).** Loaded via `evenhub qr --url
http://100.107.139.121:5173` (dev hot-reload over Tailscale). **Several short, single-app captures**
(one per capability group) — per the btsnoop gotcha, long/multi-app captures evict early data.
Capture discipline: Dev Options HCI snoop = **Enabled** (not Filtered) + BT off/on first; verify
`orig_len == incl_len` (`scripts/btsnoop_parse.py` warns); keep short.

**Stage 3 — decode + extend.** Extend `scripts/btsnoop_parse.py` / `decode_display.py` to map each
SDK call → its `e0-XX` frame; then grow `DisplayProto`/`Scene` to emit the new primitives (list
widget, borders, partial-text, …), each guarded by `G2Renderer.validate()` + unit-tested
(byte-matched to the capture), verified on Adam's eyes before the next.

---

## 9. Key file paths

- **SDK ground truth:** `/home/user/g2code/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`
  (+ `README.md`, `README.zh-CN.md`, embedded CHANGELOG).
- **SDK in action (worked example):** `/home/user/g2code/app/src/{main,display,input,menu,state,
  storage,audio,connection}.ts`; manifest `/home/user/g2code/app/app.json`; build
  `package.json`/`vite.config.ts`; layout consts `/home/user/g2code/shared/src/constants.ts`.
- **CLI/sim:** `/home/user/g2code/node_modules/@evenrealities/{evenhub-cli/main.js,evenhub-simulator}`.
- **Our renderer (extend here):** `/home/user/G2CC/android/app/src/main/kotlin/com/g2cc/g2cc/render/`
  (`DisplayProto.kt`, `Scene.kt`, `G2Renderer.kt`, `Gray4Bmp.kt`, `Rasterizer.kt`).
- **Our decoders:** `/home/user/G2CC/scripts/btsnoop_parse.py`; Chess reference + `decode_display.py`
  in `/tmp/g2cc-btsnoop5/`.
- **i-soxi protocol:** `/home/user/G2 Custom/even-g2-protocol/` (`proto/g2_protocol.proto`, `docs/`,
  `captures/`).
