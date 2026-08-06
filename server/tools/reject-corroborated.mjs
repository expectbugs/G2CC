#!/usr/bin/env node
// reject-corroborated.mjs (Adam 2026-08-06): bulk-reject pending fingerprint
// proposals for tracks whose OWN PATH already spells out their full title AND
// artist — the consolidation filed everything by its tags, so a path that
// corroborates the tags means the current identity is right and a proposal
// for a different song is a false positive ("the Shredder song proposed as
// some Amnesia song"). Artistless-kind proposals are never touched (nothing
// to corroborate — those are the real naming candidates). Rejections are the
// normal recorded, per-recording-id kind; nothing here ever changes identity.
//
//   node server/tools/reject-corroborated.mjs [--dry-run]

import { listIdentity, rejectProposal } from '../dist/identity.js'
import { getPool } from '../dist/store.js'

const DRY = process.argv.includes('--dry-run')

// Word-boundary-safe containment: fold everything non-alphanumeric to single
// spaces and pad — 'rage' must match the word, never the middle of 'garage'.
const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

const d = await listIdentity()
const mismatches = d.pending.filter((p) => p.kind === 'mismatch')
console.log(`[reject-corroborated] ${d.pending.length} pending (${mismatches.length} mismatch-kind, ${d.pending.length - mismatches.length} artistless-kind — untouched)`)

let rejected = 0
let rejectedDiffSong = 0
let kept = 0
for (const p of mismatches) {
  const path = norm(p.path)
  const title = norm(p.title)
  const artist = norm(p.artist)
  // Rule 1 (Adam verbatim): full title AND artist in the path → the current
  // identity is corroborated → any contradicting proposal is a false positive.
  if (title.trim() && artist.trim() && path.includes(title) && path.includes(artist)) {
    console.log(`[reject-corroborated] ${p.id}: KEEP "${p.title}" — ${p.artist} (path-corroborated) → reject proposal "${p.evidence.title}" — ${p.evidence.artist}`)
    if (!DRY) await rejectProposal(p.id)
    rejected++
    continue
  }
  // Rule 2 (Adam's Shredder→Amnesia class, Collections zone): the canonical
  // basename was BUILT from the title tag, so title-in-path corroborates the
  // title — a proposal for a COMPLETELY DIFFERENT song (no title overlap
  // either direction) is obviously incorrect. Same-song proposals (artist
  // formatting refinements) are NOT rejected — they stay for real review.
  const evTitle = norm(p.evidence.title)
  const sameSong = evTitle.trim() && title.trim() && (evTitle.includes(title) || title.includes(evTitle))
  if (title.trim() && path.includes(title) && !sameSong) {
    console.log(`[reject-corroborated] ${p.id}: KEEP "${p.title}" (title-corroborated) → reject DIFFERENT-SONG proposal "${p.evidence.title}" — ${p.evidence.artist}`)
    if (!DRY) await rejectProposal(p.id)
    rejectedDiffSong++
    continue
  }
  kept++
}
console.log(`[reject-corroborated] ${DRY ? 'DRY RUN — would reject' : 'rejected'} ${rejected} (rule 1: path corroborates title+artist) + ${rejectedDiffSong} (rule 2: title corroborated, proposal is a different song); ${kept} left for real review`)
await getPool().end()
