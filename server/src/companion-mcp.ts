// companion-mcp — the Companion CC session's audio tool surface (2026-08-04,
// docs/EARBUD_SPEC.md §C6.4). The FIRST MCP server in G2CC.
//
// Runs as a STANDALONE stdio process, spawned by the Claude CLI itself when
// the Companion session starts (`--mcp-config ~/.g2cc/companion-mcp.json
// --strict-mcp-config`, written at server boot by index.ts). Every tool is a
// thin HTTP call to the main server's LOOPBACK-ONLY /internal/* endpoints
// (the /scout/live gate pattern) — this process holds no state and no audio
// logic; the EarbudAudioService is the single brain.
//
// Env (set in the mcp-config json):
//   G2CC_INTERNAL_URL — http://127.0.0.1:<port>
//   G2CC_TOKEN        — the shared auth token (Bearer)
//
// Failure policy: an unreachable server / non-2xx returns the error TEXT as
// the tool result (isError: true) so the Companion can tell Adam what broke —
// never a silent success, never a crash of the MCP process.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = process.env.G2CC_INTERNAL_URL ?? 'http://127.0.0.1:7300'
const TOKEN = process.env.G2CC_TOKEN ?? ''

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ToolResult> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) {
      return { content: [{ type: 'text', text: `G2CC server refused (${res.status}): ${text}` }], isError: true }
    }
    return { content: [{ type: 'text', text }] }
  } catch (e) {
    return {
      content: [{ type: 'text', text: `G2CC server unreachable at ${BASE}${path}: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    }
  }
}

const server = new McpServer({ name: 'g2cc-earbud', version: '1.0.0' })

server.registerTool('speak', {
  description: 'Speak text aloud into Adam\'s earbud via the server TTS (Kokoro). Use for anything he should hear now. Music ducks automatically. Returns the honest delivery outcome (played/unverified/failed).',
  inputSchema: {
    text: z.string().describe('What to say. Plain prose — markdown is stripped, code blocks become "code block on glasses".'),
    priority: z.enum(['now', 'next', 'queue']).optional().describe('now = interrupt everything (urgent only); next = ahead of queued speech; queue (default) = after current speech.'),
  },
}, async ({ text, priority }) => call('POST', '/internal/speak', { text, priority }))

server.registerTool('play_music', {
  description: 'Search Adam\'s music library (1,200 tracks on the PC) and PLAY the results in his earbud (mono). Query matches artist/album/title/path tokens; "random" or "surprise me" plays a random mix. Replaces the current queue.',
  inputSchema: {
    query: z.string().describe('e.g. "pink floyd", "dark side of the moon", "powerglove", "random"'),
    shuffle: z.boolean().optional().describe('Shuffle the result order (default false = album order).'),
  },
}, async ({ query, shuffle }) => call('POST', '/internal/play', { query, shuffle }))

server.registerTool('queue_music', {
  description: 'Search the library and APPEND the results to the current play queue (does not interrupt what is playing).',
  inputSchema: { query: z.string() },
}, async ({ query }) => call('POST', '/internal/play', { query, append: true }))

server.registerTool('pause_music', {
  description: 'Pause the earbud music lane.', inputSchema: {},
}, async () => call('POST', '/internal/media', { cmd: 'pause' }))

server.registerTool('resume_music', {
  description: 'Resume paused earbud music.', inputSchema: {},
}, async () => call('POST', '/internal/media', { cmd: 'resume' }))

server.registerTool('skip_track', {
  description: 'Skip to the next queued track (delta -1 = previous).',
  inputSchema: { delta: z.number().int().optional() },
}, async ({ delta }) => call('POST', '/internal/media', { cmd: 'skip', value: delta ?? 1 }))

server.registerTool('stop_music', {
  description: 'Stop music playback and clear the player (queue stays listed).', inputSchema: {},
}, async () => call('POST', '/internal/media', { cmd: 'stop' }))

server.registerTool('set_volume', {
  description: 'Set earbud media volume 0-100 (phone STREAM_MUSIC).',
  inputSchema: { pct: z.number().min(0).max(100) },
}, async ({ pct }) => call('POST', '/internal/media', { cmd: 'volume', value: pct }))

server.registerTool('status', {
  description: 'Current earbud/system status: now-playing + queue position, speech state, phone caps, glasses BLE + batteries, pending timers. Cheap — call freely for context.',
  inputSchema: {},
}, async () => call('GET', '/internal/status'))

server.registerTool('set_timer', {
  description: 'Set a durable timer that chimes + speaks in the earbud (and shows on the glasses) when it fires. Survives server restarts.',
  inputSchema: {
    minutes: z.number().positive(),
    label: z.string().describe('Spoken when it fires, e.g. "check the oven parts".'),
  },
}, async ({ minutes, label }) => call('POST', '/internal/timer', { minutes, label }))

server.registerTool('list_timers', {
  description: 'List pending timers with remaining time.', inputSchema: {},
}, async () => call('GET', '/internal/timers'))

server.registerTool('save_note', {
  description: 'Append a line to Adam\'s notes inbox (the notes file his other flows read).',
  inputSchema: { text: z.string() },
}, async ({ text }) => call('POST', '/internal/note', { text }))

server.registerTool('unseen_notifications', {
  description: 'List unseen phone/system notifications ("what did I miss"). markSeen=true marks them all seen after listing.',
  inputSchema: { markSeen: z.boolean().optional() },
}, async ({ markSeen }) => call('GET', `/internal/notifications${markSeen ? '?markSeen=1' : ''}`))

server.registerTool('external_media', {
  description: 'Transport-control whatever third-party app is playing on the PHONE (Spotify etc.) via its MediaSession: play_pause | next | prev.',
  inputSchema: { cmd: z.enum(['play_pause', 'next', 'prev']) },
}, async ({ cmd }) => call('POST', '/internal/external-media', { cmd }))

const transport = new StdioServerTransport()
await server.connect(transport)
// stderr only — stdout belongs to the MCP protocol.
console.error(`[companion-mcp] up (server ${BASE})`)
