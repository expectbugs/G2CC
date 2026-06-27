# Universal Paperclips — vendored game engine

**Source:** https://www.decisionproblem.com/paperclips/ (`combat.js?v3`, `globals.js?v3`,
`projects.js?v3`, `main.js?v3`), fetched 2026-06-27.

**By:** Frank Lantz / Bennett Foddy / Everybody House Games.

## Why these files are here

G2CC drives the *real, unmodified* game logic headlessly (jsdom, in `server/src/paperclips.ts`)
so Adam can play it on his own G2 glasses. This is a personal, non-distributed, offline instance
on hardware Adam owns — the same first-party device-interoperability framing as the rest of G2CC.
We never reimplement or fork the game balance; we read its globals and call its global functions.

## What was changed

**Nothing in the four `.js` files** — they are byte-for-byte upstream (pinned so a site update
can't silently change the wire/behaviour under us; same drift discipline as the BLE protocol).

`index.html` is the upstream `index2.html` **body with every `<script>` tag and HTML comment
stripped** — the engine injects the four `.js` files itself, in the upstream load order
(`combat → globals → projects → main`), after restoring the save into `localStorage`. The DOM
(all element ids) is kept intact because `main.js` caches them at load (`cacheDOMElements()`)
and writes to them every tick; a missing id is covered by the engine's `getElementById` stub.

## How it runs (see `server/src/paperclips.ts`)

- jsdom with a real `url:` (so `localStorage` isn't an opaque origin — the load-bearing fix).
- Shims: no-op `Audio` (the threnody easter-egg), no-op `canvas.getContext` (combat is cosmetic
  on glass), and a `getElementById` fallback stub.
- The economy advances on the game's own `window.setInterval` loops, on Node timers — real-time,
  no browser, no tab-throttling.
- Save = the game's `localStorage` blob, mirrored to Postgres (`paperclips_save`).

## Known limitations under jsdom (reviewed 2026-06-27, deliberately deferred)

The full arc is playable end-to-end — clip economy → trust/processors → strategic
modeling / investment / quantum → Release-the-HypnoDrones → Earth-disassembly (factories /
drones / farms / batteries / power) → space / von-Neumann probes + probe-trust design → combat
(honor) → dismantle/endgame. These three edge cases are degraded, none blocking:

- **In-game prestige restart is a no-op.** "Quantum Temporal Reversion" (projects.js:2389, the
  post-victory restart) calls `reset()` → `localStorage.removeItem(...)` + `location.reload()`.
  jsdom's `location.reload()` is a no-op, so the universe doesn't actually restart (the next
  autosave re-writes the in-memory state). No data loss — it just doesn't reset. To truly start
  over: stop the server, `DELETE FROM paperclips_save WHERE id='default'`, restart. (A real
  in-process re-init would mean tearing down + rebuilding the jsdom engine — deferred.)
- **Tournament strategy isn't chosen.** `runTourney` fields the default (leftmost) strategy
  (`stratPicker` has runtime-appended options we don't surface). Tournaments still run and pay
  yomi — just not optimally. (The Strategy level's New/Run/AutoT all work.)
- **Combat MaxT/PTrust + Honor surface on the FIRST battle, not when "Combat" is purchased**
  (`battleFlag` flips when a battle starts, not at purchase — there's no separate flag). They
  appear exactly when you first need them, so this is cosmetic.

## Re-vendoring

If upstream changes and a known-good interaction breaks, re-fetch the four files and re-pin here,
then re-run `server/smoke/phase-paperclips.mjs`.
