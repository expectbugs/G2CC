# G2CC Overhaul — Modularization → New DE/WM (the "Ribbon")

**Created 2026-06-29.** This is the canonical plan for two sequential efforts: **(Phase 1)** finish
modularizing the window system *with no behaviour change*, then **STOP and soak**, and **(Phase 2+)**
build the new ribbon-based DE/WM on that modular foundation, flag-gated and reversible.

> ## ✅ STATUS — Phase 1 COMPLETE (2026-06-29), merged + on-glass verified
> **Phase 1 (modularization) is DONE, merged to master, restarted as the daily driver, and verified
> on real glasses ("works like a charm" — Adam, 2026-06-29).** The 15 windows were split out of the old
> `os-windows.ts` (8,555 lines) into `server/src/windows/` (one window per file) behind the frozen
> `OsWindow`/`WmContext` contracts + a registry; the host is now **`server/src/window-manager.ts`**
> (~1,098 lines). 20 commits, each a pure move, smoke green throughout; the proven wire/compose layer +
> Android were never touched. The window contract is now its own doc: **`docs/WINDOW_API.md`**. Layout:
> `windows/` = 14 one-per-file windows + shared `types.ts` (the contracts) / `_browse.ts` / `_util.ts` /
> `_image.ts` / `_session.ts` (the CC/Aria machinery) / `registry.ts`. Main stays in the host.
>
> **Phase 2 (the ribbon) has NOT started** — it begins only on Adam's explicit go after Phase 1 soaks
> clean in daily use (the CLEAN STOP gate). PART 1 below is preserved as the executed plan; PART 2 is the
> live forward plan. Next concrete step before Phase 2: re-apply the parked Blackjack (`wip/blackjack`)
> onto `windows/games.ts`.
>
> **Smoke baseline is 24/25**, not "23/23" (the suite grew): `phase10-calendar` is a *pre-existing
> environmental* red — aria's Google OAuth token has no refresh_token (`google_auth.py`; live
> Calendar/Deliveries sync affected too), NOT a regression. Gate: 24/25 with phase10 the ONLY red.

> ## 🚧 STATUS — Phase 2 (the ribbon) IN PROGRESS (2026-06-30), behind the `de.rootNav` flag
> **Adam gave the explicit Phase-2 go on 2026-06-30** (he opted past the soak wait — the whole thing is
> flag-gated, so the proven menu shell stays his daily driver until the on-glass cutover). Done +
> smoke-verified OFF-GLASS on branch **`phase2-ribbon`** (NOT merged; server NOT restarted — Adam holds
> the restart):
> - **Blackjack re-applied** (the pre-Phase-2 step) onto `windows/games.ts` — `BlackjackController` +
>   the additive `'hands'` compose mode; smoke 25/26 → **26/27**, scene_to_png OK. (tile sizes / thin "J"
>   / the `⏳`+`…` placeholder glyphs are Adam's on-glass tuning.)
> - **§2.2.1 / 2.2.2 / 2.2.4 — the ribbon root-nav** (NEW `server/src/ribbon.ts` = `RibbonShell`): flag
>   `de.rootNav: 'menu'|'ribbon'` (default `menu`); an antenna-driven MRU recents strip (scroll moves a
>   server-drawn cursor, tap enters, double-tap is **straight-to-ribbon** landing on the **previous**
>   window, double-tap at the root blanks); the categorized **`All>` drawer** (CATEGORY_ORDER); reclaimed
>   root chrome (full-width preview, no bars). **Menu mode is byte-for-byte unchanged** (smoke-proven).
> - **§2.2.3 — tiered live preview**: LIGHT `summary()` per notch, RICH `view()` projection on settle
>   (debounced ~`EVENT_DEBOUNCE_MS`, cached per window; `projectView()`).
> - **§2.2.6 — lossless persistence**: verified — window objects persist; `toRibbon` stops only transients
>   (the mic), never resets navigation. Only Games resets-on-activate (intentional).
> - Wire/host touchpoints: `window-manager.ts` (atRibbon state + mode-branched gestures, the `parked`
>   double-deactivate guard, a separate conflated ribbon sender), `ws-handler.ts` (DE `focus` → `onScroll`),
>   `config.ts` (the flag + validation). `os-compose.ts` was **not** touched (the ribbon builds its own
>   scene like `os-menu.ts`/`blankScene`). Full smoke **26/27** (phase10 the only red).
>
> **The on-glass-gated remainder (needs Adam's glasses — this session has none):**
> - **§2.2.5 (in-window full-bleed) — DEFERRED for on-glass co-design.** It redesigns the *in-window*
>   surface (where the action menu lives once the pinned left column is gone — a bottom antenna? a float?),
>   and the doc itself pairs it with on-glass checks. Doing it blind would likely produce a wrong in-window
>   interaction. The ribbon ROOT already reclaims its chrome; the in-window reclaim is the deferred polish.
> - **§2.2.7 (on-glass hardening)** — antenna feel, settle latency, scrollbar artifacts at the tight bottom
>   bar, fast-scroll coalescing on real BLE. Inherently on-glass ("expect days"). The OFF-glass robustness
>   (conflated render senders, estimator/wall guards, strip windowing to stay zero-range, the settle
>   debounce) is in and smoke/scene_to_png-verified.
> - **§2.2.8 (cutover)** — flipping the default to `'ribbon'` waits for the §2.2.7 soak; flipping it blind
>   would make an unverified shell the daily driver. **To try the ribbon on glass NOW: set
>   `"de": { "rootNav": "ribbon" }` in `~/.g2cc/config.json` and restart the server** (the phone
>   auto-reconnects; revert to `"menu"` to fall back instantly).

> **Name clash — read this first.** Elsewhere in this repo a **bare** `overhaul.md §N` (e.g. §5.16,
> §10, §22/§23/§24) refers to the *separate* `/home/user/aria2/overhaul.md` (the ARIA swarm overhaul) —
> **not** this file. **This** document is the **G2CC DE/WM overhaul** (Phase 1 modularization → Phase 2
> ribbon). Different document entirely.

> **Permission discipline (non-negotiable, from `~/.claude/CLAUDE.md`).** Each phase begins only on
> Adam's explicit "go." Investigation ≠ permission. Present findings and stop. Do **not** start Phase 2
> until Adam confirms Phase 1 is stable in daily use (see the CLEAN STOP gate). This document is a plan,
> not a license to implement.

---

# PART 0 — Orientation for a fresh, contextless Claude Code session

Read this whole part first, then the reading list in §0.3, before touching anything.

## 0.1 What G2CC is

A personal, first-party custom UI for Adam's *own* Even Realities **G2** smart glasses — replacing the
vendor companion app with Adam's own Android app + home-PC server. **Architecture: the home PC is the
OS/brain (holds ALL state, composes every screen); the glasses are a thin display (render the scene
they're handed, send input back, hold zero state); the phone is a BLE/WiFi bridge that stays in Adam's
pocket, untouched (the "prime directive").** A small ESP32 "hat" will replace the phone eventually; the
DE is meant to be hat-ready by construction. Everything runs on hardware Adam owns over his home
network. There are no third-party systems/accounts/credentials anywhere — this is UI + display-rendering
work for a wearable.

## 0.2 Current state (what is running and proven, as of 2026-06-29)

- The **window-manager DE is in daily use**: 15 windows (now MODULAR — one file each in
  `server/src/windows/`, host = `window-manager.ts`; see the ✅ status banner above), an MRU dashboard
  `Main`, a left-menu "action set" interaction model. Server on `:7300`. Android client APK v1.14.
- **Server smoke suite: 24/25 green** (`server/smoke/run-all.mjs`) — the lone red is `phase10-calendar`
  (external Google-OAuth, see status banner), NOT a regression. Android unit tests green.
- The **BLE wire format is fully decoded** (`docs/G2_BLE_PROTOCOL.md`, authoritative).
- The interaction model today: a pinned **left menu column** is the "current action set"; **scroll**
  moves the firmware list selection, **tap** activates, **double-tap** backs out/pops a level. This is
  the proven baseline the ribbon will eventually replace.

## 0.3 Mandatory reading list (in order; the *why* matters)

**Project rules & state (read first):**
1. `~/.claude/CLAUDE.md` — Adam's global rules (system env: Gentoo/OpenRC/Portage; verify-before-execute;
   permission discipline; "Ten Explanations"; testing safety; the Mr. Awesome canary).
2. `CLAUDE.md` (project) — G2CC-specific rules; the Three Absolute Rules; forbidden patterns; wire-source
   discipline.
3. `HANDOFF.md` — the fullest single snapshot: what works, the 15 windows, hard-learned lessons
   ("Hardware truths", "Codebase truths" / recurring bug shapes), build/deploy/restart, how Adam works.
4. `g2_custom_app_spec.md` — the canonical build spec (Part A app + Part B audio/STT). If a doc conflicts
   with the spec, the spec wins.

**The UI/DE contracts (the heart of this overhaul):**
5. `docs/DE_DESIGN.md` — the FINALIZED UI contract: geometry, the interaction model, content modes, the
   window table, costs/diff strategy. Where it and `GLASSES_OS.md` differ, DE_DESIGN wins.
6. `docs/GLASSES_OS.md` — architecture/vision, the render(scene)/input(event) contract, the LLM content
   API (markdown → widgets → validated `display` tool), render constraints.
7. `docs/CONTENT_API.md` — the content pipeline (markdown→blocks, ```chart, image rendering).

**The hardware reality you must not violate:**
8. `docs/G2_BLE_PROTOCOL.md` — authoritative wire spec. Especially: the **ack-latency table** (§ near
   line 420), **conn-interval ramp** (§1.2 ~line 60), **ack-gated pacing** (~line 431), the multi-packet
   wall, msgId-is-one-byte, the input vocabulary (focus `f3` direction, `hub_select`).
9. `docs/PROTOCOL_NOTES.md` — protocol lineage + the throughput/render-strategy notes + the input
   vocabulary (`e0-01` gestures) + "render constraints — HARDWARE-CONFIRMED."
10. `docs/SIM_TOOLING.md` — the EvenHub simulator design loop + the **measured firmware-font metrics**.
    ⚠ Its launch command is **stale** — see §0.8.

**The code (read structurally, not line-by-line — it's large):**
11. **`server/src/window-manager.ts`** (~1,098 lines — the host: `class WindowManager` + `MainWindow` +
    the notification overlay) and **`server/src/windows/`** (one window per file). The frozen contracts
    now live in `windows/types.ts` (`WmContext`, `OsWindow`, `WindowCategory`/`CATEGORY_ORDER`,
    `WindowOpen`, `SwitchTo`); shared helpers in `_browse.ts`/`_util.ts`/`_image.ts`; CC+Aria machinery in
    `_session.ts`; the factory list in `registry.ts`. Read `docs/WINDOW_API.md` first, then skim one
    window (e.g. `windows/timers.ts`) for the shape. (Was the 8,555-line `os-windows.ts` pre-Phase-1.)
12. `server/src/os-compose.ts` — `WinView`→`WireScene`; the byte budgets, clamps, the frame **estimator**
    that throws >960 B, `blankFlashScene`. **Proven; do not modify during Phase 1.**
13. `server/src/os-content.ts` — markdown→blocks, chart/image rendering, `splitGray4Tiles`. Proven.
14. `server/src/os-display.ts`, `os-menu.ts`, `os-notify.ts` — display helpers, the cursive OS-menu +
    **the antenna scroll mechanism**, the notification hub. Proven.
15. `server/src/ws-handler.ts` — WS message routing incl. **input dispatch** (`hub_select`, `focus`/
    antenna, `double_tap`, `tap`). See ~:1045–1130 for how scroll vs tap is handled today.
16. `shared/src/protocol.ts` + `shared/src/constants.ts` — the both-ends wire contract; geometry/timing
    constants (`DE_*`, `EVENT_DEBOUNCE_MS`, render limits).
17. `CHANGELOG.md` — the WHY of every change (r3–r27+). `upgrades.md` — the v2 feature queue (done).

**Android client (only if Phase 2 needs a client change — most of this overhaul is server-only):**
18. `android/.../render/G2Renderer.kt` — the BLE display protocol. **Frozen, hardware-proven semantics —
    do not touch without explicit authorization.** `os/SceneCodec.kt`, `net/WsProtocol.kt`.

## 0.4 Hardware & wire constraints — the frozen reality (verified this session)

- **Display: 576 × 288, 16-level gray.** Current DE geometry: 33 px title bar + 33 px status bar; a 96 px
  **left menu column**; content pane **480 × 222** at (96,33). Clock cutout **107 × 33 at x=469**,
  **client-owned**, minute-tick. Title and status bars are **optional**; **only the clock is required**
  to satisfy the firmware "a text region must always exist" rule (an image-only scene acks but never
  paints, and breaks the L-lens mirror).
- **The firmware font is FIXED and proportional — size cannot be changed, only how many glyphs you
  spend.** Measured (sim, `SIM_TOOLING.md`): `W`≈15.8 px, uppercase≈11.4, digit≈11, lowercase≈9.6,
  `i`≈4.8, **mixed text ≈9.0 px/char**, rows ≈34 px (≈8 full-height; **≈6 rows** in the 222 px content
  pane). **Box-drawing `─` renders ≈21 px** (≈2.2× a letter) — heavy box-drawing wraps unexpectedly.
  Practical budgets: content pane ≈**44 chars/row avg** (≈27 worst-case all-caps), menu labels ≈10 chars
  / **5 items visible**, full width ≈58 chars/row.
- **THE MULTI-PACKET WALL:** the firmware silently ignores any single message past ~4–5 AA packets
  (~1000 B) — no error, link stays up. Defences: browse pages 14 rows × ≤40 B labels; client hard-rejects
  >1000 B; the compose **estimator throws >960 B**; `scene_to_png.py` checks offline.
- **`msgId` is ONE byte** (wrap 255→0); a 2-byte msgId silently kills the display until reconnect.
- **Render limits** (client `G2Renderer.validate`): ≤12 containers, ≤8 text, ≤4 image, **exactly one**
  event-capture region, ≥1 text region, tile ≤288×129 (we use ≤240×111), no all-black tile.
- **Measured ack latency** (last fragment → `e0-00` ack, median — `G2_BLE_PROTOCOL.md` ~:420):
  text-update `f1=5` **62 ms** (35–404) · rebuild `f1=7` **86 ms** (40–160) · image-push `f1=3` **176 ms
  per chunk** (a 200×100 tile ≈ 0.5 s, full screen = seconds) · keepalive `f1=12` 54 ms.
- **Pacing is ack-gated, NOT pipelined** (measured: 0 sends before the prior ack across 100 writes).
  Updates serialize — nothing overlaps. This is *why* naive per-notch live rendering janks.
- **Conn interval:** active traffic holds the R lens at **30 ms / latency 0**; it sags to **90 ms /
  latency 4** only after ~2 s idle. Whole-screen *text* re-render was clocked at ~6–7 fps (≈150 ms/frame).
- **Text is cheap (~62–86 ms), images are slow (~0.5 s/tile → seconds), images should be static/small**
  (page-≥2 only). `EVENT_DEBOUNCE_MS = 300` (tap/scroll debounce).

## 0.5 The input model (R1 ring) — and the antenna finding (load-bearing for Phase 2)

- The R1 ring gives **three primitives: scroll, tap, double-tap.** Information-theoretically a scroll
  wheel + a 1–2-switch. There is **no second scroll axis** and **no reliable text entry** (see §0.6 on
  the mic). All navigation must stand on these three.
- **Two ways the system can read input, both hardware-proven** (`ws-handler.ts` ~:1053–1099):
  1. **Native firmware list** (`hub_select`): the firmware moves the selection ring **locally** and is
     **silent until a tap** reports the chosen index. This is why the current DE "requires a tap" — it's
     real firmware behaviour for the list widget, not a code choice.
  2. **The antenna** (a `scroll=true` text region as the event-capture): **every scroll notch fires a
     `focus` event carrying direction** (`f3`: 1=up, 2=down, hardware-confirmed). The server re-renders
     content **live, no tap.** The OS menu screen already does this (`os-menu.ts` antenna + `ws-handler`
     focus handler). **A per-notch live preview was built for the Files locations level and reverted
     2026-06-11 because it "felt janky" — pulled for UX, not capability** (`os-windows.ts` ~:2545).
- Implication: live "preview-as-you-scroll" is achievable via the antenna, but the server owns the cursor
  and redraws each notch; combine with debounce + caching (see Phase 2 §2.2.3 and the latency verdict
  §2.3).

## 0.6 Use-context constraints (shape every design choice)

- **No audio output** is available — every confirmation/state-change must be **visual**.
- **Microphone/dictation is sporadic, optional, and not always available** — so voice/dictation is a
  *bonus accelerator when present*, **never the backbone**. A command-palette/voice-launcher cannot be
  the primary navigation. Navigation must work on scroll/tap/double-tap alone.
- **Screen real estate is scarce** — the pinned left menu + two bars permanently cost ~96 px of width +
  two 33 px bands. Reclaiming them is a primary Phase-2 goal.
- **Eyes-busy/glanceable wearable context** — design for 1–2 second glances, one focal thing per screen;
  the "desktop" lives in the PC's model, the lens is a moving one-window peephole onto it.

## 0.7 The current architecture (what is ALREADY modular vs frozen)

> **✅ Phase 1 (2026-06-29) CLOSED the gaps below.** The contracts now live in `windows/types.ts`, each
> window in `windows/<id>.ts`, the registry in `windows/registry.ts`, and the host in `window-manager.ts`.
> The descriptions below are how the code was structured *pre-split* (the contracts themselves are
> byte-for-byte unchanged — only their location moved); the `os-windows.ts:line` refs are pre-Phase-1.

**Was a clean modular shape that lived in one file (now split into `windows/`):**
- **`OsWindow` (`os-windows.ts:181`)** — the per-window contract every window `implements`: `view()`→
  `WinView`; input `onMenuSelect`/`onBrowseSelect`/`onBack`; lifecycle `onActivate`/`onDeactivate`/
  `dispose`/`interruptible`/`onReload`; the `Main` hooks `summary()` & `statusLine()`; cross-window
  `onOpen`. (The inline JSDoc on it is excellent — promote it into the API doc.)
- **`WmContext` (`os-windows.ts:133`)** — the dependency-injected host-services toolbox each window is
  handed (`send`, `audio`, `displayReload`, `pool`, `config`, `mediaCommand`, `requestSmsThread`, …).
- **`WindowManager` (`os-windows.ts:8095`)** — the host; holds `windows: OsWindow[]` + `active`; routes
  input. Windows are instantiated in a **hardcoded array (~:8165)** via a `mk((rr)=>new XWindow(ctx,rr))`
  factory.
- **`WindowCategory` / `CATEGORY_ORDER` (:178)** — categories already typed (`AI/Comms/Media/Tools/Info/
  Games`); windows self-place by declaring `category`.
- The 15 windows: **Main, CC, Aria, Mail, Files, Reader, Timers, Calendar, Games, Notices, Search,
  Terminal, Deliveries, Media, SMS** (+ shared `SessionLevel`/`HistoryLevel` used by CC/Aria, and
  sub-controllers `PaperclipsController`/`BlackjackController`).

**Already separate AND proven/frozen (do NOT modify during modularization):**
- `os-compose.ts` (budgets/estimator/wall fences), `os-content.ts`, `os-display.ts`, `os-menu.ts`,
  `os-notify.ts`, and the Android `render/G2Renderer.kt` (frozen send semantics).

**The only gaps for "each window is its own thing, easily integrated":** (1) physical separation (all 15
classes in one 418 KB file), (2) a registry so adding a window doesn't edit the core, (3) one reference
doc. Phase 1 closes exactly these three gaps and nothing else.

## 0.8 Tooling

- **Regression suite:** `node server/smoke/run-all.mjs` — 23 scripts, the gate. Runs isolated against the
  `g2cc_smoke` DB + a temp notes file (never production `g2cc`). Run it after **every** server change.
- **Offline compose check:** `scripts/scene_to_png.py` (WireScene JSON → PNG; validates client rules incl.
  the wall; font is DejaVu, treat as layout-only).
- **Build/restart (server-only changes — the whole of Phase 1):** `npm run build -w server` (and
  `-w shared` first if the contract changed) → `node server/smoke/run-all.mjs` → restart per HANDOFF
  (`ss -ltnp | grep :7300` → kill → `nohup setsid node .../server/dist/index.js …`). Phone auto-reconnects.
  **No APK** unless the Android client changes.
- **The EvenHub simulator (visual design loop — real LVGL g2 font, 576×288):** ⚠ **`SIM_TOOLING.md`'s
  launch path is STALE.** The sim used to live in `g2code/node_modules`; **`g2code` and `g2aria` were
  archived to `/home/user/g2-old-backup-2026-06-24.tar.gz` on 2026-06-24 and the live dirs deleted**, so
  the sim went with them. To use the sim: `npm i @evenrealities/evenhub-simulator@0.7.3
  @evenrealities/sim-linux-x64@0.7.3` (now pinned as a `sdk-demo` devDependency — `cd /home/user/G2CC/sdk-demo && npm i` provides it; wrapper at `sdk-demo/node_modules/@evenrealities/evenhub-simulator/bin/index.js`),
  serve `sdk-demo` via vite on :5174, launch the sim binary with `GDK_BACKEND=x11
  LD_PRELOAD=scripts/simtools/gtkwl_stub.so DISPLAY=:0.0 … <wrapper> http://127.0.0.1:5174/mockup.html?
  screen=<name> --automation-port 9898`, then `GET /api/screenshot/glasses`. The egl-gbm / nvidia-drm /
  gtkwl_stub setup is system-level and **intact**; only the npm package needed reinstalling. NB: the sim
  is a **layout/density guide only** — its README + the on-glass box-drawing-width finding prove glyph
  metrics drift; validate pixel-tight layouts and *feel/latency* on real glasses. (Adam cannot easily
  screenshot the real display.)

## 0.9 Session 2026-06-29 — design decisions & artifacts (the rationale behind Phase 2)

Research compared TUIs/DEs/WMs against the R1's 3-gesture input. Conclusions Adam reached:

- **Replace the pinned-left-menu WM with a "ribbon" root selector.** Scroll switches window, tap enters
  (focus moves *into* the window), double-tap backs out; double-tap at the ribbon root blanks the display
  (as now). Each window then gets the **full width** and decides its own internal menus/content/layout
  ("sovereign windows", niri/Plan-9 style).
- **Solve scale + cross-category switching by splitting on frequency, not category:** the **hot path is a
  flat, MRU-ordered recents ribbon** (the 2–3 windows you alternate between float to the front and sit
  adjacent — so game↔email is ~2 gestures regardless of total count); the **cold path is a categorized
  drawer** ("All ▸" → category → window), reusing the existing `category`/`CATEGORY_ORDER`. The ribbon
  opens with the cursor on the **previous** window (alt-tab style) for instant A↔B toggling.
- **Live preview via the antenna**, tiered to respect the latency reality (§2.3): a **light one-line
  preview per notch** while scrolling (cheap), upgrading to a **richer full-window preview only on settle**
  (debounced), with **per-window frame caching**. The window contract already provides both tiers —
  `summary()` is the light line, `view()` is the rich preview — a direct payoff of Phase 1.
- **Reclaim real estate:** drop the pinned menu + title + status bars; keep only the mandatory clock
  cutout and fold battery/unseen micro-status into that clock line, so windows get ~576×255.
- **Latency verdict** (from the measured ack table + ack-gated pacing): one-line preview ≈100 ms (fine);
  full-window **text** preview viable **only settle-rendered + cached** (per-notch = the Files jank);
  full-window **image** preview is not viable (preview image windows as a text summary).
- **Durable design artifacts:** `sdk-demo/src/mockup.ts` now contains additive sim screens — `strip`,
  `overview`, `palette`, `transient`, `zui0/1/2`, and the ribbon flow `ribA`, `ribB`, `ribcat`, `ribwin`,
  `winsample` (existing `cc`/`aria`/`main`/`mail` screens untouched). Re-render them via the sim (§0.8).
  Rendered PNGs were saved under `/tmp/g2cc-de-mockups/` (ephemeral). These are layout studies, not specs.

---

# PART 1 — Phase 1: Modularization (server-only, NO behaviour change) — ✅ DONE 2026-06-29

> **✅ EXECUTED & VERIFIED (2026-06-29).** All of PART 1 below is done: `os-windows.ts` (8,555 ln) →
> `window-manager.ts` (1,098 ln) + `windows/` (14 windows + types/_browse/_util/_image/_session/registry),
> 20 pure-move commits, smoke green throughout, proven layer + Android untouched, merged to master and
> on-glass verified. Kept below as the executed plan. Two discoveries worth carrying into Phase 2:
> (a) two helpers were silently SHARED and got their own modules — `renderImageB64` (Media+SMS) →
> `_image.ts`, `cycleNext` (Games+SessionOptions) → `_util.ts`; (b) the dictation INTENT handling lives
> inside `SessionLevel`, so `parseIntent`/`createTimer`/`notify`/`saveMemo` moved with it into `_session.ts`.

**Goal:** split the 15 windows out of `os-windows.ts` into self-contained modules behind the *existing,
proven* `OsWindow`/`WmContext` contracts, add a registry so new features don't edit the core, and write
one reference doc — **changing no behaviour whatsoever.** This is low-risk precisely because the contract
is frozen, the dangerous wire/compose layer is untouched, and the 23-test smoke gates every step.

## 1.1 Target layout

```
server/src/
  window-manager.ts      # the host: registry consumption, input routing, active-window, dispatch,
                         #   notification-overlay queueing, the blank/wake scene. (The WM half of os-windows.)
  windows/
    registry.ts          # WINDOW_FACTORIES[] — the ONE place adding a feature touches
    _session.ts          # shared SessionLevel / SessionOptions / HistoryLevel (CC + Aria) — extract LAST
    _browse.ts           # shared browse pagination + byte-budget helpers (browsePageItems, browseBoundaries…)
    main.ts cc.ts aria.ts mail.ts files.ts reader.ts timers.ts calendar.ts games.ts
    notices.ts search.ts terminal.ts deliveries.ts media.ts sms.ts        # one window per file
  os-compose.ts os-content.ts os-display.ts os-menu.ts os-notify.ts       # UNTOUCHED (proven)
```

`os-windows.ts` itself either becomes `window-manager.ts` or shrinks to a thin re-export shim during the
transition (keeps imports stable while windows drain out).

## 1.2 Contracts (freeze as-is — do NOT redesign)

Keep `OsWindow` (:181) and `WmContext` (:133) byte-for-byte. They are battle-tested. `implements OsWindow`
already gives the TypeScript compiler full conformance checking per module — that *is* the enforced API.

## 1.3 The registry seam

Replace the hardcoded array (`os-windows.ts` ~:8165) with a list each window joins by adding one line:

```ts
// windows/registry.ts — adding a feature = new file + ONE line here; the core never changes.
import type { WmContext } from '../window-manager.js'
import type { OsWindow } from './types.js'          // OsWindow/WmContext live in a tiny shared types module
export type WindowFactory = (ctx: WmContext, reRender: () => void) => OsWindow
export const WINDOW_FACTORIES: WindowFactory[] = [
  (c, rr) => new AriaWindow(c, rr),
  (c, rr) => new CcWindow(c, rr),
  (c, rr) => new MailWindow(c, rr),
  // … one line per window. Main is special-cased by the host (it needs the window list).
]
```

`WindowManager` maps `WINDOW_FACTORIES` to build `this.windows`. (`Main` is constructed separately because
it takes `() => this.windows` + the MRU getter — keep that as a host concern.)

## 1.4 Write `docs/WINDOW_API.md` FIRST (Step 1.0 — zero code risk)

The "easily referenced design and API" Adam wants. Contents:
1. The `OsWindow` + `WmContext` contracts (promote the existing JSDoc) and the `WinView` shape.
2. **Reserved labels the host owns — a window must never use them:** `Retry / Reload / Back / Main`.
3. **Window-author checklist** (the recurring bug shapes — `HANDOFF.md` "Codebase truths"):
   - Clear **every** transient flag on **every** exit path (`onDeactivate` stops the dictation mic).
   - **Never `await` the store** in a render/turn hot path; capture paths fire-and-forget with `.catch`.
   - Keep frames under the wall — use `blocksToText` / `browsePageItems` + trust the compose estimator.
   - Answer `interruptible()` **false** during a confirm step (the "nothing reaches CC unread" guarantee).
   - Taps resolve against the **last-rendered** view; menus rebuild on state change — order actions so a
     racing tap can't hit a destructive item (the Approve/Deny-not-at-index-0 lesson).
   - Each window **owns its persistence** (namespace store keys/tables by window id; resume-position
     pattern) and its helper scripts (`scripts/*.py`).
4. A **minimal window template** (~40-line `implements OsWindow` stub) so new features start known-good.
5. A window's **smoke test** convention: ships with `server/smoke/phase-<window>.mjs`.

## 1.5 Step-by-step extraction (strangler-fig; one window per commit; smoke after each)

1. **1.0** — write `docs/WINDOW_API.md`. (No code move.)
2. **1.1** — pull `OsWindow`/`WmContext`/`WindowCategory`/`WindowOpen`/`WinView` re-export into a tiny
   `windows/types.ts`; introduce `windows/registry.ts` with `WINDOW_FACTORIES` (windows still defined in
   `os-windows.ts` for now; the array just references them). Build + **smoke 23/23.**
3. **1.2** — extract **one easy window first** (`TimersWindow` or `CalendarWindow` — small, DB-backed,
   few edges) into `windows/timers.ts`. Fix imports, add its registry line, add/keep its smoke. Build +
   **smoke 23/23.** This validates the recipe end-to-end.
4. **1.3** — extract the rest **simplest → hairiest**, one per commit, smoke after each:
   Calendar → Deliveries → Notices → Media → SMS → Reader → Search → Terminal → Mail → Files →
   Games (+ `PaperclipsController`/`BlackjackController`) → **CC → Aria + the shared `SessionLevel`/
   `HistoryLevel`/`SessionOptions` into `windows/_session.ts` LAST** (shared = trickiest).
5. **1.4** — what remains in `os-windows.ts` is the host; rename to `window-manager.ts` (or leave a
   re-export shim). Final build + **smoke 23/23** + `scene_to_png.py` spot-checks on a few windows.

## 1.6 Cardinal rules (this is what makes it problem-free)

- **PURE MOVES ONLY.** During an extraction, change *nothing* — cut/paste + fix imports. If a window
  deserves improvement, that's a **separate commit with its own test**. Mixed move-and-edit is what hides
  regressions; pure moves stay diffable and instantly revertable.
- **Do not touch the proven layer:** `os-compose`/`os-content`/`os-display`/`os-menu`/`os-notify`, the
  byte estimator/wall fences, msgId/keepalive/pacing, and `G2Renderer.kt`. Modularization is a
  window-*logic* refactor only.
- **Server-only. No APK.** The wire contract does not change in Phase 1.
- **Smoke 23/23 after every commit.** Keep TypeScript `strict`; `implements OsWindow` is the guardrail.
- Each commit is independently revertable (one file move + one registry line).

## 1.7 Phase 1 acceptance criteria

- Smoke **23/23** green at every commit and at the end.
- `git diff` for each extraction commit is **pure moves** (no logic deltas) — reviewable as such.
- No file in the proven wire/compose layer changed; no APK built.
- `docs/WINDOW_API.md` exists and a new window can be added by: new file in `windows/` + one
  `WINDOW_FACTORIES` line + one smoke script — **with zero edits to the host.**

---

# ============================== CLEAN STOP — PHASE 1 GATE ==============================

**Do not begin Phase 2 until ALL of the following hold and Adam explicitly says go.**
**Progress: 1 ✅ · 2 ✅ · 3 ✅ soaked clean · 4 ✅ Adam gave the explicit Phase-2 go 2026-06-30.**
**(Phase 2 is now in progress behind the flag — see the 🚧 STATUS banner at the top.)**

1. ✅ Phase 1 acceptance criteria (§1.7) met; server restarted on the modularized build (live on :7300).
2. ✅ **On-glass parity pass:** Adam tested on real glasses — "works like a charm" (2026-06-29). The phone
   auto-reconnected and the modular build (incl. the extracted Games/Paperclips window) rendered live.
3. ⏳ **Soak in daily use.** Running the modularized system as the daily driver now (started 2026-06-29) —
   surfacing any latent regression the smoke suite can't.
4. ⏳ Adam confirms: "Phase 1 is stable, proceed to Phase 2." — pending the soak.

The whole point of this gate: Phase 1 carries **none** of the days-of-on-glass-hardening risk that
Phase 2 does. Bank the modular foundation as the new proven baseline before introducing the big change.

# =====================================================================================

---

# PART 2 — Phase 2+: The new DE/WM (the Ribbon) — flag-gated, reversible

**Design summary:** a flat **MRU recents ribbon** in the bottom bar as the root window selector (scroll =
switch, tap = enter, double-tap = blank; opens on the previous window), a **categorized drawer** for the
cold tail, **antenna-driven tiered live preview** (light per-notch, rich on settle, cached), **sovereign
full-width windows**, full **state persistence** across switches, and **reclaimed real estate** (clock-only
mandatory chrome). Built **behind a config flag** so the proven menu shell stays the instant fallback the
entire time. See §0.9 for rationale and `sdk-demo/src/mockup.ts` (`ribA/ribB/ribcat/ribwin/winsample`) for
the visual target.

## 2.1 Decisions to lock before coding (Adam)

- **Double-tap semantics:** pop-one-level-then-exit-at-root (consistent with today, supports persistence)
  vs straight-exit-to-ribbon (faster switch; relies on persistence for lossless re-entry). *Recommend
  pop-one-level.*
- **Ribbon lands on previous (index 1) vs current (index 0)** when you back out. *Recommend previous.*
- **Recents depth** before windows spill to the drawer (5–8 is the phone-tested sweet spot).
- **Drawer ordering:** categories (most discoverable) vs frecency vs alphabetical.
- **Settle-preview feel:** confirm on glass whether ~150 ms rich-preview-on-settle reads as responsive
  (the one thing the sim/latency-trace can't settle — a ~2-minute on-glass test).

## 2.2 Sub-phases (each flag-gated and independently testable)

- **2.2.1 — `RibbonShell` behind a config flag.** Add `de.rootNav: 'menu' | 'ribbon'` (default `'menu'`).
  The `WindowManager` selects the root-nav shell; the proven Main-launcher/menu path is untouched and
  remains the default + instant fallback. The 15 modular `OsWindow`s are **reused unchanged**.
- **2.2.2 — Recents ribbon (root level).** MRU-ordered window list rendered in the bottom bar via the
  **antenna** (`scroll=true` capture, server-drawn cursor); breadcrumb top-left, clock top-right. Scroll =
  move highlight; tap = enter (focus into window); double-tap = blank. On entry from a window, land the
  cursor on the **previous** window. Reuse `os-menu.ts`'s cache+dirty-diff pattern for snappy cursor moves.
- **2.2.3 — Tiered live preview.** Per notch: render the **light** preview = the highlighted window's
  `summary()` (one line/region, ~62–100 ms). On **settle** (debounced ~`EVENT_DEBOUNCE_MS`): render the
  **rich** preview = a read-only projection of the window's `view()`, **cached per window** so revisiting
  is instant. **Never** render the rich preview per-notch (that is the Files jank — see §2.3).
- **2.2.4 — Categorized drawer (cold path).** A `[ All ▸ ]` ribbon entry → category ribbon
  (`CATEGORY_ORDER`) → that category's windows → enter. This is essentially today's `Main` launcher logic
  repackaged; reuse it. Depth is acceptable here because it is the rare path.
- **2.2.5 — Sovereign full-width windows + reclaimed chrome.** When entered, a window owns the full
  **576 × 255** (only the clock cutout reserved). Add a **full-bleed compose mode** to `os-compose.ts`
  (this is the one sanctioned touch of the proven layer — do it carefully, gated, with `scene_to_png` +
  on-glass checks): no pinned left menu, optional window-drawn title/status, **micro-status (battery/
  unseen) folded into the clock line**. Each window keeps its `view()` (menu + content); the compositor
  places them full-width. Migrate windows one at a time under the flag.
- **2.2.6 — Lossless persistence across switches.** Windows already persist (resume positions, live
  sessions tick in the background). Formalize: switching away never loses a window's full view
  stack/selection/scroll; re-entry restores exactly. Verify per window (Reader resume is the model).
- **2.2.7 — On-glass hardening (expect days).** The antenna feel, settle-preview latency, scrollbar
  artifacts at tight bars, byte budgets for ribbon+preview frames, fast-scroll coalescing. Iterate on
  glass; this is the bulk of Phase 2's calendar time.
- **2.2.8 — Cutover.** Once the ribbon is stable in daily use behind the flag, flip the default to
  `'ribbon'`; keep `'menu'` as the documented escape hatch for a soak period, then retire it.

## 2.3 The latency budget the ribbon must honour

- **Pacing is ack-gated (no pipelining).** Each preview render must finish (ack) before the next.
- One-line (`summary()`) preview ≈ **~100 ms** end-to-end → fine per-notch.
- Full-window **text** (`view()`) preview ≈ **~120–180 ms** → **settle-render + cache only**, never
  per-notch (per-notch at scroll speed = ack-gated renders queueing = the 2026-06-11 Files "janky" revert).
- **Image** content ≈ 0.5 s/tile → seconds → **not viable as a scroll preview;** image-heavy windows show
  a **text summary** line as their preview.
- Active scrolling holds the link at 30 ms/lat0; the first notch after idle eats one ~90 ms wake.

## 2.4 Phase 2 testing strategy

- Per sub-phase: **smoke must stay green**; render the affected screens in the **sim** (re-render the
  `mockup.ts` ribbon screens) for layout; **`scene_to_png.py`** for byte/wall safety on any new compose
  surface; then **on-glass** for feel/latency (Adam). The flag means every step is comparable A/B against
  the proven shell and instantly reversible.
- Acceptance for cutover: ribbon stable as daily driver for a soak period, no regressions vs the menu
  shell, latency feels right on glass, byte budgets safe on every window's ribbon/preview/full-bleed
  frames.

---

# Appendix A — Quick file index (Phase 1 done — the old `os-windows.ts:line` refs are OBSOLETE)

- **⚠ POST-PHASE-1: `os-windows.ts` no longer exists.** The contracts (`WmContext`, `OsWindow`,
  `WindowCategory`/`CATEGORY_ORDER`, `WindowOpen`, `SwitchTo`) → `server/src/windows/types.ts`;
  `SessionLevel`/`SessionOptions`/`HistoryLevel` → `windows/_session.ts`; `CcWindow` → `windows/cc.ts`,
  `AriaWindow` → `windows/aria.ts`; each window → `windows/<id>.ts`; `class WindowManager` + the
  registry-driven window array + `MainWindow` → `server/src/window-manager.ts`; factory list →
  `windows/registry.ts`. (Pre-Phase-1 line numbers were `:133/:181/:8095` etc. in the old monolith.)
- `ws-handler.ts ~:1053–1099` input dispatch (`hub_select` / `focus`-antenna / `double_tap` / `tap`).
- `os-menu.ts:100` the `scroll=true` antenna region; `:109` `menuScene` (cache + dirty-diff pattern).
- `shared/src/constants.ts:132` `EVENT_DEBOUNCE_MS=300`; `DE_*` geometry; render-limit caps.
- `G2_BLE_PROTOCOL.md ~:60` conn-interval ramp · `~:420` ack-latency table · `~:431` ack-gated pacing.

# Appendix B — Glyph safety (firmware font)

Confirmed to render: `●  ·  —  [ ]  ( )  >  digits/letters`. Avoid / verify on glass: `⚠` (does not
render — use `!`), single guillemets `‹ ›`, `▸`, `◷`, `⌕`, `…` (use `...`), curly quotes (use straight),
heavy box-drawing (renders ≈2× wide → wraps; `term*` paths price it at 21 px). When in doubt, ASCII.

# Appendix C — What must NOT be touched without explicit authorization

- `G2Renderer.kt` send semantics (frozen, hardware-proven). The msgId/keepalive/pacing wire behaviour.
- The compose byte estimator + multi-packet-wall fences (except the deliberate, gated full-bleed mode in
  Phase 2 §2.2.5).
- `g2code` / `g2aria` — now archived in `g2-old-backup-2026-06-24.tar.gz` (the live dirs are gone). The
  CLAUDE.md "read them as fallbacks" guidance is stale; they are an archive, not live references.
- The Three Absolute Rules: no I/O timeouts, no silent failures, no truncation.
