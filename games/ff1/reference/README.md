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

License note: the disassembly ships no LICENSE file; its readme states "This can
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
