// Phase 7 smoke — lyrics parsing (pure: parseLrc/currentLrcIndex) + the Media
// window routing through a real WindowManager: subscribe-on-entry, media_state
// → player view, a transport tap → media_cmd, unsubscribe-on-leave. No network
// (getLyrics is NOT called here — that hits LRCLIB live). Self-cleaning.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { parseLrc, currentLrcIndex } from '../dist/lyrics.js'
import { WindowManager } from '../dist/os-windows.js'
import { getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 1. LRC parsing (math sanity) ----------
{
  const lrc = parseLrc('[00:01.00]Hello\n[00:03.50]World\n[xx:meta]\n[00:05.00][00:06.00]End')
  // 4 lines: Hello, World, then End at BOTH 5s and 6s (multi-stamp line)
  assert.equal(lrc.length, 4)
  assert.deepEqual(lrc[0], { tMs: 1000, text: 'Hello' })
  assert.deepEqual(lrc[1], { tMs: 3500, text: 'World' })
  assert.equal(lrc[2].tMs, 5000); assert.equal(lrc[2].text, 'End')
  assert.equal(lrc[3].tMs, 6000)
  assert.equal(currentLrcIndex(lrc, 0), -1, 'before first stamp')
  assert.equal(currentLrcIndex(lrc, 2000), 0)
  assert.equal(currentLrcIndex(lrc, 4000), 1)
  assert.equal(currentLrcIndex(lrc, 9000), 3, 'past the end → last line')
  console.error('  1. parseLrc + currentLrcIndex ✓')
}

// ---------- 2. Media window through the WM ----------
{
  const scenes = []
  const mediaCmds = []
  const titleOf = (s) => s?.regions?.find((r) => r.name === 'title')?.content?.text ?? ''
  const textOf = (s) => s?.regions?.find((r) => r.name === 'content')?.content?.text ?? ''
  const wm = new WindowManager({
    send: (scene) => scenes.push(scene),
    audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 1 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
    mediaCommand: (c) => mediaCmds.push(c),
  })
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 200; i++) { if (pred()) return; await sleep(25) }
    throw new Error(`waitFor timed out: ${what}`)
  }

  wm.switchTo('media')
  await waitFor(() => titleOf(scenes[scenes.length - 1]).includes('Media'), 'media view')
  assert.ok(mediaCmds.includes('subscribe'), 'subscribed to media on entry')

  // a now-playing snapshot → the player view
  wm.onMediaState({ playing: true, title: 'Test Song', artist: 'The Testers', album: 'Smoke', durationMs: 240000, positionMs: 60000 })
  await waitFor(() => textOf(scenes[scenes.length - 1]).includes('Test Song'), 'track shows')
  assert.ok(textOf(scenes[scenes.length - 1]).includes('The Testers'), 'artist shows')
  assert.ok(/▕[█░]+▏/.test(textOf(scenes[scenes.length - 1])), 'position bar present')

  // tap Play/Pause (menu index 0) → media_cmd play_pause
  await wm.onSelect('menu', 0)
  assert.ok(mediaCmds.includes('play_pause'), 'Play/Pause → media_cmd')

  // leave → unsubscribe
  wm.switchTo('main')
  assert.ok(mediaCmds.includes('unsubscribe'), 'unsubscribed on leave')
  wm.dispose()
  console.error('  2. media subscribe → state → transport → unsubscribe ✓')
}

console.log('phase7-media: ALL OK')
await getPool().end()
