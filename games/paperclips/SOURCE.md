# Universal Paperclips — the game engine, fetched not vendored

**Source:** https://www.decisionproblem.com/paperclips/ (`combat.js?v3`, `globals.js?v3`,
`projects.js?v3`, `main.js?v3`), first fetched 2026-06-27.

**By:** Frank Lantz / Bennett Foddy / Everybody House Games.

## ⚠ These four files are NOT in this repository — run the fetcher

```bash
node games/paperclips/fetch.mjs      # fetches + SHA-256-verifies the four engine files
```

`combat.js`, `globals.js`, `projects.js`, and `main.js` are **gitignored on purpose.** They are
Frank Lantz's work. He published the game free on the open web, but under no licence that grants
redistribution — so G2CC does not republish them. What the repo pins instead is the *provenance*:
each file's URL and SHA-256 live in `fetch.mjs`, which refuses to write a file whose hash doesn't
match. That preserves the same drift discipline the vendored copies gave us (a silent upstream
change still can't move under us) without redistributing someone else's game.

If you clone this repo, you fetch the engine from Frank Lantz's site — exactly as if you'd opened
it in a browser. Go play the real thing there, and buy his other work.

*(History: the four files were committed here from 2026-06-27 until 2026-08-14, when the repo went
public and redistribution stopped being defensible.)*

## Why the engine is here at all

G2CC drives the *real, unmodified* game logic headlessly (jsdom, in `server/src/paperclips.ts`)
so Adam can play it on his own G2 glasses — an offline, first-party instance on hardware he owns,
the same device-interoperability framing as the rest of G2CC. We never reimplement or fork the
game balance; we read its globals and call its global functions.

## What was changed

**Nothing in the four `.js` files** — they are used byte-for-byte upstream, hash-pinned.

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
(honor) → dismantle/endgame. **Prestige restart now works** (2026-06-28) — "The Universe Next
Door" / "The Universe Within" (projects.js:2131/2159) and "Quantum Temporal Reversion"
(projects.js:2378) call the game's `reset()`, which ends in a `location.reload()` that jsdom
no-ops. The engine intercepts it (`installRestartHook` replaces `reset()` with a flag): after
the project's effect runs, `applyProject` calls `reboot()` to tear down the jsdom window
(`window.close()` → `stopAllTimers`) and re-boot a FRESH game carrying only `savePrestige` (the
demand / creativity bonus) — exactly what a real reload preserves. See `reboot` in
`server/src/paperclips.ts`. These two edge cases are degraded, none blocking:

- **Tournament strategy isn't chosen.** `runTourney` fields the default (leftmost) strategy
  (`stratPicker` has runtime-appended options we don't surface). Tournaments still run and pay
  yomi — just not optimally. (The Strategy level's New/Run/AutoT all work.)
- **Combat MaxT/PTrust + Honor surface on the FIRST battle, not when "Combat" is purchased**
  (`battleFlag` flips when a battle starts, not at purchase — there's no separate flag). They
  appear exactly when you first need them, so this is cosmetic.

## Re-vendoring

`fetch.mjs` will **loud-fail on a SHA-256 mismatch and write nothing** — that failure is the
signal that upstream changed, not a bug to work around. When it happens:

1. Diff the new file against your local copy and find what moved.
2. Re-run `server/smoke/phase-paperclips.mjs` against the new code before trusting it.
3. Only then update that file's `sha256` in `fetch.mjs`, noting the date.

Never re-pin a hash you haven't diffed — the pin is the whole point.
