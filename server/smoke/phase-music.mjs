// Music-app smoke (2026-08-05, MUSIC_SPEC.md Phase B) — hermetic, no phone,
// no glasses, no claude subprocess, no LLM. Replaces phase-earbud.mjs (the
// lane it tested is REMOVED — spec D2; this phase carries the removal asserts).
// HONEST COVERAGE NOTE (inherited): the /media/track HTTP handler and the real
// phone lanes are NOT exercised here — verified live at deploy. Covered:
//   Part 1: config — D8 music keys exist; audioOut.earsOn/notify RETIRED
//   Part 2: estimateSttConfidence retained (dictation meta still rides)
//   Part 3: MusicPlayerService vs a FAKE phone — caps gating, native
//           transport, capture gate, queue advance, blip retention,
//           idle-tap resume, tap-arming ping, popup emissions, prev-restart
//   Part 4: play_history + player_state persistence (smoke DB round-trip)
//   Part 5: resolver — DETERMINISTIC lanes (artist/vocab/random/empty +
//           sound-effects & spoken-word exclusions + dupe-cluster dedupe)
//   Part 6: music index → search → mono-opus transcode on a temp library
//   Part 7: popup compose — ribbon strip swap (geometry/capture unchanged) +
//           WM title intrusion + blanked flash + auto-revert
//   Part 8: removal asserts — no earbud window/aliases/grammar rows
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { MAX_CONCURRENT_SESSIONS } from '../../shared/dist/index.js'
import { MusicPlayerService } from '../dist/music-player.js'
import { estimateSttConfidence, parseVoiceCommand, WINDOW_ALIASES } from '../dist/voice.js'
import { scanLibrary, searchTracks, mediaFileFor, toPlayerTrack } from '../dist/music.js'
import { resolveRequest } from '../dist/resolver.js'
import { RibbonShell } from '../dist/ribbon.js'
import { WindowManager } from '../dist/window-manager.js'
import { query, getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- Part 1: config — D8 keys present, retired keys gone ----
{
  const { loadConfig } = await import('../dist/config.js')
  const cfg = loadConfig()
  assert.equal(Array.isArray(cfg.music.libraryDirs), true)
  assert.equal(typeof cfg.music.youtubeDir, 'string')
  assert.equal(typeof cfg.music.popupMs, 'number')
  assert.equal(typeof cfg.music.radioBatch, 'number')
  assert.equal(typeof cfg.music.queueSize, 'number')
  assert.equal(typeof cfg.music.resolver.llm, 'boolean')
  assert.equal(typeof cfg.music.embedModel, 'string')
  // Retired with the earbud lane (D2/D8):
  assert.equal(cfg.audioOut.earsOn, undefined, 'audioOut.earsOn retired')
  assert.equal(cfg.audioOut.notify, undefined, 'audioOut.notify retired')
  // Dictation config is UNTOUCHED by Phase B:
  assert.equal(cfg.stt.micSource === 'earbud' || cfg.stt.micSource === 'dji', true, 'micSource untouched')
  assert.equal(cfg.tts.engine, 'kokoro', 'tts config stays valid-dormant')
  assert.equal(typeof cfg.companion.confirmThreshold, 'number', 'companion config stays valid-dormant')
  assert.equal(MAX_CONCURRENT_SESSIONS, 6)
  console.error('  1. config: D8 music keys + earsOn/notify retirement ✓')
}

// ---- Part 2: confidence heuristic retained (SttMeta still rides transcripts) ----
{
  assert.ok(estimateSttConfidence('set a timer for ten minutes please', 2800) >= 0.95)
  assert.equal(estimateSttConfidence('', 1000), 0)
  console.error('  2. estimateSttConfidence retained ✓')
}

// ---- temp tracks for player/history/resolver parts (smoke DB; FK-real ids) ----
const SMOKE_ARTIST_A = 'Smoke Metal Band'
const SMOKE_ARTIST_B = 'Smoke Doom Crew'
const SMOKE_PATH_PREFIX = '/tmp/g2cc-smoke-music-rows/'
async function insertTrack(name, artist, album, durMs, ext = 'mp3') {
  const r = await query(
    `INSERT INTO tracks (path, title, artist, album, dur_ms, mtime_ms) VALUES ($1,$2,$3,$4,$5,0)
     ON CONFLICT (path) DO UPDATE SET title=EXCLUDED.title RETURNING id`,
    [`${SMOKE_PATH_PREFIX}${name}.${ext}`, name, artist, album, durMs])
  return r.rows[0].id
}
async function insertMeta(trackId, fields) {
  await query(
    `INSERT INTO track_meta (track_id, genres, styles, moods, dupe_cluster)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (track_id) DO UPDATE SET genres=EXCLUDED.genres, styles=EXCLUDED.styles,
       moods=EXCLUDED.moods, dupe_cluster=EXCLUDED.dupe_cluster`,
    [trackId, fields.genres ?? null, fields.styles ?? null, fields.moods ?? null, fields.dupe ?? null])
}
async function cleanupSmokeRows() {
  // The broad prefix also sweeps Part 6's mkdtemp('/tmp/g2cc-smoke-music-…')
  // leftovers from a CRASHED prior run (review #D11: those rows were outside
  // every cleanup path and made searchTracks('smoke artist') a coin flip).
  await query('DELETE FROM tracks WHERE path LIKE $1', ['/tmp/g2cc-smoke-music-%'])
  // Part 13's ingest drop-box roots (ingest review #20 + B#8: mkdtemp honors
  // TMPDIR, so match the basename anywhere — a /tmp/-anchored pattern missed
  // rows from runners with TMPDIR elsewhere, and those carry SMOKE_ARTIST_A
  // ('Smoke Metal Band') which can flake later asserts).
  await query('DELETE FROM tracks WHERE path LIKE $1', ['%g2cc-smoke-ingestlib-%'])
  await query('DELETE FROM player_state WHERE id = true')
  // Part 9/13's playlists (review #C-LOW8: a crashed run stranded the rows).
  await query("DELETE FROM playlists WHERE lower(name) IN ('smoke mix', 'other mix', 'smoke rule metal')")
}
await cleanupSmokeRows()   // stale rows from a crashed prior run

const idA1 = await insertTrack('Iron Anthem', SMOKE_ARTIST_A, 'Forge', 200_000)
const idA2 = await insertTrack('Steel Chorus', SMOKE_ARTIST_A, 'Forge', 210_000)
const idB1 = await insertTrack('Slow Dirge', SMOKE_ARTIST_B, 'Depths', 240_000)
const idSfx = await insertTrack('Sword Clang', null, null, 3_000)
// Title deliberately avoids the resolver's spoken-word opt-out words
// (spoken/interlude) so the keep/exclude asserts test the LANE flags, not the
// opt-out regex.
const idSpoken = await insertTrack('Broadcast Segment', SMOKE_ARTIST_B, 'Depths', 60_000)
const idDupHi = await insertTrack('Iron Anthem (flac rip)', SMOKE_ARTIST_A, 'Forge', 200_000, 'flac')
await insertMeta(idA1, { genres: ['metal'], styles: ['power metal'], moods: ['epic'], dupe: 9001 })
await insertMeta(idA2, { genres: ['metal'], styles: ['speed metal'], moods: ['driving'] })
await insertMeta(idB1, { genres: ['metal', 'doom metal'], moods: ['heavy'] })
// Both carry 'metal' too so the vocab lane MATCHES them and the exclusions
// are exercised deterministically (not just by random-lane luck). The
// excluded terms mirror PRODUCTION REALITY (review #C-HIGH1: the library
// files 'sound effect' SINGULAR and puts both terms mostly in STYLES — the
// old fixture planted the code's own plural-in-genres string and proved
// nothing).
await insertMeta(idSfx, { genres: ['metal'], styles: ['sound effect'] })
await insertMeta(idSpoken, { genres: ['metal'], styles: ['spoken word'] })
await insertMeta(idDupHi, { genres: ['metal'], styles: ['power metal'], dupe: 9001 })

// ---- Part 3: MusicPlayerService vs a fake phone ----
{
  const sentJson = []
  const popups = []
  const cfg = { authToken: 'smoke-token', music: { format: 'opus', popupMs: 4500, queueSize: 25, radioBatch: 10 } }
  const svc = new MusicPlayerService(cfg, {
    toPhone: (msg) => { sentJson.push(msg); return true },
    popup: (line) => popups.push(line),
  })

  // No caps announced → playQueue refuses honestly, sends nothing.
  assert.equal(svc.playQueue([{ id: idA1, title: 'Iron Anthem' }], 0, 'smoke'), false)
  assert.equal(sentJson.length, 0, 'nothing sent without media-lane caps')

  // Caps up with an IDLE EMPTY queue → no arming ping (nothing staged).
  svc.notePhoneCaps(['media-lane', 'earbud-buttons'])
  assert.equal(sentJson.length, 0, 'no arming ping without a staged queue')

  // playQueue → media_open with the token url + queue-start popup.
  const t1 = { id: idA1, title: 'Iron Anthem', artist: SMOKE_ARTIST_A, durMs: 200_000 }
  const t2 = { id: idA2, title: 'Steel Chorus', artist: SMOKE_ARTIST_A, durMs: 210_000 }
  assert.equal(svc.playQueue([t1, t2], 0, 'smoke', 'metal test'), true)
  const open1 = sentJson.find((m) => m.type === 'media_open')
  assert.ok(open1, 'media_open sent')
  assert.match(open1.url, new RegExp(`^/media/track/${idA1}\\?token=smoke-token`), 'server-relative token url')
  assert.ok(popups.some((p) => p.includes('2: metal test')), 'queue-start popup')

  // Review #H1/#N2: the capture gate must work from 'opening' too — a
  // dictation ringed inside the ~1 s open window pauses, capture-end resumes.
  {
    const pausesPre = sentJson.filter((m) => m.type === 'media_ctl' && m.cmd === 'pause').length
    const playsPre = sentJson.filter((m) => m.type === 'media_ctl' && m.cmd === 'play').length
    svc.onCaptureState(true)
    assert.equal(sentJson.filter((m) => m.type === 'media_ctl' && m.cmd === 'pause').length, pausesPre + 1, 'capture pauses even mid-open')
    svc.onCaptureState(false)
    assert.equal(sentJson.filter((m) => m.type === 'media_ctl' && m.cmd === 'play').length, playsPre + 1, 'capture end resumes a mid-open pause')
  }

  // First 'playing' → track popup + state.
  svc.onMediaEvent({ type: 'media_event', id: open1.id, state: 'playing', posMs: 0 })
  assert.equal(svc.status().music, 'playing')
  assert.ok(popups.some((p) => p.includes('Iron Anthem') && p.includes(SMOKE_ARTIST_A)), 'track-start popup')

  // Dictate capture: pause; capture end resumes (D5's one coupling).
  svc.onCaptureState(true)
  assert.ok(sentJson.some((m) => m.type === 'media_ctl' && m.cmd === 'pause'), 'capture pauses music')
  svc.onCaptureState(false)
  assert.ok(sentJson.some((m) => m.type === 'media_ctl' && m.cmd === 'play'), 'capture end resumes')
  svc.onMediaEvent({ type: 'media_event', id: open1.id, state: 'playing', posMs: 1000 })

  // Track end advances the queue.
  const opensBefore = sentJson.filter((m) => m.type === 'media_open').length
  svc.onMediaEvent({ type: 'media_event', id: open1.id, state: 'ended', posMs: 199_000 })
  const opens = sentJson.filter((m) => m.type === 'media_open')
  assert.equal(opens.length, opensBefore + 1, 'queue advanced to track 2')
  assert.match(opens.at(-1).url, new RegExp(`track/${idA2}\\?`))

  // Native prev semantics: <3 s in at queue idx 1 → goes BACK a track.
  const open2 = opens.at(-1)
  svc.onMediaEvent({ type: 'media_event', id: open2.id, state: 'playing', posMs: 1000 })
  svc.skip(-1, 'smoke')
  assert.match(sentJson.filter((m) => m.type === 'media_open').at(-1).url, new RegExp(`track/${idA1}\\?`), 'prev <3s goes back a track')
  const open3 = sentJson.filter((m) => m.type === 'media_open').at(-1)
  svc.onMediaEvent({ type: 'media_event', id: open3.id, state: 'playing', posMs: 30_000 })
  svc.skip(-1, 'smoke')
  assert.match(sentJson.filter((m) => m.type === 'media_open').at(-1).url, new RegExp(`track/${idA1}\\?`), 'prev ≥3s restarts current')

  // External (phone-initiated) pause pops honestly.
  const open4 = sentJson.filter((m) => m.type === 'media_open').at(-1)
  svc.onMediaEvent({ type: 'media_event', id: open4.id, state: 'playing', posMs: 0 })
  svc.onMediaEvent({ type: 'media_event', id: open4.id, state: 'paused', posMs: 500 })
  assert.ok(popups.some((p) => p.includes('⏸')), 'phone-initiated pause pops')

  // Review #N1: the phone resuming on its OWN (audio focus returns) must
  // clear the pause latch — the next 'ended' still advances the queue
  // (the latched pausedBy used to silently kill it mid-queue).
  svc.onMediaEvent({ type: 'media_event', id: open4.id, state: 'playing', posMs: 800 })
  const opensN1 = sentJson.filter((m) => m.type === 'media_open').length
  svc.onMediaEvent({ type: 'media_event', id: open4.id, state: 'ended', posMs: 199_900 })
  assert.equal(sentJson.filter((m) => m.type === 'media_open').length, opensN1 + 1, 'queue advances after an external pause/resume cycle (latch cleared)')

  // Phone detach (deep-review #14): the model is RETAINED mid-blip.
  svc.notePhoneCaps(null)
  assert.notEqual(svc.status().music, 'idle', 'model survives a WS blip')
  svc.notePhoneCaps(['media-lane'])
  svc.stop('smoke')
  assert.equal(svc.status().music, 'idle')

  // Idle-tap resume (the morning path): idle + staged queue → toggle starts it.
  const openCount = sentJson.filter((m) => m.type === 'media_open').length
  svc.toggle('smoke tap')
  assert.equal(sentJson.filter((m) => m.type === 'media_open').length, openCount + 1, 'idle tap starts the staged queue')
  svc.stop('smoke')

  // Tap-arming ping: caps re-announce with an idle staged queue → media_ctl(pause).
  svc.notePhoneCaps(null)
  const ctlsBefore = sentJson.filter((m) => m.type === 'media_ctl' && m.cmd === 'pause').length
  svc.notePhoneCaps(['media-lane'])
  assert.equal(sentJson.filter((m) => m.type === 'media_ctl' && m.cmd === 'pause').length, ctlsBefore + 1, 'arming ping sent for the staged idle queue')

  console.error('  3. MusicPlayerService: caps/transport/capture/advance/blip/idle-tap/arming/popups ✓')

  // ---- Part 3b (Phase E): v1.22 gapless prestage (cap media-prestage) ----
  {
    const sent2 = []
    const svcP = new MusicPlayerService(cfg, { toPhone: (m) => { sent2.push(m); return true }, popup: () => {} })
    svcP.notePhoneCaps(['media-lane', 'media-prestage'])
    assert.equal(svcP.playQueue([t1, t2, { id: idB1, title: 'Slow Dirge', durMs: 240_000 }], 0, 'smoke', 'prestage test'), true)
    const openP = sent2.find((m) => m.type === 'media_open')
    assert.ok(openP.next, 'the open ships the NEXT track (cap-gated)')
    assert.match(openP.next.url, new RegExp(`track/${idA2}\\?`), 'next points at queue[1]')
    svcP.onMediaEvent({ type: 'media_event', id: openP.id, state: 'playing', posMs: 0 })
    // The phone rolls to the prestaged item on its own: NO re-open; the
    // FOLLOWING track preloads; history completed for the finished one.
    const opensBefore2 = sent2.filter((m) => m.type === 'media_open').length
    svcP.onMediaEvent({ type: 'media_event', id: openP.next.id, state: 'playing', posMs: 0, reason: 'auto_advanced' })
    assert.equal(sent2.filter((m) => m.type === 'media_open').length, opensBefore2, 'auto-advance does NOT re-open')
    assert.equal(svcP.idx, 1, 'idx adopted the prestaged track')
    assert.equal(svcP.status().music, 'playing')
    const preload = sent2.find((m) => m.type === 'media_ctl' && m.cmd === 'preload')
    assert.ok(preload?.next, 'the following track preloads after the advance')
    assert.match(preload.next.url, new RegExp(`track/${idB1}\\?`), 'preload points at queue[2]')
    // A v1.21-class phone (no cap) gets NEITHER field nor preload cmds.
    const sent3 = []
    const svcQ = new MusicPlayerService(cfg, { toPhone: (m) => { sent3.push(m); return true }, popup: () => {} })
    svcQ.notePhoneCaps(['media-lane'])
    svcQ.playQueue([t1, t2], 0, 'smoke')
    assert.equal(sent3.find((m) => m.type === 'media_open').next, undefined, 'no cap → no next field (v1.21 floor)')
    svcQ.onMediaEvent({ type: 'media_event', id: sent3.find((m) => m.type === 'media_open').id, state: 'playing', posMs: 0 })
    assert.ok(!sent3.some((m) => m.type === 'media_ctl' && m.cmd === 'preload'), 'no cap → no preload ever')
    svcQ.stop('smoke'); svcP.stop('smoke')
    // Final-review #S1: three fixture services share the ONE player_state row
    // (a production impossibility — initMusicPlayer is a throw-on-second
    // singleton). Flush the 3b fixtures NOW so their debounced writes can't
    // race Part 4's assertion of svc's state (commit order was a coin flip).
    await svcP.flushPersist()
    await svcQ.flushPersist()
    console.error('  3b. v1.22 prestage: open+next, auto-advance w/o re-open, rolling preload, v1.21 floor ✓')
  }

  // ---- Part 4: history + player_state persistence (same service instance) ----
  await sleep(1200)          // history fire-and-forget chains settle
  await svc.flushPersist()   // #S1: svc's write lands LAST, deterministically
  const hist = await query('SELECT track_id, completed, skipped, ended_at FROM play_history WHERE track_id IN ($1,$2) ORDER BY id', [idA1, idA2])
  assert.ok(hist.rows.length >= 2, `history rows written (got ${hist.rows.length})`)
  const completedRow = hist.rows.find((r) => r.completed === true)
  assert.ok(completedRow, 'the ended track logged completed=true')
  assert.equal(Number(completedRow.track_id), idA1, 'completion on the track that ended')
  assert.ok(hist.rows.some((r) => r.skipped === true), 'an early skip logged skipped=true')
  const ps = await query('SELECT queue, idx, radio FROM player_state WHERE id = true')
  assert.equal(ps.rows.length, 1, 'player_state singleton written')
  assert.equal(Array.isArray(ps.rows[0].queue), true)
  assert.equal(ps.rows[0].queue.length, 2, 'queue persisted')

  // Boot-restore round trip: a FRESH service loads the queue, stays idle.
  const svc2 = new MusicPlayerService(cfg, { toPhone: () => true, popup: () => {} })
  await svc2.loadPersisted()
  assert.equal(svc2.status().music, 'idle', 'restore NEVER auto-plays')
  assert.equal(svc2.queue.length, 2, 'queue restored from player_state')
  console.error('  4. play_history semantics + player_state persist/restore ✓')
}

// ---- Part 5: resolver — deterministic lanes ----
{
  const cfg = { music: { queueSize: 25 } }
  const art = await resolveRequest(cfg, SMOKE_ARTIST_A.toLowerCase())
  assert.equal(art.lane, 'artist')
  assert.ok(art.tracks.length >= 2, 'artist lane finds the artist tracks')
  // Dupe-cluster dedupe: 9001 appears once, and the flac member won.
  const cluster = art.tracks.filter((t) => t.id === idA1 || t.id === idDupHi)
  assert.equal(cluster.length, 1, 'one member per dupe cluster')
  assert.equal(cluster[0].id, idDupHi, 'higher-fidelity (flac) member preferred')

  // EXPLICIT asks keep spoken word (review #D1 — IT interludes are real
  // content; the exclusion belongs to the DISCOVERY lanes only). idSpoken
  // belongs to ARTIST_B, so this is the non-vacuous exerciser.
  const artB = await resolveRequest(cfg, SMOKE_ARTIST_B.toLowerCase())
  assert.equal(artB.lane, 'artist')
  assert.ok(artB.tracks.some((t) => t.id === idSpoken), 'artist ask KEEPS spoken word')
  const srch = await resolveRequest(cfg, 'broadcast segment')
  assert.equal(srch.lane, 'search', `direct title search answers (got ${srch.lane}: ${srch.detail})`)
  assert.ok(srch.tracks.some((t) => t.id === idSpoken), 'title search KEEPS spoken word (no "1 hits → 0 queued" dead end)')

  // Vocab lane: 'metal' is library vocabulary → matched set, exclusions
  // applied deterministically (idSfx/idSpoken both carry 'metal' on purpose).
  // Punctuation-tolerant tokenization (review #D3): the trailing period must
  // not dead-end the ask.
  const vocab = await resolveRequest(cfg, 'Play some metal stuff.')
  assert.equal(vocab.lane, 'vocab', `vocab lane answers (got ${vocab.lane}: ${vocab.detail})`)
  assert.ok(vocab.tracks.length >= 2)
  assert.ok(vocab.tracks.every((t) => t.id !== idSfx), 'sfx excluded from vocab lane')
  assert.ok(vocab.tracks.every((t) => t.id !== idSpoken), 'spoken word excluded from discovery lanes')
  assert.ok(vocab.detail.includes('lane vocab'), 'honest which-lane line')

  // Random lane: exclusions hold, and random-intent PHRASES resolve random
  // (review #D4: "play something random" used to dead-end).
  const rnd = await resolveRequest(cfg, 'play something random')
  assert.equal(rnd.lane, 'random', `random phrasing resolves random (got ${rnd.lane})`)
  assert.ok(rnd.tracks.every((t) => t.id !== idSfx && t.id !== idSpoken), 'random excludes sfx + spoken word')

  // LIKE metacharacters are literal (review #D2): a '%' token must not
  // match-all — nothing in the library contains a literal '%'.
  const meta = await resolveRequest(cfg, 'zz%zz')
  assert.equal(meta.lane, 'empty', `'%' token stays literal (got ${meta.lane}: ${meta.detail})`)

  // Honest empty — nothing plays, nothing falls back.
  const none = await resolveRequest(cfg, 'zzz definitely not in any library zzz')
  assert.equal(none.lane, 'empty')
  assert.equal(none.tracks.length, 0)
  console.error('  5. resolver deterministic lanes (artist/vocab/random/empty + spoken-kept + escaping + dedupe) ✓')
}

// ---- Part 6: music index → search → transcode on a temp library ----
{
  const dir = mkdtempSync(join(tmpdir(), 'g2cc-smoke-music-'))
  // FLAC not mp3 — this box's ffmpeg ships without libmp3lame (Gentoo USE).
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-metadata', 'title=Smoke Tone', '-metadata', 'artist=Smoke Artist', join(dir, 'tone.flac')])
  const cfg = { music: { libraryDirs: [dir], format: 'opus', cacheDir: join(dir, 'cache') } }
  const s = await scanLibrary(cfg)
  assert.equal(s.failed, 0, 'no probe failures')
  assert.ok(s.added >= 1, 'tone indexed')
  const hits = await searchTracks('smoke artist')
  const tone = hits.find((t) => t.title === 'Smoke Tone')
  assert.ok(tone, 'metadata parsed')
  const media = await mediaFileFor(cfg, tone, 'opus')
  assert.ok(existsSync(media.path), 'transcode cached')
  assert.equal(media.mime, 'audio/ogg')
  assert.equal(toPlayerTrack(tone).title, 'Smoke Tone')
  await query('DELETE FROM tracks WHERE path LIKE $1', [`${dir}%`])
  rmSync(dir, { recursive: true, force: true })
  console.error('  6. music index → search → mono-opus transcode ✓')
}

// ---- Part 7: popup compose — ribbon strip swap + WM title intrusion ----
{
  // Ribbon strip: override swaps the TEXT only; id/geometry/scroll unchanged.
  const shell = new RibbonShell(
    () => ({ id: 'main', tab: 'Main' }),
    () => [{ id: 'files', tab: 'Files' }],
    () => [{ id: 'main', tab: 'Main', category: 'Info' }, { id: 'files', tab: 'Files', category: 'Tools' }],
    () => 4, () => null, () => 0,
  )
  const normal = shell.scene('preview text', '80%')
  const popped = shell.scene('preview text', '80%', '▶ Iron Anthem — Smoke Metal Band')
  const stripOf = (sc) => sc.regions.find((r) => r.name === 'strip')
  assert.ok(stripOf(normal).content.text.includes('[Main]'), 'normal strip shows the item cells')
  assert.ok(stripOf(popped).content.text.includes('Iron Anthem'), 'popup strip shows the popup line')
  assert.equal(stripOf(popped).id, stripOf(normal).id, 'same antenna id')
  assert.equal(stripOf(popped).content.scroll, true, 'scroll capture unchanged')
  assert.deepEqual(
    { x: stripOf(popped).x, y: stripOf(popped).y, w: stripOf(popped).w, h: stripOf(popped).h },
    { x: stripOf(normal).x, y: stripOf(normal).y, w: stripOf(normal).w, h: stripOf(normal).h },
    'geometry unchanged')

  // WM in-window title intrusion + auto-revert (popupMs from config).
  const scenes = []
  const titleOf = (s) => s?.regions?.find((r) => r.name === 'title')?.content?.text ?? ''
  const wm = new WindowManager({
    send: (scene) => scenes.push(scene),
    audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 1 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' }, music: { popupMs: 250 } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 200; i++) { if (pred()) return; await sleep(25) }
    throw new Error(`waitFor timed out: ${what}`)
  }
  wm.requestRender()
  await waitFor(() => titleOf(scenes.at(-1)).includes('Main'), 'initial Main render')
  wm.musicPopup('▶ Iron Anthem — Smoke Metal Band')
  await waitFor(() => titleOf(scenes.at(-1)).includes('Iron Anthem'), 'popup takes the title line')
  await waitFor(() => titleOf(scenes.at(-1)).includes('Main') && !titleOf(scenes.at(-1)).includes('Iron Anthem'), 'popup auto-reverts')

  // Blanked: popup rides the one-line flash path, then back to dark.
  await wm.onVoiceCommand('butterscotch blank')
  await sleep(60)
  const blankBase = scenes.length
  wm.musicPopup('▶ Steel Chorus')
  await waitFor(() => scenes.length > blankBase && JSON.stringify(scenes.at(-1)).includes('Steel Chorus'), 'blanked popup flash')
  await waitFor(() => !JSON.stringify(scenes.at(-1)).includes('Steel Chorus'), 'blanked popup reverts to dark')
  wm.dispose()
  console.error('  7. popup compose: ribbon strip swap + title intrusion + blank flash + revert ✓')
}

// ---- Part 8: removal asserts (spec D2) ----
{
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  assert.ok(!wm.windows.some((w) => w.id === 'earbud'), 'EarbudWindow removed from the registry')
  assert.ok(wm.windows.some((w) => w.id === 'media'), 'the third-party Media window is untouched')
  wm.dispose()
  assert.equal(WINDOW_ALIASES.earbud, undefined, 'earbud alias gone')
  assert.equal(WINDOW_ALIASES.companion, undefined, 'companion alias gone')
  assert.equal(parseVoiceCommand('butterscotch pause', { wake: true }).cmd, null, 'transport verbs gone')
  assert.equal(parseVoiceCommand("butterscotch what's playing", { wake: true }).cmd, null, 'whats_playing gone')
  // The dist tree must not resurrect the dead module.
  let earbudImport = 'rejected'
  try { await import('../dist/earbud.js'); earbudImport = 'resolved' } catch { /* expected */ }
  assert.equal(earbudImport, 'rejected', 'dist/earbud.js gone (clean build)')
  console.error('  8. removal asserts: window/aliases/grammar/module ✓')
}

// ---- Part 9 (Phase C): playlists CRUD + the resolver playlist lane ----
{
  const { listPlaylists, savePlaylist, playlistTracks, renamePlaylist, deletePlaylist, appendToPlaylist, removePlaylistRow, movePlaylistRow } = await import('../dist/playlists.js')
  const plId = await savePlaylist('Smoke Mix', [{ id: idA1, title: 'Iron Anthem' }, { id: idA2, title: 'Steel Chorus' }], 'manual')
  const mine = (await listPlaylists()).find((p) => p.id === plId)
  assert.ok(mine && mine.n === 2, 'playlist saved with 2 rows')
  await appendToPlaylist(plId, idB1)
  assert.equal((await playlistTracks(plId))[2].id, idB1, 'append lands at the tail')
  await movePlaylistRow(plId, 2, 'up')
  assert.equal((await playlistTracks(plId))[1].id, idB1, 'move-up park-swap works under the (playlist,position) PK')
  await removePlaylistRow(plId, 1)
  const after = await playlistTracks(plId)
  assert.equal(after.length, 2, 'remove closes the position gap')
  assert.ok(after.every((t) => t.id !== idB1))
  const plId2 = await savePlaylist('smoke mix', [{ id: idB1, title: 'Slow Dirge' }])
  assert.equal(plId2, plId, 'save under the same name REPLACES (case-insensitive)')
  assert.equal((await playlistTracks(plId)).length, 1)
  const otherId = await savePlaylist('Other Mix', [{ id: idA1, title: 'Iron Anthem' }])
  let clashErr = null
  try { await renamePlaylist(otherId, 'SMOKE MIX') } catch (e) { clashErr = e }
  assert.ok(clashErr, 'rename into an existing name refuses loudly')
  const plLane = await resolveRequest({ music: { queueSize: 25 } }, 'smoke mix')
  assert.equal(plLane.lane, 'playlist', 'resolver playlist lane answers by exact name')
  assert.equal(plLane.tracks.length, 1)
  await deletePlaylist(plId)
  await deletePlaylist(otherId)
  assert.ok(!(await listPlaylists()).some((p) => p.id === plId), 'delete removes the playlist')
  console.error('  9. playlists CRUD (save/replace/append/move/remove/rename-clash/delete) + playlist lane ✓')
}

// ---- Part 10 (Phase C): llm plan parse/query + radio plumbing ----
// The LLM itself is NEVER run in smokes; parseLlmPlan/planQuery are the
// deterministic halves. radioNeighbors exercises LIVE local Qdrant READ-ONLY
// (the phase10-calendar read-only precedent) with known-existing point ids;
// the returned prod track ids then filter against the smoke DB.
{
  const { parseLlmPlan, planQuery, radioNeighbors } = await import('../dist/resolver.js')
  assert.equal(parseLlmPlan('not json'), null)
  assert.equal(parseLlmPlan('{"order":"shuffle"}'), null, 'a plan with no filter is rejected')
  const plan = parseLlmPlan('```json\n{"genres":["Metal"],"energy":7,"order":"shuffle","size":10}\n```')
  assert.ok(plan, 'fenced JSON tolerated')
  assert.deepEqual(plan.genres, ['metal'], 'terms lowercased')
  assert.deepEqual(plan.energy, { min: 5, max: 9 }, 'numeric energy becomes a ±2 range')
  const rows = await planQuery({ genres: ['metal'] }, 25)
  assert.ok(rows.length >= 2, `planQuery matches the metal fixtures (got ${rows.length})`)
  const none = await planQuery({ genres: ['metal'], artists: ['nonexistent artist zz'] }, 25)
  assert.equal(none.length, 0, 'AND across filter lists')
  // Live local-Qdrant READ-ONLY (the phase10 precedent). Seed ids come from
  // the collection itself (review #C-LOW7: hard-coded [1,2] would rot if
  // those tracks are ever purged) and the failure is LABELED as environmental.
  let radio
  try {
    const scroll = await fetch('http://127.0.0.1:6333/collections/g2cc_music/points/scroll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2 }), signal: AbortSignal.timeout(8000),
    }).then((r) => r.json())
    const seedIds = (scroll.result?.points ?? []).map((p) => p.id)
    assert.ok(seedIds.length >= 1, 'collection has points to seed from')
    radio = await radioNeighbors({ music: {} }, seedIds, seedIds, 5)
  } catch (e) {
    throw new Error(`live Qdrant read failed (ENV dependency — is qdrant on :6333 up?): ${e.message}`)
  }
  assert.ok(Array.isArray(radio), 'radioNeighbors resolves cleanly (foreign ids filter to smoke-DB rows or none)')
  // Unembedded seeds must degrade cleanly, never 404 the whole call (#C2-HIGH1).
  const ghost = await radioNeighbors({ music: {} }, [987654321], [], 5)
  assert.deepEqual(ghost, [], 'an unembedded-only seed set returns [] with a loud log, not a 404 throw')
  console.error('  10. llm plan parse/query + radio plumbing (incl. unembedded-seed hygiene) ✓')
}

// ---- Part 12 (Phase C): music-browse facets (review #C-MED5: zero coverage
//      was exactly how the no-op exclusion shipped green) ----
{
  const { listAlbums, tracksByAlbum, listVocabTerms } = await import('../dist/music-browse.js')
  // Case-variant albums group as ONE row whose count equals what a tap plays
  // (review #C-LOW6 — prod has real case-duplicate albums).
  const idCase1 = await insertTrack('Case A', SMOKE_ARTIST_B, 'Smoke Case Album', 100_000)
  const idCase2 = await insertTrack('Case B', SMOKE_ARTIST_B, 'SMOKE CASE ALBUM', 100_000)
  const albums = await listAlbums()
  const caseRows = albums.filter((a) => a.album.toLowerCase() === 'smoke case album')
  assert.equal(caseRows.length, 1, 'case-variant albums group to one browse row')
  assert.equal(caseRows[0].n, 2, 'the grouped count is the union')
  assert.equal((await tracksByAlbum('smoke case album')).length, 2, 'a tap plays the union')
  // The vocab facet hides the REAL sfx term (singular, styles-resident).
  const terms = await listVocabTerms(500)
  assert.ok(!terms.some((t) => t.term.toLowerCase().startsWith('sound effect')), 'sfx terms hidden from the browse facet')
  assert.ok(terms.some((t) => t.term === 'metal'), 'real vocabulary terms present')
  await query('DELETE FROM tracks WHERE id IN ($1, $2)', [idCase1, idCase2])
  // Playlist edge coverage (review #C gaps): boundary moves refuse; append
  // works on an emptied playlist.
  const { savePlaylist, movePlaylistRow, removePlaylistRow, appendToPlaylist, playlistTracks, deletePlaylist } = await import('../dist/playlists.js')
  const pid = await savePlaylist('Smoke Mix', [{ id: idA1, title: 'Iron Anthem' }, { id: idA2, title: 'Steel Chorus' }])
  assert.equal(await movePlaylistRow(pid, 0, 'up'), false, 'move-up at the head refuses')
  assert.equal(await movePlaylistRow(pid, 1, 'down'), false, 'move-down at the tail refuses')
  await removePlaylistRow(pid, 0)
  await removePlaylistRow(pid, 0)
  assert.equal((await playlistTracks(pid)).length, 0, 'playlist emptied')
  await appendToPlaylist(pid, idB1)
  assert.equal((await playlistTracks(pid))[0].id, idB1, 'append onto an emptied playlist lands at 0')
  await deletePlaylist(pid)
  console.error('  12. music-browse facets + playlist edges ✓')
}

// ---- Part 11 (Phase C): MusicWindow registered + honest offline render ----
{
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  assert.ok(wm.windows.some((w) => w.id === 'music'), 'MusicWindow registered (the Media slot)')
  assert.ok(wm.windows.some((w) => w.id === 'media'), 'third-party Media window untouched')
  const music = wm.windows.find((w) => w.id === 'music')
  const v = await music.view()
  assert.ok(v.title.includes('Music'))
  assert.ok((v.text ?? '').toLowerCase().includes('offline'), 'honest player-offline state in harnesses')
  assert.ok((music.preview() ?? '').toLowerCase().includes('offline'), 'preview honest offline')
  wm.dispose()
  console.error('  11. MusicWindow registered + honest offline render ✓')
}

// ---- Part 13 (2026-08-05): adaptive playlists + the ingest drop-box ----
{
  const { upsertRulePlaylist, refreshRulePlaylists, listPlaylists, savePlaylist, appendToPlaylist, playlistTracks, deletePlaylist, playlistsContaining } = await import('../dist/playlists.js')
  const { ingestFileNow } = await import('../dist/ingest.js')

  // Rule playlist over the fixtures: metal, sfx excluded, cluster-deduped.
  const { id: rpId, n } = await upsertRulePlaylist('Smoke Rule Metal', { genres: ['metal'] })
  assert.ok(n >= 3, `rule materialized (${n} members)`)
  const members = await playlistTracks(rpId)
  assert.ok(members.every((t) => t.id !== idSfx), 'sfx excluded from rule membership')
  assert.equal(members.filter((t) => t.id === idA1 || t.id === idDupHi).length, 1, 'one member per dupe cluster')
  const listed = (await listPlaylists()).find((p) => p.id === rpId)
  assert.equal(listed?.adaptive, true, 'adaptive flag surfaces')
  // Guards: frozen-snapshot replace + manual append both refuse.
  let saveErr = null
  try { await savePlaylist('smoke rule metal', [{ id: idA1, title: 'Iron Anthem' }]) } catch (e) { saveErr = e }
  assert.ok(saveErr && /adaptive/i.test(saveErr.message), 'save-over-rule-name refuses')
  let appErr = null
  try { await appendToPlaylist(rpId, idB1) } catch (e) { appErr = e }
  assert.ok(appErr && /adaptive/i.test(appErr.message), 'manual append to adaptive refuses')

  // Adaptivity: a NEW matching track lands on refresh; positions stay dense.
  const idNew = await insertTrack('Fresh Steel', SMOKE_ARTIST_A, 'Forge', 180_000)
  await insertMeta(idNew, { genres: ['metal'] })
  await refreshRulePlaylists('smoke new track')
  const after = await playlistTracks(rpId)
  assert.ok(after.some((t) => t.id === idNew), 'new matching track auto-lands')
  assert.ok((await playlistsContaining(idNew)).includes('Smoke Rule Metal'), 'playlistsContaining sees it')

  // The ingest drop-box: temp root + new/ inside it; enrichment skipped
  // (testing-safety); the file indexes, gets FILED into <root>/<Artist>/<Album>/,
  // the row's id/path update in place, and the rule playlist picks it up
  // (via an explicit refresh here — the real chain does it in-line).
  const iroot = mkdtempSync(join(tmpdir(), 'g2cc-smoke-ingestlib-'))
  // try/finally (B-review 2026-08-05 #7): an assert throwing mid-part used to
  // strand the temp dir (and its rows) with nothing ever sweeping /tmp.
  try {
    const idir = join(iroot, 'new')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(idir, { recursive: true })
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
      '-metadata', 'title=Dropbox Tone', '-metadata', 'artist=Smoke Metal Band', '-metadata', 'album=Forge', join(idir, 'drop.flac')])
    const icfg = { music: { libraryDirs: [iroot], ingestDir: idir, format: 'opus', cacheDir: join(iroot, 'cache'), queueSize: 25 } }
    const ingested = await ingestFileNow(icfg, join(idir, 'drop.flac'), { enrich: false })
    assert.ok(ingested, 'ingest returned the track row')
    assert.equal(ingested.title, 'Dropbox Tone')
    // organize.ts (consolidation 2026-08-05): Library/ zone + canonical name.
    assert.ok(ingested.path.startsWith(join(iroot, 'Library', 'Smoke Metal Band', 'Forge') + '/'), `filed into Library/Artist/Album (got ${ingested.path})`)
    assert.equal(basename(ingested.path), 'Dropbox Tone.flac', `canonical file name (got ${basename(ingested.path)})`)
    assert.ok(existsSync(ingested.path), 'file physically moved')
    assert.ok(!existsSync(join(idir, 'drop.flac')), 'source left the drop-box')
    const reRead = await query('SELECT path FROM tracks WHERE id = $1', [ingested.id])
    assert.equal(reRead.rows[0].path, ingested.path, 'DB path updated in place (same id)')
    await insertMeta(ingested.id, { genres: ['metal'] })
    await refreshRulePlaylists('smoke ingest')
    assert.ok((await playlistsContaining(ingested.id)).includes('Smoke Rule Metal'), 'ingested track lands in the matching rule playlist')
  } finally {
    await deletePlaylist(rpId).catch(() => {})
    await query('DELETE FROM tracks WHERE path LIKE $1', [`${iroot}%`]).catch(() => {})
    rmSync(iroot, { recursive: true, force: true })
  }
  console.error('  13. adaptive rule playlists (materialize/guards/refresh) + ingest drop-box (index→file→playlist) ✓')
}

await cleanupSmokeRows()
await getPool().end().catch(() => {})
console.error('phase-music: ALL PASS')
