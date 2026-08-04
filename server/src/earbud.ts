// EarbudAudioService — the earbud lane's brain (2026-08-04, docs/EARBUD_SPEC.md).
//
// Owns: the speech queue (TTS → WS binary frames → phone AudioTrack), the
// output policy (glasses-text vs TTS — Adam's rule: speak only when the Earbud
// window is NOT what he's looking at), the half-duplex state machine (capture
// gates speech; music pauses/ducks around both), spoken notifications
// (notifyHub subscriber with the per-priority policy), and the music-lane
// queue/transport state (the phone's ExoPlayer is the sink; this is the state).
//
// Session-lifetime module singleton (the paperclips pattern): playback must
// survive window deactivation, screen blanking, and surface disconnects.
// Dependencies are INJECTED at init (index.ts closes them over getOsSession())
// so this module imports neither os-session nor ws-handler — no cycles.
//
// Absolute rules honored: no I/O timeouts (ack windows are STATUS windows —
// playback continues; only the delivery status falls to 'unverified'); no
// silent failures (every refusal logs + resolves an honest outcome); no
// truncation (speech is a PROJECTION — the full text always lands in the
// caller's scrollback; a killed utterance is a user action, not data loss).

import {
  SPEECH_FRAME_TAG,
  SPEECH_CHUNK_MAX_BYTES,
  SPEAK_ACK_MARGIN_MS,
  SPEECH_DUCK_DB,
  TTS_SAMPLE_RATE,
} from '@g2cc/shared'
import type { ServerMessage, SpeakAckMsg, MediaEventMsg, ChimeName } from '@g2cc/shared'
import type { G2CCConfig } from './config.js'
import { getTtsDaemon } from './tts.js'
import { notifyHub, type NotifyEvent } from './os-notify.js'

export interface EarbudDeps {
  /** JSON to the newest phone surface; false (already loudly logged by the
   *  os-session) when none is attached. */
  toPhone: (msg: ServerMessage, what: string) => boolean
  /** Binary frame to the newest phone surface; false when none/not-open. */
  toPhoneBinary: (buf: Buffer, what: string) => boolean
  /** WM focus accessors (window-manager.ts additions). */
  activeWindowId: () => string
  isScreenIdle: () => boolean
  hasDisplay: () => boolean
}

export interface EarbudTrack {
  id: number
  title: string
  artist?: string
  album?: string
  durMs?: number
}

export type SpeakOutcome = {
  status: 'played' | 'unverified' | 'failed' | 'skipped'
  reason?: string
  route?: string
}

export interface SpeakOpts {
  /** 'now' = flush the queue and speak immediately (calls, errors, barge-over);
   *  'next' = head of queue (timers/notifications); 'queue' = tail (replies). */
  priority?: 'now' | 'next' | 'queue'
  /** Music behavior while speaking. Default 'duck'. */
  music?: 'duck' | 'pause'
  /** Where this utterance came from — logs + diagnostics. */
  source: string
  /** Companion replies pass true: in speakMode 'auto' the utterance is
   *  SKIPPED when the Earbud window is the visible focus (the text is already
   *  on glass). Notifications/timers pass false — they speak per policy
   *  regardless of what's on screen. */
  respectFocus?: boolean
}

interface QueuedSpeak {
  text: string
  opts: SpeakOpts
  resolve: (o: SpeakOutcome) => void
}

interface PendingSpeakAck {
  /** null until speak_end arms the duration-sized status window (deep-review
   *  #7: the entry must EXIST from before speak_start so the phone's
   *  immediate 'failed' acks — route guard refusals — land instead of being
   *  dropped as unknown). */
  timer: ReturnType<typeof setTimeout> | null
  resolve: (o: SpeakOutcome) => void
  settle: Promise<SpeakOutcome>
}

export type MusicState = 'idle' | 'opening' | 'playing' | 'paused'

export class EarbudAudioService {
  private speakSeq = 0
  private mediaSeq = 0
  private queue: QueuedSpeak[] = []
  /** The utterance currently STREAMING to the phone (synthesis → frames). */
  private speaking: { id: string; num: number } | null = null
  /** Deep-review 2026-08-04 #0: the utterance still AUDIBLE on the phone.
   *  Synthesis runs ~10× realtime, so for most of an utterance's audible life
   *  `speaking` is already null — every cancel path (quiet, now-barge,
   *  half-duplex, the bud tap) must consult THIS slot too, or tail playback
   *  is uncancellable and dictation echoes into the open mic. Set when
   *  speak_start goes out; cleared when the ack settles (any way). */
  private audible: { id: string; num: number } | null = null
  private capturing = false
  private phoneCaps: Set<string> | null = null
  private pendingAcks = new Map<string, PendingSpeakAck>()
  private hubHandler: ((evt: NotifyEvent) => void) | null = null

  // ---- music lane state (the phone's ExoPlayer is the sink) ----
  musicQueue: EarbudTrack[] = []
  musicIdx = 0
  musicState: MusicState = 'idle'
  private mediaId: string | null = null
  private posMs = 0
  private posAt = 0            // Date.now() anchor for extrapolation
  volumePct: number | null = null
  /** Who paused the music lane — 'speech'/'capture' pauses auto-resume;
   *  'user' pauses don't. */
  private pausedBy: 'user' | 'speech' | 'capture' | null = null
  private duckedForSpeech = false

  constructor(private config: G2CCConfig, private deps: EarbudDeps) {}

  // ---- caps (which APK is attached) ----

  /** ws-handler calls this on phone os_attach (with the auth caps) and with
   *  null when the last phone surface detaches. */
  notePhoneCaps(caps: string[] | null): void {
    this.phoneCaps = caps === null ? null : new Set(caps)
    console.log(`[earbud] phone caps: ${caps === null ? 'none (no phone)' : caps.join(',') || '(empty — pre-1.20 APK)'}`)
    if (caps === null) {
      // Phone WS gone. SPEECH died with it (the app cancels its speech lane
      // on disconnect); MUSIC did NOT — the ExoPlayer streams over its own
      // HTTP connection and keeps playing (deep-review #14: forcing 'idle'
      // here made the re-attached phone's honest 'ended' event look stale and
      // the queue never advanced). Keep the music model; the phone's next
      // media_event re-anchors it.
      if (this.musicState === 'playing' || this.musicState === 'opening') {
        console.warn(`[earbud] phone WS gone mid-playback — music model RETAINED (the ExoPlayer keeps streaming; state re-anchors on re-attach)`)
      }
      this.duckedForSpeech = false
      for (const [id, p] of this.pendingAcks) {
        if (p.timer) clearTimeout(p.timer)
        p.resolve({ status: 'unverified', reason: 'phone disconnected before ack' })
        console.warn(`[earbud] speak ${id} → unverified (phone disconnected)`)
      }
      this.pendingAcks.clear()
      this.audible = null
      this.earsRequested = false
      this.handsfreeLive = false
    } else {
      // Deep-review #6/G: jobs queued while no capable phone was attached
      // WAIT (pump gates on caps) — a returning phone drains them.
      void this.pump()
      this.syncEars('phone attached')
    }
  }

  private capable(cap: 'audio-out' | 'media-lane' | 'earbud-buttons'): boolean {
    return this.phoneCaps !== null && this.phoneCaps.has(cap)
  }

  /** Deep-review #2/#8/#9/#15/#28: THE single door for every earbud-family
   *  JSON send — a message never reaches a phone that didn't announce the
   *  matching cap (a pre-1.20 APK logs a decode failure per unknown type).
   *  Refusals are loud and reported. */
  private sendCapped(cap: 'audio-out' | 'media-lane', msg: ServerMessage, what: string): boolean {
    if (!this.capable(cap)) {
      console.warn(`[earbud] ${what} NOT sent — attached phone lacks '${cap}' (caps: ${this.phoneCaps === null ? 'no phone' : [...this.phoneCaps].join(',') || 'none'})`)
      return false
    }
    return this.deps.toPhone(msg, what)
  }

  // ---- speech lane ----

  /** Speak text into the earbud. Resolves with the HONEST delivery outcome —
   *  'played' (phone confirmed a verified BT route + drained playback),
   *  'unverified' (no ack inside the status window), 'failed' (refused: no
   *  capable phone / route guard / synth error before any audio), or
   *  'skipped' (policy said don't speak — on-glass focus or speakMode).
   *  NEVER rejects. The caller owns putting the text in a scrollback FIRST —
   *  speech is a projection of the record, not the record. */
  speak(text: string, opts: SpeakOpts): Promise<SpeakOutcome> {
    if (this.config.audioOut.speakMode === 'never') {
      return Promise.resolve({ status: 'skipped', reason: 'audioOut.speakMode=never' })
    }
    if (opts.respectFocus && this.config.audioOut.speakMode === 'auto'
        && this.deps.hasDisplay() && !this.deps.isScreenIdle()
        && this.deps.activeWindowId() === 'earbud') {
      return Promise.resolve({ status: 'skipped', reason: 'earbud window is the visible focus (text on glass)' })
    }
    if (!this.capable('audio-out')) {
      console.error(`[earbud] speak(${opts.source}) refused — no audio-out-capable phone attached`)
      return Promise.resolve({ status: 'failed', reason: 'no audio-out-capable phone attached' })
    }
    return new Promise<SpeakOutcome>((resolve) => {
      const job: QueuedSpeak = { text, opts, resolve }
      const pri = opts.priority ?? 'queue'
      if (pri === 'now') {
        // Flush: queued jobs resolve 'skipped' (honest — they never played),
        // the in-flight utterance — STREAMING or still AUDIBLE (deep-review
        // #0) — is cancelled on the phone, and this job goes first.
        for (const q of this.queue.splice(0)) {
          q.resolve({ status: 'skipped', reason: 'flushed by a now-priority utterance' })
        }
        this.cancelPlayback(`now-priority ${opts.source}`)
        this.queue.unshift(job)
      } else if (pri === 'next') {
        this.queue.unshift(job)
      } else {
        this.queue.push(job)
      }
      void this.pump()
    })
  }

  /** Fire a phone-local earcon. Cheap, honest about refusals, never throws. */
  chime(name: ChimeName): void {
    if (!this.config.audioOut.chimes) return
    if (!this.capable('audio-out')) return    // no earcon sink — quiet no-op, caps already logged
    this.sendCapped('audio-out', { type: 'chime', name }, `chime(${name})`)
  }

  /** Barge-in / user-quiet: stop current speech (streaming OR audible tail)
   *  + flush the queue. */
  quiet(reason: string): void {
    for (const q of this.queue.splice(0)) {
      q.resolve({ status: 'skipped', reason: `quiet: ${reason}` })
    }
    this.cancelPlayback(reason)
  }

  /** Is any utterance streaming or still audible on the phone? The bud tap /
   *  half-duplex / barge paths key on this (deep-review #0). */
  private speechLive(): boolean {
    return this.speaking !== null || this.audible !== null
  }

  /** Cancel whatever speech the phone has — the STREAMING utterance and/or
   *  the AUDIBLE tail. The phone acks the cancelled utterance honestly
   *  (played+cancelled / failed+cancelled), which settles its pending entry;
   *  the streaming slot frees immediately so the pump can move on. */
  private cancelPlayback(reason: string): void {
    const target = this.speaking ?? this.audible
    if (!target) return
    console.log(`[earbud] cancelling utterance ${target.num} (${reason}; ${this.speaking ? 'streaming' : 'audible tail'})`)
    this.sendCapped('audio-out', { type: 'speak_cancel', num: target.num }, 'speak_cancel')
    this.speaking = null
  }

  private pumping = false
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        if (this.capturing) {
          // Review 2026-08-04 #4: deferring queued speech (even 'now'
          // priority — a call alert) behind a live capture is by design
          // (half-duplex), but it must never be a SILENT defer.
          console.log(`[earbud] ${this.queue.length} queued utterance(s) DEFERRED behind a live capture (half-duplex) — they play on capture end`)
          return
        }
        if (!this.capable('audio-out')) {
          // Deep-review #6: jobs queued when the phone dropped WAIT here (loud)
          // instead of burning as failures into a closing socket — the
          // notePhoneCaps(caps) re-pump drains them when a capable phone returns.
          console.warn(`[earbud] ${this.queue.length} queued utterance(s) HELD — no audio-out-capable phone attached (they play on reattach)`)
          return
        }
        if (this.speaking) return           // a cancel is still settling; ack path re-pumps
        const job = this.queue.shift()!
        const outcome = await this.speakOne(job)
        job.resolve(outcome)
      }
    } finally {
      this.pumping = false
    }
    // A job queued while we were draining (races the flag) — one more pass.
    if (this.queue.length > 0 && !this.capturing && !this.speaking) void this.pump()
  }

  private async speakOne(job: QueuedSpeak): Promise<SpeakOutcome> {
    const num = (this.speakSeq = (this.speakSeq + 1) >>> 0)
    const id = `spk-${Date.now()}-${num}`
    const music = job.opts.music ?? 'duck'
    const duckDb = this.config.audioOut.duckDb ?? SPEECH_DUCK_DB

    // Music etiquette (own lane only; third-party apps duck via the phone's
    // AudioFocus request when the speech AudioTrack starts). 'opening' counts
    // as playing (deep-review #4: a track mid-open would land at full volume
    // under the speech otherwise).
    if (this.musicState === 'playing' || this.musicState === 'opening') {
      if (music === 'pause') this.pauseMusic('speech')
      else {
        this.sendCapped('media-lane', { type: 'media_ctl', cmd: 'duck', value: duckDb }, 'media_ctl(duck)')
        this.duckedForSpeech = true
      }
    }

    // Register the ack entry BEFORE anything is sent (deep-review #7): the
    // phone's route guard can ack 'failed' the instant it sees speak_start.
    const ackPromise = this.registerAck(id)
    this.speaking = { id, num }
    this.audible = { id, num }
    if (!this.sendCapped('audio-out', { type: 'speak_start', id, num, music, duckDb }, `speak_start(${job.opts.source})`)) {
      this.speaking = null
      this.audible = null
      this.settleAck(id, { status: 'failed', reason: 'phone surface vanished before speak_start' })
      this.restoreMusicAfterSpeech()
      return ackPromise
    }

    let chunks = 0
    let totalMs = 0
    let synthError: string | null = null
    try {
      await getTtsDaemon(this.config).synthesize(job.text, (chunk) => {
        // The utterance may have been cancelled mid-synthesis — stop framing,
        // let the remaining chunks fall on the floor (daemon still completes).
        if (this.speaking?.num !== num) return
        // Mid-utterance phone swap (deep-review #9): a phone without the cap
        // must not receive raw frames either.
        if (!this.capable('audio-out')) throw new Error('capable phone vanished mid-utterance')
        let off = 0
        while (off < chunk.pcm.length) {
          const slice = chunk.pcm.subarray(off, off + SPEECH_CHUNK_MAX_BYTES)
          const frame = Buffer.alloc(9 + slice.length)
          frame.writeUInt8(SPEECH_FRAME_TAG, 0)
          frame.writeUInt32BE(num, 1)
          frame.writeUInt32BE(chunks, 5)
          slice.copy(frame, 9)
          if (!this.deps.toPhoneBinary(frame, `speech frame ${num}/${chunks}`)) {
            throw new Error('phone surface vanished mid-utterance')
          }
          chunks++
          off += slice.length
        }
        totalMs += chunk.ms
      })
    } catch (e) {
      synthError = e instanceof Error ? e.message : String(e)
      console.error(`[earbud] synthesis/streaming failed for ${id} (${job.opts.source}): ${synthError}`)
    }

    const cancelled = this.speaking?.num !== num
    if (cancelled) {
      // cancelPlayback already sent speak_cancel; the phone's honest ack (or
      // the margin window below) settles the entry. Report the flush.
      this.armAckWindow(id, totalMs + SPEAK_ACK_MARGIN_MS)
      this.restoreMusicAfterSpeech()
      void ackPromise.then(() => { if (this.audible?.num === num) this.audible = null; void this.pump() })
      return { status: 'skipped', reason: 'cancelled mid-utterance' }
    }

    if (chunks === 0) {
      // Nothing speakable reached the phone (empty prep or instant failure).
      this.sendCapped('audio-out', { type: 'speak_cancel', num }, 'speak_cancel(empty)')
      this.speaking = null
      const reason = synthError ?? 'nothing speakable in the text (code-only reply?)'
      console.warn(`[earbud] ${id} produced no audio — ${reason}`)
      this.settleAck(id, { status: 'failed', reason })
      this.audible = null
      this.restoreMusicAfterSpeech()
      return ackPromise
    }

    this.sendCapped('audio-out', { type: 'speak_end', id, num, chunks, totalMs }, 'speak_end')
    this.speaking = null
    this.armAckWindow(id, totalMs + SPEAK_ACK_MARGIN_MS)

    const ack = await ackPromise
    if (this.audible?.num === num) this.audible = null
    this.restoreMusicAfterSpeech()
    if (synthError && ack.status === 'played') {
      // Partial utterance played, tail lost to a synth error — honest report.
      return { status: 'played', reason: `partial: ${synthError}`, route: ack.route }
    }
    void this.pump()
    return ack
  }

  private restoreMusicAfterSpeech(): void {
    if (this.duckedForSpeech) {
      this.sendCapped('media-lane', { type: 'media_ctl', cmd: 'unduck' }, 'media_ctl(unduck)')
      this.duckedForSpeech = false
    }
    if (this.pausedBy === 'speech') {
      this.resumeMusic('speech-end')
    }
  }

  /** Create the pending entry + its settle promise. NO window yet — the
   *  duration isn't known until synthesis completes; the entry exists so an
   *  early phone ack lands (deep-review #7/#13). */
  private registerAck(id: string): Promise<SpeakOutcome> {
    let resolveFn: (o: SpeakOutcome) => void = () => {}
    const settle = new Promise<SpeakOutcome>((resolve) => { resolveFn = resolve })
    this.pendingAcks.set(id, { timer: null, resolve: resolveFn, settle })
    return settle
  }

  /** Attach the duration-sized status window to a registered entry. NOT an
   *  I/O timeout — playback continues; only the STATUS falls to unverified. */
  private armAckWindow(id: string, windowMs: number): void {
    const pending = this.pendingAcks.get(id)
    if (!pending) return   // already settled (early ack) — nothing to arm
    pending.timer = setTimeout(() => {
      if (!this.pendingAcks.has(id)) return
      this.pendingAcks.delete(id)
      console.warn(`[earbud] no speak_ack for ${id} within ${Math.round(windowMs)}ms — unverified`)
      if (this.audible?.id === id) this.audible = null
      pending.resolve({ status: 'unverified', reason: `no ack within ${Math.round(windowMs)}ms` })
    }, windowMs)
  }

  /** Resolve + remove a pending entry locally (refusal paths). */
  private settleAck(id: string, outcome: SpeakOutcome): void {
    const pending = this.pendingAcks.get(id)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingAcks.delete(id)
    pending.resolve(outcome)
  }

  /** ws-handler routes SpeakAckMsg here. */
  onSpeakAck(msg: SpeakAckMsg): void {
    const pending = this.pendingAcks.get(msg.id)
    if (!pending) {
      console.log(`[earbud] speak_ack for unknown/expired id ${msg.id} (status=${msg.status}${msg.reason ? `, ${msg.reason}` : ''})`)
      return
    }
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingAcks.delete(msg.id)
    if (this.audible?.id === msg.id) this.audible = null   // the tail is over (deep-review #0)
    console.log(`[earbud] speak_ack ${msg.id}: ${msg.status}${msg.route ? ` via ${msg.route}` : ''}${msg.reason ? ` (${msg.reason})` : ''}`)
    pending.resolve({ status: msg.status, reason: msg.reason, route: msg.route })
  }

  // ---- half-duplex: capture gates everything ----

  /** ws-handler signals real capture state (audio_start/audio_end from the
   *  phone). Speech is killed (echo: the earbud mic would hear the earbud
   *  speaker with AEC deliberately off), music pauses, queue holds. */
  onCaptureState(live: boolean): void {
    if (this.capturing === live) return
    this.capturing = live
    if (live) {
      this.cancelPlayback('dictation started (half-duplex)')   // streaming AND audible tail (deep-review #0)
      if (this.musicState === 'playing' || this.musicState === 'opening') this.pauseMusic('capture')
    } else {
      if (this.pausedBy === 'capture') this.resumeMusic('capture-end')
      void this.pump()
    }
    this.syncEars(`capture ${live ? 'started' : 'ended'}`)
  }

  // ---- music lane ----

  /** Replace the queue and start playing at startIdx. */
  playQueue(tracks: EarbudTrack[], startIdx = 0, source = 'unknown'): boolean {
    if (tracks.length === 0) {
      console.warn(`[earbud] playQueue(${source}) with 0 tracks — refusing`)
      return false
    }
    if (!this.capable('media-lane')) {
      console.error(`[earbud] playQueue(${source}) refused — no media-lane-capable phone attached`)
      return false
    }
    this.musicQueue = tracks
    this.musicIdx = Math.min(Math.max(0, startIdx), tracks.length - 1)
    console.log(`[earbud] playQueue(${source}): ${tracks.length} track(s), starting at ${this.musicIdx}`)
    return this.openCurrent()
  }

  private openCurrent(startMs?: number): boolean {
    const track = this.musicQueue[this.musicIdx]
    if (!track) {
      console.error(`[earbud] openCurrent: no track at idx ${this.musicIdx} (queue ${this.musicQueue.length})`)
      return false
    }
    const id = `med-${++this.mediaSeq}`
    const url = `/media/track/${track.id}?token=${encodeURIComponent(this.config.authToken)}&fmt=${this.config.music.format}`
    this.mediaId = id
    this.musicState = 'opening'
    this.posMs = startMs ?? 0
    this.posAt = Date.now()
    this.pausedBy = null
    const ok = this.sendCapped('media-lane', {
      type: 'media_open',
      id,
      url,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durMs: track.durMs,
      startMs,
    }, `media_open(${track.title})`)
    if (!ok) this.musicState = 'idle'
    this.syncEars('media opening')
    return ok
  }

  pauseMusic(by: 'user' | 'speech' | 'capture' = 'user'): void {
    if (this.musicState !== 'playing') return
    this.pausedBy = by
    this.sendCapped('media-lane', { type: 'media_ctl', cmd: 'pause' }, `media_ctl(pause by ${by})`)
  }

  resumeMusic(source = 'user'): void {
    if (this.musicState !== 'paused' && this.musicState !== 'playing') {
      console.log(`[earbud] resume(${source}) ignored — nothing paused (state ${this.musicState})`)
      return
    }
    this.pausedBy = null
    this.sendCapped('media-lane', { type: 'media_ctl', cmd: 'play' }, `media_ctl(play, ${source})`)
  }

  stopMusic(source = 'user'): void {
    this.sendCapped('media-lane', { type: 'media_ctl', cmd: 'stop' }, `media_ctl(stop, ${source})`)
    this.musicState = 'idle'
    this.mediaId = null
    this.pausedBy = null
    this.duckedForSpeech = false
    this.syncEars('music stopped')
  }

  /** Toggle for the earbud single-tap / handsfree "pause". */
  playPauseToggle(source: string): void {
    if (this.musicState === 'playing') this.pauseMusic('user')
    else if (this.musicState === 'paused') this.resumeMusic(source)
    else console.log(`[earbud] play/pause toggle (${source}) — nothing loaded`)
  }

  skip(delta: 1 | -1, source = 'user'): boolean {
    if (this.musicQueue.length === 0) {
      console.log(`[earbud] skip(${source}) — empty queue`)
      return false
    }
    const next = this.musicIdx + delta
    if (next < 0 || next >= this.musicQueue.length) {
      console.log(`[earbud] skip(${source}) hit the ${delta > 0 ? 'end' : 'start'} of the queue`)
      if (delta > 0) { this.stopMusic('queue-end') }
      return false
    }
    this.musicIdx = next
    return this.openCurrent()
  }

  setVolume(pct: number, source = 'user'): void {
    const v = Math.max(0, Math.min(100, Math.round(pct)))
    this.volumePct = v
    this.sendCapped('media-lane', { type: 'media_ctl', cmd: 'volume', value: v }, `media_ctl(volume ${v}, ${source})`)
  }

  // ---- ears (always-on wake-word listening — Adam field report 2026-08-04:
  // "butterscotch" did nothing because NOTHING was capturing; the old 9b
  // always-on stream never shipped) ----
  //
  // The supervisor: handsfree listening runs whenever (earsOn && a capable
  // phone && no dictate capture && music NOT playing/opening). Music wins the
  // radio: continuous SCO capture suspends A2DP on classic BT (Buds 2a =
  // SBC/AAC), so ears-on-while-music-plays would kill the music. While ears
  // are live, TTS rides the SCO downlink (phone-call quality — tolerable;
  // music is not). Dictate PTT swaps the streamer app-side (v1.21).
  private earsRequested = false
  /** The app confirmed a live handsfree capture (its audio_start mode=handsfree). */
  handsfreeLive = false

  earsOn(): boolean { return this.config.audioOut.earsOn !== false }

  setEarsOn(on: boolean, source: string): void {
    this.config.audioOut.earsOn = on
    console.log(`[earbud] ears ${on ? 'ON' : 'OFF'} (${source})`)
    this.syncEars(`setEarsOn(${source})`)
  }

  /** ws-handler: the app announced a handsfree audio_start (truth anchor). */
  noteHandsfreeStarted(): void {
    if (!this.handsfreeLive) console.log('[earbud] handsfree listening LIVE (app confirmed)')
    this.handsfreeLive = true
  }

  /** Reconcile desired vs actual listening state. Idempotent; loud on change. */
  syncEars(reason: string): void {
    const should = this.earsOn()
      && this.capable('audio-out')
      && !this.capturing
      && this.musicState !== 'playing'
      && this.musicState !== 'opening'
    if (should && !this.earsRequested) {
      this.earsRequested = true
      console.log(`[earbud] ears: starting handsfree listening (${reason})`)
      if (!this.deps.toPhone({ type: 'audio_request', action: 'start', mode: 'handsfree' }, 'audio_request(ears)')) {
        this.earsRequested = false
      }
    } else if (!should && this.earsRequested) {
      this.earsRequested = false
      this.handsfreeLive = false
      console.log(`[earbud] ears: stopping handsfree listening (${reason})`)
      this.deps.toPhone({ type: 'audio_request', action: 'stop' }, 'audio_request(ears stop)')
    }
  }

  /** ws-handler routes MediaEventMsg here — the phone's honest player state. */
  onMediaEvent(msg: MediaEventMsg): void {
    if (msg.id !== this.mediaId) {
      console.log(`[earbud] media_event for stale id ${msg.id} (current ${this.mediaId ?? 'none'}) — ignored`)
      return
    }
    if (typeof msg.posMs === 'number') { this.posMs = msg.posMs; this.posAt = Date.now() }
    switch (msg.state) {
      case 'playing':
        this.musicState = 'playing'
        break
      case 'paused':
        this.musicState = 'paused'
        break
      case 'ended': {
        const hadNext = this.musicIdx + 1 < this.musicQueue.length
        console.log(`[earbud] track ended (${this.musicIdx + 1}/${this.musicQueue.length})${hadNext ? ' — advancing' : ' — queue done'}`)
        if (hadNext && !this.capturing && this.pausedBy === null) {
          this.musicIdx++
          this.openCurrent()
        } else {
          this.musicState = 'idle'
          this.mediaId = null
          if (!hadNext) this.chime('done')
        }
        break
      }
      case 'error':
        console.error(`[earbud] media error on ${msg.id}: ${msg.reason ?? 'unknown'}`)
        this.musicState = 'idle'
        this.mediaId = null
        this.chime('error')
        break
    }
    this.syncEars(`media ${msg.state}`)
  }

  /** Extrapolated position for previews/status lines. */
  positionMs(): number {
    if (this.musicState !== 'playing') return this.posMs
    return this.posMs + (Date.now() - this.posAt)
  }

  nowPlaying(): EarbudTrack | null {
    return this.musicState === 'idle' ? null : this.musicQueue[this.musicIdx] ?? null
  }

  /** Cheap in-memory status for preview()/statusLine() — the preview cost class. */
  status(): {
    speakMode: string; capturing: boolean; speaking: boolean; queued: number
    music: MusicState; track: EarbudTrack | null; queuePos: string; posMs: number
    caps: string[] | null
  } {
    return {
      speakMode: this.config.audioOut.speakMode,
      capturing: this.capturing,
      // streaming OR audible — the bud tap keys on this (deep-review #0)
      speaking: this.speechLive(),
      queued: this.queue.length,
      music: this.musicState,
      track: this.nowPlaying(),
      queuePos: this.musicQueue.length ? `${this.musicIdx + 1}/${this.musicQueue.length}` : '—',
      posMs: this.positionMs(),
      caps: this.phoneCaps === null ? null : [...this.phoneCaps],
    }
  }

  // ---- spoken notifications ----

  /** Subscribe to the notify hub (once, at boot). quiet:true events never
   *  reach the hub, so only live notifications arrive here. */
  subscribeNotifications(): void {
    if (this.hubHandler) return
    this.hubHandler = (evt: NotifyEvent) => {
      try {
        this.onNotification(evt)
      } catch (e) {
        console.error(`[earbud] notification speech handler failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    notifyHub.on('notification', this.hubHandler)
    console.log('[earbud] spoken-notification policy subscribed to notifyHub')
  }

  private onNotification(evt: NotifyEvent): void {
    const policy = this.config.audioOut.notify[evt.priority]
    if (!policy || policy === 'silent') return
    if (!this.capable('audio-out')) return   // nothing to play through; notice stays visual
    const chimeName: ChimeName = evt.priority === 'timer' ? 'timer' : 'notify'
    this.chime(chimeName)
    if (policy === 'chime') return
    const text = policy === 'chime+name'
      ? `${evt.priority === 'sms' ? 'Message from ' : ''}${evt.title}`
      : `${evt.title}. ${evt.body}`
    void this.speak(text, { priority: 'next', source: `notify:${evt.priority}`, music: 'duck' })
      .then((o) => {
        if (o.status === 'failed' || o.status === 'unverified') {
          console.warn(`[earbud] spoken notification (${evt.priority} "${evt.title}") delivery ${o.status}: ${o.reason ?? ''}`)
        }
      })
  }

  /** Full teardown for hard reset (ws-handler drives it). Queue + state drop;
   *  durable nothing lives here. Deep-review #5: actually STOP the phone's
   *  player (best-effort — the socket may already be closing) and release the
   *  capture latch; a reset must never fabricate 'idle' while audio plays. */
  reset(): void {
    this.quiet('hard reset')
    this.sendCapped('media-lane', { type: 'media_ctl', cmd: 'stop' }, 'media_ctl(stop, hard reset)')
    this.musicQueue = []
    this.musicIdx = 0
    this.musicState = 'idle'
    this.mediaId = null
    this.pausedBy = null
    this.duckedForSpeech = false
    this.capturing = false
    this.audible = null
    for (const [id, p] of this.pendingAcks) {
      if (p.timer) clearTimeout(p.timer)
      p.resolve({ status: 'unverified', reason: 'hard reset' })
      console.warn(`[earbud] hard reset: speak ${id} → unverified`)
    }
    this.pendingAcks.clear()
    console.warn('[earbud] hard reset: speech queue + music state cleared (capture latch released)')
  }
}

let earbudService: EarbudAudioService | null = null

export function initEarbud(config: G2CCConfig, deps: EarbudDeps): EarbudAudioService {
  if (earbudService) throw new Error('initEarbud called twice — boot-time singleton')
  earbudService = new EarbudAudioService(config, deps)
  earbudService.subscribeNotifications()
  console.log(`[earbud] EarbudAudioService up (speakMode=${config.audioOut.speakMode}, voice=${config.tts.voice}, mic=${config.stt.micSource})`)
  return earbudService
}

export function getEarbud(): EarbudAudioService {
  if (!earbudService) throw new Error('EarbudAudioService not initialized — initEarbud must run at boot')
  return earbudService
}

/** Non-throwing accessor for UI paths that must render even when the audio
 *  lane never initialized (in-process smoke harnesses build a WindowManager
 *  without initEarbud — the hasDisplay-stub precedent). Returns null there;
 *  callers render an honest 'audio lane offline'. Boot paths keep the
 *  throwing getEarbud — a missing init in production is a loud bug. */
export function tryGetEarbud(): EarbudAudioService | null {
  return earbudService
}

/** TTS_SAMPLE_RATE re-export convenience for callers computing durations. */
export const SPEECH_SAMPLE_RATE = TTS_SAMPLE_RATE
