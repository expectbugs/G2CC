// G2CC server config — hybrid of g2code's config (CC dispatch + STT engine)
// with G2CC defaults: port 7300, mDNS _g2cc._tcp, faster-whisper local-only
// (Phase 8 swaps to Parakeet by changing `engine`), permissionMode bypass.
//
// Persisted at ~/.g2cc/config.json. First-run creates default + random auth token.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SERVER_PORT } from '@g2cc/shared'

export type SttEngine = 'faster-whisper' | 'parakeet'
export type CcEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface G2CCConfig {
  port: number
  host: string
  authToken: string
  stt: {
    /** Active engine. Phase 0–7 ships with `faster-whisper`; Phase 8 swaps in `parakeet`. */
    engine: SttEngine
    /** ISO 639-1 language code or 'en'. */
    language: string
    /** Python interpreter for the STT subprocess (project-scoped venv). */
    pythonPath: string
    /** faster-whisper model name (only used when engine='faster-whisper'). */
    whisperModel: string
    /** 'cuda' or 'cpu'. */
    whisperDevice: 'cuda' | 'cpu'
    /** 'float16', 'int8', etc. */
    whisperCompute: 'float16' | 'int8' | 'int8_float16'
    /** Parakeet model id (only used when engine='parakeet', Phase 8+). */
    parakeetModel: string
    /** DJI-over-Bluetooth path: apply per-utterance ADAPTIVE noise reduction
     *  (local-noise Wiener, 32 ms window) before Parakeet. Validated 2026-06-23
     *  to roughly halve WER at a realistic standing spot; ~neutral point-blank.
     *  Kill-switch — set false to fall back to raw transcribe(). */
    djiBtFilter: boolean
    /** Wiener over-subtraction factor for the BT adaptive filter (validated 1.5). */
    djiBtAlpha: number
  }
  claude: {
    /** Default permission mode. 'bypassPermissions' = --dangerously-skip-permissions. */
    defaultMode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
    /** Effort level. Spec wants 'max'. */
    effort: CcEffort
    /** Model alias or full name passed to claude --model. */
    model: string
    /** Optional system prompt appended to the default. */
    systemPrompt?: string
    /** Canned prompts for the session windows' `Prompts` menu (Phase 6 —
     *  Adam's gate A3.4 picks). One tap feeds the normal prompt() path. */
    quickPrompts: string[]
  }
  notifications: {
    /** Android package → notification priority (Phase 9). Unlisted packages
     *  default to 'info'. Values must be call|timer|sms|email|info — invalid
     *  entries log loudly and fall back to 'info'. */
    packageMap: Record<string, string>
    /** Notification title/body substrings to DROP outright (never reach the
     *  glasses) — privacy/noise spam like "Device ID accessed" (Adam 2026-06-14).
     *  Case-insensitive substring match against BOTH title and body. */
    blockTitles: string[]
  }
  /** Scout — the mixed-mode assistant window (docs/SCOUT.md, Adam 2026-07-09).
   *  A CC session at a fixed workspace cwd with the scout-g2 system prompt;
   *  answers may embed ```g2img / ```chart pages + live scout-show frames. */
  scout: {
    /** Workspace cwd for the Scout session (downloads land in <cwd>/downloads).
     *  MUST be under /home/user/ (session-pool path rules). */
    cwd: string
    /** Model alias for the Scout session (Options cycles it live). */
    model: string
    /** Effort for the Scout session (Adam: max). */
    effort: CcEffort
    /** Canned prompts for Scout's `Prompts` menu (web-research flavored). */
    quickPrompts: string[]
  }
  /** DE shell config (Phase 2 overhaul.md — the ribbon DE/WM). */
  de: {
    /** Root navigation shell. 'menu' = the proven Main category-launcher (the
     *  DEFAULT + the instant fallback); 'ribbon' = the MRU recents ribbon. Flip
     *  to 'ribbon' only AFTER the on-glass hardening soak (overhaul.md §2.2.8 —
     *  the cutover). Built flag-gated so menu stays a one-line revert. */
    rootNav: 'menu' | 'ribbon'
    /** MRU windows shown in the ribbon AFTER the fixed Main slot (active +
     *  recents) and BEFORE the 'frequent' + 'All>' slots — Phase 3 §3.1. Adam's
     *  spec is active + 3 recents = 4. Kept small so the top strip never overflows
     *  its region (an overflowing strip loses the zero-range scroll → no per-notch
     *  focus events). The full order is [Main][active][recent…][frequent][All]. */
    recentsDepth: number
    /** Phase 3 §3.3 STAGING flag (default false): the borderless full-width
     *  in-window layout — the left menu column reclaimed, the action menu moved to
     *  a 3-cell title-bar scroller. Off = the proven in-window chrome (the current
     *  ribbon). Flip on glass to test; collapsed into the default at the §2.2.8
     *  cutover. Ribbon-mode only (no effect when rootNav==='menu'). */
    fullBleed: boolean
    /** Phase 3 §3.5 (Adam 2026-07-01): the ROW CAP for a full-bleed Reader scroll-reading
     *  page — the "sovereign chapters" model. A page fills toward the ~960 B layout wall so
     *  the firmware scrolls the whole chunk then auto-advances at the boundary (proven on
     *  glass: no scroll ceiling < ~100 rows). Omitted = FB_READ_ROW_CAP (30); the ~700 B byte
     *  budget binds first for prose (~12 rows), so this only caps SPARSE content (poetry /
     *  lists / short lines). Ribbon+fullBleed only. Clamped 1–100. */
    readerScrollRows?: number
  }
}

const CONFIG_DIR = join(homedir(), '.g2cc')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

/** Default Python interpreter — falls back to project venv, then aria venv,
 *  then system. Phase 0 verified all three paths to varying degrees. */
function defaultPythonPath(): string {
  const projectVenv = '/home/user/G2CC/audio/venv/bin/python'
  if (existsSync(projectVenv)) return projectVenv
  const ariaVenv = '/home/user/aria/venv/bin/python'
  if (existsSync(ariaVenv)) return ariaVenv
  return 'python3'
}

function defaultConfig(): G2CCConfig {
  return {
    port: DEFAULT_SERVER_PORT,
    host: '0.0.0.0',
    authToken: randomUUID(),
    stt: {
      // Default engine flipped to parakeet 2026-06-02 after NeMo 2.7.3 install
      // + smoke test (espeak synthesis → exact transcription match). Reference
      // WER on LibriSpeech test-clean is 1.69%; cold model load ~5-10s, warm
      // inference ~0.5s for short utterances. faster-whisper remains an
      // available fallback if Parakeet misbehaves on a real DJI capture.
      engine: 'parakeet',
      language: 'en',
      pythonPath: defaultPythonPath(),
      whisperModel: 'large-v3',
      whisperDevice: 'cuda',
      whisperCompute: 'float16',
      parakeetModel: 'nvidia/parakeet-tdt-0.6b-v2',
      djiBtFilter: true,
      djiBtAlpha: 1.5,
    },
    claude: {
      defaultMode: 'bypassPermissions',
      effort: 'max',
      model: 'opus',
      // systemPrompt left unset; user can configure an engineering-oriented prompt.
      // Adam's picks, gate A3.4 (2026-06-11):
      quickPrompts: [
        'current status?',
        'still alive?',
        'Yes please do that',
        'go ahead',
        'explain further',
      ],
    },
    scout: {
      cwd: '/home/user/scout',
      model: 'opus',
      effort: 'max',
      // Web-research starters (Adam can override in config.json).
      quickPrompts: [
        'Continue',
        'Show me pictures of the first result',
        'Show me the next few results',
        'More detail on that one',
        'Summarize what you found so far',
      ],
    },
    notifications: {
      // Pixel 10a defaults (Phase 9): dialer → the caller-ID overlay popup,
      // messaging → sms, gmail → email; everything else 'info'.
      packageMap: {
        'com.google.android.dialer': 'call',
        'com.android.dialer': 'call',
        'com.google.android.apps.messaging': 'sms',
        'com.android.messaging': 'sms',
        'com.google.android.gm': 'email',
      },
      // Drop noisy/privacy notifications outright (Adam 2026-06-14).
      blockTitles: ['Device ID accessed'],
    },
    de: {
      // Default to the proven menu shell; the ribbon is opt-in until its
      // on-glass soak is done (overhaul.md Phase 2 — the cutover flips this).
      rootNav: 'menu',
      recentsDepth: 4,
      fullBleed: false,
    },
  }
}

export function loadConfig(): G2CCConfig {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }

  if (!existsSync(CONFIG_PATH)) {
    const config = defaultConfig()
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    return config
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8')
  let saved: Partial<G2CCConfig>
  try {
    saved = JSON.parse(raw) as Partial<G2CCConfig>
  } catch (err) {
    // Loud failure on corrupt config — return defaults so server still starts,
    // but log clearly so the user sees the issue.
    console.error(`[config] ${CONFIG_PATH} is corrupt: ${(err as Error).message}`)
    console.error('[config] using defaults; rename or fix the file to keep customizations')
    return defaultConfig()
  }
  const defaults = defaultConfig()

  const merged: G2CCConfig = {
    ...defaults,
    ...saved,
    stt: { ...defaults.stt, ...(saved.stt ?? {}) },
    claude: { ...defaults.claude, ...(saved.claude ?? {}) },
    scout: { ...defaults.scout, ...(saved.scout ?? {}) },
    notifications: { ...defaults.notifications, ...(saved.notifications ?? {}) },
    de: { ...defaults.de, ...(saved.de ?? {}) },
  }

  // authToken stability (review 2026-06-11b): defaultConfig() mints a FRESH
  // random token per call, so a config.json missing authToken silently rotated
  // the token on every restart — the paired phone failed auth with zero hints.
  // Persist the generated one (self-healing, mirrors first-run) and say so.
  if (typeof saved.authToken !== 'string' || !saved.authToken) {
    // Review 2026-07-05: a PRESENT-but-invalid authToken ("", null, a number)
    // survives the `{...defaults, ...saved}` spread, so this branch used to
    // log "generated a new one" while persisting the bad value back — an
    // empty token then authenticates ANY peer ("" === ""), and a null one
    // bricks the legit phone forever. Actually regenerate before persisting
    // (defaultConfig() already minted a fresh UUID this call).
    merged.authToken = defaults.authToken
    console.error(`[config] ${CONFIG_PATH} has NO/invalid authToken — generated a new one and SAVED it back. The phone/APK must re-pair via /setup (their baked token no longer matches).`)
    saveConfig(merged)
  }
  // Light shape validation — wrong types here used to surface as confusing
  // failures deep in browse rendering (review 2026-06-11b).
  if (!Array.isArray(merged.claude.quickPrompts) || merged.claude.quickPrompts.some((p) => typeof p !== 'string')) {
    console.error('[config] claude.quickPrompts is not a string array — using defaults')
    merged.claude.quickPrompts = defaults.claude.quickPrompts
  }
  // Scout shape validation (docs/SCOUT.md) — a bad value must degrade loudly to
  // the default, never brick the window (the rootNav fallback pattern). The
  // under-/home/user/ rule is enforced on the RESOLVED path so `..` traversal
  // can't sneak the cwd out (review 2026-07-09 #6); '/home/user' bare is also
  // rejected (the workspace must be a real subdirectory).
  if (typeof merged.scout.cwd !== 'string'
      || resolve(merged.scout.cwd) !== merged.scout.cwd.replace(/\/+$/, '')
      || !resolve(merged.scout.cwd).startsWith('/home/user/')
      || resolve(merged.scout.cwd) === '/home/user') {
    console.error(`[config] scout.cwd '${String(merged.scout.cwd)}' must be a normalized absolute path strictly under /home/user/ — using the default ${defaults.scout.cwd}`)
    merged.scout.cwd = defaults.scout.cwd
  }
  if (typeof merged.scout.model !== 'string' || !merged.scout.model) {
    console.error('[config] scout.model is not a non-empty string — using the default opus')
    merged.scout.model = defaults.scout.model
  }
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(merged.scout.effort)) {
    console.error(`[config] scout.effort '${String(merged.scout.effort)}' is not a valid effort — using the default max`)
    merged.scout.effort = defaults.scout.effort
  }
  if (!Array.isArray(merged.scout.quickPrompts) || merged.scout.quickPrompts.some((p) => typeof p !== 'string')) {
    console.error('[config] scout.quickPrompts is not a string array — using defaults')
    merged.scout.quickPrompts = defaults.scout.quickPrompts
  }
  if (typeof merged.notifications.packageMap !== 'object' || merged.notifications.packageMap === null || Array.isArray(merged.notifications.packageMap)) {
    console.error('[config] notifications.packageMap is not an object — using defaults')
    merged.notifications.packageMap = defaults.notifications.packageMap
  }
  if (!Array.isArray(merged.notifications.blockTitles) || merged.notifications.blockTitles.some((t) => typeof t !== 'string')) {
    console.error('[config] notifications.blockTitles is not a string array — using defaults')
    merged.notifications.blockTitles = defaults.notifications.blockTitles
  }
  // de.rootNav must be one of the two shells; anything else falls back to the
  // proven menu (an unknown shell would otherwise silently brick the root nav).
  if (merged.de.rootNav !== 'menu' && merged.de.rootNav !== 'ribbon') {
    console.error(`[config] de.rootNav '${merged.de.rootNav}' is not 'menu'|'ribbon' — using 'menu'`)
    merged.de.rootNav = 'menu'
  }
  if (typeof merged.de.recentsDepth !== 'number' || !Number.isFinite(merged.de.recentsDepth) || merged.de.recentsDepth < 1) {
    console.error('[config] de.recentsDepth is not a positive number — using the default 4')
    merged.de.recentsDepth = defaults.de.recentsDepth
  }
  if (typeof merged.de.fullBleed !== 'boolean') {
    console.error('[config] de.fullBleed is not a boolean — using the default false')
    merged.de.fullBleed = defaults.de.fullBleed
  }
  // §3.5 probe knob — optional; a garbage value is ignored (falls back to 7), never throws.
  if (merged.de.readerScrollRows !== undefined
      && (typeof merged.de.readerScrollRows !== 'number' || !Number.isFinite(merged.de.readerScrollRows)
          || merged.de.readerScrollRows < 1 || merged.de.readerScrollRows > 100)) {
    console.error('[config] de.readerScrollRows must be a number 1–100 (or omitted) — ignoring')
    merged.de.readerScrollRows = undefined
  }
  return merged
}

export function saveConfig(config: G2CCConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}
