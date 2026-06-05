// CC Session Manager — spawn and manage a persistent Claude Code subprocess.
//
// Inheritance: g2code/server/src/cc-session.ts ported with two changes:
//   1. `--effort max` is now a CLI flag (was env-only via CLAUDE_CODE_EFFORT_LEVEL).
//      Both are kept (CLI authoritative; env redundant) per CLAUDE.md / spec §1.
//   2. Effort + model + systemPrompt are configurable per-session via CCSessionConfig
//      (was hardcoded). Defaults come from G2CCConfig.claude.
//
// The stream-json text-assembly bug-trap (lines marked [V]) is preserved verbatim
// from ARIA session_pool.py:292-298 — `result.result` only contains the LAST text
// block, so we MUST collect text from "assistant" events and prepend missing
// parts to fullText. See docs/INHERITANCE_MAP.md and FORBIDDEN_PATTERN_AUDIT.md.

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type { CcEffort } from './config.js'

const CLAUDE_CLI = process.env.CLAUDE_CLI ?? '/usr/bin/claude'

export type CCPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

export interface CCUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextWindow: number  // max contextWindow across modelUsage (defaults to 200K)
}

export interface CCSessionEvents {
  text: (text: string) => void
  text_delta: (delta: string) => void
  tool_use: (info: { name: string; summary: string }) => void
  tool_result: (content: string) => void
  turn_complete: (info: { text: string; toolCalls: string[]; costUsd: number; usage: CCUsage }) => void
  permission_request: (info: { requestId: string; rawEvent: Record<string, unknown> }) => void
  error: (message: string) => void
  process_died: (code: number | null) => void
}

export interface CCSessionConfig {
  projectPath: string
  sessionId?: string                 // for --resume
  sessionName?: string               // for --name
  permissionMode?: CCPermissionMode  // default: 'bypassPermissions'
  /** Effort level (added in G2CC; default 'max' per spec §1). */
  effort?: CcEffort
  /** Model alias or full name (default 'opus'). */
  model?: string
  /** Optional system prompt to append (engineering-oriented for vanilla CC). */
  systemPrompt?: string
}

export class CCSession extends EventEmitter {
  private proc: ChildProcess | null = null
  private config: CCSessionConfig
  private currentTurnTextParts: string[] = []
  private toolCallsSeen: string[] = []
  private _requestCount = 0
  private _isProcessingTurn = false           // true between sendPrompt() and the turn's 'result' event
  private _ccSessionId: string | null = null  // CC's own session UUID (from system init event)
  private _recentStderr: string[] = []        // ring buffer of last stderr lines (for death diagnostics)
  private _recentEvents: string[] = []        // ring buffer of last stream-json event types
  consecutiveFailures = 0

  constructor(config: CCSessionConfig) {
    super()
    this.config = config
    // ws-handler attaches 8 listeners per session (text, text_delta, tool_use,
    // tool_result, turn_complete, error, permission_request, process_died).
    // Default cap of 10 is too tight; raise so legitimate wiring doesn't trigger
    // the "MaxListenersExceededWarning" alarm. Any real listener leak above this
    // still trips the warning.
    this.setMaxListeners(30)
  }

  get requestCount(): number { return this._requestCount }
  /** True iff a prompt has been sent and the turn's terminal 'result' event has
   *  not yet fired (or the turn was interrupted / the process died). Drives the
   *  HUD's "processing" indicator on on-demand snapshots (session_switch,
   *  list_active_sessions). Unlike `requestCount > 0`, this clears on turn end,
   *  so an idle-but-prompted session no longer reports busy forever. */
  get isProcessingTurn(): boolean { return this._isProcessingTurn }
  get projectPath(): string { return this.config.projectPath }
  /** CC's own session UUID — captured from the system init event. Used for --resume. */
  get ccSessionId(): string | null { return this._ccSessionId }
  /** True iff the most-recent spawn used --resume (i.e. preserves prior CC
   *  conversation context). Updated by setResumeTarget — including watchdog
   *  respawns of originally-fresh sessions, so the HUD's "resumed" indicator
   *  stays accurate across respawn boundaries. */
  get spawnedWithResume(): boolean { return this.config.sessionId !== undefined }
  /** Prime the --resume sessionId for the next spawn() (used by watchdog). */
  setResumeTarget(ccSessionId: string): void { this.config.sessionId = ccSessionId }

  // [V] Spawn flags verified from ARIA session_pool.py:126-141 + g2code/cc-session.ts.
  // [V] --include-partial-messages verified from g2code Phase 0 testing (2026-04-15).
  // G2CC change: --effort max as a CLI flag (was env-only in g2code).
  async spawn(): Promise<void> {
    // S-H2: guard against double-spawn. Without this, calling spawn() while the
    // previous proc is still alive silently orphans it (the old subprocess keeps
    // running, listeners no longer wired to the new pid, watchdog tracks only
    // the latest — zombie that survives server shutdown). Loud and proud.
    if (this.proc !== null && this.proc.exitCode === null) {
      throw new Error(
        `CCSession.spawn() called while previous process (pid=${this.proc.pid}) ` +
        `is still alive. Caller must kill() or wait for process_died first.`,
      )
    }

    const effort = this.config.effort ?? 'max'
    const model = this.config.model ?? 'opus'

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--include-partial-messages',
      '--effort', effort,
    ]

    // Permission mode controls whether CC emits control_request events:
    //   bypassPermissions → --dangerously-skip-permissions (no prompts, ARIA pattern)
    //   default / plan / acceptEdits → --permission-mode <mode> (control_request emitted)
    const mode = this.config.permissionMode ?? 'bypassPermissions'
    if (mode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    } else {
      args.push('--permission-mode', mode)
    }

    if (this.config.sessionId) args.push('--resume', this.config.sessionId)
    if (this.config.sessionName) args.push('--name', this.config.sessionName)
    if (this.config.systemPrompt) args.push('--system-prompt', this.config.systemPrompt)

    // [V] Env vars verified from ARIA session_pool.py:122-124 + g2code/cc-session.ts.
    // CLAUDE_CODE_EFFORT_LEVEL=max kept as redundancy with the CLI flag (CLI authoritative).
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== 'CLAUDECODE' && v !== undefined) env[k] = v
    }
    env.CLAUDE_CODE_EFFORT_LEVEL = effort
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'

    // Capture stderr for crash diagnostics (g2code learned this lesson the hard way).
    this.proc = spawn(CLAUDE_CLI, args, {
      cwd: this.config.projectPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // SRV-7 (no-mangle): decode stdout as UTF-8 so a multibyte glyph (CC's
    // markdown box-drawing ┌─└│▸ / emoji) split across two pipe reads isn't
    // mis-decoded into mojibake that then flows into scrollback. (The Parakeet
    // daemon path already does this.)
    this.proc.stdout!.setEncoding('utf8')
    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity })
    rl.on('line', (line: string) => {
      if (!line.trim()) return
      try {
        const data = JSON.parse(line)
        this._recentEvents.push(`${data.type}${data.subtype ? '/' + data.subtype : ''}`)
        if (this._recentEvents.length > 50) this._recentEvents.shift()
        this.handleStreamEvent(data)
      } catch {
        // Deliberate: stream-json emits occasional non-JSON lines (stderr leakage,
        // progress messages). ARIA verified at session_pool.py:274-275. No log —
        // would spam at startup before CC's first valid JSON line.
      }
    })

    const errRl = createInterface({ input: this.proc.stderr!, crlfDelay: Infinity })
    errRl.on('line', (line: string) => {
      this._recentStderr.push(line)
      if (this._recentStderr.length > 30) this._recentStderr.shift()
    })

    this.proc.on('close', (code, signal) => {
      const recentEvents = this._recentEvents.slice(-15).join(', ')
      const stderr = this._recentStderr.slice(-20).join('\n  ')
      console.log(`[cc-session] Process exit: code=${code} signal=${signal} cwd=${this.config.projectPath}`)
      console.log(`[cc-session] Recent events: ${recentEvents || '(none)'}`)
      if (stderr) console.log(`[cc-session] Last stderr:\n  ${stderr}`)
      this.proc = null
      this._isProcessingTurn = false   // a dead process is not mid-turn
      this.emit('process_died', code)
    })

    // S-H3: do NOT reset consecutiveFailures here. The watchdog owns this counter
    // and only resets it after the proc has stayed alive for HEALTHY_LIFETIME_MS.
    // Resetting on every successful spawn() (g2code's bug we inherited) makes the
    // crash-loop guard unreachable for procs that crash within seconds of spawning.
    this._requestCount = 0
    this._isProcessingTurn = false
    console.log(`[cc-session] Spawned (pid=${this.proc.pid}, cwd=${this.config.projectPath}, effort=${effort}, model=${model})`)
  }

  // [V] Send prompt format from ARIA session_pool.py:246-251.
  sendPrompt(text: string): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error('CC process not running')
    }
    this.currentTurnTextParts = []
    this.toolCallsSeen = []
    this._requestCount++
    this._isProcessingTurn = true

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    }) + '\n'
    this.proc.stdin.write(msg)
  }

  interrupt(): void {
    if (this.proc) this.proc.kill('SIGINT')
    // The turn is aborted. Clear the processing flag now rather than relying on
    // CC to emit a terminal 'result' on SIGINT (unverified in stream-json mode);
    // if it does emit one, the result handler clears the (already-false) flag
    // again — idempotent.
    this._isProcessingTurn = false
  }

  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL')
      this.proc = null
    }
    this._isProcessingTurn = false
  }

  // [V] control_response APPROVE format verified from ARIA session_pool.py:361-368.
  // [U] DENY format unverified — ARIA always approves. Phase 7 may need to verify
  // when implementing the confirm_on_hud reject path through CC's permission gates.
  // 4th-pass-final review HIGH: throws when proc is dead instead of silently
  // dropping. Without this, the HUD reports approval-sent but CC never got
  // it; the watchdog respawn loses the request entirely. Caller must catch
  // + surface a cc_error so the user knows their tap was lost.
  respondToPermission(requestId: string, approved: boolean): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error(`respondToPermission(${requestId}): CC stdin not writable (process dead?)`)
    }
    const resp = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: approved ? 'success' : 'error',
        request_id: requestId,
        response: { behavior: approved ? 'allow' : 'deny' },
      },
    }) + '\n'
    this.proc.stdin.write(resp)
  }

  private handleStreamEvent(data: Record<string, unknown>): void {
    const msgType = data.type as string

    // [V] "assistant" handling verified from ARIA session_pool.py:319-344.
    if (msgType === 'assistant') {
      const msgData = data.message as Record<string, unknown> | undefined
      if (msgData && typeof msgData === 'object') {
        const content = msgData.content as unknown[]
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== 'object' || block === null) continue
            const b = block as Record<string, unknown>
            if (b.type === 'text') {
              const textVal = (b.text as string) || ''
              if (textVal.trim()) {
                this.currentTurnTextParts.push(textVal)
                this.emit('text', textVal)
              }
            } else if (b.type === 'tool_use') {
              const name = (b.name as string) || 'unknown'
              const summary = summarizeToolInput(b.input as Record<string, unknown>)
              this.toolCallsSeen.push(name)
              this.emit('tool_use', { name, summary })
            }
          }
        }
      }
    }

    // [V] "tool" handling verified from ARIA session_pool.py:346-357.
    // G2CC change: NO 500-char truncation. Emit full content; scrollback paginates.
    // The g2code version sliced to 500 + '...' which violated the no-truncation rule
    // (see docs/FORBIDDEN_PATTERN_AUDIT.md §1).
    if (msgType === 'tool') {
      const toolContent = data.message as Record<string, unknown> | undefined
      if (toolContent && typeof toolContent === 'object') {
        const content = (toolContent.content as string) || ''
        this.emit('tool_result', content)
      }
    }

    // [V] "result" handling + text assembly verified from ARIA session_pool.py:279-317.
    if (msgType === 'result') {
      // A 'result' event (success or error subtype) terminates the turn.
      this._isProcessingTurn = false
      const resultSubtype = data.subtype as string | undefined
      if (data.is_error || resultSubtype === 'error_during_execution' || resultSubtype === 'error_max_turns') {
        const errText = (data.result as string) || `CC ${resultSubtype || 'error'}`
        this.emit('error', errText)
        this.emit('turn_complete', {
          text: errText,
          toolCalls: [...this.toolCallsSeen],
          costUsd: (data.total_cost_usd as number) || 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 200_000 },
        })
        // Reset turn state so a stray second 'result' for the same prompt
        // (CC --resume retries, etc.) doesn't re-prepend earlier text.
        this.currentTurnTextParts = []
        this.toolCallsSeen = []
        return
      }

      let fullText = (data.result as string) || ''

      // [V] Exact assembly logic from ARIA session_pool.py:292-298.
      // Result only has LAST text block. Prepend earlier blocks.
      if (this.currentTurnTextParts.length > 1) {
        const earlier: string[] = []
        for (const part of this.currentTurnTextParts) {
          if (!fullText.includes(part.trim())) earlier.push(part.trim())
        }
        if (earlier.length > 0) fullText = earlier.join('\n') + '\n' + fullText
      }

      // Extract usage from result event (verified from g2code Phase 0).
      const usage: CCUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 200_000, // fallback if modelUsage absent
      }
      const rawUsage = data.usage as Record<string, unknown> | undefined
      if (rawUsage) {
        usage.inputTokens = (rawUsage.input_tokens as number) || 0
        usage.outputTokens = (rawUsage.output_tokens as number) || 0
        usage.cacheReadTokens = (rawUsage.cache_read_input_tokens as number) || 0
        usage.cacheCreationTokens = (rawUsage.cache_creation_input_tokens as number) || 0
      }

      // Read actual contextWindow from modelUsage (Opus 4.7 = 1M, not 200K).
      const modelUsage = data.modelUsage as Record<string, Record<string, unknown>> | undefined
      if (modelUsage) {
        for (const [modelName, model] of Object.entries(modelUsage)) {
          const cw = model.contextWindow
          if (typeof cw === 'number' && cw > usage.contextWindow) {
            usage.contextWindow = cw
          }
          console.log(`[cc-session] Model ${modelName}: ctx=${cw} tokens=in${model.inputTokens}/out${model.outputTokens}/cacheR${model.cacheReadInputTokens}/cacheC${model.cacheCreationInputTokens}`)
        }
      }
      const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
      console.log(`[cc-session] Turn: total=${total} tokens, ctx=${usage.contextWindow}, ctx%=${Math.round(total / usage.contextWindow * 100)}`)

      const costUsd = (data.total_cost_usd as number) || 0

      this.emit('turn_complete', {
        text: fullText,
        toolCalls: [...this.toolCallsSeen],
        costUsd,
        usage,
      })
      // Reset turn state so a stray second 'result' for the same prompt
      // doesn't re-prepend earlier text. Defensive — sendPrompt() also resets.
      this.currentTurnTextParts = []
      this.toolCallsSeen = []
    }

    // [V] "control_request" handling verified from ARIA session_pool.py:359-370.
    if (msgType === 'control_request') {
      console.log('[cc-session] control_request:', JSON.stringify(data))
      this.emit('permission_request', {
        requestId: data.request_id as string,
        rawEvent: data,
      })
    }

    // [V] "stream_event" verified from g2code Phase 0 Test 1.
    if (msgType === 'stream_event') {
      const event = data.event as Record<string, unknown> | undefined
      if (event?.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.emit('text_delta', delta.text)
        }
      }
    }

    // "system" init event — capture CC's own session UUID for --resume.
    if (msgType === 'system' && data.subtype === 'init' && typeof data.session_id === 'string') {
      this._ccSessionId = data.session_id
    }
  }
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  if (input.file_path) return input.file_path as string
  // 60-char preview is for the inline tool-use status line shown alongside the
  // tool name (e.g. "Bash: git status -uno..."). NOT a truncation of user-facing
  // tool RESULT content, which goes to scrollback in full. This is a display-
  // summary cap, not a no-truncation-rule violation.
  if (input.command) return (input.command as string).slice(0, 60)
  if (input.pattern) return `"${input.pattern}"`
  return ''
}
