# FF1 reference materials — vendored 2026-08-12

Pinned local copies of the sources `PLAN.md` §6 cites, so every address in the
bridge traces to a file in-repo (the wire-format lineage discipline). These are
the AUTHORITY for `bridge/ramspec.py` and `data/charmap.json` — cite as
`reference/<file> :: <label>` in code comments.

| File | What | Source |
|---|---|---|
| `variables.inc` | Complete RAM symbol table (Disch's reassemblable US disassembly — "the closest thing to a RAM map that I have") | github.com/Entroper/FF1Disassembly @ master, fetched 2026-08-12 |
| `Constants.inc` | Class/ailment/battle-message/enemy-stat-layout constants | same |
| `table_standard.tbl` | Menu/name single-tile charmap ($80='0'…$89='9', $8A='A'…$A3='Z', $A4='a'…$BD='z', $D4-$E1 equip icons) | same |
| `table_dte.tbl` | Dialogue charmap: control codes <$1A, DTE pairs $1A-$69, singles $7A-$FF | same |
| `ff1_ram_map.txt` | Data Crystal RAM map snapshot (datacrystal.tcrf.net/wiki/Final_Fantasy/RAM_map, 2024-01-24 revision) | lynx dump 2026-08-12 |
| `ff1_rom_map.txt` | Data Crystal ROM map snapshot | lynx dump 2026-08-12 |
| `ff1_tasvideos.txt` | TASVideos GameResources/NES/FinalFantasy1 snapshot (RNG tables + formulas) | fetched 2026-08-12 |
| `bank_0C.asm` | Battle engine bank source — the battle MENU semantics authority (MenuSelection_2x4 edge-triggered input, SelectPlayerTarget/SelectEnemyTarget, BattleSubMenu_Magic index math, cmdbuf write sites). Vendored at Ph-B when the menu behavior had to be read, not guessed. | github.com/Entroper/FF1Disassembly @ master, fetched 2026-08-12 |

## Emulator-selection sources (P0 spike, fetched 2026-08-12)

The material behind `PLAN.md` §2's decision table — filed here 2026-08-14 (they
sat loose in the repo root until then). `cynes` won; the other two engines were
read and rejected, and their sources are kept so the comparison can be re-read
without re-fetching.

| File | What | Source |
|---|---|---|
| `cynes-emulator.pyi` | **The cynes Python API authority** — the exact surface `bridge/macros.py` drives: `NES(rom)`, `step(frames)` → `(240,256,3)` RGB, `nes[addr]` read/write across the full CPU bus (incl. cart SRAM `$6000-$7FFF`), `controller` bitmask, `save()`/`load()`, `reset()`, `has_crashed`. Cite as `reference/cynes-emulator.pyi :: <symbol>`. | github.com/Youlixx/cynes, MIT — fetched 2026-08-12 |
| `cynes-wrapper.cpp` | The pybind11 binding behind that stub: what `save()`/`load()` actually serialise and that `__getitem__`/`__setitem__` go through the bus rather than a RAM copy. | same |
| `mesen2-CommandLineHelper.cs` | Mesen 2's command-line entry handling, read while judging how headless it could be made. Mesen 2 is also the cross-check emulator PLAN.md §6 names for live-RAM confirmation and the `.sav` export target (§9). | github.com/SourMesen/Mesen2, **GPL-3.0** — fetched 2026-08-12 |
| `bizhawk-README.md` | BizHawk's project README — cores, features, and the shape of its scripting/CLI surface. | github.com/TASEmulators/BizHawk, MIT — fetched 2026-08-12 |
| `nespy-tree.json` | GitHub API tree listing (165 paths) for nes-py — a repo inventory, no source code. | github.com/Kautenja/nes-py, MIT — API fetch 2026-08-12 |

License note (emulator sources): each row above states its own upstream licence.
`mesen2-CommandLineHelper.cs` is the one **copyleft** item (GPL-3.0) — it is
vendored as unmodified reference text in a private repository, is not linked,
compiled, or distributed with anything here, and nothing in `bridge/` derives
from it. The cynes files are MIT; note that upstream's `.pyi` header carries a
stray `gnu.org/licenses` URL, but the package's own `LICENSE` is MIT (verified
against the installed wheel's `dist-info`). Only the runtime dependency, cynes,
is actually used — see `PLAN.md` §2.

License note (FF1 disassembly): the disassembly ships no LICENSE file; its readme states "This can
be used for whatever means you want" (Disch, informal permissive). What is
vendored here is **text only** — symbol tables, constants, charmaps, and one
bank of assembly source, each attributed above. **No ROM, no game assets, and
no assembled binary are in this repository** (`rom/` is gitignored); running the
bridge requires supplying your own dump. Where Data Crystal and the disassembly disagree (MP cur/max
order, vehicle addr), **the disassembly wins** — it reassembles to the exact US
ROM — but PLAN.md flags each conflict for a live-RAM sanity check anyway.

Other full bank sources (dialogue/RNG bank_0F, menus bank_0E, etc.) are NOT
vendored — clone github.com/Entroper/FF1Disassembly when needed. bank_0C IS
vendored (above) since Ph-B's executor cites it line-by-line.
