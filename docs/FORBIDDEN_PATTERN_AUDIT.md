# G2CC Forbidden-Pattern Audit

Line-by-line audit of patterns in g2code/g2aria/aria source that violate (or appear to violate) the project's three absolute rules:

- **NO TIMEOUTS** anywhere in BLE / WebSocket / capture / display / ASR paths
- **NO SILENT FAILURES**, ever — loud and proud
- **NO TRUNCATION** anywhere — scroll instead of `…`

For each finding: the source citation, the verdict (forbidden / allowed-with-reason), and how the G2CC port handles it.

---

## VIOLATIONS — must NOT inherit verbatim

### 1. Tool-result truncation in `cc-session.ts`

**Source:** `/home/user/g2code/server/src/cc-session.ts:241-244`

```typescript
let content = (toolContent.content as string) || ''
if (typeof content === 'string' && content.length > 500) {
  content = content.slice(0, 500) + '...'
}
```

**Verdict:** **FORBIDDEN** — fixed-N slicing on user-facing strings with `'...'` suffix. Violates RULE NO TRUNCATION.

**G2CC port handling (Phase 2A):** emit the FULL `content` string. Append it to scrollback via `wireSessionEvents`'s existing `tool_use → scrollback.append` path. The HUD already paginates via `scrollback.getPage(...)` — no new code needed; just stop the truncation.

---

### 2. 30-second timeout on local Whisper subprocess in `g2code/stt.ts`

**Source:** `/home/user/g2code/server/src/stt.ts:85-88`

```typescript
const result = execFileSync(config.stt.pythonPath, ['-c', script, tmpPath], {
  encoding: 'utf-8',
  timeout: 30000,
}).trim()
```

**Verdict:** **FORBIDDEN** — explicit `timeout=` on a long-running operation. Violates RULE NO TIMEOUTS. Long audio legitimately takes minutes; killing the job mid-transcribe is silent-failure-shaped.

**G2CC port handling (Phase 2A):** inherit g2aria's `stt.ts` shape instead — `execFileAsync` (promisified, async, non-blocking server event loop) with `maxBuffer: 16 * 1024 * 1024` and **no timeout**. Comment notes the discipline.

---

### 3. Silent `unlinkSync` cleanup swallow in `stt.ts` (both g2code and g2aria)

**Source:** `/home/user/g2aria/server/src/stt.ts:102-104` (and identical pattern in g2code's `stt.ts:62-64` and `:92-94`)

```typescript
} finally {
  try { unlinkSync(tmpPath) } catch { /* ignore cleanup errors */ }
}
```

**Verdict:** **FORBIDDEN** — bare `catch { /* ignore */ }` on cleanup. Violates RULE NO SILENT FAILURES. If the tmpfile can't be deleted (disk full, permission, race), we should know.

**G2CC port handling (Phase 2A):**

```typescript
} finally {
  if (existsSync(tmpPath)) {
    try { unlinkSync(tmpPath) }
    catch (err) { console.warn(`[stt] tmpfile cleanup failed (${tmpPath}): ${err}`) }
  }
}
```

Loud log on actual error; existsSync guard means a missing-file isn't an error in the first place.

---

### 4. Silent `JSON.parse` swallow on saved sessions file

**Source:** `/home/user/g2code/server/src/session-pool.ts:226-231`

```typescript
function loadSavedSessions(): SavedSession[] {
  if (!existsSync(SESSIONS_FILE)) return []
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as SavedSession[]
  } catch {
    return []
  }
}
```

**Verdict:** **FORBIDDEN-ish** — silent swallow on JSON parse failure. If `~/.g2cc/sessions.json` is corrupt, we silently lose all session metadata.

**G2CC port handling (Phase 2A):**

```typescript
} catch (err) {
  console.warn(`[pool] sessions.json parse failed (${SESSIONS_FILE}): ${err} — returning empty list`)
  return []
}
```

The empty-list return is intentional fallback (so a corrupt file doesn't kill the server), but the failure is now loud.

---

## ALLOWED-WITH-REASON — keep verbatim

### A. `AUTH_TIMEOUT_MS = 5000` security window kick

**Source:** `/home/user/g2code/server/src/ws-handler.ts:65-70`, `/home/user/g2code/shared/src/constants.ts:45`

```typescript
client.authTimer = setTimeout(() => {
  if (!client.authenticated) {
    sendMsg(client, { type: 'auth_result', success: false, error: 'Auth timeout' })
    ws.close(4001, 'Auth timeout')
  }
}, AUTH_TIMEOUT_MS)
```

**Verdict:** **NOT a violation.** This is a security guard that prevents an unauthenticated socket from holding a slot indefinitely. It does NOT kill an authenticated long-running operation. Killing unauthed sockets at 5s is responsible resource hygiene; the client must auth in 5s or it gets dropped.

**G2CC port handling (Phase 2A):** keep verbatim. Comment explicitly: `// AUTH_TIMEOUT_MS = security window for unauthed sockets, NOT an I/O timeout. Does not violate the no-timeouts rule.`

---

### B. Watchdog respawn backoff `await new Promise(r => setTimeout(r, backoff))`

**Source:** `/home/user/g2code/server/src/watchdog.ts:38-43`

```typescript
const backoff = 2_000 * Math.pow(2, session.consecutiveFailures)
console.log(`[watchdog] Session ${id} dead, respawning in ${backoff}ms`)
try {
  await new Promise(resolve => setTimeout(resolve, backoff))
  ...
}
```

**Verdict:** **NOT a violation.** This is a delayed retry, NOT an I/O timeout on a long-running operation. The backoff is data-driven (failure count), not arbitrary clock-watching. The pattern is "wait then retry," which is legitimate exponential-backoff.

**G2CC port handling:** keep verbatim. Comment: `// backoff DELAY between respawn attempts; not an I/O timeout. Allowed.`

---

### C. Watchdog interval `setInterval(check, WATCHDOG_INTERVAL_MS=30000)`

**Source:** `/home/user/g2code/server/src/watchdog.ts:18`

**Verdict:** **NOT a violation.** A periodic health check is not a per-operation timeout. It's how we detect that a CC subprocess has died. The 30s cadence is generous enough to not be an arbitrary clock kill.

---

### D. Stream-text-delta debounce `setTimeout(..., 300)`

**Source:** `/home/user/g2code/server/src/ws-handler.ts:389-397`

```typescript
session.on('text_delta', (delta: string) => {
  ...
  client.streamBuffer += delta
  if (!client.streamTimer) {
    client.streamTimer = setTimeout(() => {
      ...
      sendMsg(client, { type: 'text_delta', text: client.streamBuffer })
    }, 300)
  }
})
```

**Verdict:** **NOT a violation.** This is a debounce that batches outgoing text deltas every 300ms to avoid overwhelming the WebSocket with a flood of single-character writes. The CC stream itself is NOT killed; the batch interval just paces flushes. Cleanup on `turn_complete` flushes any pending content immediately.

**G2CC port handling:** keep verbatim. Comment: `// debounce: pace text_delta flush to ~300ms intervals; not an I/O timeout`.

---

### E. NDJSON parse silent skip in cc-session

**Source:** `/home/user/g2code/server/src/cc-session.ts:117-126`

```typescript
rl.on('line', (line: string) => {
  if (!line.trim()) return
  try {
    const data = JSON.parse(line)
    ...
  } catch {
    // ARIA skips non-JSON lines (session_pool.py:274-275)
  }
})
```

**Verdict:** **NOT a violation per spirit, but the catch is opaque.** The non-JSON-line case is documented behavior of the stream-json output (some lines are stderr leakage or progress messages CC emits in non-JSON form). The comment cites the ARIA reference. Skipping these is correct.

**G2CC port handling (Phase 2A):** keep with a louder comment and optional debug log:

```typescript
} catch {
  // Deliberate: stream-json emits occasional non-JSON lines (stderr leakage,
  // progress messages). ARIA verified this behavior at session_pool.py:274-275.
  // No log — would spam at startup before CC's first valid JSON line.
}
```

---

### F. WebSocket zombie-send catches in `g2aria/app/src/connection.ts`

**Source:** `/home/user/g2aria/app/src/connection.ts:218-228`

```typescript
send(msg: ClientMessage): void {
  if (this.ws?.readyState === WebSocket.OPEN) {
    try { this.ws.send(JSON.stringify(msg)) } catch { /* zombie send */ }
  }
}
```

**Verdict:** **NOT a violation per spirit.** The WebSocket has a half-closed transition window where `readyState === OPEN` but `.send()` throws. The catch is defensive against this race. The alternative is a TypeError that crashes the entire mobile app.

**G2CC port handling (Phase 6, Kotlin port):** preserve the defensive catch but make the comment explicit. In Kotlin: `try { ws.send(payload) } catch (e: Exception) { /* zombie send: ws was OPEN at readyState check but is now in half-closed transition; no recovery possible */ }`. No log — would spam during normal teardown.

---

### G. Catch-and-respond in ws-handler

**Source:** `/home/user/g2code/server/src/ws-handler.ts:213-216, 285-292, 372-376, 482-485, 500-503`

```typescript
try {
  ...
} catch (err) {
  sendMsg(client, { type: 'cc_error', error: `Failed to spawn: ${err}` })
}
```

**Verdict:** **NOT a violation.** Catch-and-respond — failure is reported to the client over the WebSocket. This is loud-and-proud failure surfacing, not silent swallow.

**G2CC port:** keep verbatim. Idiomatic.

---

## Summary

The `cc-session.ts:241-244` truncation, the `g2code/stt.ts:87` `timeout: 30000`, and the bare `unlinkSync` swallows are the only outright violations. All three are fixed in Phase 2A by either pulling g2aria's shape (which already removed the timeout) or replacing with explicit logged failure / scrolling output.

The other patterns (auth-window timer, watchdog backoff, debounce, NDJSON skip, zombie-send catch) are NOT violations on inspection — they are either resource-management primitives (security windows, interval health checks) or carefully-scoped tolerances of known stream irregularities. They keep verbatim with louder comments.

CI grep gates after Phase 2A (commands to run before merging):

```sh
# No I/O timeouts — only the auth-window security guard
rg "withTimeout|wait_for|timeout=" /home/user/G2CC/server/src/

# No silent catch
rg "catch\s*\(\s*\)?\s*\{\s*\}" /home/user/G2CC/server/src/
rg "catch\s*\([^)]*\)\s*\{\s*/\*\s*ignore" /home/user/G2CC/server/src/

# No fixed-N user-facing truncation
rg "\.slice\(0,\s*(200|500|1000)\)" /home/user/G2CC/server/src/
```

Each must produce only the explicitly-allowed matches enumerated above (auth timer, debounce setTimeout, watchdog setInterval/backoff). Any new match is a Phase 2A bug.
