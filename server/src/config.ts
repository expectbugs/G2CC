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

  return {
    ...defaults,
    ...saved,
    stt: { ...defaults.stt, ...(saved.stt ?? {}) },
    claude: { ...defaults.claude, ...(saved.claude ?? {}) },
  }
}

export function saveConfig(config: G2CCConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}
