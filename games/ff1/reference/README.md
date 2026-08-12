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

License note: the disassembly ships no LICENSE file; its readme states "This can
be used for whatever means you want" (Disch, informal permissive). Private-repo
reference use. Where Data Crystal and the disassembly disagree (MP cur/max
order, vehicle addr), **the disassembly wins** — it reassembles to the exact US
ROM — but PLAN.md flags each conflict for a live-RAM sanity check anyway.

Full bank sources (battle engine bank_0C, dialogue/RNG bank_0F, etc.) are NOT
vendored — clone github.com/Entroper/FF1Disassembly when needed.
