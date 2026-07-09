// Voice-control layer (upgrades.md v2 Phase 9) — the PLUMBING + the
// deterministic grammar. Two slices share this:
//
//   9a — Reader voice-paging: while Reader is open and its per-session Voice
//        toggle is on, the mic streams continuously; the server VAD-segments
//        (segmentUtterances) → Parakeet → accepts ONLY a bare "next"/"back".
//   9b — "butterscotch" wake-word OS control: an always-on toggle streams
//        everywhere; each utterance is gated on the wake prefix, then parsed
//        against a DETERMINISTIC grammar (window switch / read / next-back /
//        blank-wake / dictate / timer-note / confirm-cancel).
//
// The grammar + the VAD are PURE FUNCTIONS so they unit-test without a mic.
// ACCURACY (wake-word false-positive/miss rates, VAD thresholds) is tuned on
// REAL factory audio on-glass — NOT on synthetic data (the audio discipline).
// The grammar ships small and grows from real usage.

/** The wake word (Adam 2026-06-13: "butterscotch" — distinctive for STT, low
 *  false-positive rate; supersedes the earlier "G2"). Matched case-insensitively
 *  and tolerant of Parakeet splitting it ("butter scotch"). */
export const WAKE_WORD = 'butterscotch'
// `hey[\s,]+` (review 2026-07-05): Parakeet is a punctuation model and emits
// the vocative comma — "Hey, Butterscotch, blank." — which the old `hey\s+`
// rejected, silently dropping the wake command via the sanctioned quiet path.
// Pure widening: every previously-matching utterance still matches.
const WAKE_RE = /^\s*(?:hey[\s,]+)?butter[\s-]?scotch\b[\s,]*/i

/** Spoken window names → window ids (the DE windows). Kept deterministic; a
 *  name that doesn't match yields no command (logged loudly by the caller). */
export const WINDOW_ALIASES: Record<string, string> = {
  main: 'main', home: 'main', dashboard: 'main',
  mail: 'mail', email: 'mail', 'e-mail': 'mail', inbox: 'mail',
  sms: 'sms', texts: 'sms', text: 'sms', messages: 'sms',
  media: 'media', music: 'media', player: 'media',
  notices: 'notices', notifications: 'notices', alerts: 'notices',
  timers: 'timers', timer: 'timers',
  calendar: 'calendar', agenda: 'calendar', schedule: 'calendar',
  files: 'files', file: 'files',
  reader: 'reader', book: 'reader', books: 'reader',
  games: 'games', game: 'games', chess: 'games',
  search: 'search', find: 'search',
  deliveries: 'deliveries', delivery: 'deliveries', packages: 'deliveries', package: 'deliveries',
  terminal: 'term', term: 'term', tmux: 'term',
  assistant: 'aria', aria: 'aria',
  code: 'cc', claude: 'cc',
  scout: 'scout',
}

export type VoiceCommand =
  | { kind: 'page'; dir: 'next' | 'back' }
  | { kind: 'window'; id: string }
  | { kind: 'blank' }
  | { kind: 'wake' }
  | { kind: 'dictate' }
  | { kind: 'read'; target: string }   // "read first email", "read Becky's last text" — best-effort
  | { kind: 'confirm' }
  | { kind: 'cancel' }

/** Normalize an utterance: lowercased, trimmed, punctuation stripped to spaces. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').replace(/\s+/g, ' ').trim()
}

const NEXT_RE = /^(?:next|forward|page\s*(?:down|forward)?|down|continue|go\s+on)$/
const BACK_RE = /^(?:back|previous|prev|page\s*(?:up|back)?|up|go\s+back)$/

/** Parse ONE transcribed utterance into a command.
 *
 *  - `wake:false` (Reader 9a): ONLY a bare next/back paging utterance is
 *    accepted (factory chatter must not page — anything with other words →
 *    null). This is the proof slice.
 *  - `wake:true` (9b global): the utterance MUST start with the wake word; the
 *    remainder is parsed against the grammar. A wake-prefixed utterance that
 *    matches no rule returns null (the caller logs it LOUDLY — a real miss).
 *    A non-prefixed utterance returns null silently (the caller debug-logs it).
 *
 *  Returns null when nothing matches. `prefixed` (2nd return) tells the caller
 *  whether the wake word WAS present, so 9b can distinguish "ignore quietly"
 *  (no prefix) from "loud no-match" (prefix but no rule). */
export function parseVoiceCommand(
  transcript: string, opts: { wake: boolean },
): { cmd: VoiceCommand | null; prefixed: boolean } {
  const raw = transcript ?? ''
  if (!opts.wake) {
    // 9a: bare paging only.
    const t = norm(raw)
    if (NEXT_RE.test(t)) return { cmd: { kind: 'page', dir: 'next' }, prefixed: false }
    if (BACK_RE.test(t)) return { cmd: { kind: 'page', dir: 'back' }, prefixed: false }
    return { cmd: null, prefixed: false }
  }
  // 9b: require the wake prefix.
  if (!WAKE_RE.test(raw)) return { cmd: null, prefixed: false }
  const rest = norm(raw.replace(WAKE_RE, ''))
  if (!rest) return { cmd: null, prefixed: true }   // just the wake word — a loud no-op

  // paging
  if (NEXT_RE.test(rest)) return { cmd: { kind: 'page', dir: 'next' }, prefixed: true }
  if (BACK_RE.test(rest)) return { cmd: { kind: 'page', dir: 'back' }, prefixed: true }
  // blank / wake / confirm / cancel / dictate
  if (/^(?:blank|sleep|screen\s+off|go\s+dark)$/.test(rest)) return { cmd: { kind: 'blank' }, prefixed: true }
  if (/^(?:wake|wake\s+up|screen\s+on)$/.test(rest)) return { cmd: { kind: 'wake' }, prefixed: true }
  if (/^(?:confirm|yes|send|do\s+it|okay|ok)$/.test(rest)) return { cmd: { kind: 'confirm' }, prefixed: true }
  if (/^(?:cancel|no|stop|never\s*mind|nevermind|dismiss)$/.test(rest)) return { cmd: { kind: 'cancel' }, prefixed: true }
  if (/^(?:dictate|ask|listen|new\s+prompt|prompt)$/.test(rest)) return { cmd: { kind: 'dictate' }, prefixed: true }

  // read <something> — navigation-class (harmless), executes immediately. The
  // target string is handed to the active flow; full resolution (which mail /
  // which contact) is a follow-up tuning item.
  const rd = /^read\b\s*(.*)$/.exec(rest)
  if (rd) return { cmd: { kind: 'read', target: rd[1].trim() }, prefixed: true }

  // window switch: "open mail", "go to media", "mail", "show sms", "switch to reader"
  const w = /^(?:open|go\s+to|show|switch\s+to|launch)?\s*(.+)$/.exec(rest)
  if (w) {
    const name = w[1].trim()
    const id = WINDOW_ALIASES[name]
    if (id) return { cmd: { kind: 'window', id }, prefixed: true }
  }
  return { cmd: null, prefixed: true }   // wake-prefixed but no rule — caller logs LOUDLY
}

// ============================================================ VAD

/** One detected utterance, as a sample-index range [start, end) into the PCM. */
export interface Utterance { start: number; end: number }

/** Energy VAD over int16 mono PCM. Adaptive: the gate is the estimated noise
 *  floor × a margin, so it is NOT a hard-coded magic level tuned on synthetic
 *  audio — it tracks the clip's own background. Frames above the gate, merged
 *  across short gaps (hangover) and dropped if too brief, become utterances.
 *
 *  Defaults are STRUCTURAL (frame = 30 ms, hangover = 300 ms, min utt = 250 ms)
 *  — sane VAD geometry, not denoising parameters. Real wake-word/segmentation
 *  tuning happens on real factory captures (Phase 9 is [U]-heavy).
 *
 *  Pure + deterministic → unit-testable (a tone burst in silence segments to
 *  exactly the burst; pure silence segments to nothing). */
export function segmentUtterances(
  pcm: Int16Array,
  sampleRate: number,
  opts: { frameMs?: number; hangoverMs?: number; minUttMs?: number; marginDb?: number } = {},
): Utterance[] {
  const frameMs = opts.frameMs ?? 30
  const hangoverMs = opts.hangoverMs ?? 300
  const minUttMs = opts.minUttMs ?? 250
  const marginDb = opts.marginDb ?? 6     // gate = noise floor + 6 dB

  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const nFrames = Math.floor(pcm.length / frameLen)
  if (nFrames === 0) return []

  // per-frame RMS
  const rms = new Float64Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    let sum = 0
    const base = f * frameLen
    for (let i = 0; i < frameLen; i++) { const s = pcm[base + i] / 32768; sum += s * s }
    rms[f] = Math.sqrt(sum / frameLen)
  }
  // noise floor = 20th-percentile RMS (robust to mostly-speech or mostly-silence)
  const sorted = Float64Array.from(rms).sort()
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 1e-6
  const gate = floor * Math.pow(10, marginDb / 20)

  const hangoverFrames = Math.max(1, Math.round(hangoverMs / frameMs))
  const minUttFrames = Math.max(1, Math.round(minUttMs / frameMs))

  const utts: Utterance[] = []
  let inSpeech = false
  let startF = 0
  let silence = 0
  for (let f = 0; f < nFrames; f++) {
    const active = rms[f] >= gate
    if (active) {
      if (!inSpeech) { inSpeech = true; startF = f }
      silence = 0
    } else if (inSpeech) {
      silence++
      if (silence > hangoverFrames) {
        const endF = f - silence + 1
        if (endF - startF >= minUttFrames) utts.push({ start: startF * frameLen, end: endF * frameLen })
        inSpeech = false
      }
    }
  }
  if (inSpeech) {
    const endF = nFrames - silence
    if (endF - startF >= minUttFrames) utts.push({ start: startF * frameLen, end: endF * frameLen })
  }
  return utts
}
