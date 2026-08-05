// windows/music.ts — the Music app window (MUSIC_SPEC.md D6.1, 2026-08-05
// Phase C). Takes the Media-category slot the EarbudWindow left (windows/
// media.ts — the third-party phone-media window — is untouched).
//
// Levels: Now Playing (default; in fullBleed it is a scrollContent view —
// TAP opens the Actions list, DOUBLE-TAP exits to the ribbon (Adam
// 2026-08-05: double-tap always backs out; volume is max + phone-owned);
// in classic mode the left menu carries the actions), Ask
// (fuzzy request → resolver → plays immediately, honest which-lane line),
// Browse (Playlists / Artists / Albums / Moods & Genres / Search / YouTube),
// Queue (jump/curate/save), Playlists (open/play/rename/delete — delete is
// Cancel-first, the reader-jump pattern), Lyrics (karaoke — synced-LRC
// current-line, rendered only while open), Seek.
//
// Dictation discipline (the earbud-window lessons): ONE pending-dictation
// mode flag; cleared on Back/leave with the mic stopped LOUDLY (a stale flag
// must never eat a later unrelated transcript). Typed text is trusted and
// routes by the same mode. Music pauses during capture by PHYSICS (the
// server-side capture gate) — no window code needed.

import type { OsWindow, WmContext, WinView, SttMeta } from './types.js'
import { browsePageItems } from './_browse.js'
import { oneLine, fbPagePx, fbActiveCfg } from './_util.js'
import { paginateText } from '../os-compose.js'
import { tryGetMusicPlayer, type MusicPlayerService } from '../music-player.js'
import { resolveRequest, type ResolvedQueue } from '../resolver.js'
import { listArtists, tracksByArtist, searchTracks, toPlayerTrack, type PlayerTrack } from '../music.js'
import { listAlbums, tracksByAlbum, listVocabTerms, type AlbumRow, type VocabTerm } from '../music-browse.js'
import {
  listPlaylists, savePlaylist, playlistTracks, renamePlaylist, deletePlaylist,
  appendToPlaylist, removePlaylistRow, movePlaylistRow, type PlaylistRow,
} from '../playlists.js'
import { getLyrics, parseLrc, currentLrcIndex, type LrcLine } from '../lyrics.js'
import { ytSearch, ytGrab, ytHitRow, type YtHit, type GrabResult } from '../youtube.js'

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

type Level =
  | 'now' | 'actions' | 'seek' | 'ask' | 'browse'
  | 'artists' | 'albums' | 'vocab' | 'results'
  | 'queue' | 'queue-row' | 'confirm-clear'
  | 'playlists' | 'playlist' | 'playlist-edit' | 'playlist-row' | 'confirm-delete'
  | 'lyrics' | 'yt' | 'yt-grabbed'

/** Levels that render mode 'browse' — the ONLY ones where onBack's first
 *  press flips content→menu focus (review #W6: the flip on a TEXT level —
 *  lyrics — was invisible and made Back take two presses). */
const BROWSE_LEVELS: ReadonlySet<Level> = new Set([
  'actions', 'seek', 'browse', 'artists', 'albums', 'vocab', 'results',
  'queue', 'queue-row', 'confirm-clear', 'playlists', 'playlist',
  'playlist-edit', 'playlist-row', 'confirm-delete', 'yt', 'yt-grabbed',
])

const YT_GRABBED_ROWS = ['▶ Play now', 'Append to queue', 'Back to results', 'Done'] as const

/** What the next dictation transcript means (ONE mode at a time — D6.1 flows). */
type DictMode = 'ask' | 'search' | 'save-name' | 'rename' | 'yt-search' | null

// The FULL action set (review 2026-08-06 #W1: in fullBleed this list is the
// The tap-from-Now-Playing hub (Adam 2026-08-05: tap = actions, double-tap =
// exit, volume is phone-owned so the Vol rows are gone) — Ask/Browse/Queue
// must live here or the Phase C gate flow is undrivable on Adam's daily config.
const ACTIONS_ROWS = [
  '⏯ Pause/Resume', '⏭ Next', 'Ask', 'Browse', 'Queue',
  '⏮ Previous', 'Seek…', 'Radio toggle',
  'Save queue as playlist', 'Add current → playlist', 'Lyrics', '■ Stop',
] as const
const SEEK_ROWS = ['−5 min', '−30 s', '+30 s', '+5 min', 'Restart track', 'Cancel'] as const
const BROWSE_ROWS = ['Playlists', 'Artists', 'Albums', 'Moods & Genres', 'Search', 'YouTube'] as const
const QUEUE_ROW_ACTIONS = ['▶ Play from here', 'Remove', 'Move up', 'Move down', 'Cancel'] as const
const PLAYLIST_ROW_ACTIONS = ['Remove', 'Move up', 'Move down', 'Cancel'] as const

export class MusicWindow implements OsWindow {
  readonly id = 'music'
  readonly tab = 'Music'
  readonly label = 'Music'
  readonly category = 'Media' as const

  private level: Level = 'now'
  private focus: 'content' | 'menu' = 'content'
  private dictMode: DictMode = null
  /** Ask/resolve feedback (the honest which-lane line, D4). */
  private _askStatus: string | null = null
  /** When _askStatus was last set — statusLine surfaces it for ~8 s (#W8). */
  private askStatusAt = 0
  private get askStatus(): string | null { return this._askStatus }
  private set askStatus(v: string | null) {
    this._askStatus = v
    this.askStatusAt = Date.now()
  }
  private resolving = false
  /** Save-queue/rename provenance: the last Ask that built the current queue. */
  private lastAsk: { request: string; lane: ResolvedQueue['lane'] } | null = null

  // browse caches (refreshed on level entry; offsets per level)
  private artists: { artist: string; n: number }[] = []
  private albums: AlbumRow[] = []
  private vocab: VocabTerm[] = []
  private results: PlayerTrack[] = []
  private resultsLabel = ''
  private playlists: PlaylistRow[] = []
  private plOpen: PlaylistRow | null = null
  private plTracks: PlayerTrack[] = []
  private renameTarget: PlaylistRow | null = null
  private offsets = new Map<Level, number>()
  /** The tapped row a queue-row / playlist-row action applies to. */
  private rowSel = -1

  // lyrics (the MediaWindow karaoke pattern)
  private lyricsFor = ''
  private lrc: LrcLine[] | null = null
  private plainPages: string[] | null = null
  private lyricsPage = 0
  private lyricsLoading = false
  private lyricsSeq = 0

  private pacer: ReturnType<typeof setInterval> | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {
    // Position tick (sanctioned pacing, the MediaWindow precedent): re-render
    // every 5 s while playing so the bar + karaoke line advance. requestRender
    // no-ops unless this window is active (the WM's mk() closure).
    this.pacer = setInterval(() => {
      const p = this.player()
      if (p?.status().music !== 'playing') return
      if (this.level === 'lyrics' && this.lyricsFor && this.lyricsFor !== this.lyricsKey()) {
        // The queue advanced under an open lyrics level (review #W5:
        // MediaWindow re-derives on its state push; this window has no push —
        // the pacer is the substitute). loadLyrics' seq guard handles races.
        this.ctx.log('[music-win] track changed under the lyrics level — re-deriving')
        void this.loadLyrics()
        return
      }
      if (this.level === 'now' || (this.level === 'lyrics' && this.lrc)) this.requestRender()
    }, 5_000)
  }

  /** The current track's lyrics identity (artist|title — matches loadLyrics). */
  private lyricsKey(): string {
    const p = this.player()
    const t = p?.nowPlaying() ?? (p ? p.queue[p.idx] : undefined)
    return t?.artist ? `${t.artist}|${t.title}` : ''
  }

  /** The player, or null when it never initialized (smoke harnesses — the
   *  tryGetEarbud precedent). Callers render the honest offline state. */
  private player(): MusicPlayerService | null { return tryGetMusicPlayer() }

  private off(level: Level): number { return this.offsets.get(level) ?? 0 }

  summary(): string {
    const st = this.player()?.status()
    if (st?.track && st.music !== 'idle') return `${st.music === 'playing' ? '♪' : '❚❚'} ${oneLine(st.track.title, 22)}`
    if (st && st.queued > 0) return `♪ ${st.queued} staged — tap to play`
    return st ? '♪ idle' : 'player offline'
  }

  /** Ribbon preview — the spec's format, in-memory only (D6.1). */
  preview(): string | null {
    const p = this.player()
    if (!p) return 'player offline (service not initialized)'
    const st = p.status()
    if (!st.track && st.queued === 0) return '♪ idle\n\nAsk for something — "play some hard metal stuff".'
    const lines: string[] = []
    if (st.track) {
      lines.push(`♪ ${oneLine(st.track.title, 30)}${st.track.artist ? ` — ${oneLine(st.track.artist, 20)}` : ''}`)
      lines.push(`${st.music} · ${fmtClock(st.posMs)}${st.track.durMs ? `/${fmtClock(st.track.durMs)}` : ''} · q ${st.queuePos}`)
    } else {
      lines.push(`♪ idle · ${st.queued} staged (tap to play)`)
    }
    lines.push(`radio ${st.radio ? 'ON' : 'off'}${st.caps === null ? ' · NO PHONE' : ''}`)
    return lines.join('\n')
  }

  statusLine(): string | null {
    if (this.grabbing) return 'grabbing…'
    if (this.ytSearching) return 'searching YouTube…'
    if (this.resolving) return 'resolving…'
    if (this.dictMode) return 'listening…'
    // Recent ask/save/rename outcomes surface here for ~8 s (review #W8:
    // askStatus only rendered at the Ask level, so a failed save-name or an
    // empty vocab-tap resolve was on-glass silence at every other level).
    if (this.askStatus && Date.now() - this.askStatusAt < 8_000) {
      return oneLine(this.askStatus.split('\n')[0], 40)
    }
    const st = this.player()?.status()
    return st?.track && st.music === 'playing' ? `♪ ${oneLine(st.track.title, 30)}` : null
  }

  // A grab is NOT a sacred dictation/confirm surface (review #D-F7: blocking
  // overlays for a minutes-class download deferred a CALL alarm up to 10 min
  // — the B5 rationale doesn't apply; the grab completes fine under an
  // overlay and announces via popup + level change).
  interruptible(): boolean { return this.dictMode === null && !this.resolving }

  // ------------------------------------------------------------ views

  async view(): Promise<WinView> {
    const menuMode = this.focus === 'menu' ? 'capture' as const : 'passive' as const
    const p = this.player()
    switch (this.level) {
      case 'now': return this.nowView(p)
      case 'actions':
        return { mode: 'browse', menuMode, title: 'Music · actions', menu: ['Back', 'Main'], items: browsePageItems([...ACTIONS_ROWS], this.off('actions')).items }
      case 'seek':
        return { mode: 'browse', menuMode, title: 'Music · seek', menu: ['Back', 'Main'], items: [...SEEK_ROWS] }
      case 'ask': {
        const lines = [
          this.dictMode === 'ask' ? '🎤 Listening — ask for music.' : this.resolving ? '⏳ Resolving…' : 'Ask for music.',
          '', '"play some hard metal stuff" · "something piano and deep"',
          '"pink floyd" · an album name · a playlist name',
        ]
        if (this.askStatus) lines.push('', this.askStatus)
        return { mode: 'text', title: 'Music · ask', menu: ['Dictate', 'Cancel', 'Main'], text: lines.join('\n') }
      }
      case 'browse':
        return { mode: 'browse', menuMode, title: 'Music · browse', menu: ['Back', 'Main'], items: [...BROWSE_ROWS] }
      case 'artists': {
        const rows = this.artists.map((a) => `${a.artist} (${a.n})`)
        return { mode: 'browse', menuMode, title: `Music · artists (${this.artists.length})`, menu: ['Back', 'Reload', 'Main'], items: browsePageItems(rows, this.off('artists')).items }
      }
      case 'albums': {
        const rows = this.albums.map((a) => `${a.album}${a.artist ? ` — ${a.artist}` : ''} (${a.n})`)
        return { mode: 'browse', menuMode, title: `Music · albums (${this.albums.length})`, menu: ['Back', 'Reload', 'Main'], items: browsePageItems(rows, this.off('albums')).items }
      }
      case 'vocab': {
        const rows = this.vocab.map((v) => `${v.term} (${v.n})`)
        return { mode: 'browse', menuMode, title: 'Music · moods & genres', menu: ['Back', 'Reload', 'Main'], items: browsePageItems(rows, this.off('vocab')).items }
      }
      case 'results': {
        const rows = this.results.map((t) => `${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
        return { mode: 'browse', menuMode, title: `Music · ${this.resultsLabel} (${this.results.length})`, menu: ['Back', 'Main'], items: browsePageItems(rows, this.off('results')).items }
      }
      case 'queue': {
        // 'Back' first (review #W7: the WM resets the fullBleed cursor to
        // cell 0 BECAUSE cell 0 must be harmless — Clear was one stray tap
        // from wiping a curated queue; it now also confirms).
        return { mode: 'browse', menuMode, title: `Music · queue ${p?.status().queuePos ?? '—'}`, menu: ['Back', 'Save as playlist', 'Clear', 'Main'], items: browsePageItems(this.queueRows(), this.off('queue')).items }
      }
      case 'confirm-clear':
        return { mode: 'browse', menuMode, title: `Clear the queue (${p?.queue.length ?? 0} tracks)?`, menu: ['Back', 'Main'], items: ['Cancel', `Confirm clear (${p?.queue.length ?? 0} tracks)`] }
      case 'queue-row': {
        const t = p?.queue[this.rowSel]
        return { mode: 'browse', menuMode, title: `Queue · ${oneLine(t?.title ?? '?', 24)}`, menu: ['Back', 'Main'], items: [...QUEUE_ROW_ACTIONS] }
      }
      case 'playlists': {
        const rows = this.playlists.length
          ? this.playlists.map((pl) => `${pl.name} (${pl.n})${pl.adaptive ? ' ⟳' : pl.origin === 'llm' ? ' ✦' : ''}`)
          : ['(no playlists yet — Save queue as playlist creates one)']
        // Add-current mode retitles so the tap's meaning is unmistakable (#W2).
        const title = this.addTarget
          ? `Add "${oneLine(this.addTarget.title, 18)}" to…`
          : `Music · playlists (${this.playlists.length})`
        return { mode: 'browse', menuMode, title, menu: ['Back', 'Reload', 'Main'], items: browsePageItems(rows, this.off('playlists')).items }
      }
      case 'playlist': {
        const rows = this.plTracks.map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
        const sub = this.plOpen?.request ? ` · "${oneLine(this.plOpen.request, 20)}"` : ''
        return { mode: 'browse', menuMode, title: `${oneLine(this.plOpen?.name ?? '?', 22)}${sub}`, menu: ['Play', 'Add current', 'Rename', 'Edit', 'Delete', 'Back', 'Main'], items: browsePageItems(rows.length ? rows : ['(empty playlist)'], this.off('playlist')).items }
      }
      case 'playlist-edit': {
        const rows = this.plTracks.map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
        return { mode: 'browse', menuMode, title: `Edit · ${oneLine(this.plOpen?.name ?? '?', 22)} (tap a row)`, menu: ['Back', 'Main'], items: browsePageItems(rows.length ? rows : ['(empty playlist)'], this.off('playlist-edit')).items }
      }
      case 'playlist-row': {
        const t = this.plTracks[this.rowSel]
        return { mode: 'browse', menuMode, title: `Row · ${oneLine(t?.title ?? '?', 24)}`, menu: ['Back', 'Main'], items: [...PLAYLIST_ROW_ACTIONS] }
      }
      case 'confirm-delete':
        // Cancel FIRST — a stray/double-fire tap must never delete (reader r27).
        return { mode: 'browse', menuMode, title: `Delete "${oneLine(this.plOpen?.name ?? '?', 20)}"?`, menu: ['Back', 'Main'], items: ['Cancel', `Confirm delete (${this.plOpen?.n ?? 0} tracks)`] }
      case 'lyrics': return this.lyricsView()
      case 'yt': {
        const rows = this.ytHits.length
          ? this.ytHits.map(ytHitRow)
          : [this.dictMode === 'yt-search' ? '🎤 (listening — say what to grab)' : '(no results — Dictate to search)']
        const lines = browsePageItems(rows, this.off('yt')).items
        const title = this.grabbing ? 'YouTube · grabbing…' : `YouTube${this.ytQuery ? ` · "${oneLine(this.ytQuery, 16)}"` : ''}`
        const view: WinView = { mode: 'browse', menuMode, title, menu: ['Dictate', 'Back', 'Main'], items: lines }
        if (this.askStatus) view.title = `${view.title} · ${oneLine(this.askStatus, 24)}`
        return view
      }
      case 'yt-grabbed':
        return {
          mode: 'browse', menuMode,
          title: `Grabbed: ${oneLine(this.grabbed?.track.title ?? '?', 22)}`,
          menu: ['Back', 'Main'], items: [...YT_GRABBED_ROWS],
        }
    }
  }

  private nowView(p: MusicPlayerService | null): WinView {
    // TWO shapes, the Reader/Scout branch pattern (review #W1):
    //  - fullBleed: scrollContent + NO menu — TAP opens the Actions list and
    //    double-tap EXITS to the ribbon (Adam 2026-08-05: double-tap always
    //    backs out; volume is always max and phone-owned, so no ring-volume).
    //    A menu here would render as dead-looking top-bar chrome.
    //  - classic: a plain text view with the menu list (ring drives the native
    //    list).
    const fb = fbActiveCfg(this.ctx.config)
    const st = p?.status()
    const menu = fb ? [] : [st?.music === 'playing' ? 'Pause' : 'Resume', 'Next', 'Ask', 'Browse', 'Queue', 'More', 'Reload', 'Main']
    if (!p) return { mode: 'text', title: 'Music', menu, text: 'Player offline (service not initialized).' }
    if (!st!.track && st!.queued === 0) {
      return {
        mode: 'text', title: 'Music · idle', menu, scrollContent: fb,
        text: `Nothing queued.\n\n${fb ? 'Tap → Ask/Browse' : 'Menu → Ask/Browse'} to fill the queue.\nBud taps: single = play/pause · double = next · triple = previous.`,
      }
    }
    const lines: string[] = []
    if (st!.track) {
      lines.push(st!.track.title)
      lines.push(`${st!.track.artist ?? '(unknown artist)'}${st!.track.album ? ` — ${st!.track.album}` : ''}`)
      lines.push('')
      lines.push(this.posBar(st!.posMs, st!.track.durMs))
    } else {
      const next = p.queue[p.idx]
      lines.push(`Staged: ${next?.title ?? '?'}${next?.artist ? ` — ${next.artist}` : ''}`)
      lines.push('')
      lines.push(`Resume: tap a bud (or Resume) to start at ${fmtClock(st!.posMs)}`)
    }
    lines.push(`queue ${st!.queuePos} · radio ${st!.radio ? 'ON' : 'off'}`)
    if (st!.caps === null) lines.push('⚠ NO PHONE ATTACHED — playback needs the phone')
    if (fb) lines.push('', 'tap = actions · double-tap = exit')
    return { mode: 'text', title: `Music · ${st!.music}`, menu, scrollContent: fb, text: lines.join('\n') }
  }

  private posBar(posMs: number, durMs?: number): string {
    const cells = 16
    const filled = durMs ? Math.max(0, Math.min(cells, Math.round((posMs / durMs) * cells))) : 0
    return `▕${'█'.repeat(filled)}${'░'.repeat(cells - filled)}▏ ${fmtClock(posMs)}${durMs ? `/${fmtClock(durMs)}` : ''}`
  }

  private lyricsView(): WinView {
    const menu = ['Back', 'Reload', 'Main']
    if (this.lyricsLoading) return { mode: 'text', title: 'Music · lyrics', menu, text: 'Looking up lyrics…' }
    if (this.lrc && this.lrc.length) {
      const idx = currentLrcIndex(this.lrc, this.player()?.status().posMs ?? 0)
      const WINDOW = 9
      const start = Math.max(0, Math.min(idx - 3, this.lrc.length - WINDOW))
      const slice = this.lrc.slice(start, start + WINDOW)
      const text = slice.map((l, i) => (start + i === idx ? `▶ ${l.text || '♪'}` : `  ${l.text || '♪'}`)).join('\n')
      return { mode: 'text', title: 'Music · lyrics ♪', menu, text: text || '♪' }
    }
    if (this.plainPages && this.plainPages.length) {
      const suffix = this.plainPages.length > 1 ? ` · ${this.lyricsPage + 1}/${this.plainPages.length}` : ''
      const m = this.plainPages.length > 1 ? ['Next', 'Prev', 'Back', 'Main'] : menu
      return { mode: 'text', title: `Music · lyrics${suffix}`, menu: m, text: this.plainPages[this.lyricsPage] ?? '' }
    }
    return { mode: 'text', title: 'Music · lyrics', menu, text: 'No lyrics found for this track.' }
  }

  private queueRows(): string[] {
    const p = this.player()
    if (!p) return ['(player offline)']
    if (p.queue.length === 0) return ['(queue empty — Ask or Browse to fill it)']
    return p.queue.map((t, i) => `${i === p.idx ? '▶ ' : ''}${i + 1}. ${t.title}`)
  }

  // ------------------------------------------------------------ dictation

  /** Arm the mic for a mode. The one-flag rule: arming replaces any prior
   *  pending mode LOUDLY (never two interpretations for one transcript).
   *  Refused while a resolve is in flight (review #W12: two concurrent
   *  runAsks would interleave askStatus + playQueue). */
  private armDictation(mode: Exclude<DictMode, null>): void {
    if (this.resolving) { this.ctx.log(`[music-win] arm '${mode}' refused — a resolve is in flight`); return }
    if (this.dictMode) this.ctx.log(`[music-win] dictation mode '${this.dictMode}' replaced by '${mode}'`)
    this.dictMode = mode
    this.ctx.audio('start', 'dictate')
    this.requestRender()
  }

  private disarmDictation(why: string): void {
    if (!this.dictMode) return
    this.ctx.log(`[music-win] dictation '${this.dictMode}' abandoned (${why}) — mic stopped, flag cleared`)
    this.dictMode = null
    this.ctx.audio('stop')
  }

  async onStt(text: string, _meta?: SttMeta): Promise<void> {
    const mode = this.dictMode
    this.dictMode = null
    if (!mode) {
      this.ctx.log(`[music-win] transcript with no pending mode — DISCARDED loudly: "${text.slice(0, 60)}"`)
      return
    }
    await this.handleInput(mode, text)
  }

  async onSttError(error: string): Promise<void> {
    const mode = this.dictMode
    this.dictMode = null
    if (mode) {
      this.ctx.log(`[music-win] dictation (${mode}) failed: ${error}`)
      this.askStatus = `Dictation failed: ${error}`
      this.requestRender()
    } else {
      // Loud like the onStt twin (review #W11 — same event class, same noise).
      this.ctx.log(`[music-win] STT error with no pending mode — logged only: ${error}`)
    }
  }

  async onTypedText(text: string): Promise<void> {
    // Typed input is exact + user-authored — trusted for the pending mode;
    // with none, the LEVEL decides (yt = a grab search, else an Ask — the
    // natural default for a music window).
    const mode = this.dictMode ?? (this.level === 'yt' ? 'yt-search' : 'ask')
    this.disarmDictation('typed input supersedes')
    await this.handleInput(mode, text)
  }

  private async handleInput(mode: Exclude<DictMode, null>, text: string): Promise<void> {
    const q = text.trim()
    if (!q) { this.askStatus = 'Empty input — nothing done.'; this.requestRender(); return }
    switch (mode) {
      case 'ask': await this.runAsk(q); return
      case 'search': await this.runSearch(q); return
      case 'save-name': await this.runSaveQueue(q); return
      case 'rename': await this.runRename(q); return
      case 'yt-search': await this.runYtSearch(q); return
    }
  }

  private async runAsk(q: string): Promise<void> {
    const p = this.player()
    if (!p) { this.askStatus = 'Player offline.'; this.requestRender(); return }
    this.resolving = true
    this.askStatus = null
    this.requestRender()
    try {
      const r = await resolveRequest(this.ctx.config, q)
      this.ctx.log(`[music-win] ask "${q}" → ${r.detail}`)
      this.askStatus = r.detail
      if (r.tracks.length === 0) {
        // Honest empty (D4): nothing plays, nothing falls back to YouTube.
        this.askStatus = `No match: ${r.detail}\n(YouTube grabs are explicit — Browse → YouTube.)`
        return
      }
      if (!p.playQueue(r.tracks, 0, `ask "${q}"`, r.label)) {
        this.askStatus = `Resolved ${r.tracks.length} tracks but playback refused (no media-capable phone).`
        return
      }
      // Provenance only AFTER the queue actually changed (final-review #S3: a
      // refused ask must not stamp the OLD queue's save with this request).
      this.lastAsk = { request: q, lane: r.lane }
      this.level = 'now'
    } catch (e) {
      this.askStatus = `Resolve failed: ${(e as Error).message}`
      this.ctx.log(`[music-win] ask failed: ${(e as Error).message}`)
    } finally {
      this.resolving = false
      this.requestRender()
    }
  }

  private async runSearch(q: string): Promise<void> {
    try {
      const rows = await searchTracks(q, 200)
      this.results = rows.map(toPlayerTrack)
      this.resultsLabel = `search "${oneLine(q, 16)}"`
      this.offsets.set('results', 0)
      this.level = 'results'
      this.ctx.log(`[music-win] search "${q}" → ${this.results.length} hits`)
    } catch (e) {
      this.askStatus = `Search failed: ${(e as Error).message}`
      this.level = 'ask'
    }
    this.requestRender()
  }

  /** A dictated name that matches an EXISTING playlist must be said twice
   *  (review #W13: replace-by-name is by design, but a misheard transcript
   *  silently clobbering a curated playlist is the reader-confirm class). */
  private pendingSaveConfirm: string | null = null

  private async runSaveQueue(name: string): Promise<void> {
    const p = this.player()
    if (!p || p.queue.length === 0) { this.askStatus = 'Queue is empty — nothing to save.'; this.level = 'queue'; this.requestRender(); return }
    try {
      const trimmed = name.trim()
      const existing = (await listPlaylists()).find((pl) => pl.name.toLowerCase() === trimmed.toLowerCase())
      if (existing?.adaptive) {
        // Refuse on the FIRST pass (review 2026-08-05 A#4): the replace-confirm
        // round-trip promised a replace savePlaylist can never deliver.
        this.pendingSaveConfirm = null
        this.askStatus = `"${existing.name}" is an ADAPTIVE playlist (rule-managed) — pick another name.`
        this.armDictation('save-name')
        return
      }
      if (existing && this.pendingSaveConfirm?.toLowerCase() !== trimmed.toLowerCase()) {
        this.pendingSaveConfirm = trimmed
        this.askStatus = `"${existing.name}" exists (${existing.n} tracks) — say the name AGAIN to replace it, or a different name.`
        this.ctx.log(`[music-win] save-name "${trimmed}" collides — replace needs a repeat (#W13)`)
        this.armDictation('save-name')
        return
      }
      this.pendingSaveConfirm = null
      const llm = this.lastAsk && (this.lastAsk.lane === 'llm' || this.lastAsk.lane === 'embedding')
      await savePlaylist(trimmed, p.queue, llm ? 'llm' : 'manual', this.lastAsk?.request)
      this.ctx.log(`[music-win] queue saved as "${trimmed}" (${p.queue.length} tracks)`)
      this.askStatus = `Saved: "${trimmed}" (${p.queue.length} tracks)`
      this.level = 'now'
    } catch (e) {
      this.askStatus = `Save failed: ${(e as Error).message}`
      this.ctx.log(`[music-win] save-queue failed: ${(e as Error).message}`)
    }
    this.requestRender()
  }

  private async runRename(name: string): Promise<void> {
    const target = this.renameTarget
    this.renameTarget = null
    if (!target) { this.ctx.log('[music-win] rename with no target — ignored'); return }
    try {
      await renamePlaylist(target.id, name)
      await this.enterPlaylists()
    } catch (e) {
      this.askStatus = `Rename failed: ${(e as Error).message}`
      this.requestRender()
    }
  }

  // ------------------------------------------------------------ level entry

  private async enterPlaylists(): Promise<void> {
    this.playlists = await listPlaylists()
    this.offsets.set('playlists', 0)
    this.level = 'playlists'
    this.focus = 'content'
    this.requestRender()
  }

  private async openPlaylist(pl: PlaylistRow): Promise<void> {
    this.plOpen = pl
    this.plTracks = await playlistTracks(pl.id)
    this.offsets.set('playlist', 0)
    this.level = 'playlist'
    this.focus = 'content'
    this.requestRender()
  }

  // ------------------------------------------------------------ input

  async onMenuSelect(label: string): Promise<void> {
    const p = this.player()
    try {
      switch (label) {
        case 'Pause': p?.pause('user'); this.requestRender(); return
        case 'Resume': p?.toggle('window resume'); this.requestRender(); return
        case 'Next': p?.skip(1, 'window'); return
        case 'Ask': this.level = 'ask'; this.askStatus = null; this.armDictation('ask'); return
        case 'Dictate': this.armDictation(this.level === 'ask' ? 'ask' : this.level === 'yt' ? 'yt-search' : 'search'); return
        case 'Browse': this.level = 'browse'; this.focus = 'content'; this.requestRender(); return
        case 'Queue': this.offsets.set('queue', 0); this.level = 'queue'; this.focus = 'content'; this.requestRender(); return
        case 'More': this.offsets.set('actions', 0); this.level = 'actions'; this.focus = 'content'; this.requestRender(); return
        case 'Cancel':
          this.disarmDictation('Cancel')
          if (this.level === 'ask') this.level = 'now'
          this.requestRender()
          return
        case 'Back': await this.onBack(); return
        case 'Clear':
          // Cancel-first confirm (review #W7) + player-owned clear (#W3:
          // direct surgery never persisted; a restart resurrected the queue).
          if (this.level === 'queue' && p && p.queue.length > 0) { this.level = 'confirm-clear'; this.focus = 'content'; this.requestRender() }
          else this.ctx.log('[music-win] Clear: queue already empty — ignored')
          return
        case 'Save as playlist':
          if (!p || p.queue.length === 0) { this.ctx.log('[music-win] save: queue empty — ignored'); return }
          this.armDictation('save-name')
          return
        case 'Play':
          if (this.level === 'playlist' && p && this.plTracks.length) {
            if (p.playQueue(this.plTracks, 0, `playlist "${this.plOpen?.name}"`, this.plOpen?.name)) this.level = 'now'
            this.requestRender()
          }
          return
        case 'Add current':
          if (this.level === 'playlist' && this.plOpen) await this.addCurrentTo(this.plOpen)
          return
        case 'Rename':
          if (this.level === 'playlist' && this.plOpen) { this.renameTarget = this.plOpen; this.armDictation('rename') }
          return
        case 'Edit':
          if (this.level === 'playlist') {
            // Adaptive playlists are rule-managed — row surgery would be
            // overwritten by the next refresh; refuse honestly (2026-08-05).
            if (this.plOpen?.adaptive) {
              this.askStatus = 'Adaptive playlist — its rule manages the rows (edits refused).'
              this.ctx.log(`[music-win] Edit refused on adaptive "${this.plOpen.name}"`)
              this.requestRender()
              return
            }
            this.offsets.set('playlist-edit', 0); this.level = 'playlist-edit'; this.focus = 'content'; this.requestRender()
          }
          return
        case 'Delete':
          if (this.level === 'playlist') { this.level = 'confirm-delete'; this.focus = 'content'; this.requestRender() }
          return
        default: break
      }
      // lyrics pager shares Next/Prev labels with nothing else here
      if (this.level === 'lyrics' && (label === 'Next' || label === 'Prev')) {
        if (this.plainPages) {
          if (label === 'Next' && this.lyricsPage < this.plainPages.length - 1) this.lyricsPage++
          if (label === 'Prev' && this.lyricsPage > 0) this.lyricsPage--
          this.requestRender()
        }
        return
      }
      this.ctx.log(`[music-win] menu '${label}' at level '${this.level}' — ignored (LOUD)`)
    } catch (e) {
      this.ctx.log(`[music-win] menu '${label}' failed: ${(e as Error).message}`)
      this.requestRender()
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    const p = this.player()
    try {
      switch (this.level) {
        case 'now': {
          // Single tap on the fullBleed Now Playing view = the Actions list
          // (Adam 2026-08-05: double-tap is reserved for back/exit everywhere).
          this.offsets.set('actions', 0)
          this.level = 'actions'
          this.focus = 'content'
          this.requestRender()
          return
        }
        case 'actions': {
          const row = this.pick([...ACTIONS_ROWS], 'actions', index)
          if (row === null) return
          switch (ACTIONS_ROWS[row]) {
            case '⏯ Pause/Resume': p?.toggle('window actions'); this.level = 'now'; this.requestRender(); return
            case '⏭ Next': p?.skip(1, 'window'); this.level = 'now'; this.requestRender(); return
            case 'Ask': this.level = 'ask'; this.askStatus = null; this.armDictation('ask'); return
            case 'Browse': this.level = 'browse'; this.focus = 'content'; this.requestRender(); return
            case 'Queue': this.offsets.set('queue', 0); this.level = 'queue'; this.focus = 'content'; this.requestRender(); return
            case '⏮ Previous': p?.skip(-1, 'window'); return
            case 'Seek…': this.level = 'seek'; this.requestRender(); return
            case 'Radio toggle': p?.setRadio(!p.radio, 'window'); this.requestRender(); return
            case 'Save queue as playlist':
              if (!p || p.queue.length === 0) { this.ctx.log('[music-win] save: queue empty — ignored'); return }
              this.armDictation('save-name')
              return
            case 'Add current → playlist': await this.pickPlaylistForAdd(); return
            case 'Lyrics': this.level = 'lyrics'; this.requestRender(); void this.loadLyrics(); return
            case '■ Stop': p?.stop('window'); this.level = 'now'; this.requestRender(); return
          }
          return
        }
        case 'seek': {
          if (index < 0 || index >= SEEK_ROWS.length) return
          const st = p?.status()
          if (!p || !st || st.music === 'idle') { this.level = 'actions'; this.requestRender(); return }
          const deltas: Record<string, number> = { '−5 min': -300_000, '−30 s': -30_000, '+30 s': 30_000, '+5 min': 300_000 }
          const row = SEEK_ROWS[index]
          if (row === 'Cancel') { this.level = 'now'; this.requestRender(); return }
          if (row === 'Restart track') p.seek(0, 'window')
          else p.seek(st.posMs + (deltas[row] ?? 0), 'window')
          this.level = 'now'
          this.requestRender()
          return
        }
        case 'browse': {
          if (index < 0 || index >= BROWSE_ROWS.length) return
          switch (BROWSE_ROWS[index]) {
            case 'Playlists': await this.enterPlaylists(); return
            case 'Artists': this.artists = await listArtists(); this.offsets.set('artists', 0); this.level = 'artists'; this.requestRender(); return
            case 'Albums': this.albums = await listAlbums(); this.offsets.set('albums', 0); this.level = 'albums'; this.requestRender(); return
            case 'Moods & Genres': this.vocab = await listVocabTerms(); this.offsets.set('vocab', 0); this.level = 'vocab'; this.requestRender(); return
            case 'Search': this.armDictation('search'); return
            case 'YouTube':
              // Phase D wires the grab flow; the row exists so the browse map
              // is spec-complete (D6.1) and honest until then.
              this.ctx.log('[music-win] YouTube browse — Phase D flow')
              await this.enterYouTube()
              return
          }
          return
        }
        case 'artists': {
          const rows = this.artists.map((a) => `${a.artist} (${a.n})`)
          const row = this.pick(rows, 'artists', index)
          if (row === null) return
          const a = this.artists[row]
          const tracks = (await tracksByArtist(a.artist)).map(toPlayerTrack)
          if (p?.playQueue(tracks, 0, `artist ${a.artist}`, a.artist)) { this.lastAsk = null; this.level = 'now' }
          this.requestRender()
          return
        }
        case 'albums': {
          const rows = this.albums.map((x) => `${x.album}${x.artist ? ` — ${x.artist}` : ''} (${x.n})`)
          const row = this.pick(rows, 'albums', index)
          if (row === null) return
          const al = this.albums[row]
          const tracks = await tracksByAlbum(al.album)
          if (p?.playQueue(tracks, 0, `album ${al.album}`, al.album)) { this.lastAsk = null; this.level = 'now' }
          this.requestRender()
          return
        }
        case 'vocab': {
          const rows = this.vocab.map((v) => `${v.term} (${v.n})`)
          const row = this.pick(rows, 'vocab', index)
          if (row === null) return
          // One code path with Ask: the resolver's vocab lane applies the D14
          // exclusions + dupe dedupe + artist-spread + size cap.
          await this.runAsk(this.vocab[row].term)
          return
        }
        case 'results': {
          const rows = this.results.map((t) => `${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
          const row = this.pick(rows, 'results', index)
          if (row === null) return
          if (p?.playQueue(this.results, row, `search ${this.resultsLabel}`, this.resultsLabel)) { this.lastAsk = null; this.level = 'now' }
          this.requestRender()
          return
        }
        case 'queue': {
          const row = this.pick(this.queueRows(), 'queue', index)
          if (row === null || !p || p.queue.length === 0) return
          this.rowSel = row
          this.level = 'queue-row'
          this.requestRender()
          return
        }
        case 'queue-row': {
          if (!p || index < 0 || index >= QUEUE_ROW_ACTIONS.length) return
          const sel = this.rowSel
          switch (QUEUE_ROW_ACTIONS[index]) {
            case '▶ Play from here':
              // Refusal-aware (review #W10): stay put if no phone took it.
              if (p.playQueue(p.queue, sel, 'queue jump')) this.level = 'now'
              break
            case 'Remove': {
              // The CURRENT row is never removable, idle included (review #W9:
              // while idle the player's private resume position belongs to
              // this row — removing it would resume the WRONG track mid-file).
              if (sel === p.idx) { this.ctx.log('[music-win] refusing to remove the current row (skip/jump first)'); break }
              p.queue.splice(sel, 1)
              if (sel < p.idx) p.idx--
              if (p.idx >= p.queue.length) p.idx = Math.max(0, p.queue.length - 1)
              this.ctx.log(`[music-win] queue row ${sel + 1} removed (${p.queue.length} left)`)
              p.notifyQueueEdited('window remove')   // persist + radio re-check (#W3/#C2-LOW8)
              this.level = 'queue'
              break
            }
            case 'Move up': case 'Move down': {
              const to = QUEUE_ROW_ACTIONS[index] === 'Move up' ? sel - 1 : sel + 1
              if (to < 0 || to >= p.queue.length) break
              const [t] = p.queue.splice(sel, 1)
              p.queue.splice(to, 0, t)
              if (p.idx === sel) p.idx = to
              else if (p.idx === to) p.idx = sel
              p.notifyQueueEdited('window reorder')   // #W3
              this.level = 'queue'
              break
            }
            case 'Cancel': this.level = 'queue'; break
          }
          this.requestRender()
          return
        }
        case 'confirm-clear': {
          // Cancel FIRST (the reader r27 rule — review #W7: one stray tap must
          // never wipe a curated queue).
          if (index === 1 && p) {
            p.clearQueue('window clear (confirmed)')
            this.level = 'now'
          } else {
            this.level = 'queue'
          }
          this.requestRender()
          return
        }
        case 'playlists': {
          if (this.playlists.length === 0) return
          const rows = this.playlists.map((pl) => `${pl.name} (${pl.n})${pl.adaptive ? ' ⟳' : pl.origin === 'llm' ? ' ✦' : ''}`)
          const row = this.pick(rows, 'playlists', index)
          if (row === null) return
          // Add-current mode (review #W2: this route previously dead-ended —
          // the tap OPENED the playlist instead of adding to it).
          if (this.addTarget) {
            await this.addCurrentTo(this.playlists[row])
            this.level = 'now'
            this.requestRender()
            return
          }
          await this.openPlaylist(this.playlists[row])
          return
        }
        case 'playlist': {
          if (this.plTracks.length === 0) return
          const rows = this.plTracks.map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
          const row = this.pick(rows, 'playlist', index)
          if (row === null) return
          if (p?.playQueue(this.plTracks, row, `playlist "${this.plOpen?.name}"`, this.plOpen?.name)) { this.lastAsk = null; this.level = 'now' }
          this.requestRender()
          return
        }
        case 'playlist-edit': {
          if (this.plTracks.length === 0) return
          const rows = this.plTracks.map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
          const row = this.pick(rows, 'playlist-edit', index)
          if (row === null) return
          this.rowSel = row
          this.level = 'playlist-row'
          this.requestRender()
          return
        }
        case 'playlist-row': {
          if (!this.plOpen || index < 0 || index >= PLAYLIST_ROW_ACTIONS.length) return
          const sel = this.rowSel
          try {
            switch (PLAYLIST_ROW_ACTIONS[index]) {
              case 'Remove': await removePlaylistRow(this.plOpen.id, sel); break
              case 'Move up': await movePlaylistRow(this.plOpen.id, sel, 'up'); break
              case 'Move down': await movePlaylistRow(this.plOpen.id, sel, 'down'); break
              case 'Cancel': break
            }
          } catch (e) {
            // A#3: the guards throw now (e.g. a playlist converted to adaptive
            // while this window sat open on stale plOpen) — surface, don't die.
            this.askStatus = `Edit failed: ${(e as Error).message}`
            this.ctx.log(`[music-win] playlist-row edit failed: ${(e as Error).message}`)
          }
          this.plTracks = await playlistTracks(this.plOpen.id)
          this.plOpen = { ...this.plOpen, n: this.plTracks.length }
          this.level = 'playlist-edit'
          this.requestRender()
          return
        }
        case 'confirm-delete': {
          if (index === 1 && this.plOpen) {
            await deletePlaylist(this.plOpen.id)
            this.plOpen = null
            await this.enterPlaylists()
            return
          }
          this.level = 'playlist'   // Cancel / stray tap
          this.requestRender()
          return
        }
        case 'yt': {
          if (this.ytHits.length === 0) return   // the hint row
          const rows = this.ytHits.map(ytHitRow)
          const row = this.pick(rows, 'yt', index)
          if (row === null) return
          await this.runYtGrab(this.ytHits[row])
          return
        }
        case 'yt-grabbed': {
          if (index < 0 || index >= YT_GRABBED_ROWS.length) return
          const g = this.grabbed
          switch (YT_GRABBED_ROWS[index]) {
            case '▶ Play now':
              if (g && p?.playQueue([toPlayerTrack(g.track)], 0, 'youtube grab', g.track.title)) {
                this.lastAsk = null
                this.level = 'now'
              } else {
                // On-glass honesty (review #D-F12a — the refusal was log-only).
                this.askStatus = 'Playback refused (no media-capable phone attached).'
              }
              break
            case 'Append to queue':
              if (g && p) {
                p.append([toPlayerTrack(g.track)], 'youtube grab')
                this.askStatus = `Appended: ${oneLine(g.track.title, 28)}`
                this.level = 'now'
              }
              break
            case 'Back to results': this.level = 'yt'; break
            case 'Done': this.level = 'now'; break
          }
          this.requestRender()
          return
        }
        default:
          this.ctx.log(`[music-win] browse select at level '${this.level}' — ignored`)
      }
    } catch (e) {
      this.ctx.log(`[music-win] browse action failed (${this.level}): ${(e as Error).message}`)
      this.requestRender()
    }
  }

  /** Resolve a browsePageItems tap: -1/-2 = page turns (handled here), else
   *  the index into `rows`. null = handled/out-of-range. */
  private pick(rows: string[], level: Level, index: number): number | null {
    const { map, prevOffset, nextOffset } = browsePageItems(rows, this.off(level))
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[music-win] ${level}: index ${index} out of range`); return null }
    if (m === -1) { this.offsets.set(level, prevOffset); this.requestRender(); return null }
    if (m === -2) { this.offsets.set(level, nextOffset); this.requestRender(); return null }
    return m
  }

  private async pickPlaylistForAdd(): Promise<void> {
    // Reuses the playlists level with a one-shot add-target flag; the tap
    // handler routes through addCurrentTo when set.
    const p = this.player()
    const cur = p?.nowPlaying() ?? p?.queue[p.idx]
    if (!cur) { this.ctx.log('[music-win] add-current: nothing playing/staged — ignored'); return }
    this.addTarget = cur
    await this.enterPlaylists()
  }

  private addTarget: PlayerTrack | null = null

  private async addCurrentTo(pl: PlaylistRow): Promise<void> {
    const p = this.player()
    const cur = this.addTarget ?? p?.nowPlaying() ?? (p ? p.queue[p.idx] : undefined)
    this.addTarget = null
    if (!cur) { this.ctx.log('[music-win] add-current: nothing to add — ignored'); return }
    try {
      await appendToPlaylist(pl.id, cur.id)
    } catch (e) {
      // On-glass honesty (e.g. an adaptive playlist refusing appends).
      this.askStatus = `Add failed: ${(e as Error).message}`
      this.ctx.log(`[music-win] add-current refused: ${(e as Error).message}`)
      this.requestRender()
      return
    }
    this.ctx.log(`[music-win] "${cur.title}" → playlist "${pl.name}"`)
    if (this.plOpen?.id === pl.id) { this.plTracks = await playlistTracks(pl.id); this.plOpen = { ...this.plOpen, n: this.plTracks.length } }
    this.requestRender()
  }

  // ------------------------------------------------------------ YouTube (D7)

  private ytHits: YtHit[] = []
  private ytQuery = ''
  private grabbing = false
  private grabbed: GrabResult | null = null

  private async enterYouTube(): Promise<void> {
    // Explicit-only (D7): this level is the ONE road to a grab — no search
    // miss ever falls through to here on its own.
    this.offsets.set('yt', 0)
    this.level = 'yt'
    this.focus = 'content'
    this.armDictation('yt-search')
  }

  private ytSearching = false
  private ytSearchSeq = 0

  private async runYtSearch(q: string): Promise<void> {
    // Seq guard (review #D-F12b): two rapid searches must not land out of
    // order and leave stale hits under the newer query's title.
    const seq = ++this.ytSearchSeq
    this.ytQuery = q
    this.askStatus = null
    this.ytSearching = true
    this.requestRender()
    try {
      const hits = await ytSearch(q, 5)
      if (seq !== this.ytSearchSeq) { this.ctx.log(`[music-win] yt search "${q}" superseded — dropped`); return }
      this.ytHits = hits
      this.offsets.set('yt', 0)
      if (this.ytHits.length === 0) this.askStatus = `No YouTube results for "${q}".`
      this.level = 'yt'
    } catch (e) {
      if (seq !== this.ytSearchSeq) return
      this.askStatus = `YouTube search failed: ${(e as Error).message}`
      this.ctx.log(`[music-win] yt search failed: ${(e as Error).message}`)
    } finally {
      if (seq === this.ytSearchSeq) this.ytSearching = false
      this.requestRender()
    }
  }

  private async runYtGrab(hit: YtHit): Promise<void> {
    if (this.grabbing) { this.ctx.log('[music-win] grab already in flight — ignored'); return }
    const p = this.player()
    this.grabbing = true
    this.askStatus = `⬇ grabbing "${oneLine(hit.title, 28)}"…`
    this.requestRender()
    try {
      this.grabbed = await ytGrab(this.ctx.config, hit)
      this.askStatus = `✔ grabbed: ${oneLine(this.grabbed.track.title, 30)}`
      p?.popup(`✔ grabbed: ${oneLine(this.grabbed.track.title, 30)}`)   // D7's completion popup
      this.level = 'yt-grabbed'
    } catch (e) {
      // D7: failures render loudly in-window.
      this.askStatus = `Grab FAILED: ${(e as Error).message}`
      this.ctx.log(`[music-win] yt grab failed: ${(e as Error).message}`)
    } finally {
      this.grabbing = false
      this.requestRender()
    }
  }

  async onBack(): Promise<boolean> {
    // Leaving any level with a pending dictation stops the mic (the earbud
    // lesson — a stale flag eats a later transcript).
    if (this.dictMode) { this.disarmDictation('Back'); this.requestRender(); return true }
    const up: Partial<Record<Level, Level>> = {
      'actions': 'now', 'seek': 'actions', 'ask': 'now', 'browse': 'now',
      'artists': 'browse', 'albums': 'browse', 'vocab': 'browse', 'results': 'browse',
      'queue': 'now', 'queue-row': 'queue', 'confirm-clear': 'queue',
      'playlists': 'browse', 'playlist': 'playlists', 'playlist-edit': 'playlist',
      'playlist-row': 'playlist-edit', 'confirm-delete': 'playlist', 'lyrics': 'now',
      'yt': 'browse', 'yt-grabbed': 'yt',
    }
    if (this.level === 'now') return false
    // The content→menu focus flip only exists on BROWSE levels (review #W6:
    // on text levels — lyrics — it was invisible and Back took two presses).
    if (this.focus === 'content' && BROWSE_LEVELS.has(this.level)) { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    this.level = up[this.level] ?? 'now'
    this.addTarget = null
    this.requestRender()
    return true
  }

  // Adam on-glass 2026-08-05: double-tap must ALWAYS back out/exit (he was
  // trapped in a now⇄actions loop — the old onScrollReadBack consumed the
  // double-tap to open Actions, Scout-style). No onScrollReadBack: the WM's
  // double-tap path walks onBack hierarchically and EXITS from 'now'.
  // Actions now opens with a single TAP on the Now Playing view (hub_select
  // → onBrowseSelect 'now' case). Ring-volume is GONE with it (same session:
  // volume is always max, Adam controls it on the phone) — no onContentScroll
  // means ring is a natural no-op on the short Now Playing text.

  private async loadLyrics(): Promise<void> {
    const p = this.player()
    const t = p?.nowPlaying() ?? (p ? p.queue[p.idx] : undefined)
    if (!t || !t.artist) {
      this.lrc = null; this.plainPages = ['No track/artist metadata for a lyrics lookup.']; this.lyricsLoading = false; this.requestRender(); return
    }
    const key = `${t.artist}|${t.title}`
    if (this.lyricsFor === key && (this.lrc || this.plainPages)) return
    const seq = ++this.lyricsSeq
    this.lyricsFor = key; this.lrc = null; this.plainPages = null; this.lyricsPage = 0; this.lyricsLoading = true
    this.requestRender()
    try {
      const r = await getLyrics(t.artist, t.title, t.durMs, t.album)
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

  onActivate(): void {
    // Track changed while we were away (review #W5: this comment used to
    // CLAIM a re-derivation that didn't exist) — refresh a stale lyrics level.
    if (this.level === 'lyrics' && this.lyricsFor && this.lyricsFor !== this.lyricsKey()) {
      void this.loadLyrics()
    }
  }

  onDeactivate(): void {
    this.disarmDictation('window switch')
    // A half-finished add-current must not fire hours later on an unrelated
    // tap (review #W2's staleness half).
    if (this.addTarget) {
      this.ctx.log(`[music-win] add-current abandoned (window switch) — "${this.addTarget.title}" not added`)
      this.addTarget = null
    }
    this.pendingSaveConfirm = null
  }

  async onReload(): Promise<void> {
    this.disarmDictation('Reload')
    this.askStatus = null
    this.resolving = false
    // Re-derive the current level's data on next view; browse caches refresh
    // on entry, so bounce levels that hold them.
    if (this.level === 'artists') this.artists = await listArtists()
    else if (this.level === 'albums') this.albums = await listAlbums()
    else if (this.level === 'vocab') this.vocab = await listVocabTerms()
    else if (this.level === 'playlists') this.playlists = await listPlaylists()
    else if (this.level === 'playlist' && this.plOpen) this.plTracks = await playlistTracks(this.plOpen.id)
    else if (this.level === 'lyrics') { this.lyricsFor = ''; void this.loadLyrics() }
    this.focus = 'content'
  }

  dispose(): void {
    if (this.pacer) { clearInterval(this.pacer); this.pacer = null }
  }
}
