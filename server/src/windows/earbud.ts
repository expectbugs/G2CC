// windows/earbud.ts — the Earbud window: the Companion voice session + music
// control on glass (earbud lane 2026-08-04, docs/EARBUD_SPEC.md §C8).
//
// A SessionLevel shell (the windows/cc.ts pattern) over THE Companion CC
// session (cwd = config.companion.dir, persona in its CLAUDE.md, audio tools
// via --mcp-config) plus Music/Queue browse levels driven by the
// EarbudAudioService. Output policy: replies render here as text when this
// window is the visible focus; otherwise they SPEAK (speakMode 'auto' —
// Adam's rule), always landing in the scrollback first (speech is a
// projection of the record).
//
// Voice-confirm flow (Adam 2026-08-04): a transcript at confidence ≥
// companion.confirmThreshold auto-sends (trust-the-transcript ≈95%); below it
// — glasses visible → the classic Confirm/Re-record/Cancel card; audio-only →
// a SPOKEN confirm loop ("say send or cancel") that waits forever. No
// auto-confirm, no timeouts, ever.

import type { OsWindow, WmContext, WinView, SttMeta } from './types.js'
import { browsePageItems } from './_browse.js'
import { SessionLevel, type Effort } from './_session.js'
import { tryGetEarbud, type EarbudAudioService, type EarbudTrack } from '../earbud.js'
import { listArtists, tracksByArtist, searchTracks, randomTracks, toEarbudTrack } from '../music.js'
import { needsDigest, spokenDigest } from '../speak-digest.js'
import { saveConfig } from '../config.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SEND_RE = /^\s*(send( it)?|yes|yeah|yep|confirm|do it|go( ahead)?|ok(ay)?)[.!]?\s*$/i
const CANCEL_RE = /^\s*(cancel|no|nope|stop|scratch that|never ?mind|discard)[.!]?\s*$/i

/** Spoken-style addendum appended to the Companion's system prompt (the bulk
 *  of the persona lives in config.companion.dir/CLAUDE.md). */
const COMPANION_PROMPT_ADDENDUM =
  'Your reply text is usually SPOKEN aloud via TTS into one earbud. Keep replies to 1-3 short '
  + 'plain-prose sentences; no markdown, no lists, no code blocks (long detail: say it is on the '
  + 'glasses — your full text lands there automatically). Use your g2cc-earbud tools decisively.'

export class EarbudWindow implements OsWindow {
  readonly id = 'earbud'
  readonly tab = 'Ear'
  readonly label = 'Earbud'
  readonly category = 'Media' as const
  private level: 'session' | 'music' | 'queue' | 'prompts' = 'session'
  private session: SessionLevel
  private focus: 'content' | 'menu' = 'content'
  private visible = false
  /** Artists list cache for the Music browse level (refreshed on entry). */
  private artists: { artist: string; n: number }[] = []
  private musicOffset = 0
  private queueOffset = 0
  /** The next dictation is a MUSIC SEARCH, not a Companion prompt. */
  private musicSearchPending = false
  /** The spoken-confirm loop's held transcript (audio-only low-confidence). */
  private pendingVoiceConfirm: { text: string; rearms: number } | null = null
  /** Resolved companion config (falls back to defaults under stub configs). */
  private comp: { dir: string; model: string; effort: string; confirmThreshold: number }

  /** The audio service, or null when it never initialized (smoke harnesses).
   *  Callers log/render the honest offline state on null. */
  private audio(): EarbudAudioService | null { return tryGetEarbud() }

  constructor(private ctx: WmContext, private requestRender: () => void) {
    // Stub-config tolerance (the hasDisplay precedent): in-process smoke
    // harnesses hand-build minimal configs without the earbud sections. Fall
    // back to the shipped defaults LOUDLY — production always has them
    // (config.ts defaults + merge).
    const comp = ctx.config.companion ?? (() => {
      ctx.log('[earbud-win] config.companion missing (stub config?) — using built-in defaults')
      return { dir: '/home/user/g2cc-companion', model: 'opus', effort: 'max' as const, confirmThreshold: 0.95 }
    })()
    this.comp = comp
    this.session = new SessionLevel(
      ctx,
      comp.dir,
      {
        model: comp.model,
        effort: comp.effort as Effort,
        systemPrompt: COMPANION_PROMPT_ADDENDUM,
        mcpConfig: join(homedir(), '.g2cc', 'companion-mcp.json'),
        onAssistantText: (text) => { this.speakReply(text) },
        extraIdleMenu: ['Music', 'Queue', 'Speak'],
      },
      requestRender,
      'Companion',
      'Talk',
      'earbud',
    )
  }

  /** Speak a completed Companion turn per the output policy. respectFocus:
   *  when this window is the VISIBLE focus the text is already on glass —
   *  skip TTS in 'auto'. The full text is ALWAYS in the scrollback; what gets
   *  SPOKEN is a model-condensed digest when the reply is long or code-heavy
   *  (Adam mid-build 2026-08-04: never TTS hundreds of code lines — the
   *  glasses hold the full text, the ear gets what matters). */
  private speakReply(text: string): void {
    const e = this.audio()
    if (!e) { this.ctx.log('[earbud-win] audio lane offline — reply is in the scrollback only'); return }
    void (async () => {
      const spoken = needsDigest(text) ? await spokenDigest(text, this.comp.dir) : text
      if (spoken !== text) this.ctx.log(`[earbud-win] reply condensed for speech: ${text.length} → ${spoken.length} chars`)
      const o = await e.speak(spoken, {
        priority: 'queue', source: 'companion-reply', music: 'duck', respectFocus: true,
      })
      if (o.status === 'failed') {
        this.ctx.log(`[earbud-win] companion reply NOT spoken (${o.reason}) — text is in the scrollback`)
      }
    })().catch((err: unknown) => {
      this.ctx.log(`[earbud-win] speakReply pipeline failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** Send a trusted transcript/prompt to the Companion (spawns it on first
   *  use; open() is idempotent + in-flight-shared). onTypedText = the
   *  Enter-is-the-confirm path (intents parity included). */
  private async sendToCompanion(text: string): Promise<void> {
    try {
      await this.session.open()
    } catch (e) {
      this.ctx.log(`[earbud-win] companion spawn failed: ${(e as Error).message}`)
      this.session.showError(`Companion spawn failed: ${(e as Error).message}`, 'Reload to retry.')
      void this.audio()?.speak('The companion failed to start. Details on the glasses.', {
        priority: 'next', source: 'companion-error', music: 'duck',
      })
      this.requestRender()
      return
    }
    await this.session.onTypedText(text)
  }

  summary(): string {
    const st = this.audio()?.status()
    if (st?.track) return `♪ ${st.track.title} · ${st.music}`
    const phase = this.session.phase()
    return phase ?? (st ? 'talk / play music' : 'audio lane offline')
  }

  /** Ribbon preview — in-memory only (EarbudAudioService.status is the
   *  preview cost class; no DB, no spawns, no phone). */
  preview(): string | null {
    const svc = this.audio()
    if (!svc) return 'audio lane offline (service not initialized)'
    const st = svc.status()
    const lines: string[] = []
    lines.push(st.track
      ? `♪ ${st.track.title}${st.track.artist ? ` — ${st.track.artist}` : ''} (${st.music} ${st.queuePos})`
      : 'no music playing')
    const phase = this.session.phase()
    lines.push(`Companion: ${phase ?? (this.session.alive() ? 'idle' : 'not started')}`)
    lines.push(`speak ${st.speakMode}${st.caps === null ? ' · NO PHONE' : st.caps.includes('audio-out') ? '' : ' · APK lacks audio-out'}${st.capturing ? ' · MIC LIVE' : ''}${st.speaking ? ' · speaking' : ''}`)
    return lines.join('\n')
  }

  async view(): Promise<WinView> {
    const menuMode = this.focus === 'menu' ? 'capture' as const : 'passive' as const
    if (this.level === 'music') {
      const rows = ['▶ Random mix', '🎤 Search by voice', ...this.artists.map((a) => `${a.artist} (${a.n})`)]
      const { items } = browsePageItems(rows, this.musicOffset)
      return { mode: 'browse', menuMode, title: 'Earbud · music', menu: ['Reload', 'Main'], items }
    }
    if (this.level === 'queue') {
      const e = this.audio()
      const rows = e && e.musicQueue.length
        ? e.musicQueue.map((t, i) => `${i === e.musicIdx ? '▶ ' : ''}${t.title}`)
        : [e ? '(queue empty — Music to pick something)' : '(audio lane offline)']
      const { items } = browsePageItems(rows, this.queueOffset)
      return { mode: 'browse', menuMode, title: `Earbud · queue ${e?.status().queuePos ?? '—'}`, menu: ['Reload', 'Main'], items }
    }
    if (this.level === 'prompts') {
      // The Companion has no quick prompts yet — bounce back (kept so the
      // SessionLevel's 'prompts' return value can't strand the window).
      this.level = 'session'
    }
    return this.session.view(this.label)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'session') {
      this.ctx.log(`[earbud-win] menu '${label}' outside session level — ignored`)
      return
    }
    // Window-owned rows (extraIdleMenu) — intercepted BEFORE SessionLevel.
    if (label === 'Music') {
      try {
        this.artists = await listArtists()
      } catch (e) {
        this.ctx.log(`[earbud-win] artist list failed: ${(e as Error).message}`)
        this.artists = []
      }
      this.level = 'music'
      this.musicOffset = 0
      this.focus = 'content'
      this.requestRender()
      return
    }
    if (label === 'Queue') {
      this.level = 'queue'
      this.queueOffset = 0
      this.focus = 'content'
      this.requestRender()
      return
    }
    if (label === 'Speak') {
      // Cycle the output mode auto → always → never → auto; persisted.
      if (!this.ctx.config.audioOut) { this.ctx.log('[earbud-win] Speak cycle: config.audioOut missing (stub config) — ignored'); return }
      const cur = this.ctx.config.audioOut.speakMode
      const next = cur === 'auto' ? 'always' : cur === 'always' ? 'never' : 'auto'
      this.ctx.config.audioOut.speakMode = next
      try { saveConfig(this.ctx.config) } catch (e) {
        this.ctx.log(`[earbud-win] speakMode persist failed (live value still ${next}): ${(e as Error).message}`)
      }
      this.ctx.log(`[earbud-win] speakMode: ${cur} → ${next}`)
      this.requestRender()
      return
    }
    if (label === 'Talk') {
      // Warm the Companion in parallel with the mic (open is idempotent).
      void this.session.open().catch((e: unknown) => {
        this.ctx.log(`[earbud-win] companion pre-spawn failed (send will retry): ${e instanceof Error ? e.message : String(e)}`)
      })
    }
    const r = await this.session.onMenu(label)
    if (r === 'prompts') { this.level = 'session'; this.requestRender() }  // no quick prompts yet
    else if (r === 'options') { this.ctx.log('[earbud-win] options level not offered for the Companion (config-driven)'); this.requestRender() }
  }

  async onBrowseSelect(index: number): Promise<void> {
    const e = this.audio()
    if (!e) { this.ctx.log('[earbud-win] browse select with the audio lane offline — ignored'); return }
    if (this.level === 'music') {
      const rows = ['▶ Random mix', '🎤 Search by voice', ...this.artists.map((a) => `${a.artist} (${a.n})`)]
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.musicOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[earbud-win] music: index ${index} out of range`); return }
      if (m === -1) { this.musicOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.musicOffset = nextOffset; this.requestRender(); return }
      try {
        if (m === 0) {
          const tracks = (await randomTracks(30)).map(toEarbudTrack)
          if (!e.playQueue(tracks, 0, 'earbud-win random')) this.ctx.log('[earbud-win] random mix refused (no media-capable phone)')
          this.level = 'session'
        } else if (m === 1) {
          this.musicSearchPending = true
          this.ctx.audio('start', 'dictate')
          this.ctx.log('[earbud-win] music search — dictate the query')
        } else {
          const artist = this.artists[m - 2]
          if (!artist) { this.ctx.log(`[earbud-win] music: no artist at ${m - 2}`); return }
          const tracks = (await tracksByArtist(artist.artist)).map(toEarbudTrack)
          if (!e.playQueue(tracks, 0, `earbud-win artist ${artist.artist}`)) this.ctx.log('[earbud-win] artist play refused (no media-capable phone)')
          this.level = 'session'
        }
      } catch (err) {
        this.ctx.log(`[earbud-win] music action failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      this.requestRender()
      return
    }
    if (this.level === 'queue') {
      const rows = e.musicQueue.length ? e.musicQueue.map((t) => t.title) : ['(empty)']
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.queueOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[earbud-win] queue: index ${index} out of range`); return }
      if (m === -1) { this.queueOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.queueOffset = nextOffset; this.requestRender(); return }
      if (e.musicQueue.length === 0) return
      const tracks: EarbudTrack[] = e.musicQueue
      e.playQueue(tracks, m, 'earbud-win queue jump')
      this.requestRender()
      return
    }
    this.ctx.log(`[earbud-win] browse select at session level — ignored`)
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'music' || this.level === 'queue') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'session'
      this.requestRender()
      return true
    }
    this.session.stopDictation('left window')
    return false
  }

  onActivate(): void { this.visible = true }
  onDeactivate(): void {
    this.visible = false
    this.session.stopDictation('window switch')
    // Review 2026-08-04 #8: a stale music-search flag would eat a LATER
    // unrelated transcript (e.g. a companion PTT hours on) as a music query.
    if (this.musicSearchPending) {
      this.ctx.log('[earbud-win] leaving window with music search pending — cleared')
      this.musicSearchPending = false
    }
  }

  statusLine(): string | null {
    const st = this.audio()?.status()
    if (st?.track && st.music === 'playing') return `♪ ${st.track.title}`
    return this.session.phase()
  }

  interruptible(): boolean {
    return !this.session.dictationBusy() && this.pendingVoiceConfirm === null
  }

  async onReload(): Promise<void> {
    await this.session.onReload()
    this.focus = 'content'
  }

  /** The dictation router — arbitration order:
   *  1. music search  2. spoken-confirm loop  3. the confidence gate. */
  async onStt(text: string, meta?: SttMeta): Promise<void> {
    const e = this.audio()
    if (!e) {
      // Audio lane offline (smoke harness / broken boot): the Companion still
      // works as a glasses-text session — trust the transcript straight in.
      this.ctx.log('[earbud-win] onStt with the audio lane offline — sending without voice flows')
      await this.sendToCompanion(text)
      this.requestRender()
      return
    }
    if (this.musicSearchPending) {
      this.musicSearchPending = false
      try {
        const rows = await searchTracks(text, 200)
        if (rows.length === 0) {
          void e.speak(`No matches for ${text}.`, { priority: 'next', source: 'music-search', music: 'duck' })
          this.ctx.log(`[earbud-win] music search "${text}" — 0 matches`)
        } else {
          const tracks = rows.map(toEarbudTrack)
          e.playQueue(tracks, 0, `earbud-win search "${text}"`)
          void e.speak(`Playing ${tracks.length === 1 ? tracks[0].title : `${tracks.length} tracks`}.`, { priority: 'next', source: 'music-search', music: 'duck' })
        }
      } catch (err) {
        this.ctx.log(`[earbud-win] music search failed: ${err instanceof Error ? err.message : String(err)}`)
        void e.speak('Music search failed. Details on the glasses.', { priority: 'next', source: 'music-search', music: 'duck' })
      }
      this.level = 'session'
      this.requestRender()
      return
    }
    if (this.pendingVoiceConfirm) {
      const pending = this.pendingVoiceConfirm
      if (SEND_RE.test(text)) {
        this.pendingVoiceConfirm = null
        this.ctx.log(`[earbud-win] voice-confirm ACCEPTED — sending: "${pending.text.slice(0, 60)}"`)
        e.chime('done')
        await this.sendToCompanion(pending.text)
        this.requestRender()
        return
      }
      if (CANCEL_RE.test(text)) {
        this.pendingVoiceConfirm = null
        this.ctx.log(`[earbud-win] voice-confirm CANCELLED — dropped: "${pending.text.slice(0, 60)}"`)
        void e.speak('Cancelled.', { priority: 'now', source: 'voice-confirm', music: 'duck' })
        this.requestRender()
        return
      }
      // Unrecognized answer: keep waiting (NO auto-anything). Re-arm the mic
      // ONCE; after that the pending confirm stays — he answers via another
      // PTT tap or the glasses card whenever he's ready.
      this.ctx.log(`[earbud-win] voice-confirm: unrecognized answer "${text.slice(0, 60)}" — still pending`)
      if (pending.rearms < 1) {
        pending.rearms++
        void e.speak('Say send, or cancel.', { priority: 'now', source: 'voice-confirm', music: 'duck' })
          .then((o) => {
            // Review 2026-08-04 #3: re-arm the mic ONLY when the prompt was
            // actually heard — with TTS unavailable (no caps / speakMode never)
            // an unconditional re-arm opened a SILENT mic with zero user cue.
            // The pending confirm stays; the glasses card / a PTT tap answers.
            if (o.status !== 'played') {
              this.ctx.log(`[earbud-win] voice-confirm prompt not heard (${o.status}: ${o.reason ?? ''}) — NOT re-arming the mic; confirm stays pending`)
              return
            }
            this.ctx.setVoiceTarget?.('earbud')
            this.ctx.audio('start', 'dictate')
          })
      } else {
        void e.speak('Still waiting. Tap and say send or cancel.', { priority: 'now', source: 'voice-confirm', music: 'duck' })
      }
      return
    }
    // Confidence gate (Adam 2026-08-04): trust ≥ threshold; below it confirm.
    const conf = meta?.confidence ?? 1   // typed/unknown-origin = trusted
    const threshold = this.comp.confirmThreshold
    if (conf >= threshold) {
      await this.sendToCompanion(text)
      this.requestRender()
      return
    }
    this.ctx.log(`[earbud-win] confidence ${conf.toFixed(2)} < ${threshold} — confirming ("${text.slice(0, 60)}")`)
    if (this.visible && (this.ctx.hasDisplay?.() ?? true)) {
      // Glasses in view → the classic Confirm/Re-record/Cancel card.
      await this.session.onStt(text)
      this.requestRender()
      return
    }
    // Audio-only → the spoken confirm loop (waits forever; no auto-confirm).
    this.pendingVoiceConfirm = { text, rearms: 0 }
    void e.speak(`I heard: ${text}. Say send, or cancel.`, { priority: 'now', source: 'voice-confirm', music: 'duck' })
      .then((o) => {
        // Review 2026-08-04 #3 (same rule as the re-arm site): no heard
        // prompt → no silent mic. The confirm waits for a PTT/card answer.
        if (o.status !== 'played') {
          this.ctx.log(`[earbud-win] voice-confirm prompt not heard (${o.status}: ${o.reason ?? ''}) — NOT arming the mic; confirm stays pending`)
          return
        }
        this.ctx.setVoiceTarget?.('earbud')
        this.ctx.audio('start', 'dictate')
      })
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.musicSearchPending) {
      this.musicSearchPending = false
      this.ctx.log(`[earbud-win] music search dictation failed: ${error}`)
      this.requestRender()
      return
    }
    if (this.pendingVoiceConfirm) {
      // The confirm stays pending (no timeout, no auto-cancel) — he can PTT
      // again whenever. Say so once.
      this.ctx.log(`[earbud-win] voice-confirm capture failed (${error}) — still pending`)
      void this.audio()?.speak('I did not catch that. Tap and say send or cancel.', { priority: 'now', source: 'voice-confirm', music: 'duck' })
      return
    }
    await this.session.onSttError(error)
  }

  async onTypedText(text: string): Promise<void> {
    // Typed input is exact + user-authored — always trusted, any level.
    this.pendingVoiceConfirm = null
    await this.sendToCompanion(text)
  }

  surfaceView() { return this.session.surfaceView() }
}
