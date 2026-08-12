# FF1 One-Shot Build — Fresh-Session Handoff

> **⏩ SESSION 2+ RESUME (2026-08-12): Ph-A (P1) is ~90 % done and 4/4 green
> on its harness — a prior session built the daemon/scraper/classifier/data
> layer and decoded the Coneria shop/menu/dialog flows. DO NOT restart Ph-A.**
> Read, in order: (1) this doc, (2) `PLAN.md` §12 **P0-R AND P1-R** (P1-R
> carries session 1's hard-won findings: settle K=12 fade rule, press-eating,
> condensed-vs-standard rendering, position masks, the decoded shop/menu
> flows), (3) **`BUILD_LOG.md` "Ph-A open items"** — the exact ordered
> resume point (first action: the `player_tile` sm mask fix). Journey
> savestates for the harness live in `bridge/spike_out/*.npy` (gitignored,
> on disk — see BUILD_LOG for what each contains). A `wip(ff1)` checkpoint
> commit holds session 1's tree; finish the open items, run the §6 gate,
> then commit the real `feat(ff1): Ph-A …` and continue to Ph-B (§5).

**You are building the FF1-on-G2 window, fully automated, end to end, in one
run.** Adam is at work and will not answer questions — every decision is
already made and recorded here or in `games/ff1/PLAN.md`. Do not wait for him,
do not ask, do not stop at the first blocker (see §9). He kicked this off with
something like: *"Read games/ff1/HANDOFF.md and build it."*

This doc is the mission order; **`PLAN.md` is the technical spec** (architecture,
protocol, RAM map, views, macros, phases). Where this doc and PLAN.md disagree,
this doc wins (it is newer and carries Adam's final answers).

---

## 1. Locked decisions (Adam, 2026-08-12 — do not re-litigate)

1. **Scope: everything in PLAN.md P1–P5 EXCEPT dictation/voice.** This project
   is **RING-INPUT-ONLY, permanently**: do not implement `onStt`, do not build
   the §8.5 intent grammar, do not wire any voice path into the FF1 window.
   Everything else ships: daemon, scraper, native battles, window, maps,
   step/grind macros, **undo everywhere (§8.4)**, `.sav` export, ring-driven
   name-entry macro, RAM-drawn dungeon minimap, formation-tile toggle
   (default off).
2. **Git: straight to `master`.** Commit at every phase gate (§7) and push
   after each phase commit. House commit style; end messages with
   `Co-Authored-By:` per the global rules.
3. **Reviews: light per phase, heavy final** (§6, §8). The final review is the
   big one — Adam's words: *"thoroughly finds and fixes all problems, making
   sure to verify each found issue before fixing it, to ensure it's a real
   issue and not like an agent misunderstanding."*
4. **Acceptance save: create Adam's next challenge party** at the very end via
   the production engine (§8.3): slots in this order — **Red Mage `ROUX`,
   White Mage `IRIS`, Black Mage `NOX`, Black Mage `ZOT`** — leave the party
   on the overworld with the game saved at Coneria's inn, savestate persisted,
   `.sav` exported. He plays it at work tomorrow.
5. Config defaults (already in PLAN): `showEnemyHp:false`, `rngJitter:true`,
   `undoDepth:30`. FF1 lives as a GamesWindow sub-controller (level `'ff1'`,
   code in its own `server/src/windows/ff1-controller.ts`), category Games.

## 2. Read before writing any code

In order:
1. `games/ff1/PLAN.md` — the whole spec, **especially §12 P0-R** (spike
   findings that override naive assumptions: ≥8-frame menu holds, 6-press name
   entry, A finishes party select, position-verified overworld steps,
   `$81==$68` is the in-battle flag, `$4B` is transient, never accept a
   uniform-color frame as settled).
2. `games/ff1/reference/README.md` + skim `variables.inc` — every RAM address
   in code carries a `reference/variables.inc :: <label>` lineage comment.
3. `docs/WINDOW_API.md` + `server/src/windows/types.ts` — the frozen window
   contract.
4. Exemplars (copy their shape, not just their ideas):
   - `server/src/stt.ts` (ParakeetDaemon class) — THE daemon-client pattern:
     queue/pump, `-u`, identity-gated respawn, reject-on-'close'.
   - `server/src/paperclips.ts` — process-lifetime engine singleton, Postgres
     save mirror, `registerMigration`, env override for smokes
     (`G2CC_PAPERCLIPS_DIR` precedent → use `G2CC_FF1_ROM` / `G2CC_FF1_*`).
   - `server/src/windows/games.ts` — `PaperclipsController` (verb menus,
     levels, Cancel-first confirm) and `BlackjackController` (two-tile
     re-push-on-change, `loadOk` persist clobber-guard, persistChain).
   - `server/smoke/phase-paperclips.mjs` + `smoke/_env.mjs` — smoke shape.
5. `games/ff1/bridge/spike_p0.py` + `spike_p0b.py` — working cynes code:
   press timings, settle, position-verified steps, battle detection. Reuse
   freely; the checkpoints in `bridge/spike_out/` (`ckpt_overworld.npy`,
   `ckpt_battle.npy`, `state.npy`) are ready-made harness fixtures.

House rules apply in full: Three Absolute Rules (no timeouts / no silent
failures / no truncation), forbidden patterns, verify-before-execute (read the
actual API/file before calling it), Gentoo box (no apt/systemctl; venvs only).

## 3. Environment facts (verified 2026-08-12)

- ROM: `games/ff1/rom/Final Fantasy.nes` (gitignored; MMC1+battery verified).
- Python: `games/ff1/venv/` exists with `cynes numpy pillow` installed —
  `./venv/bin/python` from `games/ff1/`.
- Build/verify commands (from package.json, confirmed):
  - `npm run typecheck` (root, workspaces) — must be clean at every gate.
  - `npm run build` — server is `tsc -p tsconfig.json`.
  - `node server/smoke/run-all.mjs` — the regression suite. **Run it FIRST,
    before any changes, and record the baseline in BUILD_LOG** (music-era
    memory says ~36/37 with one known env red — verify what today's actual
    baseline is; a pre-existing red is not yours, a NEW red is).
  - Smokes are hermetic-ish: read `smoke/_env.mjs`; clear `os_state` where the
    existing phases do; never touch real tmux/phone/BLE.
- Postgres 17 on localhost, Unix-socket trust as the server user; migrations
  via `registerMigration` in `store.ts` (date-prefixed names).
- **No Android/APK work exists in this project** — the FF1 window is entirely
  server-side. If you ever conclude an APK change is needed, that conclusion
  is wrong; stop and re-read PLAN §7 (text views + existing image modes only).
  Never touch BLE, never ping the phone from tests.
- `eix` cache on this box is stale — check `/var/db/repos/gentoo/` directly if
  you ever need portage facts (you shouldn't).

## 4. Deliverable map (what exists when you're done)

```
games/ff1/bridge/ff1_daemon.py     JSON-lines stdio daemon hosting cynes
games/ff1/bridge/scrape.py         framebuffer 8x8 tile-matcher -> text
games/ff1/bridge/screens.py        screen classifier (title/menu/map/battle/dialog/shop)
games/ff1/bridge/macros.py         verified press / steps / pace / grind / name-entry
games/ff1/bridge/ramspec.py        every address, lineage-commented
games/ff1/bridge/harness/*.py      offline end-to-end tests (fixtures = spike ckpts)
games/ff1/data/charmap.json        generated from reference/*.tbl (lineage header)
games/ff1/data/items.json          id->name/category/price (ROM tables, PLAN §7.3)
games/ff1/data/spells.json         spell names/levels
games/ff1/data/enemies.json        id->name/stats (ROM 0C:$8520 + names 0B:$94E0)
server/src/ff1/bridge.ts           daemon client (stt.ts pattern)
server/src/ff1/engine.ts           game API: snapshot/actions/macros/undo ring
server/src/ff1/types.ts
server/src/windows/ff1-controller.ts   the window sub-controller
server/src/windows/games.ts        MINIMAL delta: level 'ff1' + delegation + games-list row
server/smoke/phase-ff1.mjs         registered in run-all
games/ff1/BUILD_LOG.md             your running journal (§10)
```
DB: `ff1_save` table (latest savestate + snapshot jsonb + undo-tail + labeled
slots). Config keys under `games.ff1.*` following `config.ts` patterns.

## 5. Build order (phases, each ends with §6 gate + §7 commit)

**Ph-A (= PLAN P1): daemon + scraper + classifier.**
Daemon protocol per PLAN §4 (+ `undo_list`/`undo` ops per §8.4). Tile-scrape +
charmap/glyph calibration (learn glyph hashes from known screens — main menu
"CONTINUE"/"NEW GAME", shop headers; round-trip test). Screen classifier v1.
Generate the four `data/*.json` from ROM/reference with lineage headers.
Resolve the P0 leftovers: MP cur/max (spend a charge — buy CURE for IRIS-class
test party or use any mage; record answer in PLAN §6 as VERIFIED), exp byte
order (gain exp in one scripted battle, read bytes). `.sav` structural export.
*Exit: harness scrapes exact text from menu/dialog/shop screens; classifier
correct on all spike checkpoints; daemon survives kill→respawn→restore.*

**Ph-B (= P2): battle vertical slice, off-glass.**
Native command-entry model (party/charges/targets from RAM), verified
injection against `btlcmd_curchar`/`btlcurs`/`btl_charcmdbuf`, resolution
scrape → battle log, `btl_result` end detection, undo checkpoints per round.
Desync drill: deliberately corrupt a press; assert LOUD halt + recovery.
*Exit: scripted full battle (the 5-IMP fixture) plays end-to-end with
byte-exact log; won AND fled variants.*

**Ph-C (= P3): window integration.**
`Ff1Controller` (games.ts delegates), views per PLAN §7 (battle, menus,
dialog), preview/summary/statusLine, PG persistence + clobber-guard +
persistChain, watchdog respawn, **Undo verb in every view** with the
checkpoint list UI (Cancel-first). Smoke `phase-ff1.mjs`.
*Off-glass exit (on-glass items go to §11 checklist): scene-level verification
via the sim tooling / scene renders (docs/SIM_TOOLING.md) — compose the battle
and menu scenes and check the PNGs yourself; run-all green at baseline+1.*

**Ph-D (= P4): maps.**
Two stacked 256×112 tiles at 1:1 (PNG from daemon → existing gray4 tile
machinery — read `os-content.ts` for the real function names before wiring),
per-tile change detection, step verbs + ×N cycle, position-verified steps,
battle/dialog interrupt flips, Peek, all-black guard (black→gray-1).
*Exit: scripted walk Coneria→shop→overworld→encounter→battle→win→map, with
tile pushes only at macro boundaries (assert push counts in harness).*

**Ph-E (= P5, minus dictation): macros + polish.**
`Battle` pace macro, `fight-until` grind loops (stop conditions from RAM),
ring-driven name-entry macro (6-press protocol), `.sav` export verb +
labeled save Slots UI, RAM-drawn dungeon minimap (small tile, explored-layout
only, re-push on growth), formation-tile toggle (default OFF), undo-tail PG
mirror. *Exit: each feature harness-proven; run-all green.*

**Ph-F: the finale (§8): final deep review, then the acceptance gauntlet +
Adam's save.**

## 6. Per-phase light review gate (fast, every phase)

1. Re-read your whole phase diff cold (`git diff` top to bottom).
2. Grep-audit the new code for the forbidden patterns: `except:.*pass` /
   swallowed catch, `withTimeout|timeout=|wait_for`, any string truncation of
   game text, BLE/phone touches, missing lineage comments on RAM addresses.
3. Three-Rules scan: every failure path renders/logs LOUD; every wait is
   frame-budgeted with a surfaced overrun; nothing clips.
4. `npm run typecheck` + `node server/smoke/run-all.mjs` + the ff1 harness —
   all green (baseline deltas explained in BUILD_LOG).
5. Fix what you found, then §7 commit. Keep this gate under ~15 minutes of
   effort — the deep scrutiny is Ph-F's job.

## 7. Commit protocol (straight to master, per Adam)

- One commit per phase minimum (more if a phase has natural checkpoints), on
  `master`, pushed immediately after each phase gate passes.
- Message style matches repo history: `feat(ff1): ...` / `fix(ff1): ...` /
  `test(ff1): ...`, imperative, with the phase tag in the body, ending with
  the house `Co-Authored-By` line.
- Never commit: `rom/`, `venv/`, `saves/`, `bridge/spike_out/` (gitignored),
  or any secrets. `data/*.json` ARE committed (generated text with lineage).
- If run-all shows a NEW red at commit time, the phase is not done — fix
  first. Pre-existing baseline reds (recorded in BUILD_LOG at start) don't
  block.

## 8. Ph-F — the final deep review + acceptance (the part Adam cares most about)

### 8.1 Deep review protocol
1. **Cold re-read of every ff1 file** (bridge py, data generators, server ts,
   controller, smokes, harness) — full files, not diffs.
2. Run `/code-review` at **max** effort over the whole feature (all ff1 paths +
   the games.ts delta). 
3. **Verify-before-fix, every single finding** (Adam's explicit requirement):
   a finding may only be fixed after you CONFIRM it is real by reproducing it —
   a failing harness/smoke test, a concrete traced failure scenario with the
   actual code paths, or a live daemon repro. If you cannot confirm it, it is
   NOT fixed; record it in BUILD_LOG under "rejected findings" with the
   reason (e.g. "reviewer misread the persist guard — load gates it"). This
   is the guard against agent-misunderstanding fixes.
4. Fix confirmed findings; after each batch re-run typecheck + run-all +
   harness. 
5. Loop: re-run `/code-review` max after fixes. Stop when a pass produces
   zero new CONFIRMED findings (cap: 3 loops; if loop 3 still finds real
   bugs, keep fixing but note the churn in BUILD_LOG).
6. Full final regression: typecheck, build, run-all, complete harness suite.

### 8.2 Commit + push the reviewed state
`feat(ff1): final review pass — <n> confirmed findings fixed, <m> rejected`.

### 8.3 Acceptance gauntlet (production engine, no shortcuts)
Scripted through the REAL daemon+engine (not spike code):
1. Fresh boot → New Game → **party RM/WM/BM/BM named `ROUX`/`IRIS`/`NOX`/`ZOT`**
   via the ring name-entry macro path.
2. Walk to a battle (pace macro), fight one full round through the native
   command path, finish the battle.
3. Undo drill: rewind to the pre-battle checkpoint, verify state, re-fight.
4. Enter Coneria, buy CURE for IRIS (also finally disambiguating cur/max MP —
   update PLAN §6 VERIFIED marks), inn-sleep to create the in-game save.
5. Export `.sav` to `games/ff1/saves/`, persist savestate + undo tail to PG.
6. Leave the party ON THE OVERWORLD outside Coneria, saved, ready to play.
7. Screenshot every stage (emulator PNGs + composed scene PNGs) into
   `bridge/spike_out/acceptance/` and index them in BUILD_LOG.
Final commit: `feat(ff1): acceptance — ROUX/IRIS/NOX/ZOT ready on the overworld`.

## 9. Failure policy (automated run, nobody to ask)

- LOUD always. Never fake a green, never skip a failing test silently, never
  paper over with a timeout or a swallow.
- Emulator misbehaves (accuracy bug, savestate flake): first re-test against
  the spike checkpoints; if cynes is truly at fault, invoke PLAN §2's fallback
  ladder **autonomously** (MesenCE bridge is the designed fallback) and record
  the pivot in BUILD_LOG.
- A phase exit criterion truly unreachable: write a BLOCKED entry in BUILD_LOG
  (what, why, what was tried, exact repro), commit what is solid and green,
  continue with any independent later work, and leave the blocker at the top
  of the final report. Do not spiral; do not delete working code to "unblock".
- On ANY surprising result: the Ten Explanations rule from the global
  CLAUDE.md applies — enumerate before concluding (the P0 "pacing bug" that
  was really non-committing steps is the cautionary tale).

## 10. BUILD_LOG.md (your journal — Adam reads this in the evening)

Append per phase: what was built, decisions made (with reasons), test/suite
results (numbers), review findings fixed vs rejected (with verification
notes), commit hashes. Start it by recording the pre-build run-all baseline.
If the session's context gets compacted mid-run: re-read this handoff,
PLAN.md, and the BUILD_LOG tail — those three files must always be enough to
resume. Keep them current.

## 11. Adam's evening on-glass checklist (append to BUILD_LOG at the end)

The run cannot touch the glasses. Leave Adam a checklist that includes at
least: battle view + round on glass (text speed), shop/dialog scrape views,
undo drill from the ring ("whoops-tap" recovery), map two-tile push + REAL
latency measurements (record them in PLAN §7.2), Peek, minimap, ribbon
preview + games-list row, and a pointer to the acceptance screenshots. Plus
anything you deferred.

## 12. Out of scope / don'ts (hard lines)

- No voice/dictation anywhere in FF1 (ring-only, permanent).
- No Android/APK/BLE/phone changes or tests. No on-glass claims.
- No edits to unrelated windows/subsystems beyond the minimal games.ts
  delegation + registry/config/store touchpoints the plan names.
- No gameplay-altering "fixes": the ROM is the rules authority (Ineffective
  stays; enemy HP stays hidden by default; RNG jitter stays on).
- No re-architecting: text-first battles, two-tile 1:1 maps, cynes, the
  sub-controller shape, and the §4 protocol are settled.
- ROM and saves never enter git.
