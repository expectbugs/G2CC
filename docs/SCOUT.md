# SCOUT.md — the mixed-mode Claude Code assistant window

**What Scout is:** a voice/keyboard-driven CC session window whose subprocess can *control the
glasses display* — answers render as Reader-style scrollable firmware text, and the model can embed
full-pane imagery (web photos, self-drawn PNGs, charts) as pages, or push live progress frames
mid-turn. Built for assisted web research ("find used Prevost conversions… show me the bathroom of
the first one") but general-purpose. Decided with Adam 2026-07-09; all seven design decisions below
are LOCKED.

Authoritative for Scout behavior; `DE_DESIGN.md` still wins on shared UI rules, `WINDOW_API.md` on
the window contract, `G2_BLE_PROTOCOL.md` on the wire.

## Locked decisions (Adam, 2026-07-09)

1. **Reading UX = fullBleed scroll-read** (Reader's mechanism) for answer pages; classic menued view
   when fullBleed is off or during transient states.
2. **All three input methods**: dictation (`Ask`, confirm-gated), quick-prompts, and the Terminal's
   on-glass tap keyboard (`Type`).
3. **Name: Scout**, id `scout`, category **`Tools`** — the discussion proposed `AI`, but Adam's
   2026-06-13 decision folded the AI category into Tools so Main stays at exactly 5 categories
   (`phase5-dashboard` guards it, and it caught the regression). Scout sits beside Aria/CC.
   Flagged in the build summary; say the word to resurrect a 6th category instead.
4. **Workspace `/home/user/scout`** (outside the repo — no CLAUDE.md context tax, no gitignore
   churn). Downloads land in `/home/user/scout/downloads/`.
5. **bypassPermissions** (the config default already is) — web fetches never stall on Approve cards.
6. **Defaults `opus`/`max`**, live-cyclable via Options (respawn-with-resume preserves context).
7. **Mechanism = `g2img` marker blocks + a live CLI-over-HTTP channel** (`scout-show`). MCP was
   considered and deferred: the CLI gives the identical practical UX; MCP can wrap the same endpoint
   later with zero rework.

## Architecture

```
Ask/Type/quick-prompt ──► SessionLevel.prompt() ──► claude subprocess @ /home/user/scout
                                                        │  (opus/max, bypassPermissions,
                                                        │   --append-system-prompt prompts/scout-g2.md)
   answer markdown ◄────────────────────────────────────┤
   ├─ text blocks ──► paginate ──► scroll-read pages (fullBleed) / menued pages
   ├─ ```g2img /path + caption ──► renderImageFileCached ──► tiles page (PAGE-2 rule)
   └─ ```chart JSON ─────────────► renderChart ──────────► tiles page (existing Phase 8)
   mid-turn: Bash → scripts/scout_show.py ──► POST /scout/live (loopback+Bearer)
             ──► scout-live sink ──► ScoutWindow.liveFrame ──► immediate frame
   web:      Bash → aria venv fetch_page.py (text) / scripts/fetch_images.py (list/get/shot)
```

- **`ScoutWindow`** (`windows/scout.ts`): Aria-pattern window — fixed cwd, prompt file, shared
  `SessionLevel`/`SessionOptions`/`HistoryLevel`. Adds: fullBleed scroll-read of the session pages,
  a `kbd` level (shared `_kbd.ts` model extracted from Terminal), live-frame display, `Read`/`Type`
  idle-menu verbs.
- **`g2img` block** (`os-content.ts` + `_session.ts`): fenced block in the model's answer —
  first line = absolute path, optional `caption: …` line. Parsed like ```chart; malformed input
  degrades to a LOUD visible code block; render failures REPLACE the page with a bounded
  `IMAGE RENDER FAILED` text page. Media pages append strictly after all text pages (THE PAGE-2
  RULE), placeholders swap in async, renders are promise-cached (path+size+mtime key).
- **Live channel**: `POST /scout/live` + `GET /scout/live/status` on the existing Fastify server —
  **loopback clients only + Bearer token**, both checks. `scripts/scout_show.py` (stdlib urllib,
  token from `~/.g2cc/config.json` or env) is the CC-facing CLI. Frames display only while THEIR
  OWN turn is in flight (turnSeq-stamped) and dictation UI doesn't hold focus. Text frames must
  fit one glanceable page — ≤560 B AND ≤6 wrapped rows, both rejected loudly, never clipped.
  The reply claims only what the window can know: exit 0 = delivered to Scout's active view
  (BLE push takes seconds; a notification overlay/blank can cover it) · 3 accepted-not-visible ·
  2 rejected · 1 transport. Live frames are disposable — keepers go in the final answer.
- **`scripts/fetch_images.py`** (aria venv, Playwright; CC-invoked ONLY, never the server):
  `list URL` → JSON of content images (src/alt/dims, icons filtered), `get URL --index N |
  --match STR --out DIR` → downloads via the browser context (cookies/referer survive),
  `shot URL --out FILE [--full]` → page screenshot.

## Interaction contract (revised after Adam's first on-glass session, 2026-07-09)

| State | View | Gestures |
|---|---|---|
| idle + fullBleed, `read` | scroll-read page (no menu) | scroll = page turn (images render as menued tiles pages); **double-tap = Scout's own menu** (the `onScrollReadBack` WM hook); double-tap again from the menu = ribbon |
| idle, menued (double-tap / reentry) | menued session view, **`Ask` first** (cell 0 = mic), then `Read`/`Type`/`Next`/`Prev` | top-bar scroller; `Read` returns to scroll-read |
| idle, on an image page | menued tiles view, **`Next`/`Prev` first** (nav is the default cell) | Next/Prev page; state flips leave the tiles instantly (below) |
| listening/transcribing/suggesting over an IMAGE page | a **TEXT card** (never the tiles — a state flip on tiles re-pushed ~150 BLE packets and froze the display for minutes) | Done/Cancel as usual; the image page returns after |
| busy | menued view, busy menu = `Next·Prev·Interrupt·…` — **Interrupt never at cell 0** | Interrupt is a deliberate two-notch reach |
| busy + live frame | the pushed frame; menu `Next·Prev·Interrupt·…` | `Next`/`Prev` dismiss the frame and page the doc; cleared when its turn ends |
| fullBleed off | classic menued session view everywhere (Aria-identical + `Type`) | unchanged |

A real turn (busy) flips the UI back to `read` so the answer lands in scroll-read. The WM now
resets the fullBleed cursor to **cell 0 on every menu change** — cell 0 is the deterministic
default everywhere, and every Scout/session menu keeps cell 0 harmless (a stray R1 tap can
never Interrupt/destroy; it was aborting live turns).

## Config

`config.scout` in `~/.g2cc/config.json`: `{ cwd, model, effort, quickPrompts }` — defaults
`/home/user/scout`, `opus`, `max`, web-research-flavored prompts. Validation mirrors `claude.*`
(bad values log loudly and fall back). The cwd must be under `/home/user/`.

## Invariants (house rules applied)

- No timeouts anywhere: the live endpoint waits for the render; `scout_show.py` uses no socket
  timeout; watchdog supervision is cadence, not deadline.
- No silent failures: parse errors → visible code blocks; render failures → loud failure pages;
  live rejects carry reasons; mic stops on every exit path (SessionLevel owns it).
- No truncation: pages paginate (`paginateText`), captions clamp only in the title (full caption
  stays in the doc/history), scroll-read pages are never trimmed by compose.
- cc/aria chart behavior is preserved exactly (captions, titles, ordering). One shared-parser
  consequence, deliberate: a `g2img` fence emitted in ANY session window now renders as an image
  page (previously a plain code block) — loud failure page on a bad path, so nothing silent.
- preview() stays cheap/side-effect-free; smoke runs offline (no CC spawn, no network, no BLE).

## Files

`server/src/windows/scout.ts` (new) · `server/src/windows/_kbd.ts` (new, extracted from
terminal.ts) · `server/src/scout-live.ts` (new) · `server/src/os-content.ts` (g2img block +
image cache) · `server/src/windows/_session.ts` (media pages + page helpers) ·
`server/src/config.ts` (+`config.example.json`) · `server/src/index.ts` (2 routes) ·
`server/src/voice.ts` (alias) · `server/src/windows/registry.ts` (1 line) ·
`server/prompts/scout-g2.md` (system prompt) · `scripts/scout_show.py` + `scripts/fetch_images.py`
(new) · `server/smoke/phase-scout.mjs` (new) · workspace `/home/user/scout/` (the window mkdirs
`<cwd>/downloads/` on construction; the minimal `CLAUDE.md` there was hand-placed once at build
time and is not auto-recreated).
