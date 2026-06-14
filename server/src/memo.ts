// Audio memos (upgrades.md v2 Phase 14) — `memo: <text>` at the Ask confirm
// step saves BOTH the raw captured audio (the buffered PCM already in hand →
// a wav under ~/g2cc-memos/) AND the Parakeet transcript (a Postgres row + a
// line in the notes inbox pointing at the wav). Retention is UNLIMITED (the
// standing rule — no purge, unlike Files trash).
//
// The PCM is the RAW captured audio (pre-noise-pipeline for DJI), plumbed from
// ws-handler via WmContext.lastDictationAudio(). A missing buffer never drops
// the memo: the transcript still saves, loudly flagged.

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { query, registerMigration } from './store.js'
import { pcmToWav } from './pcm-wav.js'
import { appendNote } from './intents.js'

registerMigration('memos-v1', `
  CREATE TABLE IF NOT EXISTS memos (
    id bigserial PRIMARY KEY,
    transcript text NOT NULL,
    wav_path text,
    duration_ms integer,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS memos_created ON memos (created_at DESC, id DESC);
`)

// G2CC_MEMOS_DIR override is for the SMOKE SUITE ONLY (so test wavs never land
// in Adam's real ~/g2cc-memos). Production never sets it.
const MEMOS_DIR = process.env.G2CC_MEMOS_DIR ?? join(homedir(), 'g2cc-memos')

/** The raw dictation audio + its format (the ws-handler stash). */
export interface MemoAudio {
  pcm: Buffer
  sampleRate: number
  channels: number
  encoding: 'int16' | 'float32'
}

export interface MemoResult {
  id: number
  wavPath: string | null
  durationMs: number | null
  /** Loud: the audio couldn't be written (disk error / frame-misaligned PCM) —
   *  the transcript was STILL saved. null = no error. */
  wavError: string | null
  /** Loud: the notes-inbox pointer line couldn't be appended — the memo ROW
   *  (the authoritative save) still committed. null = no error. */
  noteError: string | null
}

function stampName(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `memo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

/** Save a memo: write the wav (if audio is in hand), insert the DB row, append
 *  the notes-inbox pointer line. Loud-throws on any failure (the caller renders
 *  the error card). The transcript ALWAYS saves — a missing/empty audio buffer
 *  is logged, not a silent drop. */
export async function saveMemo(transcript: string, audio: MemoAudio | null): Promise<MemoResult> {
  let wavPath: string | null = null
  let durationMs: number | null = null
  let wavError: string | null = null

  if (audio && audio.pcm.length > 0) {
    // Best-effort: the transcript must NEVER be lost to a wav failure (a
    // frame-misaligned buffer / disk error). Build+write the wav inside a
    // try so the INSERT below always runs; surface the failure loudly.
    try {
      const bytesPerSample = audio.encoding === 'float32' ? 4 : 2
      const audioFormat = audio.encoding === 'float32' ? 3 : 1   // pcmToWav: 3 = IEEE float, 1 = int PCM
      const blockAlign = bytesPerSample * audio.channels
      if (blockAlign > 0 && audio.pcm.length % blockAlign === 0) {
        durationMs = Math.round((audio.pcm.length / blockAlign / audio.sampleRate) * 1000)
      }
      const wav = pcmToWav(audio.pcm, audio.sampleRate, bytesPerSample * 8, audio.channels, audioFormat)
      await mkdir(MEMOS_DIR, { recursive: true })
      wavPath = join(MEMOS_DIR, `${stampName(new Date())}.wav`)
      await writeFile(wavPath, wav)
      console.log(`[memo] wav saved ${wavPath} (${audio.pcm.length} B PCM, ${audio.encoding}/${audio.channels}ch/${audio.sampleRate}Hz, ${durationMs ?? '?'} ms)`)
    } catch (e) {
      wavError = (e as Error).message
      wavPath = null
      durationMs = null
      console.error(`[memo] AUDIO SAVE FAILED (transcript will still save): ${wavError}`)
    }
  } else {
    console.warn('[memo] no audio buffer in hand — saving transcript only (LOUD, not a silent drop)')
  }

  const ins = await query<{ id: number }>(
    'INSERT INTO memos (transcript, wav_path, duration_ms) VALUES ($1, $2, $3) RETURNING id',
    [transcript, wavPath, durationMs])
  const id = Number(ins.rows[0].id)

  // notes-inbox pointer line — BEST-EFFORT, AFTER the authoritative row commits:
  // a notes-write failure (ENOSPC/EACCES) must NOT roll back the saved memo or
  // report total failure (which would make Adam re-dictate → duplicate row).
  let noteError: string | null = null
  try {
    await appendNote(`🎙 memo: ${transcript}${wavPath ? ` (audio: ${wavPath})` : wavError ? ' (audio FAILED — see log)' : ' (no audio)'}`)
  } catch (e) {
    noteError = (e as Error).message
    console.error(`[memo] notes-inbox append FAILED (memo #${id} still saved): ${noteError}`)
  }
  console.log(`[memo] saved #${id}: "${transcript.slice(0, 60)}"`)
  return { id, wavPath, durationMs, wavError, noteError }
}
