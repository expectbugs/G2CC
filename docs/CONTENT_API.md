# DE Content API — how AIs (and anything else) draw on the glasses

**The model describes SEMANTIC content; the Display Renderer owns every pixel.** This is the
contract that makes LLM display output hard to get wrong (docs/GLASSES_OS.md "LLM content
API"; layout/geometry in docs/DE_DESIGN.md). Any text that flows through the content
pipeline — CC responses, Aria replies, future apps — is parsed and typeset the same way.

## Pipeline

```
LLM markdown ──parseMarkdown()──► Block[] ──render_content.py──► 480×212 gray4 pages
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
```

## Guidance baked into the system prompts

`server/prompts/aria-g2.md` (wired via `--append-system-prompt`) teaches Aria the display:
lead with the answer, one focal element per page, stat cards for numerics, ≤48-char code
lines, no filler. CC sessions get standard engineering prompting; their markdown renders
through the same pipeline.

## Roadmap (deliberately NOT v1)

- ` ```chart ` (+ Vega-Lite / Mermaid) → server-rasterized via matplotlib/headless — the
  schema slot is reserved; rasterizer hooks live in render_content.py.
- Inline bold/mono runs (multi-font text layout).
- The validated `display` tool with interaction round-trip (GLASSES_OS.md layer 3).
