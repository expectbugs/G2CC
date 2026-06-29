# G2CC Game List

Master list of games worth driving from the G2 glasses through G2CC. Each entry records
what the game is, why it fits the G2 input/display model, and the concrete bridge approach
(how the PC-side game connects to a G2CC window). This is a planning doc; per-game specifics
get hashed out in a dedicated session.

Last updated 2026-06-28.

## The fit lens (why these and not others)

G2 is a 576×288 16-gray heads-up display. The entire input vocabulary is **scroll a list →
tap to pick → double-tap to go back → enter a number on the numpad**
(`docs/DE_DESIGN.md`, `docs/G2_BLE_PROTOCOL.md` §6.6). Render limits: ≤4 image tiles, ≤8 text
regions, ≤12 containers, stay under the ~1 KB/frame multi-packet wall; text updates ~62 ms,
image tiles ~seconds (`docs/G2_BLE_PROTOCOL.md`, memory `g2-render-limits`).

A game fits when it is:

- **Turn-based or self-paced** — ideally *no real-time clock*, so a glance can be 3 s or
  3 min with no penalty, and a hand can be pocketed mid-turn.
- **List-/number-shaped** — the moment-to-moment choice reduces to picking from a list (cards
  in hand, a menu of actions, a project to buy) or entering a number.
- **Resumable & async** — survives being put down for hours; better still if the PC keeps the
  sim alive 24/7.
- **Deep** — rewards repeated short sessions over weeks; deeper than a one-and-done puzzle.

Anti-fit: twitch/real-time, spatial pointing, free-text entry as the primary loop, fast
multiplayer. (These are why MUDs, Neptune's Pride, Fallen London, lichess puzzles, and async
board-game sites were considered and dropped.)

## Integration interface

A game becomes a selectable window by implementing the `OsWindow` interface in
`server/src/os-windows.ts` — `view()` returns `{title, menu[], browse?[]}`; `onMenuSelect` /
`onBrowseSelect` / `onBack` receive taps; the window is a persistent singleton that re-derives
its screen from game state every tick (so phase/state changes need no special handling).
Game-specific glue lives in `server/src/games.ts`. Category is `'Games'`.

## Bridge patterns

1. **Native module** — game logic in-process (TS). Lowest effort. *(Hold'Em.)*
2. **Subprocess / PTY** — run a text program (curses roguelike) in a pseudo-terminal and parse
   the screen grid; the existing Terminal window (tmux + scrollback) is a ready substrate.
   Save files make it resumable. *(Angband, Cataclysm, Brogue, DCSS-console.)*
3. **jsdom engine host** — load a browser game's real JS under jsdom on Node timers; read its
   globals, call its functions. No browser, no tab-throttling. *(Universal Paperclips — chosen
   over headless Chromium specifically to dodge background-timer throttling.)*
4. **Pre-built bot bridge (localhost protocol)** — a community mod exposes state + commands over
   a socket/HTTP; G2CC is just a client. Lowest-risk when it exists. *(Balatro → BalatroBot.)*
5. **Open-source client/server protocol** — speak the game's own network/AI protocol with a thin
   client. *(FreeCiv, Wesnoth.)*

## Existing baseline (already in `server/src/games.ts` / `GamesWindow`)

- **rpg-cli** — filesystem-as-dungeon roguelike (subprocess). Proves the subprocess pattern.
- **Chess vs Stockfish** — python-chess + Stockfish, confirm-before-move, rendered board tiles
  (`scripts/chess_move.py`, `scripts/render_board.py`). Lichess correspondence is the documented,
  deferred extension.

---

## Summary

| Game | Genre | Bridge | G2 fit | Effort | Status |
|---|---|---|---|---|---|
| Universal Paperclips | Incremental | jsdom engine host | Excellent | — | **In progress** |
| Balatro | Deckbuilder roguelike | BalatroBot (JSON-RPC) | Excellent | Low | Candidate |
| Blackjack | Card | Native TS module | Excellent | Low | **Next (graphics build)** |
| Poker (Hold'em) | Card | RLCard via Python daemon | Excellent | Low–Med | Candidate |
| Spades · Euchre · Gin · Cribbage | Card (trick/melds) | OpenSpiel via Python daemon | Excellent | Medium | Candidate |
| Hearts | Card (trick) | jsdom host (html5-hearts) or native | Very good | Medium | Candidate |
| Dungeon Crawl Stone Soup | Roguelike | PTY / webtiles | Excellent | Low–Med | Candidate |
| Brogue | Roguelike | PTY | Excellent | Low–Med | Candidate |
| Angband | Roguelike | PTY (curses) | Excellent | Low–Med | Candidate |
| Cataclysm: Dark Days Ahead | Survival roguelike | PTY (ncurses) | Very good | Medium | Candidate |
| FreeCiv | 4X strategy | client/server protocol | Good | Med–High | Candidate |
| The Battle for Wesnoth | TB tactics | engine/network | Good | High | Candidate |

---

## Universal Paperclips — *in progress*

Frank Lantz's incremental classic. Three phases (business → drones/Earth → space probes); the
"UI" is a live list of available buttons + a dynamic `activeProjects[]` array, all numbers and
text — no board to render. Idle by nature: it accrues while you're not looking, so the glasses
are a glanceable dashboard + occasional strategic taps. The textbook "advance while bored at
work" game.

- **Bridge:** jsdom host in `server/src/paperclips.ts`. Loads the real, unmodified engine under
  jsdom on Node `setInterval` timers — **no browser, no tab-throttling** (this was the chief
  risk with a headless-Chromium approach, and jsdom sidesteps it). Audio + canvas are shimmed
  no-ops; combat canvas is cosmetic on glass.
- **Engine:** vendored byte-for-byte in `games/paperclips/` (`combat/globals/projects/main.js`
  + stripped `index.html`); provenance + re-vendoring steps in `games/paperclips/SOURCE.md`.
  Pinned so an upstream change can't silently alter behaviour (same drift discipline as the BLE
  protocol).
- **Window:** `PaperclipsController` / `PaperclipsWindow` in `server/src/os-windows.ts` —
  reads state each tick, renders dashboard text + a menu of phase actions and affordable
  projects; taps call the engine's global functions.
- **State model:** all in plain globals (`clips`, `funds`, `wire`, `operations`, `trust`,
  `processors`, `spaceFlag`, …); actions are global functions (`clipClick`, `buyWire`,
  `makeClipper`, `raisePrice`, `makeHarvester(n)`, the 8-axis `raiseProbe*`, …); phases are
  flags (`humanFlag` → `spaceFlag` → `swarmFlag`/`battleFlag`).
- **Save:** game `localStorage` blob mirrored to Postgres (`paperclips_save`).
- **Smoke test:** `server/smoke/phase-paperclips.mjs`.
- **Open item:** the quantum-chip mechanic (`quantumCompute`/`qComp`) is the one twitchy bit —
  best handled as an auto-quantum toggle (engine clicks it only when favourable).

## Balatro — *candidate (bridge already exists)*

Poker-themed deckbuilder roguelike Adam owns and plays heavily. Solo, no clock, deep
joker-synergy engine-building, brutal scaling. Each hand is `select cards → play/discard`, the
shop is a list, blinds are a choice — i.e. natively list-shaped, the cleanest input fit on this
list.

- **Bridge:** **BalatroBot** — a Steamodded Lua mod that serves a **JSON-RPC 2.0 HTTP API at
  `http://127.0.0.1:12346`**, plus a `pip`-installable Python package.
  - Repos: `coder/balatrobot` (actively maintained, OpenRPC docs, Linux support) ·
    `besteon/balatrobot` (original). Already driven by LLMs (siblings `coder/balatrollm`,
    `coder/balatrobench`) — the "external brain controls it" path is proven.
  - G2CC is just an HTTP client (no subprocess parsing, no headless-browser concerns).
- **Methods:** `gamestate`, `start{deck,stake}`, `select`/`skip` (blinds), `play{cards:[idx]}`,
  `discard`, `buy`/`sell`/`reroll`/`pack` (shop + boosters), `use` (consumables), `rearrange`,
  `cash_out`, `next_round`, `save`/`load`, `screenshot`, `menu`. States:
  `MENU → BLIND_SELECT → SELECTING_HAND → ROUND_EVAL → SHOP → (SMODS_BOOSTER_OPENED) → GAME_OVER`.
- **G2 mapping:** `gamestate` → render hand / jokers / shop as tappable lists; multi-select
  cards then a Play/Discard commit (same confirm-before-apply pattern as chess); `save`/`load`
  make runs resumable; `screenshot` could feed the image tile if a visual is wanted.
- **Requirements:** Lovely Injector v0.8.0+ and Steamodded; mod copied to the Balatro Mods dir
  (Linux native: `~/.config/love/Mods/balatrobot/`; Steam/Proton path differs). Needs a display
  (`DISPLAY=:0.0` present).
- **Risks:** runs the *real, modded* Balatro as a GUI window (not headless); mods can break on
  Balatro/Steamodded version bumps; "may conflict with other mods."
- **Effort:** Low — localhost HTTP against a finished API. Verify current BalatroBot ↔ Balatro
  version compatibility when wiring.

## Card games (standard 52-card deck) — *researched 2026-06-28*

Poker, blackjack, spades, hearts, euchre, gin rummy, cribbage, and the like — all turn-based,
list/number-shaped, and resumable, so among the cleanest fits on this list. Research verdict: a
single **Python "card daemon"** (JSON-over-stdio, mirroring `scripts/chess_move.py` and
`audio/pipeline/parakeet_daemon.py`) wrapping two engines covers almost everything vs CPU, behind
one interface whose core call is *"here are the legal actions — pick one by index,"* which IS the
G2 input model (scroll list → tap → numpad). Each game is then one `OsWindow` that renders
`legal_actions` as its menu.

### Engines (CPU opponents) — verified 2026-06-28

| Engine | License / health | Covers | Interface | Bridge |
|---|---|---|---|---|
| **OpenSpiel** (DeepMind) — [repo](https://github.com/google-deepmind/open_spiel) | Apache-2.0, active (v1.6.15, May 2026); pip wheels py3.11–3.14 | Spades, Euchre, Gin Rummy, Cribbage, Blackjack, Bridge, Oh Hell, + Leduc/limit poker | `state.legal_actions()`→ints, `action_to_string()`→HUD labels, `apply_action()`; CFR/MCTS/ISMCTS bots | Python daemon (pattern 2) |
| **RLCard** — [repo](https://github.com/datamllab/rlcard) | MIT, dormant since ~2022–24 but stable | Blackjack, Gin Rummy, **Limit/No-Limit Hold'em**, UNO, Leduc | `env.step()`, `get_state()['raw_legal_actions']`; ships **pretrained rule-based bots** | Python daemon |
| **html5-hearts** — [repo](https://github.com/yyjhao/html5-hearts) | BSD-2 | **Hearts** | logic split from UI, DOM-based, ships a headless simulator | **jsdom host** (Paperclips pattern) |
| native TS | — | **Blackjack** (+ War-class) | hand-eval + fixed-rule dealer; ~50 LOC | in-process (pattern 1) |

**Per-game pick:** Poker → RLCard (best API + a real bot; OpenSpiel's full No-Limit `universal_poker`
has known issues). Blackjack → native TS (no real opponent — the dealer is fixed-rule). Spades /
Euchre / Gin / Cribbage → OpenSpiel (trick-takers flagged "experimental" — expect rule-edge
verification + ISMCTS tuning). Hearts → jsdom html5-hearts or native (⚠ two researchers disagreed
on whether OpenSpiel actually ships Hearts — verify before relying on it). Bridge is supported but
its bidding/play is a poor G2-input fit — deprioritize.

**Meta-finding:** every engine with real card AI is Python, so the spine is pattern 2 (Python
subprocess), same shape as chess. No JS card engine with competent AI is worth wrapping (except
html5-hearts for the jsdom route).

### Real / internet opponents — verdict: self-host or nothing

Feasible only by **self-hosting a server you control** (vs friends, or by publicising your
instance). Best ROI: **boardgame.io** or **Colyseus** (both MIT, active) — write each game's rules
once, get networking + lobby + reconnection + auto-bots (so the same engine also serves the CPU
path); the G2CC Node server is the network client, the glasses just render. **PokerTH** (AGPLv3,
alive — v2.0.6, Mar 2026) is the only maintained ready-made server with public games to join, but
poker-only + protobuf-binary. **Do NOT bother** (closed / bot-banned / no public client API,
verified against their ToS): online poker (PokerStars / 888 / GGPoker — active bans + fund
seizures), BoardGameArena, Trickster Cards, PlayOK/kurnik, VIP Games, Tabletopia, Tabletop
Simulator. No live federated standard exists (XMPP gaming never shipped; GGZ Gaming Zone is defunct
~2008 — a rules/protocol reference only).

### Blackjack — *first build (graphics-first), with Adam*

Engine: **native TS** — the dealer follows fixed house rules, so there's no AI to import (a
basic-strategy hint can ride alongside). Reason to start here: it proves the **card-rendering UI**
with zero engine dependencies, then the Python-daemon games inherit it.

Rendering plan (Adam 2026-06-28 — to build together): a **card atlas** (one master image of all 52
cards + back, generated once, converted to G2 gray4) plus a **sprite-coordinate map** (x,y,w,h per
card). The server composites per-hand tiles by blitting sprites from the atlas, then ships **four
small image regions**: (1) player hand, cards fanned/overlapping; (2) dealer hand, overlapping the
face-down hole card; (3) the deck/shoe, shrinking as it's used; (4) the player's chip stack,
growing/shrinking at settlement. Reuses the existing chess
board-render → tile-splitter → compose substrate (`scripts/render_board.py`, the shared splitter,
`composeScene` tiles).

Constraints + refinements that shape it (from `docs/G2_BLE_PROTOCOL.md`, memory `g2-render-limits`):
- **Hard caps:** ≤4 image regions — the four tiles (hand / dealer / deck / chips) hit the ceiling
  EXACTLY, so a SPLIT (a second player hand) gets composited into the one player tile, not a 5th
  region. Each single image **≤288×129** (≥384×192 silently drops); size each tile to its content,
  not the max.
- **Latency ∝ tile area.** Images blit UNCOMPRESSED gray4 (no RLE on the wire), ~1 s for a full
  288×129 tile; a content-sized ~130×70 hand tile is a few hundred ms. Small tiles = minor tax —
  the instinct is right.
- **Re-push a tile ONLY when its cards change** — NEVER on menu navigation. This is exactly the
  "redraw fix" already learned on the chess board (selection levels render zero image regions to
  avoid re-pushing tiles). A Hit re-sends only the player tile; Stand / dealer-reveal re-sends only
  the dealer tile; the deck updates in discrete steps (it's the most decorative — could even be a
  text "shoe ~60%" if a tile isn't worth its tax).
- **Suits must read by SHAPE, not colour** — red and black both render dark in 16-gray, so
  hearts/diamonds vs spades/clubs disambiguate only by pip glyph. Design HUD-legible cards (bold
  rank + large suit pip, high contrast), not photorealistic ones.
- **Card art = AI style layer + code-composited exact index/pips** (Adam 2026-06-28). Generate the
  *art* with the local image models (Qwen-Image / Flux.2): the frame/border, the back, the J/Q/K
  face portraits, four stylish suit-pip glyphs, and the chip art. Composite the correctness-critical
  layer — the large corner rank+suit index and the exact 2–10 pip COUNT — programmatically on top,
  so all 52 come out exact and consistent. (Raw txt2img-per-card garbles ranks / pip-counts / style
  — avoid it; for the face cards, AI ControlNet/inpaint onto a fixed layout template is the
  exact-AND-stylish route.) The **corner index is what shows when cards are fanned**, so it must be
  the crisp code-rendered element; the AI body is mostly hidden in a fan.
- **Design the AI art for the medium.** A card is only ~66×92 px in 16-gray on glass, so bold / flat
  / high-contrast / graphic styles (art-deco, woodcut, engraving, poster) survive; painterly or
  photoreal detail turns to mud after the downscale + 4-bpp posterise. Generate 2–3 sample cards and
  verify on REAL glass before committing the full 52 (suits must stay distinguishable by silhouette,
  ~10–15 px).
- **Overlap separation:** a 1 px outline / slight drop-shadow so fanned cards read as distinct in
  mono.
- The **atlas never goes to the glasses** — it's a server asset; only composited tiles ship
  (convert each composited tile → gray4 at send, or pre-store the atlas in gray4 and blit
  gray4→gray4).
- Text regions carry the live numbers (hand totals, bet, bankroll, result) and the menu
  (`Hit / Stand / Double / Split`) — within the ≤8 text / ≤12 container budget.

## Roguelikes (Angband · Cataclysm: DDA · Brogue · DCSS) — *candidates*

The genre's killer property for glance-play: **turn-based with no real-time clock** — the game
waits forever for the next move. The Reader's numpad maps directly to roguelike movement
(7-8-9 / 4-5-6 / 1-2-3 = the eight compass directions + wait). Each is a real terminal program,
so the existing Terminal window (tmux + scrollback) is a ready substrate to start in; a dedicated
window later adds numpad-movement + command menus + a text/grid render.

- **Dungeon Crawl Stone Soup** — the deep, modern, beloved one. Two bridge options: PTY of the
  console build, or **webtiles** (DCSS's own JSON-over-websocket tile protocol, which also gives
  persistent online characters playable from anywhere). Fit excellent.
- **Brogue** — elegant, far fewer commands, vicious tactical depth; gorgeous even in mono. PTY
  of the console build. Fit excellent, lightest command surface.
- **Angband** — deep loot + character progression; classic curses build → PTY; persistent save.
  Fit excellent; more commands → more menu design than Brogue.
- **Cataclysm: Dark Days Ahead** — a different depth axis: post-apocalyptic *survival sim*
  (crafting, vehicles, bionics, base-building). Real ncurses build → PTY; open-source; enormous.
  Fit very good — the large command/menu surface is the main input-design work.

**Shared bridge note:** PTY screen-scrape = run the program in a pseudo-terminal, parse the
rendered grid into G2 regions, inject keystrokes for taps/numpad. Save files make all of them
resumable. Sil-Q (an Angband variant) is a strong alternative if the tightest tactical combat is
wanted.

## FreeCiv — *candidate*

Full open-source Civ. Turn-based (take all the time you want), deep 4X. Solo vs AI.

- **Bridge:** thin client against the `civserver` protocol, or drive **freeciv-web**'s
  `freeciv-proxy` (JSON over websocket) — verify which is the lower-effort path when wiring.
- **G2 fit:** good but heavier — a spatial 4X needs the map/cities/units abstracted into lists
  (e.g. "units needing orders" as a browse list, per-unit action menus) rather than a rendered
  map. The turn structure itself is a clean fit; the input design is the work.
- **Effort:** Med–High.

## The Battle for Wesnoth — *candidate*

Turn-based tactical campaigns vs AI; open-source; deep unit/terrain/recruit systems; clean turn
structure. No clock.

- **Bridge:** heaviest on this list. No clean external bot API — likely the engine's Lua/WML
  scripting hooks or the `wesnothd` network protocol, or PTY/scrape as a fallback. Approach
  needs verification before committing.
- **G2 fit:** good with caveats — the hex map is the least natural G2 input; would lean on
  "unit needing orders → action menu" lists like FreeCiv. Deep and self-paced, so it earns a
  slot, but it's the biggest integration lift here.
- **Effort:** High.

---

## Notes / open items

- **Slay the Spire** was researched alongside Balatro (its `CommunicationMod` exposes full
  game-state JSON + commands over stdio, with a `spirecomm` Python wrapper) but is **not on this
  list** — not explicitly greenlit. Add on request.
- None of the candidates are wired yet beyond the existing baseline (rpg-cli, chess) and the
  in-progress Paperclips. Effort ratings are relative and assume the `OsWindow` plumbing is
  reused.
</content>
</invoke>
