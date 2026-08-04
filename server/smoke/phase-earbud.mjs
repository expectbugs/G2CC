// Earbud-lane smoke (2026-08-04, docs/EARBUD_SPEC.md) — hermetic, no phone,
// no glasses, no claude subprocess:
//   Part 1: config — new sections exist in defaults, validators log+fallback
//   Part 2: estimateSttConfidence heuristic shape
//   Part 3: EarbudAudioService against a FAKE phone — caps gating, speech
//           framing (0x11 header), duck/pause etiquette, half-duplex capture
//           gate, honest ack outcomes, media queue advance
//   Part 4: TTS daemon — REAL Kokoro synthesis through the sentinel protocol
//   Part 5: music index/search/transcode on a TEMP library (generated tone)
//   Part 6: companion-mcp handshake + tools/list over real stdio
//   Part 7: speak-digest gate + deterministic fallback shape
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SPEECH_FRAME_TAG, MAX_CONCURRENT_SESSIONS } from '../../shared/dist/index.js'
import { EarbudAudioService } from '../dist/earbud.js'
import { estimateSttConfidence, parseVoiceCommand } from '../dist/voice.js'
import { needsDigest, fallbackDigest } from '../dist/speak-digest.js'
import { scanLibrary, searchTracks, mediaFileFor, toEarbudTrack } from '../dist/music.js'
import { getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- Part 1: config sections ----
{
  const { loadConfig } = await import('../dist/config.js')
  const cfg = loadConfig()
  assert.equal(cfg.stt.micSource === 'earbud' || cfg.stt.micSource === 'dji', true, 'micSource validated')
  assert.equal(cfg.tts.engine, 'kokoro')
  assert.equal(typeof cfg.tts.voice, 'string')
  assert.equal(['auto', 'always', 'never'].includes(cfg.audioOut.speakMode), true)
  assert.equal(Array.isArray(cfg.music.libraryDirs), true)
  assert.equal(typeof cfg.companion.confirmThreshold, 'number')
  assert.equal(MAX_CONCURRENT_SESSIONS, 6, 'companion headroom (5→6)')
  console.error('  1. config sections + defaults ✓')
}

// ---- Part 2: confidence heuristic ----
{
  // Normal dictation (~2.5 wps) clears the 0.95 gate; degenerate shapes don't.
  assert.ok(estimateSttConfidence('set a timer for ten minutes please', 2800) >= 0.95, 'normal speech trusted')
  assert.ok(estimateSttConfidence('ok', 6000) < 0.95, 'one word from 6s of speech is suspicious')
  assert.ok(estimateSttConfidence('mmmm hm mmm', 500) < 0.95, 'implausible wps down-scored')
  assert.equal(estimateSttConfidence('', 1000), 0, 'empty = zero')
  console.error('  2. estimateSttConfidence shape ✓')
}

// ---- Part 3: EarbudAudioService vs a fake phone ----
{
  const sentJson = []
  const sentBinary = []
  const cfg = {
    authToken: 'smoke-token',
    stt: { micSource: 'earbud' },
    tts: { engine: 'kokoro', voice: 'af_heart', speed: 1.0, modelDir: '/nonexistent-smoke' },
    audioOut: { speakMode: 'auto', duckDb: -12, chimes: true, allowSpeaker: false, notify: { call: 'speak', timer: 'speak', sms: 'chime+name', email: 'silent', info: 'silent' } },
    music: { libraryDirs: [], format: 'opus', cacheDir: '/tmp/g2cc-smoke-cache' },
    companion: { dir: '/home/user/g2cc-companion', model: 'opus', effort: 'max', confirmThreshold: 0.95 },
  }
  const svc = new EarbudAudioService(cfg, {
    toPhone: (msg) => { sentJson.push(msg); return true },
    toPhoneBinary: (buf) => { sentBinary.push(buf); return true },
    activeWindowId: () => 'main',
    isScreenIdle: () => false,
    hasDisplay: () => true,
  })

  // No caps announced → speak refuses honestly, sends nothing.
  const refused = await svc.speak('hello', { source: 'smoke' })
  assert.equal(refused.status, 'failed')
  assert.match(refused.reason, /no audio-out/)
  assert.equal(sentJson.length, 0)

  // Caps up → media queue etiquette + capture gate (no TTS daemon needed).
  svc.notePhoneCaps(['audio-out', 'media-lane'])
  assert.equal(svc.playQueue([{ id: 1, title: 'T1' }, { id: 2, title: 'T2' }], 0, 'smoke'), true)
  const open1 = sentJson.find((m) => m.type === 'media_open')
  assert.ok(open1, 'media_open sent')
  assert.match(open1.url, /^\/media\/track\/1\?token=smoke-token/, 'server-relative token url')
  svc.onMediaEvent({ type: 'media_event', id: open1.id, state: 'playing', posMs: 0 })
  assert.equal(svc.status().music, 'playing')

  // Dictate capture: music pauses; capture end resumes.
  svc.onCaptureState(true)
  assert.ok(sentJson.some((m) => m.type === 'media_ctl' && m.cmd === 'pause'), 'capture pauses music')
  svc.onCaptureState(false)
  assert.ok(sentJson.some((m) => m.type === 'media_ctl' && m.cmd === 'play'), 'capture end resumes music')

  // Track end advances the queue.
  const before = sentJson.filter((m) => m.type === 'media_open').length
  svc.onMediaEvent({ type: 'media_event', id: open1.id, state: 'playing', posMs: 1000 })
  const open1id = sentJson.filter((m) => m.type === 'media_open').at(-1).id
  svc.onMediaEvent({ type: 'media_event', id: open1id, state: 'ended' })
  const opens = sentJson.filter((m) => m.type === 'media_open')
  assert.equal(opens.length, before + 1, 'queue advanced to track 2')
  assert.match(opens.at(-1).url, /track\/2\?/)

  // Speech framing: a synth failure path (bad modelDir) must resolve failed,
  // send speak_start then speak_cancel — never a fabricated success.
  const bad = await svc.speak('this will fail to synth', { source: 'smoke', priority: 'now' })
  assert.equal(bad.status, 'failed')
  assert.ok(sentJson.some((m) => m.type === 'speak_start'), 'speak_start sent before synth')
  assert.ok(sentJson.some((m) => m.type === 'speak_cancel'), 'empty utterance cancelled honestly')
  assert.equal(sentBinary.length, 0, 'no frames from a failed synth')
  assert.equal(SPEECH_FRAME_TAG, 0x11)

  // Phone detach: state honest, in-flight acks resolve unverified.
  svc.notePhoneCaps(null)
  assert.equal(svc.status().music, 'idle')
  console.error('  3. EarbudAudioService caps/etiquette/half-duplex/honest-failure ✓')
}

// ---- Part 4: REAL Kokoro synthesis via the daemon protocol ----
{
  const p = spawn('./venv/bin/python', ['-u', '-m', 'pipeline.tts_daemon'], {
    cwd: '/home/user/G2CC/audio',
    env: { ...process.env, G2CC_TTS_VOICE: 'af_heart' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  p.stdout.on('data', (c) => { out += c })
  p.stdin.write(JSON.stringify({ text: 'Smoke test speech.' }) + '\n')
  const t0 = Date.now()
  while (!out.includes('"done":true') && Date.now() - t0 < 60_000) await sleep(100)
  p.kill()
  assert.ok(out.includes('___G2CC_RESULT_BEGIN___'), 'sentinel frames present')
  const pcmBlock = out.split('___G2CC_RESULT_BEGIN___')[1]
  assert.ok(pcmBlock.includes('"pcm_b64"'), 'pcm chunk emitted')
  const done = JSON.parse(out.split('___G2CC_RESULT_BEGIN___').at(-1).split('___G2CC_RESULT_END___')[0].trim())
  assert.ok(done.done && done.sentences >= 1 && done.totalMs > 300, `real audio synthesized (${done.totalMs}ms)`)
  console.error(`  4. Kokoro daemon real synth ✓ (${done.sentences} unit, ${Math.round(done.totalMs)}ms audio)`)
}

// ---- Part 5: music index/search/transcode on a temp library ----
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
  assert.ok(hits.length >= 1, 'search finds the tone')
  const tone = hits.find((t) => t.title === 'Smoke Tone')
  assert.ok(tone, 'metadata parsed')
  const media = await mediaFileFor(cfg, tone, 'opus')
  assert.ok(existsSync(media.path), 'transcode cached')
  assert.equal(media.mime, 'audio/ogg')
  const et = toEarbudTrack(tone)
  assert.equal(et.title, 'Smoke Tone')
  // Cleanup: temp dir + the temp rows (path-scoped, smoke DB anyway).
  const { query } = await import('../dist/store.js')
  await query('DELETE FROM tracks WHERE path LIKE $1', [`${dir}%`])
  rmSync(dir, { recursive: true, force: true })
  console.error('  5. music index → search → mono-opus transcode ✓')
}

// ---- Part 6: companion-mcp stdio handshake ----
{
  const p = spawn(process.execPath, ['/home/user/G2CC/server/dist/companion-mcp.js'], {
    env: { ...process.env, G2CC_INTERNAL_URL: 'http://127.0.0.1:1', G2CC_TOKEN: 'x' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  const replies = []
  p.stdout.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (line.trim()) replies.push(JSON.parse(line))
    }
  })
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }) + '\n')
  await sleep(600)
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
  await sleep(600)
  p.kill()
  const init = replies.find((r) => r.id === 1)
  const list = replies.find((r) => r.id === 2)
  assert.equal(init?.result?.serverInfo?.name, 'g2cc-earbud')
  const names = (list?.result?.tools ?? []).map((t) => t.name)
  for (const n of ['speak', 'play_music', 'set_timer', 'status', 'unseen_notifications']) {
    assert.ok(names.includes(n), `tool ${n} present`)
  }
  console.error(`  6. companion-mcp handshake ✓ (${names.length} tools)`)
}

// ---- Part 7: spoken-digest gate ----
{
  assert.equal(needsDigest('Short reply.'), false)
  assert.equal(needsDigest('x'.repeat(400)), true)
  assert.equal(needsDigest('ok\n```js\ncode\n```'), true, 'code fence always digests')
  const fb = fallbackDigest('First sentence. Second one. Third.\n```\nhuge code\n```')
  assert.match(fb, /Full answer on your glasses\.$/)
  assert.ok(!fb.includes('huge code'), 'code never spoken in fallback')
  // Companion catch-all + verbs stay in sync with the window aliases.
  assert.equal(parseVoiceCommand('butterscotch companion', { wake: true }).cmd.kind, 'window')
  console.error('  7. speak-digest gate + fallback ✓')
}

await getPool().end().catch(() => {})
console.error('phase-earbud: ALL PASS')
