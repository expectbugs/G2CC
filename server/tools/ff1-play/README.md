# ff1-play — drive the FF1 window from the command line

A headless `/pc` surface client plus a game-level driver, used to play Final
Fantasy on the **live** G2CC server without glasses and without a browser. This
is the harness that ran the 2026-08-13 acceptance: Adam's party from level 1 to
level 5 on 130 real encounters, geared at Coneria, walked to the Temple of
Fiends, and **beat Garland in two rounds** — see `games/ff1/BUILD_LOG.md`
§ "Session 5".

Nothing here reaches the daemon or the window directly. Every action is one of
the three events the glasses actually send — `focus` (ring scroll), `tap`,
`double_tap` — or a `hub_select` row tap, exactly as `server/static/pc/` sends
them. If a thing cannot be done here, it cannot be done on-glass either; that
is the whole point.

## Running it

```bash
cd server/tools/ff1-play
printf '%s' "$G2CC_TOKEN" > /tmp/tok            # the same token the /pc page uses
TOKFILE=/tmp/tok OUTDIR=./data CTRL_PORT=7455 node mirror.mjs &   # attach a surface
node run_grind.mjs 5 400        # fight until every character is level 5
node run_endgame.mjs shop       # spells + best gear + a TENT + potions
node run_endgame.mjs equip
node run_endgame.mjs inn        # heal, restore MP, in-game save
node run_endgame.mjs journey    # walk to the temple — NO spells, potions only
node run_endgame.mjs tent
node run_endgame.mjs boss       # 8 north, face him, talk twice
```

`mirror.mjs` attaches as `os_attach{surface:'browser'}` and exposes a tiny HTTP
control plane (`/scene`, `/status`, `/send`) so the drivers can read what is on
screen and post input. **Pick a port outside 7394-7399** — the smoke suite binds
those, and a harness squatting there shows up as a phantom red.

## The pieces

| file | what it does |
| --- | --- |
| `mirror.mjs` | headless `/pc` client: auth → `os_attach` → capture `render` scenes; HTTP control plane |
| `drv.mjs` | ring primitives: `focus`/`tap`/`doubleTap`/`pick`, `verb(label)` (scroll the strip to a label and tap it), scene parsing, busy/settle detection |
| `ff1.mjs` | game moves: screen classification from the title, `move`/`goTo`/`goShop`/`exitTown`, `fightBattle`, shop purchases, party readout |
| `grind.mjs` | the levelling plan + `recover()` (party wipe → the window's own Undo) |
| `garland.mjs` | the journey/boss plans and `toGarland()` |
| `run_grind.mjs`, `run_endgame.mjs` | the runners |
| `data/*.json` | ROM-derived navigation: overworld policies, Coneria town policies, the temple route |

## Things it learned the hard way

- **Steer FF1's menus by counting keypresses from a known origin.** The game's
  cursor is a *sprite*, invisible to the tile scraper, and `·` is also the
  unknown-glyph filler — matching `·NAME` picks up false positives (it once
  gave all four suits of armour to one character). Shops reset both cursors
  only on a *fresh* entry, which is why `buyFresh()` re-enters every time.
- **The equip grid is 4 characters × 2 rows × 2 columns**, filled left to
  right: character *c*'s row is `↓×(c*2)`; the second item is `→`, not `↓`.
  Verify with the `-` equipped marker — but a *swap* keeps the marker count the
  same, so check for `-<ItemName>`, not the count.
- **A blocked step is not always a wall.** Town NPCs wander and park, and FF1
  objects only step when the *player* steps, so bumping forever never frees the
  tile. The walkers side-step, and `exitTown()` tries every one of the map's
  exits.
- **A dungeon door is a teleport tile**, so the tile you stand on after walking
  out is off every walkable policy — step to a routed neighbour first.
- **NES FF1 never re-targets.** An attack aimed at an enemy that died earlier in
  the same round is wasted; four characters on slot 0 turned a 3-IMP fight into
  13 rounds. The plans spread targets across the formation.
- Poll `/status` for a new `seq` and wait for the status bar to stop reading
  `ff1 · <op>…` before acting again. That is display pacing, not a timeout —
  a stall is reported loudly, never eaten.
