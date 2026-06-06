# G2CC — the Glasses OS (design + build plan)

**Status: design agreed 2026-06-06, ready to build. The display renderer it sits on is
HARDWARE-PROVEN (commit `c5fdd50`).** This doc captures the architecture, the LLM content API,
and the Phase-1 contract decided in the 2026-06-05/06 session so a fresh instance can build it.

## The vision (Adam's, and it's the right framing)

**The home PC is the OS; the glasses are just the screen.** The official Even app is limited to its
built-in features plus whatever a *single currently-open* app adds. We replace that entirely: a
display server on Adam's beefy home PC holds **all** state, persistence, and logic — a stack of
views / menus / layers, every "app" (email, web, SMS, AI projects, certain games, dashboards),
what's running — and streams the **current** view to the glasses as a Scene. The glasses hold **no
state**: they render the frame they're given and send input back. The "only so much fits on screen"
limit is trivially solved because the PC keeps the whole menu/layer stack; the glasses just show one
configuration at a time.

## Architecture

```
  Home PC (Node server = the brain)                         Glasses (Android app = thin client)
  ┌───────────────────────────────────────────┐            ┌─────────────────────────────────┐
  │ View / layer manager  (nav stack, state,   │  render(scene)   │ ConnectionManager (WS)     │
  │   persistence — the "windowing system")    │ ───────────────► │ Scene(JSON) → render.Scene │
  │ Compositor (state → Scene of regions)      │            │     │ G2Renderer → BLE → glasses │
  │ Rasterizer (markdown/charts/web/img→gray4) │ ◄─────────────── │ EventParser (ring/gesture) │
  │ LLM content API (CC / Aria / swarm)        │  input(event)    │ (no app logic, no state)   │
  └───────────────────────────────────────────┘            └─────────────────────────────────┘
```

- **Glasses client** already exists and is proven: `android/.../render/G2Renderer` (region-based
  gray4 renderer) + `net/ConnectionManager` (WS). For the OS it becomes server-driven: receive a
  Scene, render via `G2Renderer`, forward `EventParser` input. The harness (`harness/`) is the
  standalone test rig that proved the renderer — the OS reuses the renderer, not the harness UI.
- **PC server** is where the new work is: a compositor + view manager + rasterizer + the LLM API,
  built on the existing g2code/g2aria WS + dispatch infra (don't start the WS from scratch).

## The one contract everything rides on (Phase 1)

Two WebSocket messages, added to `shared/src/protocol.ts` (extend, don't replace):

- **`render(scene)`** PC → glasses. `scene = { regions: [ { name, x, y, w, h, kind, content } ] }`,
  where `content` is one of:
  - **text** — `{ text, scroll? }` → the app makes a `Content.Text` (firmware renders the font).
  - **image** — a base64 **gray4 BMP** the PC already rasterized → `Content.Image` (the heavy-lifting
    path: charts, web, photos).
  - **widget** — a small spec the *app* draws locally with `Rasterizer` (cheap: stat card, gauge,
    sparkline, the status-bar clock).
  The app diffs vs the current scene and re-renders only what changed (dirty-rect is already in
  `G2Renderer.setScene`).
- **`input(event)`** glasses → PC. `EventParser` events (region-select + ring tap/scroll/gesture).
  The PC owns the reaction → updates state → sends a new `render`.

Get this loop solid on hardware and the entire OS is just "produce Scenes" + "react to input." It
also delivers the handoff's standing goals (extract networking, decompose the `G2Pipeline` monolith).

## Build order — vertical slices, each VERIFIED on real glasses before the next

1. **Remote display loop** *(keystone)* — PC sends a Scene → app renders → input back → PC reacts.
   Reuses the proven `G2Renderer`. This is where to start.
2. **Compositor + view/layer manager** — the PC nav stack (screens/menus/layers), input→navigation,
   persistence. The windowing system.
3. **Server rasterizer (the heavy lifting)** — markdown / charts / Mermaid / web / images → gray4 BMP
   on the PC; the app draws only simple widgets + text locally. The hybrid Adam chose.
4. **LLM content API** — see below. Dispatch-agnostic (same contract for CC, Aria, the swarm).
5. **Apps** — email, web, SMS, AI projects, dashboards, simple games: each just a content provider.

## The LLM content API (decided: build all of it)

Principle that makes it **hard to get wrong**: the model describes *semantic content*; **we own
every pixel** (layout, region sizes, tiling, the status bar, gray4, the 576×288 limit, scroll /
pagination). The model never touches a coordinate. Three layers, increasing precision:

1. **Markdown is the zero-friction default.** Models already answer in Markdown; we just render it
   (headings, **bold**, lists, tables, `code`) to regions, scrollable. ~80% of responses, no behavior
   change.
2. **A tiny widget vocabulary as fenced blocks they already write** — extracted from the stream and
   rasterized to regions. Keep the schema *small* (fewer ways to be invalid):
   - ` ```chart ` — simple schema e.g. `{"type":"line","title":"CPU %","x":[...],"y":[...]}`; **also
     accept Vega-Lite and Mermaid** (models know those cold) → server-rasterized.
   - ` ```stat ` — `[{"label":"Temp","value":"72°","trend":"+3"}]` big-number cards.
   - ` ```gauge ` / ` ```image ` / ` ```diagram `(Mermaid).
3. **A validated `display` tool** for guarantees + the interactive round-trip — `display({blocks:[...]})`;
   the schema rejects malformed input with a clear error the model self-corrects, and the tool
   **returns the user's interaction** (tap/scroll/select) so "respond with a chart" becomes a real
   conversation, not a one-shot.

Chart/diagram/image rasterization is **server-side** (Node + the `audio/venv` python has
matplotlib; headless rendering for Vega/Mermaid/web) → ship the gray4 BMP down. Simple widgets +
text render **app-side** via `Rasterizer`.

Guidance baked into the API (so models aim at what the glasses do well): one focal visual + concise
text per screen; the layout layer **scrolls/paginates, never truncates** (the no-truncation rule).

## Render constraints — HARDWARE-CONFIRMED (the renderer foundation must respect these)

Full list: `docs/PROTOCOL_NOTES.md` §"Render constraints — HARDWARE-CONFIRMED". Summary:
- **Every screen MUST contain a text region** (image-only is acked but never paints + breaks the L
  mirror). The OS always keeps a top status bar (ticking-clock text region) — also the never-blank
  signal and the always-present text container.
- **Image regions ≤ 200×100**; tile anything larger into multiple regions.
- **Push image chunks as DISCRETE, paced, keepalive-interleaved writes** (~0.3 s/chunk), never one
  big atomic batch (a full-frame atomic burst drops the BLE link mid-push). Implemented in
  `G2Renderer.sendMessage`.
- **Both lenses mirror R→L** when a text region is present; write display content to R only.

## What's done vs next

- **DONE + proven:** `render/` renderer (Gray4Bmp/Quantize/DisplayProto/Scene/G2Renderer/Rasterizer),
  the `harness/` test app, server `/diag` + `/apk`, the wire protocol decode (`PROTOCOL_NOTES.md`
  §"EvenHub display rendering"), and the constraints above. 176 unit tests; full hardware pass.
- **NEXT:** Phase 1 — the remote display loop. Start by reading `shared/src/protocol.ts`,
  `android/.../net/{ConnectionManager,WsProtocol}.kt`, and `server/src/ws-handler.ts`, then add the
  `render`/`input` messages and drive `G2Renderer` from the server.

## Open design points to settle as you build (not blockers)

- **Input vocab not fully hardware-confirmed:** `e0-01` gesture codes (tap vs scroll-up/down vs
  double-tap) are structurally decoded but the per-code semantics are inferred — needs one controlled
  gesture capture (Adam) early in Phase 2, since navigation depends on it. (`PROTOCOL_NOTES.md`
  §"Input vocabulary".)
- **Ack-driven chunk pacing:** the renderer currently *time*-paces chunks (~0.3 s) which is proven.
  Ack-pacing (send next chunk on the `e0-00 f1=4` ack) would be more robust/self-tuning for the
  image-heavy OS — but it changes the just-proven send path and needs a fresh hardware verification,
  so it's a deliberate later enhancement, not a Phase-1 task.
- **Persistence store** for the view/app state (sqlite? json? the server already has a `sessions.json`
  pattern) — decide in Phase 2.
