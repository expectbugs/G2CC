// MusicPlayerService — the music app's player core (MUSIC_SPEC.md D5,
// 2026-08-05 Phase B). The lean replacement for the earbud lane's
// EarbudAudioService: same boot-time session-lifetime singleton + injected-deps
// pattern (imports neither os-session nor ws-handler — no cycles), music lane
// ONLY. Speech/TTS/ears/notification audio are gone (shelved whole to a future
// session, spec D2); the ONE dictation coupling that remains is the capture
// gate, and it's physics (SCO capture suspends A2DP on classic BT).
//
// Owns: the queue + transport state (the phone's ExoPlayer is the sink; this
// is the truth the phone re-anchors), play_history writes (D3.1), the
// player_state persistence mirror (debounced — feeds boot-time resume, which
// NEVER auto-plays; a bud tap is the explicit resume), popup emissions
// (→ WindowManager.musicPopup, D6.3), and the caps door (sendCapped — a
// message never reaches a phone that didn't announce 'media-lane').
//
// Absolute rules: no I/O timeouts (the persist debounce is sanctioned pacing);
// no silent failures (every refusal logs; DB write failures are loud and never
// kill playback); no truncation (popup lines are display chrome — the full
// track data lives in the queue/state).

import type { ServerMessage, MediaEventMsg } from '@g2cc/shared'
import type { G2CCConfig } from './config.js'
import type { PlayerTrack } from './music.js'
import { query } from './store.js'

export interface MusicDeps {
  /** JSON to the newest phone surface; false (already loudly logged by the
   *  os-session) when none is attached. */
  toPhone: (msg: ServerMessage, what: string) => boolean
  /** The WM's transient popup channel (D6.3). Must never throw; failures are
   *  the callee's to log. */
  popup: (line: string) => void
}

export type MusicState = 'idle' | 'opening' | 'playing' | 'paused'

/** Spotify convention: a prev-tap ≥ this far into a track restarts it instead
 *  of jumping back a track (D1: "bud taps go native (Spotify-identical)"). */
const PREV_RESTART_MS = 3_000

/** A skip before this fraction of the track counts as `skipped` in
 *  play_history (D3.1: "a next/prev/stop/new-queue before ~80% position"). */
const SKIP_FRACTION = 0.8

/** player_state write debounce — persistence pacing (sanctioned class), not an
 *  I/O timeout: state mutates freely; the mirror follows within ~1.5 s. */
const PERSIST_DEBOUNCE_MS = 1_500

export class MusicPlayerService {
  queue: PlayerTrack[] = []
  idx = 0
  state: MusicState = 'idle'
  volumePct: number | null = null
  /** Radio flag (D5). PERSISTED in Phase B; the nearest-neighbor append engine
   *  lands with Phase C's resolver — a dying queue with radio on logs the gap
   *  loudly instead of silently ending. */
  radio = false

  private mediaSeq = 0
  private mediaId: string | null = null
  private posMs = 0
  private posAt = 0                     // Date.now() anchor for extrapolation
  private pausedBy: 'user' | 'capture' | null = null
  private capturing = false
  private phoneCaps: Set<string> | null = null
  /** A track ended while dictation had the lane paused — advance on capture
   *  end instead of dropping the rest of the queue (the old lane went idle
   *  here and the queue died mid-dictation). */
  private pendingAdvance = false
  /** The tap-arming ping was sent for the current phone attach (see
   *  armTapRouting). Reset when the phone detaches or a real open runs. */
  private armed = false
  /** The media id whose track-start popup already fired (a 'playing' event
   *  arrives on every resume too — only the FIRST per open pops). */
  private announcedId: string | null = null
  /** Open play_history row for the currently-playing track (null = none).
   *  The TRACK is captured at open time — closeHistory must judge the ~80%
   *  skip rule against the track that PLAYED, not whatever queue[idx] points
   *  at after a skip already moved the index. */
  private history: { id: number | null; track: PlayerTrack; pending: Promise<void> } | null = null
  private historySource = 'unknown'
  private radioGapLogged = false

  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private config: G2CCConfig, private deps: MusicDeps) {}

  // ---- caps (which APK is attached) ----

  /** ws-handler calls this on phone os_attach (with the auth caps) and with
   *  null when the last phone surface detaches. */
  notePhoneCaps(caps: string[] | null): void {
    this.phoneCaps = caps === null ? null : new Set(caps)
    console.log(`[music] phone caps: ${caps === null ? 'none (no phone)' : caps.join(',') || '(empty — pre-1.20 APK)'}`)
    if (caps === null) {
      this.armed = false
      // Phone WS gone. The music model is RETAINED — the ExoPlayer streams
      // over its own HTTP connection and keeps playing (earbud deep-review
      // #14: forcing 'idle' here made the re-attached phone's honest 'ended'
      // event look stale and the queue never advanced). The phone's next
      // media_event re-anchors state.
      if (this.state === 'playing' || this.state === 'opening') {
        console.warn('[music] phone WS gone mid-playback — model RETAINED (ExoPlayer keeps streaming; state re-anchors on re-attach)')
      }
      return
    }
    this.armTapRouting('phone attached')
  }

  private capable(cap: 'media-lane' | 'earbud-buttons'): boolean {
    return this.phoneCaps !== null && this.phoneCaps.has(cap)
  }

  /** THE single door for every media-lane send (earbud deep-review #2/#8):
   *  a message never reaches a phone that didn't announce the cap (a pre-1.20
   *  APK logs a decode failure per unknown type). Refusals are loud. */
  private sendCapped(msg: ServerMessage, what: string): boolean {
    if (!this.capable('media-lane')) {
      console.warn(`[music] ${what} NOT sent — attached phone lacks 'media-lane' (caps: ${this.phoneCaps === null ? 'no phone' : [...this.phoneCaps].join(',') || 'none'})`)
      return false
    }
    return this.deps.toPhone(msg, what)
  }

  /** Arm the phone's owned MediaSession so bud taps route to G2CC while the
   *  queue is merely STAGED (idle). The v1.21 app builds its MediaSession
   *  lazily on the first player command (AudioOutController.ensurePlayer), so
   *  after an app restart a tap has no session to land on until something
   *  plays once. A media_ctl(pause) on the empty player is a zero-audio no-op
   *  that forces the session up. Playback paths don't need it (media_open
   *  arms as a side effect). */
  private armTapRouting(reason: string): void {
    if (this.armed) return
    if (this.state !== 'idle' || this.queue.length === 0) return
    if (!this.capable('media-lane')) return
    if (this.sendCapped({ type: 'media_ctl', cmd: 'pause' }, 'media_ctl(arm-tap-routing)')) {
      this.armed = true
      console.log(`[music] armed the phone MediaSession (${reason}; ${this.queue.length}-track queue staged) — bud taps route to G2CC`)
    }
  }

  // ---- transport ----

  /** Replace the queue and start playing at startIdx. `label` feeds the
   *  queue-start popup ("▶ 25: hard metal"). */
  playQueue(tracks: PlayerTrack[], startIdx = 0, source = 'unknown', label?: string): boolean {
    if (tracks.length === 0) {
      console.warn(`[music] playQueue(${source}) with 0 tracks — refusing`)
      return false
    }
    if (!this.capable('media-lane')) {
      console.error(`[music] playQueue(${source}) refused — no media-lane-capable phone attached`)
      return false
    }
    this.closeHistory('new-queue')
    this.queue = tracks
    this.idx = Math.min(Math.max(0, startIdx), tracks.length - 1)
    this.pendingAdvance = false
    console.log(`[music] playQueue(${source}): ${tracks.length} track(s), starting at ${this.idx}`)
    const ok = this.openCurrent(0, source)
    if (ok) this.deps.popup(`▶ ${tracks.length}: ${label ?? source}`)
    this.schedulePersist()
    return ok
  }

  /** Append to the queue without touching playback (staged if idle). */
  append(tracks: PlayerTrack[], source = 'unknown'): number {
    this.queue.push(...tracks)
    console.log(`[music] append(${source}): +${tracks.length} → ${this.queue.length} queued`)
    this.schedulePersist()
    return this.queue.length
  }

  private openCurrent(startMs = 0, source?: string): boolean {
    const track = this.queue[this.idx]
    if (!track) {
      console.error(`[music] openCurrent: no track at idx ${this.idx} (queue ${this.queue.length})`)
      return false
    }
    // The track we leave behind (if any) settles its history row first.
    this.closeHistory('advance')
    // Any REAL open supersedes a deferred advance (review 2026-08-05 #N3: a
    // bud-tap skip during the capture that deferred it would otherwise
    // double-advance at capture end, replacing the user's pick).
    this.pendingAdvance = false
    const id = `med-${++this.mediaSeq}`
    const url = `/media/track/${track.id}?token=${encodeURIComponent(this.config.authToken)}&fmt=${this.config.music.format}`
    this.mediaId = id
    this.state = 'opening'
    this.posMs = startMs
    this.posAt = Date.now()
    this.pausedBy = null
    if (source) this.historySource = source
    const ok = this.sendCapped({
      type: 'media_open',
      id,
      url,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durMs: track.durMs,
      ...(startMs > 0 ? { startMs } : {}),
    }, `media_open(${track.title})`)
    if (!ok) this.state = 'idle'
    else this.armed = true              // a real open arms the session anyway
    this.schedulePersist()
    return ok
  }

  pause(by: 'user' | 'capture' = 'user'): void {
    if (this.state !== 'playing' && this.state !== 'opening') {
      // Loud ignore (review 2026-08-05 #H1): a silently dropped pause left the
      // capture gate believing nothing needed pausing.
      console.log(`[music] pause(${by}) ignored — nothing playing (state ${this.state})`)
      return
    }
    // 'opening' counts (review #H1): a dictation started inside the ~1 s open
    // window must still pause — the phone's ExoPlayer loads the track paused
    // (playWhenReady=false while preparing emits NO event, so state stays
    // 'opening' with pausedBy set; resume() below handles that state and the
    // next media_event re-anchors). Without this, pausedBy stayed null and the
    // phone's SCO-suspend self-pause was misclassified as route loss.
    if (this.state === 'opening') console.log(`[music] pause(${by}) during open — track will load paused`)
    this.pausedBy = by
    this.sendCapped({ type: 'media_ctl', cmd: 'pause' }, `media_ctl(pause by ${by})`)
    this.schedulePersist()
  }

  resume(source = 'user'): void {
    if (this.state !== 'paused' && this.state !== 'playing' && this.state !== 'opening') {
      console.log(`[music] resume(${source}) ignored — nothing paused (state ${this.state})`)
      return
    }
    this.pausedBy = null
    this.sendCapped({ type: 'media_ctl', cmd: 'play' }, `media_ctl(play, ${source})`)
  }

  stop(source = 'user'): void {
    this.closeHistory('stop')
    this.sendCapped({ type: 'media_ctl', cmd: 'stop' }, `media_ctl(stop, ${source})`)
    this.state = 'idle'
    this.mediaId = null
    this.pausedBy = null
    this.pendingAdvance = false
    // Review 2026-08-05 #C2: a stale position here made the next idle-tap
    // resume the stopped track at its OLD offset (worst case: its final
    // second, instantly re-ending). Stop = restart-from-top semantics.
    this.posMs = 0
    this.posAt = Date.now()
    this.schedulePersist()
  }

  /** The bud single-tap (D6.2 native semantics). idle + a staged/persisted
   *  queue = START it — the tap is the explicit user action the no-auto-play
   *  rule requires (boot restores the queue but never plays it; this does). */
  toggle(source: string): void {
    if (this.state === 'playing') { this.pause('user'); return }
    if (this.state === 'paused') { this.resume(source); return }
    if (this.state === 'opening') { console.log(`[music] toggle(${source}) mid-open — ignored (settle first)`); return }
    if (this.queue.length > 0) {
      const t = this.queue[this.idx]
      console.log(`[music] toggle(${source}) from idle — starting the staged queue at ${this.idx + 1}/${this.queue.length} (${t?.title ?? '?'} @ ${Math.round(this.posMs / 1000)}s)`)
      this.openCurrent(this.posMs, source)
      return
    }
    console.log(`[music] toggle(${source}) — queue empty; nothing to play (seed via /internal/play or Phase C's window)`)
  }

  /** next/prev. Spotify-identical prev: ≥3 s into a track restarts it; earlier
   *  goes back a track (clamped — prev at the head restarts). */
  skip(delta: 1 | -1, source = 'user'): boolean {
    if (this.queue.length === 0) {
      console.log(`[music] skip(${source}) — empty queue`)
      return false
    }
    if (delta === -1) {
      if (this.positionMs() >= PREV_RESTART_MS || this.idx === 0) {
        console.log(`[music] prev(${source}) → restart current (${this.positionMs() >= PREV_RESTART_MS ? `${Math.round(this.positionMs() / 1000)}s in` : 'at queue head'})`)
        return this.openCurrent(0, source)
      }
      this.idx--
      console.log(`[music] prev(${source}) → back to ${this.idx + 1}/${this.queue.length}`)
      return this.openCurrent(0, source)
    }
    if (this.idx + 1 >= this.queue.length) {
      console.log(`[music] skip(${source}) hit the end of the queue — stopping`)
      this.maybeLogRadioGap()
      this.stop('queue-end')
      this.deps.popup('■ queue ended')
      return false
    }
    this.idx++
    return this.openCurrent(0, source)
  }

  setVolume(pct: number, source = 'user'): void {
    const v = Math.max(0, Math.min(100, Math.round(pct)))
    this.volumePct = v
    this.sendCapped({ type: 'media_ctl', cmd: 'volume', value: v }, `media_ctl(volume ${v}, ${source})`)
  }

  seek(ms: number, source = 'user'): void {
    if (this.state === 'idle') { console.log(`[music] seek(${source}) ignored — nothing loaded`); return }
    const v = Math.max(0, Math.round(ms))
    this.posMs = v
    this.posAt = Date.now()
    this.sendCapped({ type: 'media_ctl', cmd: 'seek', value: v }, `media_ctl(seek ${v}, ${source})`)
    this.schedulePersist()
  }

  setRadio(on: boolean, source = 'user'): void {
    this.radio = on
    this.radioGapLogged = false   // each toggle re-arms the Phase-C gap notice (#H3)
    console.log(`[music] radio ${on ? 'ON' : 'OFF'} (${source})`)
    this.schedulePersist()
  }

  // ---- capture gate (the ONE dictation coupling — physics, D5) ----

  onCaptureState(live: boolean): void {
    if (this.capturing === live) return
    this.capturing = live
    if (live) {
      if (this.state === 'playing' || this.state === 'opening') this.pause('capture')
      return
    }
    if (this.pendingAdvance) {
      // A track ended under the capture pause — continue the queue now.
      this.pendingAdvance = false
      if (this.idx + 1 < this.queue.length) {
        console.log('[music] capture ended — resuming the queue advance the dictation deferred')
        this.idx++
        this.openCurrent(0)   // no source: the queue's origin stands (#D8)
        return
      }
    }
    if (this.pausedBy === 'capture') this.resume('capture-end')
    // Paused-by-capture is NOT popped (D5: he caused it).
  }

  // ---- the phone's honest player state ----

  onMediaEvent(msg: MediaEventMsg): void {
    if (msg.id !== this.mediaId) {
      console.log(`[music] media_event for stale id ${msg.id} (current ${this.mediaId ?? 'none'}) — ignored`)
      return
    }
    if (typeof msg.posMs === 'number') { this.posMs = msg.posMs; this.posAt = Date.now() }
    switch (msg.state) {
      case 'playing': {
        this.state = 'playing'
        // Review 2026-08-05 #N1: a 'playing' report means NOTHING is holding
        // the lane — clear any pause latch. Without this, a transient focus
        // loss (call ring, nav prompt) auto-paused AND auto-resumed on the
        // phone, but the latched pausedBy='user' silently killed the queue at
        // the next track boundary (the advance gates on pausedBy===null).
        if (this.pausedBy !== null) {
          console.log(`[music] playing report clears pausedBy='${this.pausedBy}' (phone resumed on its own)`)
          this.pausedBy = null
        }
        if (this.announcedId !== msg.id) {
          this.announcedId = msg.id
          const t = this.queue[this.idx]
          if (t) {
            this.deps.popup(`▶ ${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
            this.openHistory(t)
          }
        }
        break
      }
      case 'paused': {
        this.state = 'paused'
        if (this.pausedBy === null) {
          // We never commanded this pause — the phone did it on its own
          // (audio-becoming-noisy: buds disconnected / focus loss). D5 pops it.
          console.warn(`[music] phone-initiated pause on ${msg.id} (route loss / focus loss)`)
          this.pausedBy = 'user'   // don't auto-resume out of an external pause
          this.deps.popup('⏸ paused (buds route lost?)')
        }
        break
      }
      case 'ended': {
        const hadNext = this.idx + 1 < this.queue.length
        console.log(`[music] track ended (${this.idx + 1}/${this.queue.length})${hadNext ? '' : ' — queue done'}`)
        this.closeHistory('ended')
        if (hadNext && !this.capturing && this.pausedBy === null) {
          this.idx++
          // No source arg (review 2026-08-05 #D8): auto-advance must not
          // overwrite historySource — D3.1's `source` is the ORIGIN of play
          // (tap/voice/radio/playlist), which the queue start already set.
          this.openCurrent(0)
        } else if (hadNext && (this.capturing || this.pausedBy === 'capture')) {
          // Dictation holds the lane — advance when the capture ends instead
          // of dropping the rest of the queue.
          console.log('[music] track ended under a live capture — advance DEFERRED to capture end')
          this.pendingAdvance = true
          this.state = 'idle'
          this.mediaId = null
        } else if (hadNext) {
          // pausedBy==='user' racing a natural end (rare). LOUD (#N1's sibling
          // branch used to go idle in silence) — the queue holds; a tap
          // continues it from the top of the ended track's successor.
          console.warn(`[music] track ended while paused-by-user — queue HOLDS at ${this.idx + 1}/${this.queue.length} (tap to continue)`)
          this.state = 'idle'
          this.mediaId = null
          this.idx++
          this.posMs = 0
          this.posAt = Date.now()
        } else {
          this.state = 'idle'
          this.mediaId = null
          if (!hadNext) {
            this.maybeLogRadioGap()
            // Review 2026-08-05 #C2: reset to the top so a future tap replays
            // the queue instead of re-ending the final second of the last track.
            this.idx = 0
            this.posMs = 0
            this.posAt = Date.now()
            console.log('[music] queue done — reset to the top (a tap replays it)')
            this.deps.popup('■ queue ended')
          }
        }
        this.schedulePersist()
        break
      }
      case 'error': {
        console.error(`[music] media error on ${msg.id}: ${msg.reason ?? 'unknown'}`)
        this.closeHistory('error')
        this.state = 'idle'
        this.mediaId = null
        this.deps.popup(`✗ playback error: ${msg.reason ?? 'unknown'}`)
        this.schedulePersist()
        break
      }
    }
  }

  private maybeLogRadioGap(): void {
    if (this.radio && !this.radioGapLogged) {
      this.radioGapLogged = true
      console.warn('[music] radio is ON but the nearest-neighbor append engine lands with Phase C — the queue ends honestly until then')
    }
  }

  // ---- position / status ----

  /** Extrapolated position for status lines/persistence. */
  positionMs(): number {
    if (this.state !== 'playing') return this.posMs
    return this.posMs + (Date.now() - this.posAt)
  }

  nowPlaying(): PlayerTrack | null {
    return this.state === 'idle' ? null : this.queue[this.idx] ?? null
  }

  /** Cheap in-memory status — the preview()/statusLine() cost class. */
  status(): {
    music: MusicState; track: PlayerTrack | null; queuePos: string; queued: number
    posMs: number; volumePct: number | null; radio: boolean; capturing: boolean
    caps: string[] | null
  } {
    return {
      music: this.state,
      track: this.nowPlaying(),
      queuePos: this.queue.length ? `${this.idx + 1}/${this.queue.length}` : '—',
      queued: this.queue.length,
      posMs: this.positionMs(),
      volumePct: this.volumePct,
      radio: this.radio,
      capturing: this.capturing,
      caps: this.phoneCaps === null ? null : [...this.phoneCaps],
    }
  }

  // ---- play history (D3.1) ----

  private openHistory(track: PlayerTrack): void {
    // Fire-and-forget with a loud catch — a down DB must never kill playback
    // (store.ts rules). The row id lands whenever the INSERT resolves; a
    // close arriving before that chains on `pending` so the UPDATE can never
    // race ahead of its own INSERT.
    const entry: { id: number | null; track: PlayerTrack; pending: Promise<void> } = {
      id: null,
      track,
      pending: Promise.resolve(),
    }
    entry.pending = query<{ id: number }>(
      'INSERT INTO play_history (track_id, source) VALUES ($1, $2) RETURNING id',
      [track.id, this.historySource],
    ).then((r) => {
      entry.id = r.rows[0]?.id ?? null
    }).catch((e: unknown) => {
      console.error(`[music] play_history insert failed (playback unaffected): ${e instanceof Error ? e.message : String(e)}`)
    })
    this.history = entry
  }

  /** Settle the open history row. reason 'ended' = completed; anything else
   *  before ~80% of the PLAYED track = skipped (D3.1); past 80% = just closed. */
  private closeHistory(reason: 'ended' | 'advance' | 'stop' | 'new-queue' | 'error'): void {
    const entry = this.history
    if (entry === null) return
    this.history = null
    const posMs = this.positionMs()
    const completed = reason === 'ended'
    // Unknown duration → NOT skipped (review 2026-08-05 #D6): the broken-
    // duration rips have dur_ms null, and defaulting them to skipped would let
    // Phase C's skip-weighting permanently bury untagged tracks.
    const early = entry.track.durMs ? posMs < entry.track.durMs * SKIP_FRACTION : false
    const skipped = !completed && reason !== 'error' && early
    void entry.pending.then(() => {
      if (entry.id === null) return   // the INSERT failed — already logged
      return query(
        'UPDATE play_history SET ended_at = now(), completed = $2, skipped = $3 WHERE id = $1',
        [entry.id, completed, skipped],
      ).then((r) => {
        // Review #D7: the row can CASCADE-vanish if a rescan dropped the track
        // mid-play — a 0-row UPDATE must not be silent.
        if (r.rowCount === 0) console.warn(`[music] play_history row ${entry.id} vanished before close (track deleted mid-play?)`)
      })
    }).catch((e: unknown) => {
      console.error(`[music] play_history close failed: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  // ---- player_state persistence (D3.1 singleton row → boot resume) ----

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async persistNow(): Promise<void> {
    try {
      await query(
        `INSERT INTO player_state (id, queue, idx, pos_ms, radio, updated_at)
         VALUES (true, $1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET queue = EXCLUDED.queue, idx = EXCLUDED.idx,
           pos_ms = EXCLUDED.pos_ms, radio = EXCLUDED.radio, updated_at = now()`,
        [JSON.stringify(this.queue), this.idx, Math.round(this.positionMs()), this.radio],
      )
    } catch (e) {
      console.error(`[music] player_state persist failed (state is live-only until the DB returns): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Boot-time restore (index.ts, fire-and-forget). Loads the persisted queue
   *  into the IDLE model — NEVER plays (surprise audio in the ear = policy
   *  violation, D5). A bud tap / Phase C's Resume row starts it. */
  async loadPersisted(): Promise<void> {
    const r = await query<{ queue: unknown; idx: number; pos_ms: number; radio: boolean }>(
      'SELECT queue, idx, pos_ms, radio FROM player_state WHERE id = true')
    const row = r.rows[0]
    if (!row) { console.log('[music] no persisted player state — starting empty'); return }
    if (!Array.isArray(row.queue)) {
      // Malformed jsonb must not masquerade as "empty" (review #D9).
      console.error(`[music] persisted queue is not an array (${typeof row.queue}) — starting empty`)
    }
    const q = Array.isArray(row.queue) ? row.queue as PlayerTrack[] : []
    if (this.state !== 'idle' || this.queue.length > 0) {
      // Someone started music before the (async) load resolved — live wins.
      console.warn('[music] persisted-state load superseded by live playback — ignored')
      return
    }
    this.queue = q
      .filter((t) => typeof t?.id === 'number' && typeof t?.title === 'string')
      // Sanitize durMs (#D9): a non-numeric value would poison the 80% skip
      // math (NaN comparisons) — drop the field, keep the track.
      .map((t) => (t.durMs !== undefined && typeof t.durMs !== 'number' ? { ...t, durMs: undefined } : t))
    if (this.queue.length !== q.length) console.warn(`[music] persisted queue had ${q.length - this.queue.length} malformed entry(ies) — dropped`)
    this.idx = Math.min(Math.max(0, Number(row.idx) || 0), Math.max(0, this.queue.length - 1))
    this.posMs = Math.max(0, Number(row.pos_ms) || 0)
    this.posAt = Date.now()
    this.radio = row.radio === true
    if (this.queue.length > 0) {
      const t = this.queue[this.idx]
      console.log(`[music] resume available: ${this.queue.length}-track queue at ${this.idx + 1} — ${t?.title ?? '?'} @ ${Math.round(this.posMs / 1000)}s (radio ${this.radio ? 'on' : 'off'}; NOT auto-playing — tap to start)`)
      this.armTapRouting('persisted queue restored')
    } else {
      console.log('[music] persisted player state is empty — starting empty')
    }
  }

  /** Flush any pending debounced persist NOW (index.ts shutdown chain — the
   *  paperclips.flush precedent, review #H5). A DB write, not a time-bounded
   *  wait; compatible with the no-timeouts rule. */
  async flushPersist(): Promise<void> {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
    await this.persistNow()
  }

  /** Hard reset (ws-handler drives it): stop the phone's player best-effort
   *  and drop TRANSIENTS. The queue/idx/pos are durable user data (mirrored in
   *  player_state) and SURVIVE — the reader-position rule; a tap resumes. */
  reset(): void {
    this.sendCapped({ type: 'media_ctl', cmd: 'stop' }, 'media_ctl(stop, hard reset)')
    this.closeHistory('stop')
    this.state = 'idle'
    this.mediaId = null
    this.announcedId = null
    this.pausedBy = null
    this.pendingAdvance = false
    this.capturing = false
    this.armed = false
    this.radioGapLogged = false
    console.warn(`[music] hard reset: playback stopped, transients cleared (the ${this.queue.length}-track queue is durable and survives)`)
    this.schedulePersist()
  }
}

let musicPlayer: MusicPlayerService | null = null

export function initMusicPlayer(config: G2CCConfig, deps: MusicDeps): MusicPlayerService {
  if (musicPlayer) throw new Error('initMusicPlayer called twice — boot-time singleton')
  musicPlayer = new MusicPlayerService(config, deps)
  console.log('[music] MusicPlayerService up (the D5 player core; speech/ears retired per D2)')
  return musicPlayer
}

export function getMusicPlayer(): MusicPlayerService {
  if (!musicPlayer) throw new Error('MusicPlayerService not initialized — initMusicPlayer must run at boot')
  return musicPlayer
}

/** Non-throwing accessor for render paths that must work when the player never
 *  initialized (in-process smoke harnesses — the tryGetEarbud precedent).
 *  Callers render an honest 'player offline' on null. */
export function tryGetMusicPlayer(): MusicPlayerService | null {
  return musicPlayer
}
