// G2CC server config — hybrid of g2code's config (CC dispatch + STT engine)
// with G2CC defaults: port 7300, mDNS _g2cc._tcp, faster-whisper local-only
// (Phase 8 swaps to Parakeet by changing `engine`), permissionMode bypass.
//
// Persisted at ~/.g2cc/config.json. First-run creates default + random auth token.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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
    notifications: { ...defaults.notifications, ...(saved.notifications ?? {}) },
  }

  // authToken stability (review 2026-06-11b): defaultConfig() mints a FRESH
  // random token per call, so a config.json missing authToken silently rotated
  // the token on every restart — the paired phone failed auth with zero hints.
  // Persist the generated one (self-healing, mirrors first-run) and say so.
  if (typeof saved.authToken !== 'string' || !saved.authToken) {
    console.error(`[config] ${CONFIG_PATH} has NO authToken — generated a new one and SAVED it back. The phone/APK must re-pair via /setup (their baked token no longer matches).`)
    saveConfig(merged)
  }
  // Light shape validation — wrong types here used to surface as confusing
  // failures deep in browse rendering (review 2026-06-11b).
  if (!Array.isArray(merged.claude.quickPrompts) || merged.claude.quickPrompts.some((p) => typeof p !== 'string')) {
    console.error('[config] claude.quickPrompts is not a string array — using defaults')
    merged.claude.quickPrompts = defaults.claude.quickPrompts
  }
  if (typeof merged.notifications.packageMap !== 'object' || merged.notifications.packageMap === null || Array.isArray(merged.notifications.packageMap)) {
    console.error('[config] notifications.packageMap is not an object — using defaults')
    merged.notifications.packageMap = defaults.notifications.packageMap
  }
  if (!Array.isArray(merged.notifications.blockTitles) || merged.notifications.blockTitles.some((t) => typeof t !== 'string')) {
    console.error('[config] notifications.blockTitles is not a string array — using defaults')
    merged.notifications.blockTitles = defaults.notifications.blockTitles
  }
  return merged
}

export function saveConfig(config: G2CCConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}
