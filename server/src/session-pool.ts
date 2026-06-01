// Session pool — concurrent CC sessions, one per project directory.
//
// Inheritance: g2code/server/src/session-pool.ts ported with one extension:
//   `getOrCreateByDirectory(cwd, mode)` — the new directory-keyed entry point.
//   When the HUD picks a `/home/user/*` directory, this method either resumes
//   the saved CC session for that path (via --resume) or creates a fresh one.
//
// Internal pool entries stay UUID-keyed (g2code's pattern); the directory map
// is a thin index over the UUID pool persisted at ~/.g2cc/sessions.json.

import { EventEmitter } from 'node:events'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { CCSession, type CCUsage, type CCPermissionMode } from './cc-session.js'
import { ScrollbackBuffer } from './scrollback.js'
import { MAX_CONCURRENT_SESSIONS } from '@g2cc/shared'
import type { ActiveSessionSummary, SessionSummary } from '@g2cc/shared'

const SESSIONS_FILE = join(homedir(), '.g2cc', 'sessions.json')

interface SavedSession {
  id: string                       // CC's own session UUID (for --resume)
  name: string                     // basename of projectPath
  projectPath: string              // absolute cwd path
  lastActive: string               // ISO-8601 timestamp
}

export interface PoolEntry {
  id: string                       // pool entry UUID (DIFFERENT from CC's session ID)
  session: CCSession
  scrollback: ScrollbackBuffer
  name: string
  projectPath: string
  lastActivity: Date
  contextPct: number
  pendingPermissionId: string | null
  /** True iff this entry's CCSession was spawned with --resume. Tracked at
   *  create-time so re-selecting a reused entry still reports the correct
   *  "resumed prior conversation" status to the HUD. */
  spawnedWithResume: boolean
}

export interface CreateOptions {
  permissionMode?: CCPermissionMode
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  model?: string
  systemPrompt?: string
}

export class SessionPool extends EventEmitter {
  private sessions = new Map<string, PoolEntry>()
  private activeId: string | null = null

  constructor() {
    super()
    // Pool fans 'background_alert' (+ future event types) out to clients; default
    // EventEmitter cap is 10 but with multiple concurrent sessions + future events
    // we want headroom. Raised explicitly so any genuine listener-leak still surfaces.
    this.setMaxListeners(30)
  }

  get count(): number { return this.sessions.size }
  get activeSessionId(): string | null { return this.activeId }

  getActive(): PoolEntry | null {
    if (!this.activeId) return null
    return this.sessions.get(this.activeId) ?? null
  }

  get(id: string): PoolEntry | null {
    return this.sessions.get(id) ?? null
  }

  /** 1-based position of the given session in iteration order. Returns -1 when
   *  the id is not present. Use -1 (not 0) as the sentinel so callers can
   *  distinguish "first session" from "not found". */
  indexOf(id: string): number {
    let idx = 0
    for (const key of this.sessions.keys()) {
      idx++
      if (key === id) return idx
    }
    return -1
  }

  /** Create a fresh session in the given project directory. */
  createSession(projectPath: string, options: CreateOptions = {}): PoolEntry {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Max ${MAX_CONCURRENT_SESSIONS} concurrent sessions`)
    }

    const id = randomUUID()
    const entry: PoolEntry = {
      id,
      session: new CCSession({
        projectPath,
        sessionName: basename(projectPath),
        permissionMode: options.permissionMode,
        effort: options.effort,
        model: options.model,
        systemPrompt: options.systemPrompt,
      }),
      scrollback: new ScrollbackBuffer(),
      name: basename(projectPath),
      projectPath,
      lastActivity: new Date(),
      contextPct: 0,
      pendingPermissionId: null,
      spawnedWithResume: false,
    }

    this.sessions.set(id, entry)
    this.activeId = id
    return entry
  }

  /** Create a session that resumes a previous CC session by ID. */
  createResumeSession(projectPath: string, resumeSessionId: string, options: CreateOptions = {}): PoolEntry {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Max ${MAX_CONCURRENT_SESSIONS} concurrent sessions`)
    }

    const id = randomUUID()
    const entry: PoolEntry = {
      id,
      session: new CCSession({
        projectPath,
        sessionId: resumeSessionId,           // → --resume
        sessionName: basename(projectPath),
        permissionMode: options.permissionMode,
        effort: options.effort,
        model: options.model,
        systemPrompt: options.systemPrompt,
      }),
      scrollback: new ScrollbackBuffer(),
      name: basename(projectPath),
      projectPath,
      lastActivity: new Date(),
      contextPct: 0,
      pendingPermissionId: null,
      spawnedWithResume: true,
    }

    this.sessions.set(id, entry)
    this.activeId = id
    return entry
  }

  /** G2CC NEW: Resolve a directory to a session, creating or resuming as needed.
   *  Looks up the directory in ~/.g2cc/sessions.json:
   *    - If a saved CC session ID exists → createResumeSession (--resume)
   *    - Otherwise → createSession (fresh)
   *  This is the directory-picker landing point from the HUD.
   *
   *  Returns `wired=true` when an existing live pool entry is reused. The caller
   *  MUST skip wireSessionEvents() + spawn() in that case — otherwise listeners
   *  accumulate (S-H1) and a second subprocess is spawned orphaning the first
   *  (S-H2). `resumed` reflects whether the underlying CCSession was spawned
   *  with --resume at create time, NOT whether this particular call re-spawned. */
  getOrCreateByDirectory(projectPath: string, options: CreateOptions = {}): { entry: PoolEntry; resumed: boolean; wired: boolean } {
    // First, see if we already have a live pool entry for this path.
    for (const entry of this.sessions.values()) {
      if (entry.projectPath === projectPath) {
        this.activeId = entry.id
        return { entry, resumed: entry.spawnedWithResume, wired: true }
      }
    }

    // Look up the most recent saved session for this directory.
    const saved = loadSavedSessions()
    const match = saved.find(s => s.projectPath === projectPath)

    if (match) {
      const entry = this.createResumeSession(projectPath, match.id, options)
      return { entry, resumed: true, wired: false }
    }

    const entry = this.createSession(projectPath, options)
    return { entry, resumed: false, wired: false }
  }

  switchTo(id: string): PoolEntry {
    const entry = this.sessions.get(id)
    if (!entry) throw new Error(`Session ${id} not found`)
    this.activeId = id
    return entry
  }

  closeSession(id: string): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    entry.session.kill()
    this.sessions.delete(id)

    if (this.activeId === id) {
      this.activeId = null
      let latest: PoolEntry | null = null
      for (const e of this.sessions.values()) {
        if (!latest || e.lastActivity > latest.lastActivity) latest = e
      }
      if (latest) {
        this.activeId = latest.id
        // If the newly-promoted active session has a pending permission, surface
        // it to the client. Otherwise the HUD shows IDLE for a session that's
        // actually awaiting user input.
        if (latest.pendingPermissionId) {
          this.emit('background_alert', {
            sessionId: latest.id,
            alertType: 'permission',
            details: 'Newly active session has a pending permission_request',
          })
        }
      }
    }
  }

  listSessions(): ActiveSessionSummary[] {
    const result: ActiveSessionSummary[] = []
    for (const entry of this.sessions.values()) {
      let sessionState: ActiveSessionSummary['state'] = 'idle'
      if (entry.pendingPermissionId) sessionState = 'permission'
      else if (entry.session.isAlive() && entry.session.requestCount > 0) sessionState = 'streaming'

      result.push({
        id: entry.id,
        name: entry.name,
        project: entry.projectPath,
        state: sessionState,
        contextPct: entry.contextPct,
      })
    }
    return result
  }

  allEntries(): PoolEntry[] {
    return Array.from(this.sessions.values())
  }

  /** Update context % and last activity for a session. */
  updateUsage(id: string, usage: CCUsage): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    const totalTokens = usage.inputTokens + usage.outputTokens
      + usage.cacheReadTokens + usage.cacheCreationTokens
    const window = usage.contextWindow > 0 ? usage.contextWindow : 200_000
    entry.contextPct = Math.min(100, Math.round((totalTokens / window) * 100))
    entry.lastActivity = new Date()
  }

  /** Emit background alert when a non-active session needs attention. */
  emitBackgroundAlert(sessionId: string, alertType: 'permission' | 'complete' | 'error', details?: string): void {
    if (sessionId !== this.activeId) {
      this.emit('background_alert', { sessionId, alertType, details })
    }
  }

  /** Save session metadata to ~/.g2cc/sessions.json for directory-resume. */
  persistSessionMeta(): void {
    const entries: SavedSession[] = []
    for (const entry of this.sessions.values()) {
      const ccId = entry.session.ccSessionId
      if (!ccId) continue                  // skip sessions that haven't initialized yet
      entries.push({
        id: ccId,
        name: entry.name,
        projectPath: entry.projectPath,
        lastActive: entry.lastActivity.toISOString(),
      })
    }

    const dir = join(homedir(), '.g2cc')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // Merge with existing saved sessions (keep old paths' resume IDs around).
    const existing = loadSavedSessions()
    const seenPaths = new Set(entries.map(e => e.projectPath))
    for (const old of existing) {
      if (!seenPaths.has(old.projectPath)) entries.push(old)
    }

    // Sort by recency; cap at 50.
    entries.sort((a, b) => b.lastActive.localeCompare(a.lastActive))
    writeFileSync(SESSIONS_FILE, JSON.stringify(entries.slice(0, 50), null, 2), 'utf-8')
  }

  /** List saved (ended or paused) sessions for the resume menu. */
  static listSavedSessions(): SessionSummary[] {
    return loadSavedSessions().map(s => ({
      id: s.id,
      name: s.name,
      project: s.projectPath,
      lastActive: s.lastActive,
    }))
  }
}

function loadSavedSessions(): SavedSession[] {
  if (!existsSync(SESSIONS_FILE)) return []
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as SavedSession[]
  } catch (err) {
    // Loud-and-proud per docs/FORBIDDEN_PATTERN_AUDIT.md §4: log corruption,
    // continue with empty list (so server still starts) but don't silently
    // pretend everything is fine.
    console.warn(`[pool] sessions.json parse failed (${SESSIONS_FILE}): ${err} — returning empty list`)
    return []
  }
}
