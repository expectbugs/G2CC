# Final Fantasy 1 (NES) on the G2 — Build Plan

**Status:** P0 SPIKE COMPLETE 2026-08-12 — cynes PROVEN on FF1, all §6 addresses
live-verified, every P0 exit criterion green (results + new findings in §12.P0-R).
**P1–P5 are being built as a fully-automated one-shot — mission order + locked
decisions in `HANDOFF.md` (it wins over this doc where they differ; notably:
dictation CUT, ring-only).** Original plan authored same day.
**Goal:** play real FF1 — same ROM, same save, full authenticity — from the glasses,
built around the G2's real constraints: text is fast (~62 ms updates), images are
SLOW (~10 s for big tiles under work-BT conditions, Adam's measured reality).
**Prime directive:** battles, shops, inns, menus, and dialogue NEVER touch an image.
Imagery is for map navigation only, at macro cadence. The emulator is a headless
game ENGINE; G2CC renders its own native UI from RAM + scraped screen text
(the Paperclips pattern — real engine, our UI — applied to a NES game).
**Adam's campaign:** the unfinished "One White Mage, Three Black Mages" challenge
run. Authenticity guards below (§7.1, §8.3) exist so the bridge never softens the
game: no retarget fixes, no RNG cheats, enemy HP hidden by default.

**Context for the vocabulary in this spec:** this is a retro-gaming project —
a 1987 single-player NES game in a locally-hosted open-source emulator on
Adam's own PC, shown on his own glasses. Offline, first-party, no other
players, no anti-cheat, no external system anywhere; the same software class
as TAS tooling. Terms of art: **"scrape"** = screen-OCR of our own emulator's
framebuffer (deterministic 8×8 font-tile matching); **"command entry"**
(formerly "injection" in early revisions) = pressing buttons on the EMULATED
controller via cynes' documented input API, verified by reading the game's
own menu-state variables; **"daemon"** = an ordinary long-lived local child
process hosting the emulator (the stt.ts pattern).

This doc follows the house wire-format discipline: **every address/byte traces to a
reference** (§6, §15). Everything marked `[VERIFY-SPIKE]` is documented by a source
but gets re-confirmed against live RAM (Mesen 2 cross-check) before code relies on
it — verify-before-execute applies inside the emulator too.

---

## 1. Verified inputs

- ROM: `games/ff1/rom/Final Fantasy.nes` (copied 2026-08-12 from
  `/mnt/slug/pandora2/ROMS/NES/Final Fantasy.zip`; dir gitignored).
  iNES header verified by hand: `NES\x1a`, PRG `0x10` (256 KB), CHR `0x00`
  (CHR-RAM), flags6 `0x12` → **mapper 1 (MMC1) + battery SRAM**. Exactly the
  canonical FF1 (USA) shape. Hashes recorded: CRC32 `0xAB12ECE6`,
  MD5 `9b0f042cfdc5f9e8200b47104a4768a9`, SHA1 `80ce108f…94feb`.
- Display/input constraints (from `games/gamelist.md` fit lens + memory):
  576×288 gray4; ≤4 image tiles, single tile ≤288×129; ~1 KB/frame multi-packet
  wall; text ~62 ms, images seconds-to-~10s; input = scroll / tap / double-tap
  (+ dictation via `onStt`, typed text via `onTypedText`); menu labels ≤~7 chars,
  constant-label rule; double-tap is ALWAYS exit/back (music stuck-trap lesson).
- Server precedents this build copies:
  - Persistent Python daemon over JSON-lines stdio: `server/src/stt.ts`
    (`pipeline.parakeet_daemon`) — queue/pump, `-u` unbuffered, identity-gated
    respawn, reject-on-close.
  - Process-lifetime game singleton surviving ws-close: `server/src/paperclips.ts`.
  - Two independent image tiles, re-pushed only on per-tile pixel change:
    `BlackjackController` (`server/src/windows/games.ts`).
  - Save clobber-guard (`loadOk` gate before any persist): blackjack, review 2026-07-05.
  - GamesWindow sub-controller shape: `PaperclipsController` / `BlackjackController`.

## 2. Emulator decision

**Pick: `cynes` 0.1.2** (github.com/Youlixx/cynes, MIT) — the only candidate that is
natively headless, pure Python, and covers every runtime need:

| Need | cynes answer |
|---|---|
| Headless | `from cynes import NES` — no window, no SDL. |
| Clock control | `nes.step(frames=N)` runs exactly N frames, unthrottled; nothing advances between calls (we own the clock — the screen cannot change while Adam reads). |
| Input | `nes.controller = bitmask` (`NES_INPUT_A/B/SELECT/START/UP/DOWN/LEFT/RIGHT`), set before `step()`. |
| CPU memory | `nes[addr]` read/write through the full CPU bus incl. cart SRAM `$6000-$7FFF` (verified in source: reads dispatch to the mapper). |
| Framebuffer | `step()` returns numpy `(240,256,3)` uint8 RGB — pixel-exact, feeds the text scraper (§5). |
| Savestates | `nes.save()` → numpy byte buffer / `nes.load(buf)`; includes mapper PRG-RAM. Trivially persisted to Postgres. |
| Battery .sav | not automatic — we dump `$6000-$7FFF` ourselves (8 KB) for cross-emulator .sav export (§9). |
| Mappers/accuracy | MMC1 supported; README claims nestest + blargg CPU/PPU test passes. FF1-specific accuracy is `[VERIFY-SPIKE]`. |
| Install | `pip install cynes` — manylinux wheels cp39–cp314 (system 3.13 fine), zero system deps. |

Verification notes (agent-fetched from source, 2026-08-12): the `$6000-$7FFF`
range is EXPLICITLY documented as safe in `cynes/emulator.pyi` ("Mapper RAM");
`class MMC1` confirmed in `src/mapper.hpp`; no throttling code anywhere (grep
clean) → true zero-CPU idle between `step()` calls; controller bitmask layout
bit0=Right…bit7=A, P2 in the high byte; v0.1.2 released 2026-03-12.
**UNVERIFIED → P0 items:** savestate round-trip through disk in a FRESH process
(docs only promise same-ROM restore), and FF1-specific accuracy (young core).

**Known gap:** no PPU/nametable access → on-screen text comes from framebuffer
tile-matching instead (§5). That path is deterministic (known font, pixel-exact
frames), not fuzzy OCR.

**Fallback ladder** (only if the spike shows cynes mis-emulating FF1):
1. **MesenCE** (github.com/nesdev-org/MesenCE — the active successor;
   SourMesen/Mesen2 was ARCHIVED mid-2025): native headless
   `--testRunner script.lua rom.nes` with MaximumSpeed forced, **bundled
   luasocket** for a TCP bridge, side-effect-free full-bus reads
   (`emu.memType.nesDebug`), first-class `nesSaveRam` AND `nesNametableRam`
   domains (real nametable text, no pixel matching). Costs: Lua protocol layer,
   two timeout knobs to raise (`--timeout=N` testrunner ceiling ~24.8 days →
   supervised respawn; `ScriptTimeout` per-callback watchdog), binary outside
   portage (native AoT build, needs only SDL2).
2. `libretro.py` + FCEUmm or Nestopia core — headless-Python shape,
   `RETRO_MEMORY_SAVE_RAM` = exactly FF1's $6000-$7FFF; both cores are IN
   PORTAGE (`games-emulation/libretro-fceumm`, `libretro-nestopia`).
3. FCEUX 2.6.6 (also in portage) — full Lua incl. `ppu.readbyterange` +
   compiled-in luasocket, but no headless Qt mode (Xvfb tax). BizHawk last
   (Mono + dial-out socket = wrong shape for a server subprocess).

**RE workbench (install regardless):** MesenCE desktop — its debugger, RAM
search, and nametable viewer are how we live-confirm §6 and hunt §6.3's
gaps. (Local note: the portage checks above were done against
`/var/db/repos/gentoo` directly — this box's `eix` cache is stale; run
`eix-update` before trusting `eix` searches.)

## 3. Architecture

```
                         ┌────────────────────────────────────────────┐
  glasses ── BLE ── app ─┤ G2CC server (Node)                          │
                         │  windows/games.ts  → Ff1Controller          │
                         │        (windows/ff1-controller.ts, new)     │
                         │  server/src/ff1/engine.ts  (game API,       │
                         │        snapshots, macro orchestration)      │
                         │  server/src/ff1/bridge.ts  (daemon client — │
                         │        stt.ts queue/pump/respawn pattern)   │
                         └───────────────┬────────────────────────────┘
                                         │ JSON lines over stdio (-u)
                         ┌───────────────┴────────────────────────────┐
                         │ games/ff1/bridge/ff1_daemon.py (own venv)   │
                         │   cynes NES core (headless, paused between  │
                         │   ops) · RAM reader · frame tile-scraper ·  │
                         │   screen classifier · macro executor ·      │
                         │   savestate/SRAM dump · PNG frame export    │
                         └────────────────────────────────────────────┘
```

- **Module layout**
  - `games/ff1/bridge/` — `ff1_daemon.py`, `scrape.py` (tile hash → char),
    `screens.py` (classifier), `macros.py`, `ramspec.py` (addresses, §6, each
    with a lineage comment).
  - `games/ff1/data/` — `charmap.json` (generated from FF1Randomizer
    `FF1Text.cs`, lineage header), `glyphs.json` (8×8 glyph hashes learned in
    calibration, §5.2), `items.json` / `spells.json` / `enemies.json`
    (generated from ROM tables per Data Crystal ROM map offsets).
  - `games/ff1/venv/` — python venv (gitignored), `pip install cynes numpy pillow`.
  - `games/ff1/saves/` — .sav exports (gitignored).
  - `server/src/ff1/` — `bridge.ts`, `engine.ts`, `types.ts`.
  - `server/src/windows/ff1-controller.ts` — the GamesWindow sub-controller
    (games.ts delegates a new level `'ff1'`, exactly like `'pc'`/`'bj'`).
- **Lifecycle:** daemon is a process-lifetime singleton (paperclips rule): ws-close
  does NOT kill it; it idles paused (zero frames advancing — FF1 is not an idle
  game, nothing is lost while paused). Watchdog-style respawn on daemon death:
  reload ROM + restore last savestate + LOUD notice in the window (never silent).
- **Autosave:** savestate → Postgres `ff1_save` on every macro completion, every
  battle round, and on onDeactivate/leave/dispose (persistChain serialization +
  the blackjack `loadOk` clobber-guard). This is a cadence, not a timeout.

## 4. Bridge protocol (JSON lines, one object per line)

Requests (Node → daemon):
- `{op:"boot", rom:"…/Final Fantasy.nes", state?:b64}` — load ROM, optionally
  restore savestate. Response includes full snapshot.
- `{op:"press", buttons:["A"], hold?:frames, jitter?:true}` — press → advance →
  settle (§5.3) → respond.
- `{op:"macro", kind:"steps", dir:"up", count:5, stops:["battle","dialog","mapchange","blocked"]}`
- `{op:"macro", kind:"menu_seq", path:[…verified press script…]}` — §7.1 command
  entry with per-press verification.
- `{op:"state"}` — snapshot only (no advance).
- `{op:"save"}` / `{op:"load", state:b64}` / `{op:"sram"}` (8 KB b64 for .sav).
- `{op:"frame", crop:"top"|"bottom"|"full"}` — PNG b64 of the 256×224 visible
  area (8 px overscan trimmed top+bottom), for map pushes only.

Every response: `{seq, screen:"battle-entry"|"battle-msg"|"map"|"dialog"|"menu"|"shop"|"title"|"name"|…,
frameHash, text:[lines…], state:{party,gold,pos,mapId,vehicle,battle?}, stopped?:reason}`.
Scrape misses ride the response as `unknownTiles:[hashes]` — surfaced LOUD (§10).
Errors are `{seq, error}` — never a silent default. The TS `Ff1Bridge` mirrors
stt.ts exactly: single inflight job, queue, identity-gated respawn, reject-on-close.

## 5. Screen model & text scraping

### 5.1 Tile-match scraping (not OCR)
The NES draws text as 8×8 font tiles on an aligned grid. The framebuffer is
pixel-exact. So: slice the 256×240 frame into the 32×30 tile grid, hash each
cell (normalized to palette-independent form — threshold on luminance), look up
against the learned glyph table. Deterministic; a miss is a NEW tile (logged
loud with its hash), never a misread.

### 5.2 Charmap + glyph calibration
- String-byte charmap — from the VENDORED disassembly TBLs (`reference/
  table_standard.tbl`, `reference/table_dte.tbl`; see reference/README.md):
  menu/name single-tile map: `$80-$89`='0'-'9', `$8A-$A3`='A'-'Z',
  `$A4-$BD`='a'-'z', `$C0`='.', `$C1`=space, `$C2`='-', `$C4`='!', `$C5`='?',
  `$FF`=pad-space, `$D4-$E1`=equipment-category icons. Dialogue additionally:
  control codes `<$1A` (`$05`=newline, `$02`=insert item name), DTE pairs
  `$1A-$69`, singles `$7A-$FF` (bank_0F `DrawDialogueString` behavior).
  Generate `data/charmap.json` from the vendored TBLs (lineage header);
  cross-check against TASVideos' name-entry LUT (matches).
- Glyph pixel table: learned empirically in a calibration harness — drive the
  game to screens with KNOWN strings (title, "CONERIA", shop headers), match
  glyphs to expected text, save `data/glyphs.json`. Round-trip test: scrape a
  screen, compare to expectation, fail loudly on drift. (CHR-RAM means the font
  is loaded by the game at runtime; empirical capture is simpler and safer than
  chasing the PRG copy through the disassembly. `[VERIFY-SPIKE]` menu-font tile
  indices ↔ text bytes offset.)
- DTE only affects string bytes in ROM, not drawn tiles — scraping reads DRAWN
  glyphs, so DTE is irrelevant to the scraper (it matters only if we later read
  strings straight from ROM/RAM, e.g. items.json generation).

### 5.3 Settle detection ("the game wants input")
cynes has no input-poll/lag introspection, so settling is:
1. advance in small bursts, hashing frames;
2. settled = K consecutive identical hashes (K≈4) — FF1 battle/menu screens are
   expected static-when-waiting (no idle animation) `[VERIFY-SPIKE: sweep the
   major screens; if any region animates (e.g. orb shimmer), add a per-screen
   mask rather than loosening the rule)`;
3. battle text pacing: message lines print on a frame rule — the executor scrapes
   EVERY new-text frame during resolution so no message is missed (messages
   accumulate in the battle log regardless of on-screen dwell).
Frame budgets bound each op (frames, not wall-clock — the no-timeouts rule);
budget overrun = surface current state + `stopped:"budget"` LOUDLY, state intact,
Adam decides (Continue verb). Never auto-abandon, never auto-confirm.

## 6. RAM map

**Authority: `reference/variables.inc` + `reference/Constants.inc`** (Disch's
reassemblable US disassembly, vendored — see reference/README.md), corroborated
by the Data Crystal RAM-map snapshot (`reference/ff1_ram_map.txt`). Where the
two disagree the disassembly wins (it rebuilds the exact ROM); conflicts are
flagged below and get a live-RAM sanity check at the spike anyway. `ramspec.py`
cites `reference/variables.inc :: <label>` per address.

### 6.1 Party & world (labels verbatim from variables.inc)
| What | Addr | Notes |
|---|---|---|
| `ch_stats` ×4 | `$6100/$6140/$6180/$61C0` | 0x40 bytes each (`unsram=$6000` battery region) |
| +$00 `ch_class` | | $00-$05 FT/TH/BB/RM/WM/BM, $06-$0B promoted (Constants.inc `CLS_*`) |
| +$01 `ch_ailments` | | bits: $01 dead $02 stone $04 poison $08 dark $10 stun $20 sleep $40 mute $80 conf |
| +$02-$05 `ch_name` | | 4 chars, game charset (§5.2 charmap) |
| +$07 `ch_exp` | | 3 bytes (byte order → §6.3) |
| +$0A/+$0C `ch_curhp`/`ch_maxhp` | | 16-bit LE pairs |
| +$10-$14 STR/AGI/INT/VIT/LUCK | | `ch_str…ch_luck` |
| +$16 `ch_exptonext` | | 2 bytes, display-only |
| +$18-$1B / +$1C-$1F | | `ch_weapons`×4 / `ch_armor`×4; **+$80 = equipped** |
| +$20-$25 `ch_substats` | | dmg/hitrate/absorb/evade/resist/magdef |
| +$26 `ch_level` | | 0-based out of battle |
| `ch_magicdata` ×4 | `$6300` +$40/char | spells known +$00-$1F (per-level rows of 3+pad; values 0-8 OB) |
| **`ch_curmp`** / **`ch_maxmp`** | `$6320`/`$6328` +$40/char | 8 bytes each, L1-8 — **the 1WM3BM charge HUD.** **VERIFIED LIVE (P1-R 2026-08-12): $6320 = CUR, $6328 = MAX** — cast CURE via the game menu, (2,2)→(1,2). Disassembly right, Data Crystal wrong. |
| `gold` | `$601C` | 3 bytes (variables.inc; NOT in Data Crystal). Byte order → §6.3 |
| `items` | `$6020+` | fixed slots: lute $6021 … orbs $6032-35, tent $6036, cabin $6037, house $6038, heal $6039, pure $603A, soft $603B |
| `ow_scroll_x/y` | `$27/$28` | **SCROLL — player tile = (scroll+7)&$FF** (bank_0F: `ADC #7 ; +7 to get player's coord`) |
| `sm_player_x/y` | `$68/$69` | ⚠ P1-R: STALE after menu/shop screens (zero-page reuse); refreshes only on movement. **Use `(sm_scroll+7)&$3F`** ($29/$2A; standard maps are 64×64, mask required) — matches sm_player exactly post-move. |
| `cur_map` / `cur_tileset` | `$48` / `$49` | disassembly-only |
| `mapflags` | `$2D` | bit0 = in standard map |
| `vehicle` | `$42` | 1 walk / 2 canoe / 4 ship / 8 airship (`facing`=$33; persisted vehicle state $6000-$6014) |

### 6.2 Battle (well documented — better than hoped)
| What | Addr | Notes |
|---|---|---|
| `btl_result` | `$6B86` | 0 fighting / 1 party dead / 2 won / 3 ran — **the round/battle-end detector** |
| `btl_enemyIDs` | `$6BB7` | 9 slots, $FF empty |
| `btl_enemyroster` | `$6BC9` | the 4 IDs the battle menu prints |
| `btl_enemycount` / `btl_battletype` | `$6C93` / `$6C92` | type: 0=9small 1=4large 2=mix 3=fiend 4=chaos |
| `btl_enemystats` | `$6BD3` | **$14 bytes/enemy: +$02 HP (2b), +$06 ailments(dead), +$0D exp, +$0F gp, +$11 enemyid** |
| `btl_formdata` | `$6D84` | +$2 ids, +$6 qty, +$C surprise, +$D bit0 **norun**, +$E B-side qty |
| `btlformation` / `battlecounter` | `$6A` / `$F7` | pending formation id / next-encounter index |
| **Command-entry state** | | **the §7.1 verification anchors, all documented:** `btlcmd_curchar` $6B7A (whose command, 0-3), `btlcmd_target` $6B7B, `btlcurs_x/y` $6AAA/$6AAB (menu coords), `btl_charcmdbuf` $688F (4b/char), `btl_turnorder` $6848, `btl_curturn` $688E |
| OB menu cursor | `$62`/`$63` | `cursor`/`cursor_max` (+ `menustall` $37) |

**RNG — three pure counters, zero entropy (TASVideos + bank_0C/0F source):**
1. **Encounters:** per-step `battlestep` $F5/$F6 → fixed 256-byte table @ CPU
   $F100; thresholds: overworld walk/canoe 10, ship 3, most dungeons 8.
   **Route-deterministic** — same steps, same fights; frame timing irrelevant;
   macros cannot distort cadence. **P1 session-2 verified: battlestep ticks
   ONLY on encounter-capable terrain — the tiles around Coneria are
   encounter-FREE ((153,165)-(153,169) never tick; first ticking tile on the
   spike column is (153,170)). The §8.2 Battle pace macro must verify the
   counter advances and surface "safe terrain" if it doesn't.**
2. **Which formation:** `battlecounter` $F7 → same table → 64-entry weight lut
   (12/12/12/12/6/6/3/1). Advances once per encounter.
3. **In-battle:** `btl_rngstate` **$688A** → its own scramble lut @ $FCF1;
   advances once per call AND **burns one per input-poll frame** during command
   entry (bank_0C `DoFrame_WithInput`: "generate a number and throw it away").
   So frame-exact press timing ⇒ bit-exact crits/misses/AI ⇒ **jitter (§8.3) is
   mandatory**. Note: $688A sits in the save range — it persists across
   save/power-cycle (the game is save-scum-resistant by design; we keep it so).

### 6.3 Remaining gaps (spike items — small now)
- **Clean "in battle" boolean** — RESOLVED P0-R: `$81 == $68`.
- **Gold byte order** — RESOLVED P0-R: little-endian. **exp byte order** —
  **RESOLVED P2 (2026-08-12, session 2): LITTLE-ENDIAN** — after the first
  harness battle win each survivor's `ch_exp` read `[7, 0, 0]` (30 exp from
  5 IMPs split 4 ways); gold reward +30 corroborates. `read_char`'s low-first
  decode is correct as written.
- **MP cur/max order** — **RESOLVED P1-R 2026-08-12: $6320=cur / $6328=max**
  (live CURE cast; disassembly right, Data Crystal wrong).
- **Out-of-battle menu state machine** — P1-R: cursor `$62`/`$63` + scrape
  anchors suffice for every screen driven so far (shop char/spell/confirm,
  main menu, MAGIC char/page); see §12 P1-R for the decoded flows.

## 7. Views & UX

### 7.1 Battle — 100 % native text, zero images
Two phases, both image-free:

**Entry (G2CC-native, instant):** for each living character in order — verb menu
`Fight / Magic / Drink / Item / Run`; Magic → spell list with live charges from
RAM (`L3 FIR2 ×2/3`); target → enemy slots by name+count from the formation
(via `$6BB3` + enemies.json). The `>` marker walks the party pane. All of this is
OUR menus at text speed — the game hasn't moved yet.

**Command entry + resolution (one burst):** the executor drives the game's real
battle menus with the collected commands — every press VERIFIED against the
documented command-entry RAM (`btlcmd_curchar`/`btlcmd_target`/`btlcurs_x/y`,
§6.2), with `btl_charcmdbuf` as the final pre-resolution check that the queued
commands are EXACTLY what Adam picked and `btl_result` as the end-of-battle
detector; a mismatch HALTS the macro loudly with a desync view (Reload
re-derives; nothing is guessed). Then the round resolves;
every message frame is scraped into the battle log:

```
IMP ×3 · GrIMP ×1          > FIGHTER 45/45
                             W.MAGE  24/28  chg 2/1/0…
FIGHT MAGIC DRINK            Bl.MAGE 19/22  chg 3/2/0…
ITEM  RUN                    Bl.MAGE 22/22  chg 3/2/0…
──────────────────────────────────────────────
Bl.MAGE: FIRE — IMP A: 18 DMG. Terminated!
IMP C: FIGHTER — 4 DMG.
```

- Authenticity: commands target SLOTS; if the slot is dead by resolution the
  attack whiffs "Ineffective" exactly like 1987 (no retarget assist — that's the
  original challenge; AlgoRhythm's mechanics guide is the behavior reference).
- Enemy HP: hidden by default (`games.ff1.showEnemyHp:false`) — the RAM knows it,
  the challenge run shouldn't.
- Battle log: paginated/scrollable, full history per battle — NO TRUNCATION.
- Round cost on glass: native entry ≈ instant; one text update per resolution.

### 7.2 Maps (overworld / town / dungeon) — the only imagery
- **Two stacked 256-wide tiles at 1:1** — pixel-sharp, each under the ≤288×129
  cap; per-tile change key → re-push ONLY changed tiles (blackjack pattern).
  **P4-BUILT geometry: 256×110 + 256×112 (9 px overscan trim each side, 222
  rows total)** — the original 2×112 spec can't fit the 222 px DE content pane
  and BMP heights must be even (os-compose FF1_MAP_*_RECT; daemon frame op
  crops 'map-top'/'map-bottom', format 'gray4' = the encodeGray4Single payload
  whose all-black guard covers the black-tile rule).
- **Push policy: one push per completed macro.** We own the clock — the screen
  cannot change while Adam reads. No stability timers, no per-step pushes.
- Verbs: `↑ ↓ ← →` (step ×N), `×N` (cycle 1/2/3/5/8), `A` (talk/search),
  `Menu` (game menu → native text view), `Battle` (§8.2), `Peek` (force fresh
  push), `B`. Dictation later (§8.4).
- **Interrupts beat pushes:** a step-macro stopping on `battle` flips STRAIGHT to
  the native battle view — the map is never pushed mid-macro. `dialog` stop
  flips to scraped dialogue text (no image). Post-battle/dialogue: one map push.
- Latency truth (Adam's measured ~10 s for big tiles at work): two 112-row tiles
  ≈ half the pixel volume of a full-screen push, and usually only one tile
  changed. Measured for real in P4 — expectations set by data, not the docs.

### 7.3 Menus / shops / inns / status / equip — native text
Scrape + RAM enrichment; driven by verified command entry like battle. The flagship
touch: **un-truncated item names.** FF1-US squeezed names to fit ("Short" +
sword icon — the `$D4-$E1` icon tiles in the charmap); our labels come from our
own generated `items.json`: equipment IDs weapons `$01-$28` / armor `$29-$50`
(+$80 = equipped bit), name pointer table at ROM 0A:$B700 (weapon names start
at entry $1B+id, armor $43+id — bank_0F), prices in bank 0D, enemy names
0B:$94E0, enemy ROM stats 0C:$8520, weapon/armor/magic data 0C:$8000/$8140/
$81E0 (layouts in Constants.inc). So the shop list reads `Swd·Short Sword 550G`
at full text speed. Better than the original, zero images, NO-TRUNCATION
honored where the NES itself couldn't.

### 7.4 Name entry (one-time per file)
New-game naming drives the letter grid via macro. Input: the existing `_kbd`
model or dictation → 4-char name (charset-checked, loud on invalid). Nice-to-
have, P5; manual cursor mode suffices day one.

### 7.5 Title / continue
`Continue` = restore latest savestate (suspend-anywhere is free with savestates;
in-game inn/save remains the authoritative .sav for cross-play §9).

## 8. Input, macros, determinism

### 8.1 Ring mapping
- Native views (battle entry, menus): scroll = list nav, tap = select,
  double-tap = back/exit — ALWAYS (stuck-trap rule). `B` is a verb, never
  double-tap.
- Map view: verbs as §7.2; constant labels; state rides content, never labels.
- Cursor mode (driving the game's own menus manually, e.g. unscripted screens):
  scroll = ↑/↓ presses, tap = A, double-tap exits cursor mode.

### 8.2 Macros (all with declarative stops, all interrupt-first)
- `steps(dir, n)` — stop on battle / dialog / map change / blocked.
- `Battle` (pace-until-encounter): alternate one step forward/back on safe tiles
  until the battle stop fires. Encounter cadence is step-deterministic (§6.2),
  so pacing is exactly as honest as walking.
- `fight-until` (P5): repeat last round's commands each round; stop on battle
  end / any-ally-HP<X / charges-below / status. Stop conditions read RAM, never
  guess.
- Every macro reports what stopped it (`stopped:"battle"`, enemy formation in
  the same response — "which enemy, how many, where" is the snapshot).

### 8.3 RNG honesty
`games.ff1.rngJitter:true` (default): pad every executed press with 0-9 random
extra frames so battle outcomes aren't frame-replayable (§6.2). Tests set it
false for reproducibility. Encounter pacing needs no jitter (step-counter).

### 8.4 Undo — accidental-input insurance (Adam 2026-08-12: "losing a run
because I accidentally triggered a ring input while lifting a part would suuuuck")
Accidental ring inputs at work are COMMON. Every game-advancing action gets a
checkpoint FIRST; nothing an accidental tap can do is unrecoverable:
- The daemon keeps an in-memory ring of LABELED savestates (default depth 30,
  `games.ff1.undoDepth`): one before EVERY press burst (step, macro, battle
  round, menu_seq), plus auto-checkpoints at battle start and map change.
- **`Undo` is a standing verb in every view** (map, battle, menus). It opens the
  checkpoint list — reader_history pattern, labels like `↩ before Step ×5 →` /
  `↩ battle start (IMP ×3)` — Cancel-first confirm, then `nes.load()` that
  state. Multi-level: scroll deeper to rewind further.
- The ring's tail (last 5) mirrors to Postgres with the autosave, so a crash
  preserves undo depth, not just the latest state.
- Native G2CC menus (battle command picks not yet entered, verb lists) never
  need undo — nothing advanced; re-pick freely. The ring tracks exactly the set of
  actions an accidental tap can actually break.
- RNG honesty: undo restores the RNG counters too, but §8.3 jitter means a
  redone action is NOT bit-identical — undo is accident recovery, not a
  deterministic save-scum lever. (It is still rewinding time; Adam's run,
  Adam's call.)
- Bridge protocol: every advancing op auto-checkpoints (`label` field);
  `{op:"undo_list"}` / `{op:"undo", index}` round it out.

### 8.5 Dictation — CUT (Adam 2026-08-12: FF1 is RING-INPUT-ONLY, permanently)
No voice anywhere in this window: no onStt, no intent grammar, no mic. All
macro configuration is verbs + cycles on the ring. (Kept here as a tombstone
so nobody re-adds it.)

## 9. Persistence & cross-play
- Postgres `ff1_save(id, state bytea, snapshot jsonb, updated_at)` — savestate
  autosave (§3) + labeled manual slots (`Save`/`Slots` verbs). Load-clobber
  guard per the blackjack lesson.
- `.sav` export verb: dump `$6000-$7FFF` → `games/ff1/saves/ff1-<date>.sav` —
  standard 8 KB battery format, loads in Mesen/mGBA-class PC emulators for
  full-speed home play; re-import supported (`sram` op both directions).
  Cross-emulator note: export is only coherent at an in-game save point (inn /
  title) — the export verb enforces that (loud refusal otherwise).
- ROM + saves + venv gitignored; `data/*.json` (generated, text) committed with
  lineage headers.

## 10. The Three Absolute Rules, applied
- **NO TIMEOUTS:** every wait is frame-budgeted or event-driven; budget overruns
  surface state and WAIT for Adam (Continue verb). Daemon supervision is the
  watchdog pattern, not wall-clock I/O wrappers.
- **NO SILENT FAILURES:** scrape misses (unknown tile hashes), command-entry
  desyncs, daemon death, savestate write failures — all render in the window
  and log `[ff1]` lines. The statusLine carries `⚠ unsaved` / `⚠ desync` states
  (paperclips precedent).
- **NO TRUNCATION:** battle logs, dialogue, item lists paginate/scroll; item
  names are UN-truncated (§7.3); any string that can't fit raises loudly.

## 11. Testing (per project testing safety)
- **Harness-first:** everything through P2 runs off-glass. `bridge/harness/`
  scripts: boot → title → name entry → Coneria shop scrape → first battle round
  end-to-end, asserting scraped text + RAM snapshots.
- **Fixtures = savestates** (fixture-from-production pattern): a library of
  states (pre-battle, shop open, dialog open, airship) checked into
  `bridge/harness/fixtures/` (binary but small, or regenerated by script —
  decide at P1 by size).
- **Determinism:** tests run `rngJitter:false` + fixed frame pads → identical
  battles, byte-identical scrapes.
- **Smoke:** `server/smoke/phase-ff1.mjs` (daemon boot + one scrape + savestate
  roundtrip vs a fixture) joins run-all — baseline shifts 36/37 → 37/38.
- **No BLE, no glasses, no phone in any test.** WM mocked as in blackjack tests.

## 12. Phases & acceptance criteria

**P0 — Spike (one session).** venv + cynes; boot ROM; step; measure headless
frames/sec. Read `$6100` party + `$601C` gold on a fresh file and cross-check
in MesenCE. **Savestate round-trip THROUGH DISK IN A FRESH PROCESS** (the
flagged cynes unknown). SRAM dump→`.sav` loads in MesenCE. Framebuffer
captured; title-screen glyphs matched by hand against the vendored charmap.
Static-screen sweep (§5.3) on title/menu/battle/map. Resolve §6.3's small
gaps (in-battle boolean pick, gold/exp byte order, MP-order sanity check).
Measure savestate size + save/load cost (the §8.4 undo ring rides on this
being cheap). **Exit: cynes is proven or the fallback ladder is invoked.
Everything in §6 re-stamped VERIFIED or fixed.**

**P0-R — RESULTS (2026-08-12, scripts: `bridge/spike_p0.py` + `spike_p0b.py`,
artifacts in `bridge/spike_out/` gitignored). ALL EXIT CRITERIA GREEN.**
Verified end-to-end: boot → prologue → menu → party select → name entry (4×
"AAAA") → overworld → walked into a 5-IMP battle, screenshots at every stage.
- **Emulation correct:** prologue text, menus, party select, overworld, battle
  all pixel-clean; IMP battle block reads canonical 8 HP / 6 exp / 6 GP.
- **Measured:** ~610-700 frames/sec headless (~10× realtime; batching step()
  doesn't change it). Savestate = 21,773 bytes; save/load ≈ microseconds →
  §8.4 undo ring ×30 ≈ 0.7 MB, effectively free.
- **Savestate FRESH-PROCESS disk roundtrip: PASS** (the flagged cynes unknown).
- **Live-verified addresses:** party block (classes 0-3, Fighter 35HP/20STR
  canonical), names `8A×4` = "AAAA" → **charmap 'A'=$8A empirically confirmed**;
  gold $601C = 400 **little-endian confirmed**; vehicle=$42 (=1 walking) —
  disassembly beat Data Crystal; facing $33 values 1/2/4/8 confirmed;
  battlestep $F5 ticks per tile, battlecounter $F7 +1 per encounter;
  btl_enemyIDs/count/type/result + $6BD3 enemy stats all correct;
  btlcmd_curchar/target + btlcurs read sane values at the command menu.
- **In-battle boolean RESOLVED: `$81 == $68`** — fired the frame the encounter
  triggered (mid-step-hold). `music_track $4B` is a TRANSIENT request byte
  (00 at steady state) — NOT usable as a state flag.
- **Static screens CONFIRMED:** main menu and battle-command screen = 1
  distinct frame in 120 (fully static → settle detection trivial). Fades pass
  through sustained uniform black → settle-v2 rule: never accept a
  uniform-color frame as settled (§5.3 mask note).
- **Input protocol findings (executor spec):** menu presses need **≥8-frame
  holds** (2-frame presses get eaten; gap ~24f reliable). Name entry = 6
  presses/slot (open + 4 letters + confirm); party-select finisher = **A**,
  not Start. **Overworld steps must be position-verified**: hold the direction
  until $27/$28 changes (~24f/tile) or a frame budget — fixed short holds
  never commit a tile; check $81 every frame during the hold (battles trigger
  mid-hold).
- Deferred to P1: MP cur/max disambiguation (needs a spent charge — buy CURE
  or use the MesenCE workbench), `.sav` cross-load into MesenCE, exp byte
  order (reads 0 on a fresh file).

**P1 — Bridge + scraper.** Daemon skeleton (protocol §4), screen classifier v1,
charmap/glyphs/items data files generated with lineage, calibration round-trip
test green. **Exit: any menu/dialog screen scrapes to exact text in harness.**

**P1-R — RESULTS (2026-08-12, Ph-A session 1; harness 4/4, exit ~90 % — the
remaining items are listed in BUILD_LOG "Ph-A open items"). Findings that
override naive assumptions (same authority class as P0-R):**
- **Glyphs:** learned from the name-entry grid (two-frame cursor dodge; probed
  coords r=10+2i, c=6+2j; rows `A-J/K-T/UVWXYZ',./0-9/a-j/k-t/u-z-‥!?`),
  round-trip-verified on mainmenu/partyselect/battle screens → ONE standard
  font everywhere + `data/glyphs.json` (77 patterns). **'O' and '0' share one
  bitmap** (003e63636363633e) — alias folded, `fold_digit_token()` restores
  digits in numeric tokens.
- **Condensed rendering, not a second font:** any string WIDER than its box
  interior is composed CONDENSED into CHR-RAM (battle commands FIGHT/MAGIC/
  DRINK at ~6px pitch; menu WEAPON/STATUS; the `L`-level and `/` glyphs are
  separate menu tiles). Resolution combat boxes, shop text, dialog, menu
  headers ITEM/MAGIC/ARMOR, party pane = STANDARD font — everything the
  bridge scrapes is standard-font; condensed strings are never scraped
  (command entry + menu navigation are RAM-verified instead).
- **Settle-v2 extended:** fade-ins hold each palette level SEVERAL frames —
  K=4 accepted a mid-fade town as settled and inputs pressed into fades get
  latched/eaten (`joy_start`). **K=12 fixed it.** The GAME MENU never settles
  (portraits animate perpetually) → `settle(allow_animated=True)` returns
  False and the fact rides the response; menu-open detection = scrape anchor
  (ITEM+MAGIC+ARMOR) or cursor response, never frame stability.
- **Steps macro v2:** hold-until-motion-starts (move_ctr $35/$36), release,
  run animation out — a held button through the ~16-frame animation LATCHES a
  second step (southward doubles). Stop reason re-evaluated AFTER every
  settle (transitions/battles fire on the committed tile — 'done' there was
  the BFS-blinding bug). All four directions verified tile-exact.
- **Positions:** ow = (ow_scroll+7)&$FF; **sm = (sm_scroll+7)&$3F** (64×64
  wrap; sm_player $68/$69 goes stale after menus). ← ramspec fix is the FIRST
  next-session action; harness re-run after.
- **Coneria decoded (route + flows, all cursor/RAM-verified):** from the
  new-game spawn (153,165) walk `up×4` + `right×1` → town (sm map 0, spawn
  sm(16,23)). Seven shop doors BFS-mapped (shop_id dec): (11,10)=1 weapon,
  (6,10)=11 armor, **(7,4)=21 WHITE MAGIC (type $66=2)**, (3,4)=31 black
  magic, (24,4)=41 clinic, (11,18)=51 inn, (27,10)=61 item. Shop flow:
  enter → "Who will learn the spell?" char cursor $62 (max $63=4) → A → spell
  list (CURE/HARM/FOG/RUSE ea. "L1 100") → A → "100 Gold OK?" Yes/No
  ($63=2, Yes first) → A → gold −100 + `ch_spells` slot write (value 1 =
  CURE). Exit = B (from char select), ONE B after the fixed settle.
  Main menu: Start → palette-cycle swirl → ITEM/MAGIC/WEAPON/ARMOR/STATUS
  (cursor $62 0-4); MAGIC → 2×2 char-panel cursor (Down=+2, Right=+1) → A →
  per-char magic page ("who needs to recover HP?" target cursor) → cast
  spends $6320-side MP. Dialog: face NPC + A → top-rows box, standard font
  ("Nothing here." scraped; classifier → 'dialog'). NPC positions readable
  at mapobj $6F00 (+2/+3 phys, $10/entry).
- **Data files generated + anchor-verified** (`data/*.json`): 108 items
  (weapon 6 = Short Sword 550 G — weapons run Nunchuck/Small Knife/Wooden
  Staff/Rapier/Iron Hammer/Short Sword; icon tiles expanded via ICON_WORDS,
  fullName carries the §7.3 un-truncated names), 64 spells (CURE…XXXX,
  4W+4B per level), 128 enemies (IMP 6/6/8 canon), charmap from the TBLs.
- **Daemon protocol live** (boot/state/press/steps/save/load/sram/frame/
  undo_list/undo/checkpoint/set_config/scrape/ping/shutdown), kill -9 →
  respawn → savestate restore PASSES; undo ring labels verified.

**P2 — Battle vertical slice (off-glass, the risk burn-down).** Formation read,
native entry model, verified command entry against the documented menu-state
addresses (§6.2; live-confirm them + find the in-battle boolean, §6.3),
resolution scrape → battle log. One full authentic round in harness; desync
drill (deliberately drop a press → loud halt). **Exit: a scripted battle
plays end-to-end with byte-exact log.**

**P2-R — FINDINGS (2026-08-12 session 2; build ~85% done, one known fix
pending — resume point + code map in BUILD_LOG "Ph-B"). Authority class of
P0-R/P1-R; the battle-menu semantics were READ from the now-vendored
`reference/bank_0C.asm`, then live-verified:**
- **The battle engine's input rules are the OPPOSITE of the overworld's.**
  bank_0C menus poll per frame-ish with EDGE detection (`MenuSelection_2x4`:
  `DoFrame_WithInput` vs `btlinput_prevstate`, delay counter for repeats). A
  held button that spans a submenu transition is re-sampled by the NEXT menu
  as a fresh edge: an 8-frame A hold on the battle spell menu instantly
  auto-confirmed the ally-target picker at its home position (default target
  = party slot 0). Discipline (encoded in `bridge/battle.py`): **4-frame
  holds + 20 released frames + every press verified by a TRANSITION**, with
  bounded retries (short presses can still be eaten — the magic-draw path
  samples on a ~5-frame cadence).
- **Command menu 2×4:** (0,0) FIGHT (0,1) MAGIC (0,2) DRINK (0,3) ITEM,
  column 1 RUN. `btlcurs` y wraps through 255 transiently — never trust raw
  cursor values outside verified transitions.
- **FIGHT:** A → enemy picker (`btlcmd_target` live-tracks; Down cycles the
  ALIVE slots), A confirms → cmdbuf `04 10 target 00` (effect byte $10 is an
  observed constant). Picker slot n = enemy slot n (identity); resolution
  ORDER is initiative-shuffled, so damage lands out of entry order — pair
  effects to targets by RAM deltas, never by message order.
- **MAGIC:** A → spell menu (page 0 = L1-4 rows, page 1 = L5-8 via Down at
  row 3; x = slot 0-3 within the level; empty slot or 0 MP → "Nothing" box
  and the submenu restarts). Spell-select A pre-fills the cmdbuf row; target
  byte encoding (variables.inc block comment, live-confirmed): `0x` enemy
  slot, `8x` party slot, `FF` all enemies, `FE` whole party. One-ally spells
  open `SelectPlayerTarget`; the chosen ally = `btlcurs_y & 3` AT CONFIRM.
- **The ally picker (session-3 CORRECTION, asm-verified then live-proven):**
  session 2's "picker = `curs(16,0)`" was WRONG — that value was post-confirm
  resolution scratch, so the wait-cond only ever fired on the FAILURE case.
  Ground truth (bank_0C.asm): the ally picker is `MenuSelection_2x4`, which
  ZEROES btlcurs_x/y at entry — a LIVE picker reads (0,0), indistinguishable
  from the spell menu's home. The reliable picker-open signature is the cursor
  SPRITE `btlcursspr_x/y` ($6AE3/4), rewritten every menu-loop iteration from
  per-menu pixel luts with DISJOINT areas (ally x≥$90,y≤$7C; enemy x≤$50,
  y $30-$70; magic x≤$70,y≥$A6; command y≥$9E) — but stale after a menu
  exits, so "sprite reached picker area" + "cmdbuf row NOT freshly written
  vs a pre-press capture" together prove "picker live" (the guard compares
  against the captured row, not 'unwritten': cmdbuf persists across rounds).
  The cmdbuf row is written ONLY at picker confirm (`SetCharacterBattleCommand`,
  `BattleSubMenu_Magic @Target_10`) — the picker-confirm A IS the completing
  press. $6AAA/$6AAB are OVERLOADED labels (btlcurs_x/btlcurs = $6AAA,
  btlcurs_y/btlcurs_max = $6AAB): enemy pickers store slot/max there (why the
  old fight cond "y≥3" worked — btlcurs_max ∈ {3,7,8} at prep), 2x4 menus
  store x/y. **Auto-confirm mechanism**: a held A re-fires via the menu's
  input-delay REPEAT (~3-5 unchanged samples ≈ 6-10 frames), so
  picker-opening A presses use a 2-frame hold (`PICKER_HOLD`) — too short to
  reach the repeat window — while other battle presses stay at 4 f.
- **cmdbuf persists across rounds** (never cleared) — byte equality can NEVER
  verify a press landed; only transitions (curchar advance, combat-box
  change) can. The byte-exact §7.1 check compares AFTER a verified
  transition.
- **Round end** = `btlcmd_curchar` back to the FIRST LIVING slot (char 0 can
  die) + cursor home + roster box scraping, sustained 10 frames. Static-frame
  detection CANNOT end a round — message dwells hold static 40+ frames.
- **Battle end** = `btl_result` 1/2/3. **$81 flips away from $68 BEFORE the
  victory boxes finish**, and the victory screen's own party pane
  misclassifies as 'dialog' — the outro must run until the CLASSIFIER reaches
  ow/sm. Outro any-key boxes advance on B (an A carried onto the map opens
  "Nothing here."). Party-dead (result 1): game-over screen is terminal — no
  outro wait.
- **Verified end-to-end in harness** (test_battle.py, 13 checks green before
  the pending fix): FIGHT×4 byte-exact rows; full 4-round battle WON with
  stable message log ("Terminated", "Monsters perished"); outro → overworld;
  gold +30; exp little-endian (§6.3 closed). CURE/fled/drill/daemon sections
  written but blocked behind the ally-picker fix.

**P3 — Window integration.** `Ff1Controller` (games.ts level `'ff1'`),
battle + menus on glass, preview()/summary()/statusLine(), Postgres autosave +
clobber guard, watchdog respawn drill, **Undo verb live in every view (§8.4)
with a deliberate accidental-tap drill**. **Exit: full battle + shop visit
played on the real glasses, text-only, sub-second round updates, and a
"whoops-tap" undone on glass.**

**P4 — Maps.** Two-tile 1:1 pipeline (reuse existing PNG→gray4 tile machinery —
function names verified at wiring), step verbs + ×N, interrupt flips
(battle/dialog), Peek, all-black guard. **Measure real on-glass push times and
record them here.** **Exit: walk Coneria→shop→overworld→encounter→battle→back,
map pushes only at macro boundaries.**

**P5 — Polish.** `Battle` pace macro, `fight-until` grind loops, name-entry
macro (ring-driven), `.sav` export verb + slots UI, enemy-formation tile
toggle (small image, battle-start only, default off), RAM-drawn dungeon
minimap. NO dictation (§8.5 cut). Each lands independently.

## 13. Open decisions (Adam)
1. **Enemy HP display** — default hidden (recommended for the challenge run);
   flip `games.ff1.showEnemyHp` anytime.
2. **Sub-controller vs own window** — plan says sub-controller in GamesWindow
   (consistency with pc/bj; Games list stays the hub). Own window only if the
   controller outgrows the pattern.
3. **Battle log verbosity** — every message (authentic) vs condensed per-actor
   lines. Plan default: authentic, paginated.
4. **Fixture format** — committed savestate binaries vs regeneration script
   (decide at P1 when we see sizes).

## 14. Risks
- **cynes accuracy on FF1** — mitigated by P0 exit gate + fallback ladder (§2).
- **Idle-animation surprises** breaking settle detection — P0 sweep + per-screen
  masks (§5.3).
- **Battle-RAM gaps** — smaller than feared: command entry, enemy stats, and
  battle result are all documented (§6.2); P2 burns down what's left (§6.3)
  with Mesen + the vendored symbol table.
- **Command-entry desync drift** (menu timing quirks, surprise prompts) — per-
  press verification + loud halt is the design; the desync drill (P2) proves it.
- **Map push latency disappoints even at half-volume** — Peek-first play still
  works (text interactions dominate); RAM-drawn minimap (P5) is the deeper cut.
- **Scope creep toward "remake the game"** — the bridge renders and presses
  buttons; the ROM stays the only rules authority. Anything smarter than the original is a
  labeled, optional, default-off convenience.

## 15. Sources
- **`reference/` (vendored 2026-08-12 — the in-repo authority; see
  reference/README.md):** `variables.inc` + `Constants.inc` (Disch's
  reassemblable US disassembly via github.com/Entroper/FF1Disassembly — "v1.0
  Complete!… documentation of ALL code"; informal-permissive per its readme),
  `table_standard.tbl` + `table_dte.tbl` (charmaps), plus snapshots of the
  Data Crystal RAM/ROM maps and the TASVideos page.
- Data Crystal (datacrystal.tcrf.net): `Final_Fantasy/RAM_map` (2024-01-24
  revision) + `/ROM_map` — corroboration + item tables. Conflicts with the
  disassembly (MP order, vehicle addr) resolved in the disassembly's favor,
  flagged in §6. NOTE: the wiki's `Text_table` page is EMPTY — don't chase it;
  the TBLs above are the charmap source.
- TASVideos `GameResources/NES/FinalFantasy1` — the three-counter RNG model,
  both RNG tables, encounter thresholds, battle formulas + famous-bug list
  (§6.2, §8.3).
- AstralEsper's Game Mechanics Guide (GameFAQs 57009; endorsed by TASVideos as
  the most comprehensive) — battle formulas; NB GameFAQs 403s CLI fetches, open
  in a browser. Anomie's per-bank disassembly notes via RHDN doc 401.
- github.com/Youlixx/cynes — README + `emulator.pyi` + `src/mapper.hpp`
  ($6000-$7FFF documented safe range; MMC1 class; no-throttle grep).
- Emulator survey 2026-08-12 (primary sources fetched per candidate): MesenCE
  2.2.1 (fallback #1 + workbench; Mesen2 archived), libretro.py 0.8.2 +
  portage cores (fallback #2), FCEUX 2.6.6 (portage; Xvfb-bound), BizHawk
  2.11.1 (wrong shape), nes-py 9.0.1 (RAM capped at $0800 + same-process-only
  snapshots — disqualified, verbatim from `nes_py/ram.py` + its docs),
  tetanes-core (fine core, would need a Rust bridge), HeadlessQuickNes (dead
  2016).
- Local verification 2026-08-12: iNES header + hashes (§1); PyPI wheel
  coverage; charmap/vehicle/gold/MP/enemy-stat labels spot-checked directly in
  the vendored files after copying.
- Design session: this conversation (Adam, 2026-08-12) — text-first battles,
  macro maps, ~10 s image reality, challenge-run authenticity requirements.
