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
2. ~~**Menu-glyph calibration stage**~~ **DONE session 2**: calibrate_glyphs.py
   gained a self-locating menu stage — unknowns classified by known-neighbor
   context (`dd�<sp>d` → the HP `/`; `<blank>�<sp>1` → the level `L`, where
   blank includes learned chrome — the panel border sits left of the L).
   glyphs.json 77 → **79 patterns**; round-trip "35/ 35" + "L 1" green.
   Bonus: the magic page now scrapes fully (`L1 2/2 · CURE`, L2-L8 charge
   rows) — those rows became the magic-page classifier anchor (below).
3. ~~**screens.py `_menuish`**~~ **DONE session 2**, plus a REAL classifier bug
   found while verifying: the dialog/shop branch ran BEFORE the menu check,
   and the game menu has name/HP text in the dialog rows + a gold line
   containing 'G' — `fix_menu.npy` classified **'shop'** and
   `fix_magicpage.npy` 'dialog' (verified live pre-fix). Fix: `_menuish`
   FIRST (trio ITEM+MAGIC+ARMOR ≥2-of-3, per this item), plus an L1..L8
   charge-table anchor (≥4 rows) so the per-char MAGIC page classifies
   'gamemenu' too. All five journey states verify: menu/magicpage →
   gamemenu, dialog → dialog, shop_open → shop, j_town → sm. Harness 4/4.
4. ~~**Committed fixtures**~~ **DONE session 2**: `gen_fixtures.py` replays the
   whole journey live from `ckpt_overworld.npy` and writes **9 fixtures**
   (town_entry, shop_open, shop_bought, town_after_shop, menu_open,
   magic_page, after_cast, dialog_open, battle_start; 21.9 KB each, 220 KB
   total, committed). The town route is NOT hand-coded: a savestate BFS
   probes steps outward (271 tiles mapped, ~1k probes) until the (7,4) door
   opens the white-magic shop — regeneration survives layout/NPC drift.
   NOT a run_all stage (it re-walks everything); run manually on flow change.
   New findings baked into it (each probed live, PNGs in scratch):
   - **$63 (cursor_max) goes STALE on the MAGIC char panel** (stays 5); the
     panel-open signal is the $62 cursor RESET 1→0. Down=+2/Right=+1 confirmed.
   - **Menu cast ends in an any-key HP-result strip** — condensed small-font
     box, scrapes NOTHING, misreads as 'sm' (it sits below the dialog
     region). Dismiss (B) before trusting classify; fixture saves the clean
     magic page after dismissal.
   - **Battle-stop fires the frame the encounter triggers; the roster box
     draws later** — battle_start waits for the roster to scrape (settles
     can catch a static pre-draw moment).
   - **Encounter-free terrain around Coneria**: battlestep ($F5) ticks only
     on encounter-capable tiles — (153,165)-(153,169) NEVER tick; first
     ticking tile (153,170). Recorded in PLAN §6.2 (pace-macro impact).
     Encounter fired after 29 paces on the ticking tile: 5 IMPs again.
5. ~~**test_journey.py**~~ **DONE session 2**: 30 checks green against the
   committed fixtures — classifier verdicts at every stage, exact text
   ("Nothing here.", "35/ 35", "L 1", "3OO G", "L1 2/2", 1OO/Gold/OK?
   with the O/0 fold), LIVE purchase replay (cursor path, spell rows
   CURE/HARM/FOG/RUSE, gold 400→300, ch_spells write) and LIVE cast replay
   ($6320 drop 2→1, $6328 untouched), battle roster + enemies.json names.
   run_all auto-discovered it → **harness now 5/5**.
6. ~~**Light review gate**~~ **DONE session 2**: forbidden-pattern greps clean
   (no swallowed excepts, no timeouts; every wait frame-budgeted + LOUD);
   typecheck clean; server smoke 36/37 (the known env calendar red only);
   ff1 harness 5/5. gamelist.md FF1 entry (predates session 1) rides this
   commit with its wording aligned ("verified command entry").

## Ph-B (= PLAN P2) — battle vertical slice

**Session 2 (2026-08-12, continued): Ph-B ~85% BUILT, 13/29-ish harness checks
green, ONE KNOWN FIX PENDING. Work is committed as a `wip(ff1)` checkpoint
(run_all shows test_battle red until the fix — expected, documented here).
SESSION 3 STARTS AT "Ph-B resume point" below.**

### Built this session (code map)

- `bridge/battle.py` — `BattleExecutor`: verified command entry (fight /
  magic / run) + resolution runner + outro. Read its docstring FIRST — it
  encodes the battle-menu input discipline (4-frame holds, edge-triggered
  menus, transition-verified presses) and the full menu model with
  `reference/bank_0C.asm` lineage. `drop_presses` is the desync-drill hook.
- `bridge/ff1_daemon.py` — new op `battle_round` (auto-checkpoints
  `battle round (formation)`, runs executor, response carries
  `battleRound: {log, result, outcome, frames}`); loads spells.json.
- `bridge/harness/test_battle.py` — the P2 exit harness: fight×4 byte-exact,
  fight-until-WON (+ exp/gold asserts), CURE one-ally round, fled variant,
  desync drill, daemon stdio integration. run_all auto-discovers it.
- `reference/bank_0C.asm` — vendored battle-bank source (README updated).
  PLAN §12 **P2-R** carries every finding with detail; §6.3 exp byte order
  is CLOSED (little-endian, `[7,0,0]` per survivor after the 5-IMP win).

### Session 3 (2026-08-12, resumed): Ph-B COMPLETE — 30/30 checks, 6/6 harness

The prescribed resume-point fix (2-frame hold, unchanged cond) did NOT pass:
with the shorter hold the wait-cond `curs()[0] == 16` never fired at all.
Frame-by-frame probe + reading the vendored `reference/bank_0C.asm` gave the
real model (PLAN §12 P2-R now carries the session-3 CORRECTION):

- Session 2's "(16,0) = picker live" was post-confirm resolution SCRATCH —
  the cond only ever fired on the failure (auto-confirm) case. A live ally
  picker is `MenuSelection_2x4`, which zeroes btlcurs to (0,0) at entry —
  indistinguishable from the spell menu's home position.
- Correct picker-open signature: the cursor SPRITE `btlcursspr_x/y` ($6AE3/4,
  new in ramspec with lineage), rewritten every menu-loop iteration from
  per-menu pixel luts occupying disjoint screen areas. Stale after exit, so
  battle.py pairs "sprite reached picker area" with the cmdbuf double-consume
  guard `_assert_picker_live` (row freshly written vs pre-press capture ⇒
  desync; compared against the captured row because cmdbuf persists across
  rounds — a stale `40 …` from a previous round must not trip it).
- Auto-confirm root cause refined: the menus' input-delay REPEAT re-fires a
  held A after ~3-5 unchanged samples (~6-10 frames) — PICKER_HOLD=2 cannot
  reach it; 4 f holds stay for every other battle press. Fight→enemy-picker A
  also moved to PICKER_HOLD + guard (was passing by luck of prep length).
- cmdbuf write timing asm-confirmed: ONLY at picker confirm
  (`SetCharacterBattleCommand`) — never at spell select — so the guard and
  the byte-exact post-entry check are both sound.

Results: test_battle.py ALL 30 checks green — CURE round byte-exact
(`40 00 82 00`, MP 1→0, log mentions CURE), fled variant (outcome 'ran',
overworld classify), desync drill (dropped `char 0 fight confirm` raises
BattleDesync, cmdbuf row 0 untouched, pre-round savestate recovers, clean
re-entry), daemon battle_round + auto-checkpoint + undo through real stdio.
run_all **6/6**. Light gate: typecheck clean; server smoke 36/37 (known
calendar env red only); forbidden-pattern grep clean (`visible[:112]` is the
frame-crop parameter, not text truncation).

### Ph-B resume point (superseded — kept for the record; SESSION 3 landed it)

test_battle.py fails at check 14: `char 3 ally cycle: no effect` — the CURE
ally-picker Down presses land nowhere. ROOT CAUSE (established by probes, do
NOT re-derive): the spell-select A uses the standard 4-frame hold, and the
one-ally picker opens FAST enough that the held A gets re-sampled by the
picker as a fresh edge → instant auto-confirm at default target (slot 0,
byte 0x80). After that the game is resolving, so the cycle presses are dead.
`curs == (16,0)` reads identically in both states — the RELIABLE
disambiguator is the cmdbuf row: **unwritten ⇒ picker live; already
`40 xx 8x 00` ⇒ double-consumed** (a 2-frame A + Down was PROVEN to open the
picker live and move `btlcurs_y` 0→1 in the session probes).

1. In `battle.py` `_enter_spell_target` (one-ally AND one-enemy spell paths):
   give the spell-select A a **2-frame hold** (add a `hold=` param to
   `_bpress`/`bpress_verified`; default stays 4), and after the picker-open
   cond fires assert `self.cmdbuf(ch)[0] != 0x40` — if the row is already
   written, raise BattleDesync (the pre-round checkpoint recovers; do not
   try to un-enter). Consider the same 2-frame hold for the fight→enemy-
   picker A (it has the same shape; it happens to pass today because
   SelectEnemyTarget preps longer — do not rely on that).
2. Re-run `./venv/bin/python bridge/harness/test_battle.py` — expect the CURE
   round green (`rows[3] == (0x40, 0x00, 0x82, 0x00)`, MP 1→0, log mentions
   CURE), then the UNRUN sections: fled variant (all-run rounds until
   `outcome == 'ran'`), desync drill (dropped `char 0 fight confirm` must
   raise BattleDesync with cmdbuf row 0 untouched, pre-round savestate
   recovers, clean re-entry), daemon integration (battle_round op + undo).
   Iterate LOUDLY on whatever they surface — they have never executed.
3. `./venv/bin/python bridge/harness/run_all.py` → expect **6/6**.
4. §6 light gate (typecheck + server run-all 36/37 baseline + forbidden-
   pattern grep over the Ph-B diff), then commit
   `feat(ff1): Ph-B — battle vertical slice` + push, then Ph-C (HANDOFF §5).

## Ph-C (= PLAN P3) — window integration

**Session 3 (2026-08-12, continued): Ph-C COMPLETE (off-glass exit).**

Built:
- `server/src/ff1/types.ts` — protocol/snapshot types, field-verified against
  the daemon's snapshot() builder + screens.py SCREENS tuple.
- `server/src/ff1/bridge.ts` — `Ff1Bridge`, the stt.ts pattern verbatim:
  single-inflight queue/pump, identity-gated respawn, reject-on-'close',
  16 MB runaway backstop, seq-checked JSON-lines, daemon stderr forwarded
  as `[ff1]` lines. `Ff1OpError` distinguishes in-protocol failures (desync,
  budget) from daemon death.
- `server/src/ff1/engine.ts` — process-lifetime singleton (paperclips
  lifecycle): single-flight boot restoring the PG savestate (restore-throws-
  on-DB-down, C-F1), serialized opChain + persistChain, the blackjack loadOk
  clobber-guard, autosave after every advancing op (savestate + snapshot +
  §8.4 undo TAIL ×5 → `ff1_save` row 'latest'), WATCHDOG: daemon death →
  LOUD notice + lazy respawn restoring the in-memory savestate. New daemon op
  `undo_state` (read a checkpoint without loading it) feeds the tail mirror.
- `server/src/windows/ff1-controller.ts` — screen-adaptive root (classifier
  verdict → view+verbs): battle entry per §7.1 (native menus: Fight/Magic/
  Drink/Item/Run/RunAll per living char, spell list with live charges from
  RAM, target picks, Cancel-first Go), one `battle_round` op → paginated
  full-history log; dialog/shop/gamemenu/title cursor mode; ow/sm text
  placeholder (tiles land Ph-D); **Undo standing verb in every view**
  (checkpoint browse → Cancel-first confirm). Drink/Item refuse LOUDLY
  (Ph-E inventory fixtures).
- `server/src/windows/games.ts` — minimal delta: level 'ff1', 5th games-list
  row, delegation in the same spots as pc/bj.
- `server/src/config.ts` — `games.ff1.{showEnemyHp,rngJitter,undoDepth}`
  defaults + merge-list entry (the known lost-overrides gotcha).
- `server/smoke/phase-ff1.mjs` — 7 stages through the REAL WM: list row →
  daemon boot → fixture battle → Fight×4 native entry → Go → real round +
  log → Undo drill (restores 5×8 HP) → PG mirror row (21,773 B state +
  snapshot + tail) → watchdog drill (`debugKillDaemon` → notice → respawn →
  battle restored). Menu-width + frame-byte guards on every scene.

Results: typecheck + build clean; **server run-all 37/38** (baseline+1; the
one red stays the known calendar env red) — phase-blackjack's stale
"4 games listed" assert updated to 5 (the FF1 row is a legitimate list
change, not a regression). ff1 harness still 6/6. Scene verification
(scripts/scene_to_png.py over captured WireScenes): battle-entry twocol
(formation left / `>`-marked party pane + charge line right), magic list,
ally target, Go confirm, paginated log, undo list — all render correctly,
client-rule check OK on all 7 (regions/text/list/image caps).

Notes for later phases: fresh ROM boot classifies 'dialog' (the prologue
crawl) — correct, it IS a text screen; round 1 on the 5-IMP fixture kills
1 IMP deterministically (rngJitter false), so asserts on "5 alive" only
hold at round START (the smoke's undo assert).

## Ph-D (= PLAN P4) — maps

**Session 3 (2026-08-12, continued): Ph-D COMPLETE (off-glass exit).**

Built:
- **Geometry decision:** PLAN's two 256×112 tiles can't exist — the DE content
  pane is 222 px tall (2×112=224) and `encodeGray4Single` requires EVEN BMP
  heights (111+111 illegal). Shipped **256×110 + 256×112** (9 px overscan trim
  per side, 222 rows exactly). PLAN §7.2 updated with the lineage.
- Daemon `op_frame` grew crops `map-top`/`map-bottom` + `format:'gray4'` —
  ITU-601 luma → 4-bit, emitted as the exact `encodeGray4Single` payload
  (u16 w/h + pixel bytes), so the server-side conversion IS the existing
  tile machinery (all-black guard + 288×129 caps included). PNG crops stay
  for diagnostics. test_daemon +3 checks (27 total).
- os-compose: new mode `'maptiles'` (top=t0 @ FF1_MAP_TOP_RECT, bottom=t2 @
  FF1_MAP_BOTTOM_RECT — the hands-mode independent-region discipline), in
  BOTH compose paths (menu shell + fullBleed/ribbon placeImageRegions).
- Engine `frameGray4(crop)` (read-only op — no checkpoint, no persist).
- Controller: `syncMapTiles()` runs at **op completions only** (the §7.2
  one-push-per-macro policy — we own the clock); per-tile raw-payload change
  keys re-encode/re-push ONLY changed tiles; seq-guarded; `Peek` = forced
  refresh; LOUD text fallback on fetch failure. Map view = maptiles mode
  with verbs ↑↓←→ ×N A B Menu Peek Undo Main. Interrupts win for free:
  battle/dialog screens aren't maps, so no fetch happens mid-flow.
  Bonus fix: battle entry state now keys on battlecounter ($F7) so a stale
  half-collected entry from an abandoned battle can't leak into a new one.

phase-ff1.mjs stages 8-10 (the P4 exit criterion): town fixture → both tiles
push ONCE (256×110/256×112 asserted); ONE steps-×2 macro → exactly ONE more
push at the boundary (not per step); battle fixture → ZERO map pushes through
a full engine-driven 4-round WIN; post-outro Reload → exactly one overworld
push. Scene PNG (scene_to_png over the captured WireScene): Coneria renders
1:1, seamless tile join, client-rule check OK.

Results: typecheck/build clean; ff1 harness 6/6 (133 checks total); server
run-all **37/38** (the known calendar env red only).

On-glass items deferred to the §11 checklist: real push-latency measurements
(PLAN §7.2 records them), gray-ramp legibility (the >>4 luma mapping), Peek
feel.

## Ph-E (= PLAN P5, minus dictation) — macros + polish

**Session 3 (2026-08-12, continued): Ph-E COMPLETE.**

Built (python side; every finding live-probed, PLAN updated where reality won):
- **Name entry (`macros.name_entry`)**: the P0-R 6-press protocol confirmed =
  open + 4 letters + CONFIRM. New probed facts: ptygen_name fills PER
  KEYSTROKE ($FF-initialized at grid open); the preview box (rows 3-6, cols
  12-18) counts letters; the CONFIRM press closes the box (verified by the
  preview emptying). **The blank grid cell (2,9) is DEAD** (the JP END key
  the US release removed) → **the vanilla grid types EXACTLY 4 glyphs — no
  spaces, no early end**. Short names (Adam's NOX/ZOT) are UNREACHABLE by
  input; shipped the documented cosmetic bridge: daemon op `rename` writes
  ch_name directly (grid glyphs only, $FF-padded — the byte the game itself
  renders blank). Names have zero gameplay effect; auto-checkpoints first.
  ALSO CAUGHT: my duplicate PTYGEN constants shadowed the pre-existing
  absolute-address block in ramspec (PTYGEN_NAME is $0302 absolute, not an
  offset) — the phantom "ptygen reads 00" chase; duplicate removed.
- **Pace (`macros.pace`)**: alternate one step out/back (left/right, falling
  back through pairs on walls) until battle/mapchange/blocked/cap; reports
  paces + battlestep delta so a non-ticking spot is VISIBLE ("battlestep
  NEVER TICKED" surfaces in the window). NPC-blocked town pacing stops LOUD
  (observed live — Coneria NPCs wander into the lane).
- **fight-until (`BattleExecutor.fight_until`)**: repeat commands per round;
  RAM-read stops (any-ally-HP<pct BEFORE each round, charges-out for magic
  commands, 30-round cap) + battle end. Fight targets re-resolve to the
  weakest LIVING enemy at entry (the game's picker only offers living slots
  — entry-time behavior, not a resolution retarget). Battle-log hygiene while
  here (`_log_push`): the round-end command-menu redraw bleeding into the
  combat box as condensed-font junk is dropped, and incremental box draws
  collapse to the completed line (prefix-replace) — logs read clean now.
- **.sav export (`op_sav_export`)**: writes games/ff1/saves/ff1-<stamp>.sav;
  REFUSES loudly without the SRAM save asserts ($55/$AA) or mid-battle.
- **Minimap v1 (`op_minimap`)**: breadcrumb trail per (mapType,mapId),
  recorded at op-endpoint snapshots (≤8 tiles apart), session-lifetime,
  advisory-by-design. Server renders a 200×100 'tile' (2 px/map-tile window
  ±50/±25 around the player; trail gray-6, player white).
- **Formation glance (`frame` crop 'formation')**: the battle tableau at 1:1
  (200×100, x[4:204] y[24:124]) behind `games.ff1.formationTile` (default
  OFF) — one small tile at battle start, Enter proceeds.

Server (engine ops + controller): nameEntry/rename/pace/battleAuto/savExport/
minimap/saveSlot/listSlots/loadSlot; map verbs grew Battle (pace) + Sys +
Mini (sm); battle entry grew Auto (Cancel-first fight-until confirm, repeats
the last round, stops at 25 % HP); nameentry screen grew Name (the _kbd ring
keyboard → the macro; 4-glyph rule enforced with the rename hint); Sys level
= SaveSlot / Slots (Cancel-first load, pre-load checkpoint) / Export.

Tests: `test_macros.py` (24 checks — ROUX typed end-to-end + ptygen bytes,
4-glyph refusal, town pace battlestep-frozen, REAL overworld encounter after
28 paces, hp-guard stop, grind-to-WIN, sav refusal, rename NOX, trail op,
daemon pace + auto-checkpoint) → **ff1 harness 7/7**. phase-ff1 stages 11-12
(fight-until through the WM + Sys/Slots round-trip) → **run-all 37/38**
(known calendar red). Typecheck/build clean; forbidden-pattern grep clean.

### Ph-B deferrals (intentional, don't chase)

- DRINK/ITEM entry paths: raise loudly; need a potion-holding fixture (buy
  HEAL at the Coneria item shop (27,10) with the existing shop machinery —
  natural Ph-E work when grind loops land).
- Magic pages L5-8 (Down-at-row-3 page flip): deferred until a leveled
  fixture exists; `battle.py` raises loudly on level > 4.
- `probe_layout.py` grew no battle regions — REGION_BTL_* in screens.py
  were probed in session 1 and reconfirmed live this session.

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
