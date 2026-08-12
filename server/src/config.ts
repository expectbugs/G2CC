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
     *  Kill-switch — set false to fall back to raw transcribe(). ALSO governs
     *  the earbud-bt path (same 16 k mono BT capture class). */
    djiBtFilter: boolean
    /** Wiener over-subtraction factor for the BT adaptive filter (validated 1.5). */
    djiBtAlpha: number
    /** Which BT mic the phone captures from (earbud 2026-08-04 — Adam retired
     *  the DJI to minimize BT connections). 'earbud' = first non-DJI comms
     *  device (Pixel Buds 2a), announced as source 'earbud-bt'. 'dji' = the
     *  legacy DJI-name-matched pick — the DISABLED-NOT-DELETED undo: one flip
     *  restores the collar mic, no code change. Sent to the phone in
     *  config_snapshot; pre-1.20 APKs ignore it. */
    micSource: 'earbud' | 'dji'
  }
  /** TTS — the earbud speech lane (2026-08-04, docs/EARBUD_SPEC.md §C6.1).
   *  Engine choice mirrors stt.parakeetModel: a config flip, not a code edit. */
  tts: {
    /** Synthesis engine. Only 'kokoro' is implemented (ARIA's proven stack). */
    engine: 'kokoro'
    /** Kokoro voice id (Adam 2026-08-04: af_heart — same as ARIA). */
    voice: string
    /** Speaking-rate multiplier. */
    speed: number
    /** Directory holding kokoro-v1.0.onnx + voices-v1.0.bin. Defaults to
     *  ARIA's copy — one set of model files on disk. */
    modelDir: string
  }
  /** Earbud output policy (2026-08-04, docs/EARBUD_SPEC.md §C6.2). */
  audioOut: {
    /** When Companion replies speak: 'auto' = TTS only when the Earbud window
     *  is NOT the visible focus (Adam's rule); 'always' = both channels;
     *  'never' = glasses text only (kill-switch). */
    speakMode: 'auto' | 'always' | 'never'
    /** dB drop applied to the music lane while speech plays. */
    duckDb: number
    /** Phone-local earcons (dictation start/stop, done, error, timer). */
    chimes: boolean
    /** RESERVED (deep-review #10): the phone currently HARD-refuses any
     *  non-Bluetooth output route unconditionally — this flag is documented
     *  intent, not yet wired across the wire. Flipping it changes nothing
     *  until a future APK consults it. */
    allowSpeaker: boolean
    // earsOn + notify RETIRED (music redesign 2026-08-05, MUSIC_SPEC D2/D8):
    // the ears supervisor and spoken notifications died with the earbud lane.
    // loadConfig strips them from a saved config with a loud one-time note.
  }
  /** Music library + streaming + the music app (MUSIC_SPEC D8, 2026-08-05). */
  music: {
    /** Directories scanned into the tracks index (ffprobe metadata). */
    libraryDirs: string[]
    /** Wire format for /media/track: 'opus' = ffmpeg → Opus 96k MONO with
     *  loudnorm, cached (cellular-kind; mono enforced at the source);
     *  'raw' = range-served original file (LAN listening). */
    format: 'opus' | 'raw'
    /** Transcode cache directory. */
    cacheDir: string
    /** yt-dlp grabs land in this SUBDIRECTORY of libraryDirs[0] (D7). */
    youtubeDir: string
    /** Track-change/queue popup duration on glass (D6.3). 0 = popups off. */
    popupMs: number
    /** Radio mode: how many nearest-neighbor tracks each append adds (D5). */
    radioBatch: number
    /** Default resolver queue size (D4: "default size ~25"). */
    queueSize: number
    /** Resolver lane 2 (D4): the Opus one-shot parse. llm=false skips straight
     *  to the deterministic + embedding lanes (kill-switch). */
    resolver: { llm: boolean; model: string; effort: CcEffort }
    /** The pinned local embedding model (D3.1) — MUST match what built the
     *  Qdrant g2cc_music collection (Phase A pinned BAAI/bge-small-en-v1.5,
     *  384-dim). Changing it = re-embed the collection. */
    embedModel: string
    /** Ingest watch directory (Adam 2026-08-05): audio dropped here is
     *  indexed, enriched, FILED into <its library root>/<Artist>/[<Album>/]
     *  and added to every matching adaptive playlist. MUST live inside one of
     *  libraryDirs (the index-in-place flow depends on it). '' = disabled. */
    ingestDir: string
  }
  /** The Companion — the dedicated earbud CC session (docs/EARBUD_SPEC.md §C6.4). */
  companion: {
    /** Session cwd (a real directory; its CLAUDE.md is the persona). */
    dir: string
    /** Model alias for the Companion session. */
    model: string
    /** Effort for the Companion session. */
    effort: CcEffort
    /** Voice-send confidence gate (Adam 2026-08-04): a dictation whose
     *  confidence heuristic scores ≥ this auto-sends to the Companion;
     *  below it, a VOICE confirmation loop runs ("say send or cancel" —
     *  waits forever, never auto-confirms). 0 = always trust, 1 = always
     *  confirm. */
    confirmThreshold: number
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
  /** Games window sub-apps (FF1 2026-08-12, games/ff1/PLAN.md). */
  games: {
    /** FF1-on-G2 (games/ff1) — the emulated NES original, ring-driven. */
    ff1: {
      /** Show live enemy HP in battle views. Default OFF — the RAM knows it,
       *  the challenge run shouldn't (PLAN §7.1). */
      showEnemyHp: boolean
      /** Pad every executed press with 0-9 random frames so battle outcomes
       *  aren't frame-replayable (RNG honesty, PLAN §8.3). Tests run false. */
      rngJitter: boolean
      /** Undo-ring depth (labeled savestates, PLAN §8.4). */
      undoDepth: number
      /** Show the battle-start formation glance tile (small image, one push,
       *  battle start only — PLAN §7 toggle, default OFF). */
      formationTile: boolean
    }
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
    /** Multi-surface restart resume (2026-07-13): reopen the last active window
     *  after a server restart (os-state.ts pointer; windows self-restore their
     *  content). Default true. false = always boot at the root — the escape
     *  hatch if a wedged window ever survives restarts it shouldn't. */
    resumeWindow: boolean
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
      // 2026-08-04: Adam retired the DJI for the Pixel Buds 2a mic ('dji' is
      // the one-flip undo — every DJI code path stays intact).
      micSource: 'earbud',
    },
    tts: {
      engine: 'kokoro',
      voice: 'af_heart',
      speed: 1.0,
      modelDir: '/home/user/aria/tts_models/kokoro',
    },
    audioOut: {
      speakMode: 'auto',
      duckDb: -12,
      chimes: true,
      allowSpeaker: false,
    },
    music: {
      // /home/user/Music is included so the DEFAULT pair is self-consistent —
      // ingestDir below must sit inside a root or the drop-box refuses to
      // start (B-review 2026-08-05 #6: the old default pair could never work).
      libraryDirs: ['/mnt/slug/Music', '/home/user/Music'],
      format: 'opus',
      cacheDir: join(homedir(), '.g2cc', 'media-cache'),
      youtubeDir: 'YouTube',
      popupMs: 4500,
      radioBatch: 10,
      queueSize: 25,
      resolver: { llm: true, model: 'opus', effort: 'low' },
      embedModel: 'BAAI/bge-small-en-v1.5',
      ingestDir: '/home/user/Music/new',
    },
    companion: {
      dir: '/home/user/g2cc-companion',
      model: 'opus',
      effort: 'max',
      confirmThreshold: 0.95,
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
    games: {
      ff1: {
        showEnemyHp: false,
        rngJitter: true,
        undoDepth: 30,
        formationTile: false,
      },
    },
    de: {
      // Default to the proven menu shell; the ribbon is opt-in until its
      // on-glass soak is done (overhaul.md Phase 2 — the cutover flips this).
      rootNav: 'menu',
      recentsDepth: 4,
      fullBleed: false,
      resumeWindow: true,
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
    // Earbud lane (2026-08-04) — every new section MUST be in this merge list
    // or a saved config silently loses its user overrides (the known gotcha).
    tts: { ...defaults.tts, ...(saved.tts ?? {}) },
    audioOut: {
      ...defaults.audioOut,
      ...(saved.audioOut ?? {}),
    },
    music: {
      ...defaults.music,
      ...(saved.music ?? {}),
      resolver: { ...defaults.music.resolver, ...(saved.music?.resolver ?? {}) },
    },
    companion: { ...defaults.companion, ...(saved.companion ?? {}) },
    games: {
      ff1: { ...defaults.games.ff1, ...(saved.games?.ff1 ?? {}) },
    },
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
  if (typeof merged.de.resumeWindow !== 'boolean') {
    console.error('[config] de.resumeWindow is not a boolean — using the default true')
    merged.de.resumeWindow = defaults.de.resumeWindow
  }
  // §3.5 probe knob — optional; a garbage value is ignored (falls back to 7), never throws.
  if (merged.de.readerScrollRows !== undefined
      && (typeof merged.de.readerScrollRows !== 'number' || !Number.isFinite(merged.de.readerScrollRows)
          || merged.de.readerScrollRows < 1 || merged.de.readerScrollRows > 100)) {
    console.error('[config] de.readerScrollRows must be a number 1–100 (or omitted) — ignoring')
    merged.de.readerScrollRows = undefined
  }
  // ---- Earbud lane validators (2026-08-04) — log loudly, fall back, never throw ----
  if (merged.stt.micSource !== 'earbud' && merged.stt.micSource !== 'dji') {
    console.error(`[config] stt.micSource '${String(merged.stt.micSource)}' is not 'earbud'|'dji' — using 'earbud'`)
    merged.stt.micSource = defaults.stt.micSource
  }
  if (merged.tts.engine !== 'kokoro') {
    console.error(`[config] tts.engine '${String(merged.tts.engine)}' is not implemented — using 'kokoro'`)
    merged.tts.engine = 'kokoro'
  }
  if (typeof merged.tts.voice !== 'string' || !merged.tts.voice) {
    console.error('[config] tts.voice is not a non-empty string — using af_heart')
    merged.tts.voice = defaults.tts.voice
  }
  if (typeof merged.tts.speed !== 'number' || !Number.isFinite(merged.tts.speed)
      || merged.tts.speed < 0.5 || merged.tts.speed > 2.0) {
    console.error('[config] tts.speed must be a number 0.5–2.0 — using 1.0')
    merged.tts.speed = defaults.tts.speed
  }
  if (typeof merged.tts.modelDir !== 'string' || !merged.tts.modelDir.startsWith('/')) {
    console.error('[config] tts.modelDir must be an absolute path — using the default')
    merged.tts.modelDir = defaults.tts.modelDir
  }
  if (!['auto', 'always', 'never'].includes(merged.audioOut.speakMode)) {
    console.error(`[config] audioOut.speakMode '${String(merged.audioOut.speakMode)}' is not auto|always|never — using 'auto'`)
    merged.audioOut.speakMode = defaults.audioOut.speakMode
  }
  if (typeof merged.audioOut.duckDb !== 'number' || !Number.isFinite(merged.audioOut.duckDb)
      || merged.audioOut.duckDb > 0 || merged.audioOut.duckDb < -40) {
    console.error('[config] audioOut.duckDb must be a number in [-40, 0] — using -12')
    merged.audioOut.duckDb = defaults.audioOut.duckDb
  }
  if (typeof merged.audioOut.chimes !== 'boolean') {
    console.error('[config] audioOut.chimes is not a boolean — using true')
    merged.audioOut.chimes = defaults.audioOut.chimes
  }
  if (typeof merged.audioOut.allowSpeaker !== 'boolean') {
    console.error('[config] audioOut.allowSpeaker is not a boolean — using false (earbud-or-nothing)')
    merged.audioOut.allowSpeaker = defaults.audioOut.allowSpeaker
  }
  // Retired keys (music redesign 2026-08-05, MUSIC_SPEC D2/D8): the ears
  // supervisor + spoken notifications died with the earbud lane. The interface
  // change alone doesn't strip a SAVED config's runtime keys — the spread
  // carries them — so drop them explicitly, say so ONCE, and persist the strip.
  {
    const legacy = merged.audioOut as Record<string, unknown>
    if ('earsOn' in legacy || 'notify' in legacy) {
      console.error('[config] audioOut.earsOn / audioOut.notify are RETIRED (music redesign D2) — removed from config.json; TTS/notification audio returns in its own future session')
      delete legacy['earsOn']
      delete legacy['notify']
      // Persist the strip from PRODUCTION boots only (review 2026-08-05 #H2):
      // the smoke suite also calls loadConfig() and must never write Adam's
      // real ~/.g2cc/config.json ("never pollute production data"). The smoke
      // env is marked by G2CC_PG_DATABASE (_env.mjs; production never sets it).
      if (!process.env.G2CC_PG_DATABASE) {
        try { saveConfig(merged) } catch (e) {
          console.error(`[config] persisting the retired-key strip failed (live config is clean anyway): ${(e as Error).message}`)
        }
      }
    }
  }
  if (!Array.isArray(merged.music.libraryDirs)
      || merged.music.libraryDirs.some((d) => typeof d !== 'string' || !d.startsWith('/'))) {
    console.error('[config] music.libraryDirs must be an array of absolute paths — using defaults')
    merged.music.libraryDirs = defaults.music.libraryDirs
  }
  if (merged.music.format !== 'opus' && merged.music.format !== 'raw') {
    console.error(`[config] music.format '${String(merged.music.format)}' is not opus|raw — using 'opus'`)
    merged.music.format = defaults.music.format
  }
  if (typeof merged.music.cacheDir !== 'string' || !merged.music.cacheDir.startsWith('/')) {
    console.error('[config] music.cacheDir must be an absolute path — using the default')
    merged.music.cacheDir = defaults.music.cacheDir
  }
  // ---- Music-app validators (MUSIC_SPEC D8, 2026-08-05) — loud fallback, never throw ----
  if (typeof merged.music.youtubeDir !== 'string' || !merged.music.youtubeDir
      || merged.music.youtubeDir.startsWith('/') || merged.music.youtubeDir.includes('..')) {
    console.error(`[config] music.youtubeDir '${String(merged.music.youtubeDir)}' must be a plain subdirectory NAME (it lands under libraryDirs[0]) — using 'YouTube'`)
    merged.music.youtubeDir = defaults.music.youtubeDir
  }
  if (typeof merged.music.popupMs !== 'number' || !Number.isFinite(merged.music.popupMs)
      || merged.music.popupMs < 0 || merged.music.popupMs > 60_000) {
    console.error('[config] music.popupMs must be a number 0–60000 (0 = popups off) — using 4500')
    merged.music.popupMs = defaults.music.popupMs
  }
  if (typeof merged.music.radioBatch !== 'number' || !Number.isInteger(merged.music.radioBatch)
      || merged.music.radioBatch < 1 || merged.music.radioBatch > 100) {
    console.error('[config] music.radioBatch must be an integer 1–100 — using 10')
    merged.music.radioBatch = defaults.music.radioBatch
  }
  if (typeof merged.music.queueSize !== 'number' || !Number.isInteger(merged.music.queueSize)
      || merged.music.queueSize < 1 || merged.music.queueSize > 500) {
    console.error('[config] music.queueSize must be an integer 1–500 — using 25')
    merged.music.queueSize = defaults.music.queueSize
  }
  if (typeof merged.music.resolver.llm !== 'boolean') {
    console.error('[config] music.resolver.llm is not a boolean — using true')
    merged.music.resolver.llm = defaults.music.resolver.llm
  }
  if (typeof merged.music.resolver.model !== 'string' || !merged.music.resolver.model) {
    console.error('[config] music.resolver.model is not a non-empty string — using opus')
    merged.music.resolver.model = defaults.music.resolver.model
  }
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(merged.music.resolver.effort)) {
    console.error(`[config] music.resolver.effort '${String(merged.music.resolver.effort)}' is not a valid effort — using low`)
    merged.music.resolver.effort = defaults.music.resolver.effort
  }
  if (typeof merged.music.embedModel !== 'string' || !merged.music.embedModel) {
    console.error('[config] music.embedModel is not a non-empty string — using BAAI/bge-small-en-v1.5')
    merged.music.embedModel = defaults.music.embedModel
  }
  if (typeof merged.music.ingestDir !== 'string'
      || (merged.music.ingestDir !== '' && !merged.music.ingestDir.startsWith('/'))) {
    console.error(`[config] music.ingestDir '${String(merged.music.ingestDir)}' must be an absolute path or '' (disabled) — using the default`)
    merged.music.ingestDir = defaults.music.ingestDir
  }
  // Companion cwd follows the scout.cwd rules: normalized, strictly under /home/user/.
  if (typeof merged.companion.dir !== 'string'
      || resolve(merged.companion.dir) !== merged.companion.dir.replace(/\/+$/, '')
      || !resolve(merged.companion.dir).startsWith('/home/user/')
      || resolve(merged.companion.dir) === '/home/user') {
    console.error(`[config] companion.dir '${String(merged.companion.dir)}' must be a normalized absolute path strictly under /home/user/ — using the default ${defaults.companion.dir}`)
    merged.companion.dir = defaults.companion.dir
  }
  if (typeof merged.companion.model !== 'string' || !merged.companion.model) {
    console.error('[config] companion.model is not a non-empty string — using opus')
    merged.companion.model = defaults.companion.model
  }
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(merged.companion.effort)) {
    console.error(`[config] companion.effort '${String(merged.companion.effort)}' is not a valid effort — using max`)
    merged.companion.effort = defaults.companion.effort
  }
  if (typeof merged.companion.confirmThreshold !== 'number' || !Number.isFinite(merged.companion.confirmThreshold)
      || merged.companion.confirmThreshold < 0 || merged.companion.confirmThreshold > 1) {
    console.error('[config] companion.confirmThreshold must be a number 0–1 — using 0.95')
    merged.companion.confirmThreshold = defaults.companion.confirmThreshold
  }
  return merged
}

export function saveConfig(config: G2CCConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}
