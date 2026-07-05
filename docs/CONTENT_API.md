# DE Content API — how AIs (and anything else) draw on the glasses

**The model describes SEMANTIC content; the Display Renderer owns every pixel.** This is the
contract that makes LLM display output hard to get wrong (docs/GLASSES_OS.md "LLM content
API"; layout/geometry in docs/DE_DESIGN.md). Any text that flows through the content
pipeline — CC responses, Aria replies, future apps — is parsed and typeset the same way.

## Pipeline

```
LLM markdown ──parseMarkdown()──► Block[] ──blocksToText()──► paginateText() ──► firmware-text pages

> **2026-06-11 — session content is FIRMWARE TEXT now.** The tile pipeline below was
> NIXED for CC/Aria responses (hardware: menu rebuilds re-pushed all four tiles, taps
> took 15-20 s). Tiles remain ONLY for page-≥2-class imagery: the Files image viewer
> (render_image.py), ` ```chart ` pages (render_chart.py, upgrades Phase 8), and the
> chess board (render_board.py, Phase 11) — all through the shared `splitGray4Tiles()`
> (tiles ≤240×111). Main's logo tile retired with the Phase-5 dashboard
> (renderSingleTile is parked, no producers). The legacy description below is kept for
> the roadmap's rich-tile revisit:

LLM markdown ──parseMarkdown()──► Block[] ──render_content.py──► 480×212 gray4 pages [LEGACY]
 (os-content.ts)                            (PIL + DejaVu)         │ sliced 2×2
                                                                   ▼
                                                    4× 240×106 BMP tiles per page
                                                    (paged on-glass via Next/Prev)
```

- **Pagination, never truncation**: oversized content flows to more pages; blocks split at
  line granularity. The title bar shows `· page/pages`.
- Every page is framed with a hairline so no tile is ever all-black (hardware kill).
- Rendering is cached by content hash — paging back/forward re-sends only tiles.

## The markdown subset (v1)

| Construct | Renders as |
|---|---|
| `# Heading` (any level) | 16px bold white + divider rule |
| paragraph | 14px light-gray prose, word-wrapped |
| `- item` / `* item` | bullet list |
| ```` ```lang ```` fenced block | bordered monospace panel (13px) |
| ```` ```stat ```` fenced block | **big-number stat cards** (see below) |
| ```` ```chart ```` fenced block | **matplotlib image page, strictly page ≥2** (see below) |
| `---` | horizontal rule |
| `\|a\|b\|` table rows | aligned monospace lines (proper grid later) |
| inline `**b**` / `*i*` / `` `c` `` / `[t](url)` | flattened to plain text (v1) |

### Stat cards

````
```stat
[{"value":"54°F","label":"garage"},{"value":"1.2 kW","label":"load"},{"value":"2","label":"alerts"}]
```
````

→ up to 3 cards, 21px bold value + 12px label, bordered tiles. Malformed JSON renders as a
visible error code-panel (loud, never dropped).

### Charts (upgrades Phase 8 — LIVE)

````
```chart
{"type": "line", "title": "CPU %", "x": [0,1,2,3], "series": [{"label": "cpu", "y": [10,40,35,80]}]}
```
````

Types `line`/`bar`/`scatter`; keys `title`/`xlabel`/`ylabel`/`x`/`series` (shorthand:
top-level `y`). A `y` value may be `null` — it renders as a GAP (null → NaN; matplotlib
breaks the line there). Review 2026-07-05: the Stats charts use this for sampler outages —
a gap is honest, a fabricated 0-dip reads as "GPU died" on a 1–2 s glance. Rendered by
`scripts/render_chart.py` (matplotlib Agg, white-on-black,
thick lines) into the render_image gray4 contract → 2×2 tiles. **THE PAGE-2 RULE (Adam's
elegance constraint, enforced server-side always):** text pages assemble FIRST; chart
pages land strictly AFTER page 1 regardless of fence position. Page 1 never waits on
imagery — chart pages render async behind a "⏳ chart rendering…" placeholder and swap in;
failures become a loud bounded text page. Cached by (size, spec) hash with in-flight
dedupe. Malformed JSON degrades to the visible error code-panel (the ```stat pattern).

## Block schema (for non-markdown producers)

Server code can skip markdown and hand `renderBlocks()` blocks directly:

```ts
type Block =
  | { t: 'heading'; text: string; meta?: string }   // meta = right-aligned gray (dates, tool counts)
  | { t: 'para'; text: string }
  | { t: 'bullets'; items: string[] }
  | { t: 'code'; lines: string[] }
  | { t: 'stats'; cards: { value: string; label: string }[] }  // ≤3 used
  | { t: 'rule' }
  | { t: 'chart'; spec: string }   // JSON spec text → async image page (PAGE-2 RULE)
```

## Guidance baked into the system prompts

`server/prompts/aria-g2.md` (wired via `--append-system-prompt`) teaches Aria the display:
lead with the answer, one focal element per page, stat cards for numerics, ≤48-char code
lines, no filler. CC sessions get standard engineering prompting; their markdown renders
through the same pipeline.

## Roadmap (deliberately NOT yet)

- Mermaid / ` ```image ` blocks (headless-browser dependency — upgrades.md D5, charts v2).
- Inline bold/mono runs (multi-font text layout).
- The validated `display` tool with interaction round-trip (GLASSES_OS.md layer 3;
  upgrades.md Phase 12 stretch — design doc required first).
