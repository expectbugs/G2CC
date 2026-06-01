// G2CC Display & Timing Constants
// Merged from g2code/shared/src/constants.ts (display geometry) and
// g2aria/shared/src/constants.ts (heartbeat / liveness / stuck-reload).
// Aria-daemon-specific timeouts (ASK_START_TIMEOUT_MS, ASK_STATUS_TIMEOUT_MS,
// ARIA_IDLE_PROGRESS_MS) are dropped — G2CC dispatches to a Claude Code
// subprocess directly via cc-session, not to an Aria HTTP daemon.

// ============================================================
// Screen geometry — verified from G2_DEVELOPMENT_REFERENCE.md
// (576x288 per eye, monochrome green; immutable at the firmware layer)
// ============================================================

export const SCREEN_WIDTH = 576
export const SCREEN_HEIGHT = 288

// Status bar — kept at g2code's proven 28px (LVGL font clips below
// 28px + 4px padding = 20px usable text height)
export const STATUS_BAR_HEIGHT = 28
export const STATUS_BAR_Y = 0
export const STATUS_CONTAINER_ID = 1
export const STATUS_CONTAINER_NAME = 'status' // SDK max 16 chars
export const STATUS_PADDING = 4

// Main content
export const CONTENT_Y = 30                  // 2-px gap below status bar
export const CONTENT_HEIGHT = 256            // 288 - 30 (gap) - 2 (border)
export const CONTENT_WIDTH = 576
export const MAIN_CONTAINER_ID = 2
export const MAIN_CONTAINER_NAME = 'main'

// Container styling (g2code values; g2aria runs PADDING=2 BORDER=0 for density —
// G2CC uses g2code's safer defaults; tighten in Phase 6 if needed)
export const PADDING = 8
export const BORDER_WIDTH = 1
export const BORDER_COLOR_SUBTLE = 5
export const BORDER_COLOR_BRIGHT = 13
export const BORDER_RADIUS = 4

// Menu container (shares container ID 2 with main content; rebuilt
// when entering menu via SDK's rebuildPageContainer)
export const MENU_CONTAINER_ID = 2
export const MENU_CONTAINER_NAME = 'menu'

// ============================================================
// Text limits (SDK transport limits, not visual)
// ============================================================

export const STARTUP_CHAR_LIMIT = 1000
export const UPGRADE_CHAR_LIMIT = 2000
export const PAGE_CHAR_TARGET = 1500   // safe margin under 2000 for pagination

// ============================================================
// Scrollback
// ============================================================

export const SCROLLBACK_MAX_LINES = 5000

// ============================================================
// Timing — input + streaming
// ============================================================

export const EVENT_DEBOUNCE_MS = 300       // tap/scroll debounce
export const STREAMING_UPDATE_MS = 300     // text_delta flush cadence

// ============================================================
// Reconnect (WebSocket exponential backoff)
// ============================================================

export const RECONNECT_BASE_MS = 1000
export const RECONNECT_MAX_MS = 30_000
export const RECONNECT_MULTIPLIER = 1.5

// ============================================================
// Auth window — security guard, NOT an I/O timeout
// ============================================================
// 5-second window for unauthenticated sockets to send their auth message.
// If they don't, we close the socket. This does NOT kill an authenticated
// long-running operation; it's a security/resource guard against zombie
// pre-auth connections holding pool slots indefinitely.
export const AUTH_TIMEOUT_MS = 5_000

// ============================================================
// Watchdog (CC session crash detection)
// ============================================================

export const WATCHDOG_INTERVAL_MS = 30_000   // health-check cadence (interval, not per-op timeout)
export const CRASH_LOOP_MAX_FAILURES = 5
// After a CC subprocess has stayed alive for this long, its consecutiveFailures
// counter resets. Below this threshold, a death within the lifetime counts as
// a crash and increments the counter. Fixes the bug where the prior code reset
// the counter unconditionally on every successful spawn, making the crash-loop
// guard unreachable for fast-flapping processes.
export const HEALTHY_LIFETIME_MS = 60_000

// ============================================================
// Heartbeat / liveness (ported from g2aria/shared/src/constants.ts)
// ============================================================
// The WebSocket between phone and server can sit silent for long stretches
// during slow CC tool calls. Without heartbeat, mobile OS / carrier NAT
// reaps the idle TCP within 30–60s. We send a server-driven `hb` every
// HEARTBEAT_INTERVAL_MS; the client REPLIES with `client_hb` so the server
// can detect a frozen WebView (protocol pongs fire at the network layer
// even when JS is paused — only an app-level round-trip is a true
// liveness test of the JS event loop).
export const HEARTBEAT_INTERVAL_MS = 10_000        // server-driven hb cadence
export const LIVENESS_TIMEOUT_MS = 30_000          // client forces reconnect after this many ms with no inbound message
export const LIVENESS_CHECK_MS = 5_000             // client liveness watchdog tick
export const APP_ACTIVITY_TIMEOUT_MS = 45_000      // server kicks clients after this many ms with no app-level activity
export const STUCK_RELOAD_MS = 90_000              // last resort: client restarts foreground service after this offline duration

// ============================================================
// Diagnostics
// ============================================================

export const MAX_AUTH_FAILURES_BEFORE_HELP = 3

// ============================================================
// Container counts (must EXACTLY match the number of containers
// per page — SDK invariant)
// ============================================================

export const OUTPUT_LAYOUT_CONTAINER_COUNT = 2
export const MENU_LAYOUT_CONTAINER_COUNT = 2

// ============================================================
// Menu limits (SDK)
// ============================================================

export const MAX_MENU_ITEMS = 20
export const MAX_ITEM_NAME_LENGTH = 64

// ============================================================
// Server defaults — DISTINCT from g2code (7200) and g2aria (7250)
// ============================================================

export const DEFAULT_SERVER_PORT = 7300
export const DEFAULT_MDNS_SERVICE = '_g2cc._tcp'

// ============================================================
// CC session limits
// ============================================================

export const MAX_CONCURRENT_SESSIONS = 5

// ============================================================
// Channel Router ack window (Phase 7) — NOT a timeout on the
// operation; the operation continues either way. This is the
// window after which delivery STATUS falls to "unverified"
// per g2_custom_app_spec.md §10.
// ============================================================

export const BLE_ACK_WINDOW_MS = 5_000
