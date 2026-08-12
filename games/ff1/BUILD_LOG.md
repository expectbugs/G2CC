# FF1 One-Shot Build — Run Journal

Automated build per `HANDOFF.md` (mission order) + `PLAN.md` (spec). Session
started 2026-08-12. Adam reads this in the evening — per-phase entries below.

## Pre-build baseline (before any changes)

- `node server/smoke/run-all.mjs` → **36/37 passed**. The one red is
  `phase10-calendar.mjs` — the known env GCal-OAuth red (memory: no
  refresh_token on this box; documented in the Phase-1 modularization memory).
  NOT ours; the gate for every phase is "no NEW red", i.e. still 36/37 with
  phase-ff1 added → 37/38.
- `games/ff1/venv` verified: cynes imports, numpy 2.5.2, PIL present.
- Spike artifacts verified in `bridge/spike_out/`: `state.npy` (main menu),
  `ckpt_overworld.npy`, `ckpt_battle.npy`, `ckpt_partysel.npy`,
  `ckpt_named.npy`, `ckpt_all_named.npy`, `ckpt_confirm.npy`,
  `ckpt_postmenu.npy`, `ckpt_poststart.npy` + stage PNGs.
- cynes API surface re-verified from the spike session's `.pyi` dump
  (repo root `cynes-emulator.pyi`): controller bit layout (bit0=Right …
  bit7=A, P2 high byte), `reset()` KEEPS RAM (→ the .sav import path),
  `save()/load()`, `step(frames)` → (240,256,3) RGB read-only view,
  `has_crashed` flag.

## Ph-A (= PLAN P1) — daemon + scraper + classifier + data files

### Design decisions (with reasons)

1. **Glyph calibration source = the name-entry letter grid** (not menu
   strings): one screen carries A-Z, a-z, 0-9 and the 6 name-grid punctuation
   glyphs at known grid positions (`f_00_grid_open.png`). Two captures with
   the cursor moved between them (open: cursor on A; after one Down: cursor on
   K) so the finger-sprite-contaminated cells are learned from the clean
   frame. Learned table is then round-trip-verified against the OTHER
   calibration screens (main menu "CONTINUE"/"NEW GAME"/"RESPOND RATE 1",
   battle "FIGHT/MAGIC/DRINK/ITEM/RUN" + "IMP" + "AAAA") — this doubles as
   the proof that FF1 uses one font for grid + menus + battle.
2. **Binarization: luminance ≥ 128 = ink**, per 8×8 cell on the 32×30 tile
   grid; the 64-bit pattern itself (16 hex chars) is the glyph key — no lossy
   hashing, collisions impossible. Palette-independence is not needed for
   FF1's text (always white-on-dark; fades are excluded by the settle-v2
   uniform-frame rule) — documented as a scraper invariant, revisit only if a
   round-trip test ever fails on a real screen.
3. **Region-scoped extraction**: `screens.py` owns per-screen TEXT REGIONS
   (interior row/col rects); unknown-tile LOUDness applies inside those
   regions only (map graphics/sprites outside text boxes are not "misses").
4. **Classifier is RAM-first**: battle = `$81 == $68` (P0-verified), map =
   `mapflags $2D` bit0 (sm) else ow, with scrape anchors for the pre-game
   screens (mainmenu/partyselect/nameentry) and dialog/shop (text present in
   their box regions while on a map). Uniform frame = 'transition', never a
   settled classification.
5. **Name-entry is position-verified** via `namecurs_x/y` ($64/$65,
   variables.inc) — same discipline as overworld steps: press toward the
   target cell, verify the cursor RAM moved, LOUD on budget overrun.
6. **Undo ring**: newest-first list of labeled savestates, depth-trimmed
   (default 30); `undo(i)` loads WITHOUT popping (newer entries stay = redo
   stays possible until new checkpoints trim them). Every advancing op
   auto-checkpoints first.
7. **Data generation anchors** (empirical verification at gen time, LOUD on
   mismatch): enemy 0 = "IMP" with 6 exp/6 GP/8 HP ($6BD3 canon from P0);
   spell 0 = "CURE"; weapon 1 "Wooden" + name-table entry $1B+id; Short Sword
   price 550. Charmap from the vendored TBLs verbatim.

### Progress log

**Session 1 (2026-08-12) — Ph-A ~90 % done, harness 4/4. Context handoff
prepared at Adam's request; SESSION 2 STARTS AT "Ph-A open items" below.**

Built (all under `bridge/` unless noted):
- `ramspec.py` — every address lineage-commented + decoders (read_char,
  read_enemy_slots, in_battle, player_tile, sram_save_present).
- `scrape.py` — binarize (lum≥128), 64-bit cell patterns as 16-hex keys,
  GlyphTable (+known-ambiguity aliasing O/0 + fold_digit_token), region
  scraping with LOUD unknown-tile side channel.
- `calibrate_glyphs.py` — grid two-frame learning + border/cursor chrome +
  © + four-screen round-trip; writes `data/glyphs.json` (77 patterns).
- `gen_data.py` — charmap/items/spells/enemies from TBLs+ROM, anchors
  (Short Sword 550 G @ weapon 6, HEAL Potion 60 G, Masmune, CURE, LIT,
  IMP 6/6/8) — an anchor CAUGHT a wrong assumption once already (weapon 2
  vs 6), exactly the point.
- `screens.py` — classifier v1 (RAM-first battle/map + scrape anchors);
  probed regions for mainmenu/grid/dialog/battle roster+party+combat boxes.
- `macros.py` — Emu wrapper (settle-v2 K=12 + allow_animated; press ≥8f;
  press_verified retry-with-condition; steps v2 motion-start/release/rerun
  tile-exact). See PLAN §12 P1-R for the findings each encodes.
- `ff1_daemon.py` — full §4 protocol + §8.4 undo ring (newest-first, labeled,
  auto-checkpoint before advancing ops, undo without pop).
- `harness/run_all.py` + `test_daemon.py` (24 checks — incl. kill -9 →
  respawn → restore) + `test_scrape_classify.py` (16 checks) +
  `probe_layout.py` (the coordinate prober). **4/4 green.**
- `data/`: glyphs.json, charmap.json, items.json, spells.json, enemies.json
  (committed; lineage headers inside).

Resolved questions (details in PLAN §12 P1-R): MP $6320=cur VERIFIED via live
CURE cast; O/0 shared bitmap; condensed-vs-standard rendering; fade-hold
settle bug (K=12); step-latch double-move bug; stop-reason-after-settle bug;
sm position mask; Coneria route + all seven shop doors + full shop/menu/cast
flows cursor-verified; dialog scrape + classify green.

Journey savestates preserved for session 2 in `bridge/spike_out/` (gitignored,
on disk): `town_entry.npy` (just inside Coneria), `shop_open.npy` (white-magic
shop, char select), `j_town.npy` (town, post-shop, CURE bought, gold 300),
`fix_menu.npy` (main menu open), `fix_magicpage.npy` (RM magic page),
`fix_dialog.npy` (dialog box open), `k2_final.npy` (post-CURE-cast, RM MP 1/2).
Party in those states: FIGHTER/THIEF/Bl.BELT/RedMAGE all named AAAA, RM knows
CURE, gold 300, battlestep advanced from the town walk.

### Session 2 (2026-08-12, resumed)

**Terminology normalization (Adam's request):** session 1's autonomous run
kept tripping assistant-safety false positives — the docs used security-
flavored vocabulary for benign emulator work ("command injection", "deliberately
corrupt a press", an undefined "daemon+scraper" pairing). Fixed at the source:
HANDOFF.md + PLAN.md now open with a first-party framing block (the same
pattern that fixed the BLE-work misreads in CLAUDE.md), "injection" is now
**"command entry"** everywhere (also more accurate — we press buttons on the
emulated controller and verify via the game's menu-state RAM; nothing is
written into a foreign process), the desync drill "corrupts" nothing (it
DROPS a press), and stray `payload` variables are `doc`. Module names
(scrape.py etc.) unchanged — "scrape" is defined up front as framebuffer
screen-OCR. No behavior change; harness stayed 4/4.

### Ph-A open items (SESSION 2 STARTS HERE — in order)

1. ~~**ramspec.player_tile fix**~~ **DONE session 2**: standard maps now read
   `((sm_scroll+7)&0x3F)` from $29/$2A (sm_player $68/$69 documented STALE —
   kept only as reference constants). Verified: harness 4/4; route replay
   ckpt_overworld (153,165) → up×4 right×1 → mapchange → town map 0
   **sm(16,23)** exact; post-shop `j_town.npy` reads player_tile **(7,4)**
   (the white-magic door) while raw sm_player says (7,68), and a down step
   lands (7,5) — stale case closed.
2. **Menu-glyph calibration stage**: extend calibrate_glyphs.py — from
   `fix_menu.npy` learn the two menu-only tiles by expected position:
   the `/` in char-0's "HP 35/ 35" row and the `L` level tile in "L 1"
   (both currently scrape �). Round-trip assert "35/ 35" and "L 1"
   afterward. (Screen layout: see scratch shot notes — HP row is the 4th
   text row of each char panel; find cells by scraping char-0's panel and
   locating the � between the two '35' runs — self-locating, no new probe
   needed.)
3. **screens.py `_menuish`** → anchor on the STANDARD-font trio
   ITEM+MAGIC+ARMOR (≥2 of 3; WEAPON/STATUS are condensed and never scrape).
   Currently requires ≥3 of 5 — works but only because exactly 3 can match;
   make it intentional.
4. **Committed fixtures**: `bridge/harness/gen_fixtures.py` replaying
   spawn→town→shop→buy→menu→cast from `ckpt_overworld.npy` (all steps are
   already proven; the scratch scripts to distill live in this entry's
   flows + PLAN P1-R), writing `bridge/harness/fixtures/*.npy` — commit
   those (≈22 KB each; PLAN §13 open decision 4 → DECIDED: commit binaries).
   Un-gitignore `bridge/harness/fixtures/` (the ff1 .gitignore currently
   covers only rom/venv/saves/spike_out — fixtures dir is fine as-is).
5. **test_journey.py**: replay the fixture chain asserting each stage's
   scrape text + RAM effects (menu/dialog/shop exact-text = the P1 exit
   criterion): shop char-select header "Who will learn the spell?", spell
   list rows, "1OO Gold OK?"→fold, gold 400→300, ch_spells write, menu
   ITEM/MAGIC/ARMOR anchor, MAGIC 2×2 cursor path, cast → $6320 drop,
   dialog "Nothing here.", classifier verdicts at every stage.
6. **Light review gate (§6 HANDOFF)** over the whole Ph-A diff, then commit
   `feat(ff1): Ph-A — daemon, scraper, classifier, data files` + push.
   (Session 1 committed a WIP checkpoint instead — see below.)

### Ph-A findings your next actions depend on (quick recall)

- Daemon runs from `games/ff1` cwd: `./venv/bin/python -u bridge/ff1_daemon.py`.
- Press-eating is REAL: any menu press needs press_verified (condition-based)
  or a scrape/RAM wait — never trust a bare press landed.
- `press(settle=True)` on the game menu returns with `last_settled=False`
  (portraits animate) — that flag rides daemon responses as `settled:false`.
- Shop exit: ONE B from char-select → map (with K=12 settle). Menu open:
  ONE Start → wait for ITEM/MAGIC/ARMOR scrape (swirl takes ~200f).
- Data JSONs load in the daemon at startup (enemy names for formation
  labels; charmap for ch_name decode) — keep that wiring when touching it.
- The four L1 white spells price 100 G each in Coneria; CURE = list index 0.
- `git status` baseline oddities that are NOT ours: repo-root untracked
  bizhawk-README.md, cynes-emulator.pyi, cynes-wrapper.cpp,
  mesen2-CommandLineHelper.cs, nespy-tree.json (P0 research droppings —
  leave them; games/gamelist.md modification predates this session too).
