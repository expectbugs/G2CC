#!/usr/bin/env node
// organize-library.mjs — the ONE-TIME library consolidation mover
// (Adam 2026-08-05: "rename move and organize ALL music from all locations
// into /home/user/Music"). Run with the SERVER STOPPED (preflight enforces
// it) — no scans, no playback, no watcher can race the move.
//
//   node server/tools/organize-library.mjs [--plan-only]
//
// Plan: every indexed track gets a destination in the single target root:
//   Archive/Dupes/…       non-representative dupe-cluster members (fidelity
//                         then non-archive then path — dedupeClusters' exact
//                         rule, mirrored here)
//   Collections/<Set>/…   prefix-mapped game-shaped sets (approved by Adam:
//                         Wurm Online incl. tomcd, GTA Radio, Castlevania
//                         SotN, Doom/DSoP, the two FF collections, misc game
//                         audio) + VA-detected albums (≥6 tracks, ≥5 distinct
//                         normalized artists — OCRemix tribute albums)
//   Library/<Artist>/…    everything with tags, canonical "NN - Title.ext"
//   Unsorted/<src>/…      artistless residue, grouped by source dir
//
// Execution: same-FS = the organize.ts hazard-ordered pair; cross-FS =
// copy + mtime-preserve + sha1 verify + DB path update; SOURCES ARE KEPT
// (30-day cold hold — Adam's D5 call). Every action appends to a manifest
// (~/.g2cc/organize-manifest-<ts>.jsonl) for undo. pg_dump runs first.

import { execFileSync, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join, extname, basename, dirname } from 'node:path'
import { loadConfig } from '../dist/config.js'
import { getPool, query } from '../dist/store.js'
import { sanitizeName, canonicalFileName, cachePathFor } from '../dist/organize.js'
import { applyIdentity } from '../dist/identity.js'
import { parseTagNumber } from '../dist/music.js'

const PLAN_ONLY = process.argv.includes('--plan-only')
const TARGET_ROOT = '/home/user/Music'
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const MANIFEST = join(homedir(), '.g2cc', `organize-manifest-${ts}.jsonl`)
const BACKUP_DIR = join(homedir(), '.g2cc', 'backups')

// ---- collection prefix map (grounded in the real dirs, 2026-08-05) ----
// mode 'always': every track under the prefix belongs to the set.
// mode 'artistless': only artistless tracks are collected; tagged ones go
//                    to Library (the misc grab-bag holds real releases too).
// rel: true preserves the path structure below the prefix.
// identity: artist/album written via applyIdentity(method 'collection') for
//           ARTISTLESS tracks only — classification, recorded + reversible.
const COLLECTIONS = [
  { prefix: '/mnt/slug/pandora2/Media/Music/wurm', set: 'Wurm Online', mode: 'always', rel: false,
    identity: { artist: 'Wurm Online', album: 'Wurm Online Game Audio' } },
  { prefix: '/mnt/slug/Music/tomcd', set: 'Wurm Online', mode: 'always', rel: false,
    identity: { artist: 'Wurm Online', album: 'Wurm Online Game Audio' } },
  { prefix: '/mnt/slug/Music/sotn-music/general/gtaradio', set: 'GTA Radio', mode: 'always', rel: false,
    identity: { artist: 'GTA Radio', album: 'GTA Radio Rips' } },
  { prefix: '/mnt/slug/pandora2/Media/Music/GTA-Radio', set: 'GTA Radio', mode: 'always', rel: false,
    identity: { artist: 'GTA Radio', album: 'GTA Radio Rips' } },
  { prefix: '/mnt/slug/Music/sotn-music', set: 'Castlevania SotN', mode: 'always', rel: true,
    identity: { artist: 'Castlevania SotN', album: 'Symphony of the Night Rip' } },
  // DSoP: real remixers exist — album only; artists wait for fingerprints.
  { prefix: '/mnt/slug/Music/The Dark Side of Phobos', set: 'Doom/The Dark Side of Phobos', mode: 'always', rel: true,
    identity: { album: 'The Dark Side of Phobos' } },
  { prefix: '/mnt/slug/pandora2/Media/Music/DOOM/The Dark Side of Phobos', set: 'Doom/The Dark Side of Phobos', mode: 'always', rel: true,
    identity: { album: 'The Dark Side of Phobos' } },
  { prefix: '/mnt/slug/pandora2/Media/Music/DOOM', set: 'Doom', mode: 'always', rel: true, identity: {} },
  { prefix: '/mnt/slug/pandora2/Media/Music/FF7', set: 'Final Fantasy/FF7', mode: 'always', rel: true, identity: {} },
  { prefix: '/mnt/slug/pandora2/Media/Music/FFMixed', set: 'Final Fantasy/Mixed', mode: 'always', rel: true, identity: {} },
  { prefix: '/home/user/Downloads/[AGM22] Final Fantasy collection v3 - Jan 2020/_Games OST', set: '', mode: 'always', rel: true, identity: {} },
  { prefix: '/home/user/Music/Final Fantasy Music Collection (FLAC)', set: 'Final Fantasy', mode: 'always', rel: true, identity: {} },
  { prefix: '/mnt/slug/pandora2/Media/Music/misc', set: 'Game Audio/misc', mode: 'artistless', rel: true,
    identity: { artist: 'Game Audio', album: 'Misc Game Rips' } },
]

const log = (m) => console.log(m)
const manifest = (o) => appendFileSync(MANIFEST, JSON.stringify(o) + '\n')

function fidelityRank(path) {
  switch (extname(path).slice(1).toLowerCase()) {
    case 'flac': return 5
    case 'wav': case 'aiff': return 4
    case 'm4a': case 'aac': return 3
    case 'ogg': case 'opus': return 2
    case 'mp3': return 1
    default: return 0
  }
}

function sha1File(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha1')
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej)
  })
}

let probeFailures = 0
async function ffprobeNumbers(path) {
  return new Promise((res) => {
    execFile('ffprobe', ['-v', 'error',
      '-show_entries', 'format_tags=track,disc,tracknumber,discnumber:stream_tags=track,disc,tracknumber,discnumber',
      '-of', 'json', path], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // Loud on failure (review A'#4 — house rule: no silent failures): a
      // probe error files the track WITHOUT its "NN - " prefix this run.
      if (err) {
        probeFailures++
        console.error(`[organize] ffprobe FAILED for ${path} (filed without a track number this run): ${err.message}`)
        res({ trackNo: null, discNo: null })
        return
      }
      try {
        const p = JSON.parse(stdout)
        const tags = {}
        for (const st of p.streams ?? []) for (const [k, v] of Object.entries(st.tags ?? {})) tags[k.toLowerCase()] = v
        for (const [k, v] of Object.entries(p.format?.tags ?? {})) tags[k.toLowerCase()] = v
        res({
          trackNo: parseTagNumber(tags['track']) ?? parseTagNumber(tags['tracknumber']),
          discNo: parseTagNumber(tags['disc']) ?? parseTagNumber(tags['discnumber']),
        })
      } catch (e) {
        probeFailures++
        console.error(`[organize] ffprobe output unparseable for ${path}: ${e instanceof Error ? e.message : String(e)}`)
        res({ trackNo: null, discNo: null })
      }
    })
  })
}

const normArtist = (a) => (a ?? '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim()

async function main() {
  // ---- preflight ----
  // Smoke-context refusal (review A'#10): with G2CC_PG_DATABASE leaked the
  // plan would read the SMOKE DB while pg_dump backs up prod — a mismatch no
  // file-moving tool should tolerate. Production never sets the var.
  if (process.env.G2CC_PG_DATABASE) {
    console.error(`PREFLIGHT FAIL: G2CC_PG_DATABASE=${process.env.G2CC_PG_DATABASE} (smoke/test context) — the mover only runs against production.`)
    process.exit(1)
  }
  // :7300 matches the live config; loadConfig() needs the DB layer that this
  // check gates, so the port stays literal here.
  const port = execFileSync('bash', ['-c', "ss -ltn 'sport = :7300' | tail -n +2 | wc -l"]).toString().trim()
  if (port !== '0') {
    if (PLAN_ONLY) {
      log('[organize] note: server is running — fine for --plan-only (reads + a plan file, no moves).')
    } else {
      console.error('PREFLIGHT FAIL: the G2CC server is RUNNING on :7300 — stop it first (no scans/playback may race the move).')
      process.exit(1)
    }
  }
  const free = parseInt(execFileSync('bash', ['-c', "df --output=avail -B1G / | tail -1"]).toString().trim(), 10)
  if (!PLAN_ONLY && free < 40) {
    console.error(`PREFLIGHT FAIL: only ${free}G free on / — need ≥40G headroom for the ~32G cross-FS copy.`)
    process.exit(1)
  }
  if (!PLAN_ONLY) {
    mkdirSync(BACKUP_DIR, { recursive: true })
    const dump = join(BACKUP_DIR, `g2cc-pre-organize-${ts}.sql`)
    log(`[organize] pg_dump → ${dump}`)
    execFileSync('pg_dump', ['-d', 'g2cc', '-f', dump])
  }

  const config = loadConfig()
  const rows = (await query(
    `SELECT t.*, m.dupe_cluster FROM tracks t LEFT JOIN track_meta m ON m.track_id = t.id ORDER BY t.id`)).rows
  log(`[organize] ${rows.length} tracks loaded`)

  // ---- track/disc backfill (probe only rows that lack numbers) ----
  const needNums = rows.filter((r) => r.track_no == null)
  log(`[organize] probing track/disc numbers for ${needNums.length} row(s)…`)
  let probed = 0
  const CONC = 8
  for (let i = 0; i < needNums.length; i += CONC) {
    await Promise.all(needNums.slice(i, i + CONC).map(async (r) => {
      if (!existsSync(r.path)) return
      const n = await ffprobeNumbers(r.path)
      r.track_no = n.trackNo
      r.disc_no = n.discNo
      if ((n.trackNo ?? n.discNo) != null && !PLAN_ONLY) {
        await query('UPDATE tracks SET track_no=$2, disc_no=$3 WHERE id=$1', [r.id, n.trackNo, n.discNo])
      }
      probed++
      if (probed % 400 === 0) log(`[organize]   …${probed}/${needNums.length}`)
    }))
  }

  // ---- dupe representatives (dedupeClusters' exact rule, incl. the
  // non-Archive tie preference — review A'#1: without it, Archive/ is the
  // alphabetical minimum, so every equal-fidelity tie on a RE-RUN would flip
  // to the quarantined copy and oscillate representatives run-to-run) ----
  const archived = (p) => p.includes('/Archive/')
  const clusters = new Map()
  for (const r of rows) {
    if (r.dupe_cluster == null) continue
    const cur = clusters.get(r.dupe_cluster)
    if (!cur) { clusters.set(r.dupe_cluster, r); continue }
    const rr = fidelityRank(r.path), cr = fidelityRank(cur.path)
    const better = rr > cr
      || (rr === cr && !archived(r.path) && archived(cur.path))
      || (rr === cr && archived(r.path) === archived(cur.path) && r.path < cur.path)
    if (better) clusters.set(r.dupe_cluster, r)
  }
  const isLoser = (r) => r.dupe_cluster != null && clusters.get(r.dupe_cluster)?.id !== r.id

  // ---- VA-shaped albums (tribute/OCR albums scatter under per-remixer dirs) ----
  const byAlbum = new Map()
  for (const r of rows) {
    if (!r.album || !r.artist) continue
    const k = r.album.toLowerCase()
    if (!byAlbum.has(k)) byAlbum.set(k, { name: r.album, artists: new Set(), n: 0 })
    const a = byAlbum.get(k)
    a.artists.add(normArtist(r.artist))
    a.n++
  }
  const vaAlbums = new Set([...byAlbum.values()].filter((a) => a.n >= 6 && a.artists.size >= 5).map((a) => a.name.toLowerCase()))
  log(`[organize] VA-shaped albums: ${vaAlbums.size}`)
  for (const a of [...byAlbum.values()].filter((x) => vaAlbums.has(x.name.toLowerCase()))) log(`[organize]   VA: "${a.name}" (${a.n} tracks, ${a.artists.size} artists)`)

  // ---- plan ----
  const planned = new Map()   // dest -> row (collision detection within the plan)
  const idApplies = []        // {id, identity}
  const plan = []             // {row, dest, zone, mode}
  const zones = { library: 0, collections: 0, archive: 0, unsorted: 0, stay: 0 }

  const claim = (destDir, want, row) => {
    const ext = extname(want)
    const stem = basename(want, ext)
    let dest = join(destDir, want)
    let n = 0
    while (planned.has(dest) || (existsSync(dest) && dest !== row.path)) {
      n++
      dest = join(destDir, `${stem} (${row.id}${n > 1 ? `-${n}` : ''})${ext}`)
    }
    planned.set(dest, row)
    return dest
  }

  for (const r of rows) {
    if (!existsSync(r.path)) {
      log(`[organize] MISSING on disk (left to the next scan): ${r.path}`)
      continue
    }
    const collection = COLLECTIONS.find((c) => r.path.startsWith(c.prefix + '/') || dirname(r.path) === c.prefix)
    let destDir, zone
    if (isLoser(r)) {
      zone = 'archive'
      destDir = join(TARGET_ROOT, 'Archive', 'Dupes', sanitizeName(r.artist ?? 'Unknown'))
    } else if (collection && (collection.mode === 'always' || !r.artist)) {
      zone = 'collections'
      const below = collection.rel ? dirname(r.path.slice(collection.prefix.length + 1)) : ''
      const setPart = collection.set ? collection.set.split('/').map(sanitizeName).join('/') : ''
      const relPart = below && below !== '.' ? below.split('/').map(sanitizeName).join('/') : ''
      destDir = join(TARGET_ROOT, 'Collections', ...[setPart, relPart].filter(Boolean).join('/').split('/'))
      if (!r.artist && collection.identity && (collection.identity.artist || collection.identity.album)) {
        idApplies.push({ id: r.id, identity: collection.identity })
      }
    } else if (r.album && /^https?:\/\//i.test(r.album)) {
      // URL-as-album junk tags (OCRemix loose singles tagged with the site) —
      // a literal "http·--ocremix.org" dir helps no one.
      zone = 'collections'
      destDir = join(TARGET_ROOT, 'Collections', 'OCRemix')
    } else if (r.album && vaAlbums.has(r.album.toLowerCase())) {
      zone = 'collections'
      destDir = join(TARGET_ROOT, 'Collections', sanitizeName(r.album))
    } else if (r.artist) {
      zone = 'library'
      const artistDir = join(TARGET_ROOT, 'Library', sanitizeName(r.artist))
      const disc = r.disc_no != null && r.disc_no >= 2 ? ` (Disc ${r.disc_no})` : ''
      destDir = r.album ? join(artistDir, `${sanitizeName(r.album)}${disc}`) : artistDir
    } else {
      zone = 'unsorted'
      destDir = join(TARGET_ROOT, 'Unsorted', sanitizeName(basename(dirname(r.path))))
    }
    const dest = claim(destDir, canonicalFileName(r), r)
    if (dest === r.path) { zones.stay++; continue }
    zones[zone]++
    plan.push({ row: r, dest, zone })
  }

  log(`[organize] plan: ${plan.length} moves — library ${zones.library}, collections ${zones.collections}, archive ${zones.archive}, unsorted ${zones.unsorted}; already-canonical ${zones.stay}; identity applies ${idApplies.length}`)
  writeFileSync(join(homedir(), '.g2cc', `organize-plan-${ts}.jsonl`),
    plan.map((p) => JSON.stringify({ id: p.row.id, zone: p.zone, from: p.row.path, to: p.dest })).join('\n') + '\n')
  log(`[organize] plan written → ~/.g2cc/organize-plan-${ts}.jsonl`)
  if (PLAN_ONLY) { await getPool().end(); return }

  // ---- execute ----
  let done = 0, copied = 0, renamed = 0, failed = 0, bytes = 0
  for (const p of plan) {
    const { row, dest } = p
    try {
      await fsp.mkdir(dirname(dest), { recursive: true })
      const st = await fsp.stat(row.path)
      const sameFs = (await fsp.stat(dirname(dest))).dev === st.dev
      if (sameFs) {
        await query('UPDATE tracks SET path=$2 WHERE id=$1', [row.id, dest])
        try {
          await fsp.rename(row.path, dest)
        } catch (e) {
          // Guarded revert (review A'#6): a pg hiccup here must not mask the
          // rename error nor hide the DB/disk divergence.
          await query('UPDATE tracks SET path=$2 WHERE id=$1', [row.id, row.path])
            .catch((re) => console.error(`[organize] path revert ALSO failed (row ${row.id} points at ${dest} but the file is at ${row.path}): ${re instanceof Error ? re.message : String(re)}`))
          throw e
        }
        renamed++
        manifest({ op: 'rename', id: row.id, from: row.path, to: dest })
      } else {
        await fsp.copyFile(row.path, dest)
        await fsp.utimes(dest, st.atime, st.mtime)
        const [a, b] = await Promise.all([sha1File(row.path), sha1File(dest)])
        if (a !== b) {
          await fsp.unlink(dest)
          throw new Error(`sha1 mismatch after copy (${a} vs ${b}) — copy deleted, row untouched`)
        }
        const dstStat = await fsp.stat(dest)
        const newMtime = Math.round(dstStat.mtimeMs)
        await query('UPDATE tracks SET path=$2, mtime_ms=$3 WHERE id=$1', [row.id, dest, newMtime])
        // cache key uses (id, mtime, path-hash) — rename to the FINAL key.
        const oldCache = cachePathFor(config, row.id, row.mtime_ms, row.path)
        if (existsSync(oldCache)) {
          await fsp.rename(oldCache, cachePathFor(config, row.id, newMtime, dest)).catch((e) =>
            log(`[organize] cache rename failed for ${row.id} (will re-transcode): ${e.message}`))
        }
        copied++
        bytes += st.size
        manifest({ op: 'copy', id: row.id, from: row.path, to: dest, sha1: a, sourceKept: true })
      }
      // same-FS cache rename (mtime unchanged)
      if (sameFs) {
        const oldCache = cachePathFor(config, row.id, row.mtime_ms, row.path)
        if (existsSync(oldCache)) {
          await fsp.rename(oldCache, cachePathFor(config, row.id, row.mtime_ms, dest)).catch((e) =>
            log(`[organize] cache rename failed for ${row.id} (will re-transcode): ${e.message}`))
        }
      }
      done++
      if (done % 100 === 0) log(`[organize] ${done}/${plan.length} moved (${copied} copied ${(bytes / 1e9).toFixed(1)}G, ${renamed} renamed)`)
    } catch (e) {
      failed++
      console.error(`[organize] FAILED ${row.id} ${row.path} → ${dest}: ${e instanceof Error ? e.message : String(e)}`)
      manifest({ op: 'FAILED', id: row.id, from: row.path, to: dest, error: String(e) })
    }
  }

  // ---- collection identity applies (recorded + reversible) ----
  let applied = 0
  for (const a of idApplies) {
    try {
      await applyIdentity(config, a.id, a.identity, { method: 'collection' }, { reEmbed: false })
      applied++
      manifest({ op: 'identity', id: a.id, identity: a.identity })
    } catch (e) {
      console.error(`[organize] identity apply FAILED for ${a.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ---- leftovers report: indexed rows still outside the target root ----
  const outside = (await query(`SELECT count(*) AS n FROM tracks WHERE path NOT LIKE $1`, [`${TARGET_ROOT}/%`])).rows[0].n
  log(`[organize] DONE: ${done} moved (${renamed} renamed, ${copied} copied ${(bytes / 1e9).toFixed(1)}G), ${failed} FAILED, ${applied} collection identities applied${probeFailures ? `, ${probeFailures} PROBE FAILURES (filed without track numbers)` : ''}`)
  log(`[organize] rows still outside ${TARGET_ROOT}: ${outside} (should be 0)`)
  log(`[organize] manifest → ${MANIFEST}`)
  log(`[organize] sources on /mnt/slug + Downloads were KEPT (30-day cold hold) — reap later, deliberately.`)
  await getPool().end()
}

main().catch((e) => { console.error(`[organize] FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1) })
