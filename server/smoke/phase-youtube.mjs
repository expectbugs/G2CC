// YouTube-grab smoke (2026-08-06, MUSIC_SPEC.md D7 / Phase D) — hermetic:
// yt-dlp is a SHIM (G2CC_YTDLP env hook), nothing touches the network, the
// "download" writes a real ffmpeg tone so the index/scan path is exercised
// end-to-end, and enrichment is skipped via the ytGrab smoke hook (tests must
// never spawn claude/ASR). The REAL yt-dlp flags were verified against
// --help + a live search at build (2026-08-06); the live grab is Adam's
// on-glass Phase D gate.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, getPool } from '../dist/store.js'

// ---- the yt-dlp shim ----
const work = mkdtempSync(join(tmpdir(), 'g2cc-smoke-yt-'))
const shim = join(work, 'yt-dlp')
writeFileSync(shim, `#!/bin/bash
# yt-dlp SHIM for phase-youtube.mjs. Search mode: --dump-json present → two
# canned JSONL hits. Grab mode: --print present → write a real tone where the
# -o template points and print its final path (after_move:filepath contract).
if [[ "$G2CC_SHIM_FAIL" == "1" ]]; then echo "shim: forced failure" >&2; exit 1; fi
args=("$@")
if [[ " $* " == *" --dump-json "* ]]; then
  echo '{"id":"abc123","title":"Shim Song","channel":"Shim Channel","duration":147.0,"url":"https://www.youtube.com/watch?v=abc123"}'
  echo '{"id":"def456","title":"Other Cut","uploader":"Fallback Uploader","duration":301.5,"url":"https://www.youtube.com/watch?v=def456"}'
  exit 0
fi
out=""
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[$i]}" == "-o" ]]; then out="\${args[$((i+1))]}"; fi
done
if [[ -z "$out" ]]; then echo "shim: no -o template" >&2; exit 2; fi
dir=$(dirname "$out")
mkdir -p "$dir"
final="$dir/Shim Song [abc123].opus"
# Mirror --embed-metadata: the real grab embeds title/artist tags, so the
# indexer reads REAL metadata instead of falling back to the filename.
ffmpeg -v error -f lavfi -i "sine=frequency=330:duration=2" -metadata title="Shim Song" -metadata artist="Shim Channel" -c:a libopus "$final" >&2
echo "$final"
`, { mode: 0o755 })
chmodSync(shim, 0o755)
process.env.G2CC_YTDLP = shim

const { ytSearch, ytGrab, ytHitRow } = await import('../dist/youtube.js')

// ---- Part 1: search parsing + the pick-row format ----
{
  const hits = await ytSearch('shim query', 5)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].id, 'abc123')
  assert.equal(hits[0].channel, 'Shim Channel')
  assert.equal(hits[1].channel, 'Fallback Uploader', 'uploader fallback when channel absent')
  assert.equal(ytHitRow(hits[0]), 'Shim Song · Shim Channel · 2:27', 'title · channel · m:ss row (D7)')
  assert.equal(ytHitRow(hits[1]), 'Other Cut · Fallback Uploader · 5:01')
  assert.deepEqual(await ytSearch('   ', 5), [], 'blank query → empty, no subprocess')
  console.error('  1. ytSearch parsing + pick rows ✓')
}

// ---- Part 2: grab → file in <root>/YouTube/ → indexed (enrichment skipped) ----
{
  const root = mkdtempSync(join(tmpdir(), 'g2cc-smoke-ytlib-'))
  const cfg = {
    music: { libraryDirs: [root], youtubeDir: 'YouTube', format: 'opus', cacheDir: join(root, 'cache') },
    stt: { pythonPath: '/home/user/G2CC/audio/venv/bin/python' },
  }
  const hit = { id: 'abc123', title: 'Shim Song', channel: 'Shim Channel', durationS: 147, url: 'https://www.youtube.com/watch?v=abc123' }
  const r = await ytGrab(cfg, hit, /* enrich = */ false)
  assert.ok(r.path.startsWith(join(root, 'YouTube') + '/'), `lands in the YouTube/ subdir (got ${r.path})`)
  assert.ok(existsSync(r.path), 'the audio file exists')
  assert.equal(r.track.title, 'Shim Song', 'indexed with probed metadata')
  const row = await query('SELECT id FROM tracks WHERE path = $1', [r.path])
  assert.equal(row.rows.length, 1, 'track row present after the incremental scan')
  // Failure path: the subprocess failing must REJECT loudly, never fabricate.
  process.env.G2CC_SHIM_FAIL = '1'
  let failed = null
  try { await ytGrab(cfg, hit, false) } catch (e) { failed = e }
  delete process.env.G2CC_SHIM_FAIL
  assert.ok(failed instanceof Error && /failed/.test(failed.message), 'grab failure rejects loudly')
  await query('DELETE FROM tracks WHERE path LIKE $1', [`${root}%`])
  rmSync(root, { recursive: true, force: true })
  console.error('  2. ytGrab → YouTube/ file → index → loud failure path ✓')
}

rmSync(work, { recursive: true, force: true })
await getPool().end().catch(() => {})
console.error('phase-youtube: ALL PASS')
