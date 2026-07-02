# G2CC — G2 Control Center

**A custom operating environment for [Even Realities G2](https://www.evenrealities.com/) smart glasses.**
It replaces the vendor's companion app with a home-built stack that turns the glasses into a small, fully windowed computer you drive from your own PC. The vendor app — and the Even Hub store behind it — already offers apps, games, news, and email; G2CC's edge is a different one: cohesiveness, deep customization, PC-powered capabilities, persistent sessions, more robust connectivity, independence from the vendor's decisions and limits, and privacy — nothing in it touches Even Realities' servers or proprietary stack.

The trick is a clean split of responsibilities:

- **The PC is the brain.** A Node server holds every bit of window and session state and *composes each
  screen* the glasses show.
- **The glasses are a thin display.** They render the scene they're handed, send your taps and ring‑scrolls
  back, and hold zero application state.
- **The phone is just a bridge.** An Android foreground service relays the connection (Bluetooth LE to the
  glasses, WebSocket to the PC) and otherwise stays in your pocket.

Because the PC does all the thinking, the glasses can show far more than the stock firmware ever intended:
a windowed desktop, a live terminal, an e‑reader, email, calendars, even games — all rendered server‑side
and streamed as display frames.

> **Status:** a personal, self‑hosted project for my own pair of G2 glasses, sideloaded (no app store), talking
> to hardware I own over my home network. The Bluetooth wire format is community/observation‑derived, not
> official. Not affiliated with or endorsed by Even Realities.

---

## What it does

A windowing system runs on the home server and streams frames to the glasses. Each "window" is a content
provider; a compositor turns it into a display frame that fits the glasses' 576×288 monochrome screen and its
strict per‑frame size limits. You navigate with the temple's touch bar and the ring's scroll wheel.

**The windows:**

| Window | What it is |
| --- | --- |
| **Main** | A dashboard: battery states, host/CPU/GPU pulse, unseen notifications, next timer, recently‑used apps |
| **Claude Code** / **Aria** | A live AI coding/assistant session running as a subprocess on the PC, streamed to the lenses with a dictate‑and‑confirm flow |
| **Reader** | An EPUB reader with your books' *real* chapters, firmware‑scrolling pages, and book‑faithful formatting (see below) |
| **Mail** / **SMS** / **Notices** | Read + reply to email, texts, and phone notifications, dictated by voice |
| **Files** | Browse the PC's filesystem, preview text + images, move/copy/rename/trash |
| **Terminal (Tmux)** | Attach to tmux sessions and watch/drive them live |
| **Calendar** / **Timers** / **Deliveries** | Agenda, countdowns, and package tracking |
| **Media** | Now‑playing controls + synced lyrics for whatever's on the phone |
| **Games** | Blackjack, a text roguelike, and *Universal Paperclips* running in a headless DOM |
| **Search** | One dictated query across mail, files, conversation history, and notes |

**The desktop ("the ribbon"):** a most‑recently‑used app strip lives in the top bar, driven by the ring —
scroll to move a server‑drawn cursor, tap to enter, double‑tap for alt‑tab back to the previous app. Windows
render borderless and full‑width; a categorized drawer holds everything else.

**Input by voice:** speech is captured on the phone, transcribed by a local [NVIDIA
Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) ASR model on the PC, and shown back for a
confirm step before anything acts on it — because on‑glass mistakes are annoying to undo.

### Feature spotlight: the Reader

EPUBs are *reflowable* — they have no fixed pages. Most readers invent arbitrary page numbers that shift
whenever you change the font. G2CC's Reader instead:

- **Splits each book into its real chapters** by parsing the book's own table of contents and anchor points,
  so "Chapter 33" is the actual chapter 33 (`33. Juniper: The Encounter`), not a made‑up section.
- **Shows chapter‑relative page numbers** (`p.2/28`) plus overall progress — numbers that mean something and
  stay stable.
- **Fills each display page as full as the wire allows and lets the firmware scroll it**, then auto‑advances at
  the boundary — so you flip pages far less often. (The G2's scroll behaviour for large captured text regions
  was reverse‑engineered on‑glass to make this work.)
- **Preserves the book's structure** — chapter headings, scene‑break dividers, paragraph flow — while never
  dropping a single character of prose.

Your reading position is stored as a real anchor, bookmark‑able from the menu, and survives layout changes.

---

## How it works

```
  Home PC (the brain)                                Glasses (thin client)
  ┌────────────────────────────────────┐  frame   ┌─────────────────────────────┐
  │ window manager   (navigation/state)│ ───────► │ WebSocket ← phone bridge    │
  │ 15 windows       (content providers)│          │ scene(JSON) → renderer      │
  │ compositor       (→ display frame) │ ◄─────── │   → Bluetooth LE → lenses   │
  │ AI subprocess bridge · PostgreSQL  │  input   │ ring/touch events           │
  └────────────────────────────────────┘          └─────────────────────────────┘
```

- **The compositor** turns a window's requested view into a wire scene of positioned regions (text, lists,
  4‑bit grayscale image tiles). It works within the firmware's hard limits — most notably a per‑message size
  ceiling that silently drops oversized frames — with a byte estimator and fences that keep every frame legal.
- **The Bluetooth wire format** was decoded from community references and packet captures of the glasses'
  own traffic (the vendor doesn't publish it). Firmware updates occasionally shift it; the format is
  re‑derived when that happens.
- **AI sessions** are real command‑line agent processes on the PC, streamed to the lenses and driven by voice
  with a mandatory confirm step, so you can make progress on real work from the glasses.

## Tech stack

- **Server:** TypeScript / Node, PostgreSQL, a WebSocket + Bluetooth bridge, an offline
  scene‑to‑PNG renderer for developing UI without the hardware.
- **Client:** Kotlin / Android — a foreground service, a BLE driver, notification mirroring, and the frame
  renderer. Zero app‑side state.
- **Audio/STT:** a Python pipeline — noise reduction (learned‑profile spectral subtraction, with a two‑mic
  adaptive‑filter fallback) + DeepFilterNet polish + Parakeet ASR, CUDA‑accelerated.

## Repository layout

```
server/          the Node server — window manager, the windows, the compositor, the wire layer
  src/windows/   one file per window
  smoke/         the regression suite
android/         the Kotlin client (foreground service, BLE, renderer)
audio/           the Python audio + speech‑to‑text pipeline
scripts/         helpers — EPUB/terminal/image → renderable content, scene → PNG
shared/          the wire contract shared by both ends
docs/            protocol notes, the display/UI contract, capability maps
```

## Running it

The server is Node + PostgreSQL; the client is a sideloaded Android app that pairs with the glasses over BLE.
Because it's built around one person's specific hardware, network, and accounts, it isn't a turnkey install —
but the server, the smoke suite, and the offline scene renderer all run without any glasses attached, which is
how most of the UI is actually developed.

```bash
npm run build -w server && node server/smoke/run-all.mjs   # build + the regression gate
```

## Engineering principles

Three rules run through the codebase, learned the hard way from a wearable that's unforgiving of sloppiness:

- **No timeouts** on the connection/capture/display paths — supervise externally, never time‑bound I/O.
- **No silent failures** — every error surfaces loudly with a tagged log; status fields reflect reality.
- **No truncation** — content scrolls or paginates; nothing is ever silently cut.

Plus a hard *verify‑before‑execute* habit: reverse‑engineered wire values, external‑API types, and hardware
settings are checked against a real source, never guessed.
