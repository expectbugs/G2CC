// windows/media.ts — phone MediaSessionManager player + LRCLIB lyrics (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import type { MediaState } from '@g2cc/shared'
import type { OsWindow, WmContext, WinView } from './types.js'
import { oneLine, fbPagePx } from './_util.js'
import { renderImageB64 } from './_image.js'
import { paginateText } from '../os-compose.js'
import type { RenderedImage } from '../os-content.js'
import { getLyrics, parseLrc, currentLrcIndex, type LrcLine } from '../lyrics.js'

/** m:ss from ms (position bar / clock). */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}


/** Phase 7 — a real media player driven by the phone's MediaSessionManager.
 *  The client pushes `media_state` on every change WHILE subscribed (the window
 *  subscribes on entry, unsubscribes on leave); transport commands go back as
 *  `media_cmd`. Album art + lyrics are PAGE-2-class per the hardware page rule:
 *  the player is text (instant), art renders as tiles, lyrics are their own
 *  level. Synced LRC drives a karaoke current-line that advances with position. */
export class MediaWindow implements OsWindow {
  readonly id = 'media'
  readonly tab = 'Media'
  readonly label = 'Media'
  readonly category = 'Media' as const
  private state: MediaState | null = null
  private stateAt = 0                 // Date.now() when `state` arrived (position extrapolation)
  private subscribed = false
  private level: 'player' | 'lyrics' | 'art' = 'player'
  // lyrics
  private lyricsFor = ''              // trackKey the loaded lyrics belong to
  private lrc: LrcLine[] | null = null
  private plainPages: string[] | null = null
  private lyricsPage = 0
  private lyricsLoading = false
  private lyricsSeq = 0
  // album art (rendered tiles)
  private artFor = ''
  private art: RenderedImage | null = null
  private artFailed: string | null = null
  private artSeq = 0
  private pacer: ReturnType<typeof setInterval> | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {
    // Position tick (sanctioned pacing cadence, not an I/O timeout): re-render
    // every 5 s while playing so the bar + synced lyrics advance. requestRender
    // no-ops unless Media is active, so this is cheap. Cleared in dispose().
    this.pacer = setInterval(() => {
      if (this.state?.playing && (this.level === 'player' || (this.level === 'lyrics' && this.lrc))) this.requestRender()
    }, 5_000)
  }

  summary(): string {
    if (!this.state || (!this.state.title && !this.state.artist)) return 'nothing playing'
    return `${this.state.playing ? '▶' : '❚❚'} ${oneLine(this.state.title ?? '(unknown)', 22)}`
  }

  /** Ribbon preview (READ-ONLY): the now-playing snapshot the window already
   *  holds — track / artist / album, the play-pause glyph, and the
   *  server-extrapolated position bar. NO subscribe, NO media_cmd, NO mutation. */
  preview(): string | null {
    const s = this.state
    if (!s || (!s.title && !s.artist)) return null   // → summary 'nothing playing'
    const lines = [`${s.playing ? '▶ playing' : '❚❚ paused'}`, oneLine(s.title ?? '(unknown title)', 28)]
    if (s.artist) lines.push(oneLine(s.artist, 30))
    if (s.album) lines.push(oneLine(s.album, 30))
    lines.push(this.posBar())   // pure: reads this.state + extrapolates from Date.now()
    return lines.join('\n')
  }

  statusLine(): string | null { return this.lyricsLoading ? 'lyrics…' : null }

  private trackKey(): string { return `${this.state?.artist ?? ''}|${this.state?.title ?? ''}|${this.state?.album ?? ''}` }

  private ensureSubscribed(): void {
    if (this.subscribed) return
    this.subscribed = true
    this.ctx.mediaCommand?.('subscribe')   // client pushes the current state back
  }

  /** Current playback position, extrapolated from the last snapshot while playing. */
  private posMs(): number {
    const s = this.state
    if (!s) return 0
    const pos = (s.positionMs ?? 0) + (s.playing ? Math.max(0, Date.now() - this.stateAt) : 0)
    return s.durationMs ? Math.min(pos, s.durationMs) : pos
  }

  async view(): Promise<WinView> {
    this.ensureSubscribed()
    if (this.level === 'lyrics') return this.lyricsView()
    if (this.level === 'art') return this.artView()
    return this.playerView()
  }

  private playerView(): WinView {
    const menu = ['Play/Pause', 'Skip', 'Prev', 'Random', 'Lyrics', 'Art', 'Reload', 'Main']
    const s = this.state
    if (!s || (!s.title && !s.artist)) {
      return { mode: 'text', title: 'Media', menu, text: 'Nothing is playing.\n\nStart a track on the phone — controls appear here.' }
    }
    const lines = [s.title ?? '(unknown title)']
    if (s.artist) lines.push(s.artist)
    if (s.album) lines.push(s.album)
    lines.push('', this.posBar())
    return { mode: 'text', title: `Media · ${s.playing ? 'playing' : 'paused'}`, menu, text: lines.join('\n') }
  }

  /** ▕████░░░░░░░░░░░░▏ 2:31/4:05 — fixed 16-cell bar, server-extrapolated. */
  private posBar(): string {
    const s = this.state!
    const pos = this.posMs(), dur = s.durationMs ?? 0, cells = 16
    const filled = dur > 0 ? Math.max(0, Math.min(cells, Math.round((pos / dur) * cells))) : 0
    return `▕${'█'.repeat(filled)}${'░'.repeat(cells - filled)}▏ ${fmtClock(pos)}${dur ? `/${fmtClock(dur)}` : ''}`
  }

  private lyricsView(): WinView {
    const menu = ['Back', 'Reload', 'Main']
    if (this.lyricsLoading) return { mode: 'text', title: 'Media · lyrics', menu, text: 'Looking up lyrics…' }
    if (this.lrc && this.lrc.length) {
      const idx = currentLrcIndex(this.lrc, this.posMs())
      const WINDOW = 9
      const start = Math.max(0, Math.min(idx - 3, this.lrc.length - WINDOW))
      const slice = this.lrc.slice(start, start + WINDOW)
      const text = slice.map((l, i) => (start + i === idx ? `▶ ${l.text || '♪'}` : `  ${l.text || '♪'}`)).join('\n')
      return { mode: 'text', title: 'Media · lyrics ♪', menu, text: text || '♪' }
    }
    if (this.plainPages && this.plainPages.length) {
      const suffix = this.plainPages.length > 1 ? ` · ${this.lyricsPage + 1}/${this.plainPages.length}` : ''
      const m = this.plainPages.length > 1 ? ['Next', 'Prev', 'Back', 'Reload', 'Main'] : menu
      return { mode: 'text', title: `Media · lyrics${suffix}`, menu: m, text: this.plainPages[this.lyricsPage] ?? '' }
    }
    return { mode: 'text', title: 'Media · lyrics', menu, text: 'No lyrics found for this track.' }
  }

  private artView(): WinView {
    const menu = ['Back', 'Reload', 'Main']
    const key = this.trackKey()
    if (this.artFor === key && this.artFailed) return { mode: 'text', title: 'Media · art', menu, text: `Album art FAILED:\n${this.artFailed}` }
    if (this.artFor === key && this.art) return { mode: 'tiles', tilesRect: { w: this.art.w, h: this.art.h }, title: 'Media · art', menu, tiles: this.art.tiles }
    if (this.state?.artB64) return { mode: 'text', title: 'Media · art', menu, text: '⏳ rendering album art…' }
    return { mode: 'text', title: 'Media · art', menu, text: 'No album art for this track.' }
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'lyrics' || this.level === 'art') {
      switch (label) {
        case 'Back': this.level = 'player'; this.requestRender(); return
        case 'Next': if (this.plainPages && this.lyricsPage < this.plainPages.length - 1) { this.lyricsPage++; this.requestRender() } return
        case 'Prev': if (this.plainPages && this.lyricsPage > 0) { this.lyricsPage--; this.requestRender() } return
        default: this.ctx.log(`[os] media ${this.level}: menu '${label}' — ignored`); return
      }
    }
    switch (label) {
      case 'Play/Pause': this.ctx.mediaCommand?.('play_pause'); return
      case 'Skip': this.ctx.mediaCommand?.('next'); return
      case 'Prev': this.ctx.mediaCommand?.('prev'); return
      case 'Random': this.ctx.mediaCommand?.('shuffle'); return
      case 'Lyrics': this.level = 'lyrics'; this.requestRender(); void this.loadLyrics(); return
      case 'Art': this.level = 'art'; this.requestRender(); void this.renderArt(); return
      default: this.ctx.log(`[os] media: menu '${label}' — ignored (LOUD)`)
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    this.ctx.log(`[os] media: browse select ${index} — no browse surface, ignored`)
  }

  private async loadLyrics(): Promise<void> {
    const s = this.state
    if (!s || !s.title || !s.artist) { this.lrc = null; this.plainPages = ['No track metadata for a lyrics lookup.']; this.lyricsLoading = false; this.requestRender(); return }
    const key = this.trackKey()
    if (this.lyricsFor === key && (this.lrc || this.plainPages)) return   // already loaded for this track
    const seq = ++this.lyricsSeq
    this.lyricsFor = key; this.lrc = null; this.plainPages = null; this.lyricsPage = 0; this.lyricsLoading = true
    this.requestRender()
    try {
      const r = await getLyrics(s.artist, s.title, s.durationMs, s.album)
      if (seq !== this.lyricsSeq) return
      this.lyricsLoading = false
      if (r.synced) this.lrc = parseLrc(r.synced)
      else if (r.plain) this.plainPages = paginateText(r.plain, fbPagePx(this.ctx))
      else this.plainPages = ['No lyrics found for this track.']
    } catch (e) {
      if (seq !== this.lyricsSeq) return
      this.lyricsLoading = false
      this.plainPages = paginateText(`Lyrics lookup failed:\n${(e as Error).message}`, fbPagePx(this.ctx))
    }
    this.requestRender()
  }

  private async renderArt(): Promise<void> {
    const s = this.state
    const key = this.trackKey()
    if (!s?.artB64) { this.art = null; this.artFailed = null; return }
    if (this.artFor === key && (this.art || this.artFailed)) return   // already rendered for this track
    const seq = ++this.artSeq
    this.artFor = key; this.art = null; this.artFailed = null
    try {
      const img = await renderImageB64(s.artB64)
      if (seq !== this.artSeq) return
      this.art = img
    } catch (e) {
      if (seq !== this.artSeq) return
      this.artFailed = (e as Error).message
      this.ctx.log(`[os] media: art render failed: ${(e as Error).message}`)
    }
    this.requestRender()
  }

  /** The phone pushed a now-playing change (Phase 7). A track change drops the
   *  cached lyrics/art so they re-derive for the new song. */
  onMediaState(state: MediaState): void {
    const prevKey = this.trackKey()
    this.state = state
    this.stateAt = Date.now()
    if (this.trackKey() !== prevKey) {
      this.lyricsFor = ''; this.lrc = null; this.plainPages = null; this.lyricsPage = 0
      this.artFor = ''; this.art = null; this.artFailed = null; this.artSeq++
      if (this.level === 'lyrics') void this.loadLyrics()
      if (this.level === 'art') void this.renderArt()
    }
    this.requestRender()
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'lyrics' || this.level === 'art') { this.level = 'player'; this.requestRender(); return true }
    return false
  }

  async onReload(): Promise<void> {
    this.level = 'player'
    this.ctx.mediaCommand?.('subscribe')   // force a fresh state push
  }

  onDeactivate(): void {
    if (this.subscribed) { this.subscribed = false; this.ctx.mediaCommand?.('unsubscribe') }
  }

  dispose(): void {
    if (this.pacer) { clearInterval(this.pacer); this.pacer = null }
    // Best-effort unsubscribe on ws close (the socket is usually already gone, so
    // this no-ops; the phone-side MediaBridge is authoritatively released by the
    // client's teardown). Keeps the server-side intent explicit.
    if (this.subscribed) { this.subscribed = false; this.ctx.mediaCommand?.('unsubscribe') }
  }
}
