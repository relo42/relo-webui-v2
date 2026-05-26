/**
 * Relo Gateway FastAPI Client
 *
 * HTTP client for the Relo Agent gateway backend (default: http://127.0.0.1:8642).
 */

import {
  BEARER_TOKEN,
  RELO_API,
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  ensureGatewayProbed,
  getCapabilities,
  probeGateway,
} from './gateway-capabilities'

const _authHeaders = (): Record<string, string> =>
  BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}

console.log(`[relo-api] Configured API: ${RELO_API}`)

// ── Types ─────────────────────────────────────────────────────────

export type ReloSession = {
  id: string
  source?: string
  user_id?: string | null
  model?: string | null
  title?: string | null
  started_at?: number
  ended_at?: number | null
  end_reason?: string | null
  message_count?: number
  tool_call_count?: number
  input_tokens?: number
  output_tokens?: number
  parent_session_id?: string | null
  last_active?: number | null
}

export type ReloMessage = {
  id: number
  session_id: string
  role: string
  content: string | null
  tool_call_id?: string | null
  tool_calls?: Array<unknown> | string | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
}

export type ReloConfig = {
  model?: string
  provider?: string
  [key: string]: unknown
}

// ── Helpers ───────────────────────────────────────────────────────

async function reloGet<T>(path: string): Promise<T> {
  const res = await fetch(`${RELO_API}${path}`, { headers: _authHeaders() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Relo API ${path}: ${res.status} ${body}`)
  }
  return res.json() as Promise<T>
}

async function reloPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${RELO_API}${path}`, {
    method: 'POST',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Relo API POST ${path}: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

async function reloPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${RELO_API}${path}`, {
    method: 'PATCH',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Relo API PATCH ${path}: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

async function reloDeleteReq(path: string): Promise<void> {
  const res = await fetch(`${RELO_API}${path}`, {
    method: 'DELETE',
    headers: _authHeaders(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Relo API DELETE ${path}: ${res.status} ${text}`)
  }
}

// ── Health ────────────────────────────────────────────────────────

export async function checkHealth(): Promise<{ status: string }> {
  return reloGet('/health')
}

// ── Sessions ─────────────────────────────────────────────────────

export async function listSessions(
  limit = 50,
  offset = 0,
): Promise<Array<ReloSession>> {
  const resp = await reloGet<{ items: Array<ReloSession>; total: number }>(
    `/api/sessions?limit=${limit}&offset=${offset}`,
  )
  return resp.items
}

export async function getSession(sessionId: string): Promise<ReloSession> {
  const resp = await reloGet<{ session: ReloSession }>(
    `/api/sessions/${sessionId}`,
  )
  return resp.session
}

export async function createSession(opts?: {
  id?: string
  title?: string
  model?: string
}): Promise<ReloSession> {
  const resp = await reloPost<{ session: ReloSession }>(
    '/api/sessions',
    opts || {},
  )
  return resp.session
}

export async function updateSession(
  sessionId: string,
  updates: { title?: string },
): Promise<ReloSession> {
  const resp = await reloPatch<{ session: ReloSession }>(
    `/api/sessions/${sessionId}`,
    updates,
  )
  return resp.session
}

export async function deleteSession(sessionId: string): Promise<void> {
  return reloDeleteReq(`/api/sessions/${sessionId}`)
}

export async function getMessages(
  sessionId: string,
): Promise<Array<ReloMessage>> {
  const resp = await reloGet<{ items: Array<ReloMessage>; total: number }>(
    `/api/sessions/${sessionId}/messages`,
  )
  return resp.items
}

export async function searchSessions(
  query: string,
  limit = 20,
): Promise<{ query: string; count: number; results: Array<unknown> }> {
  return reloGet(
    `/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  )
}

export async function forkSession(
  sessionId: string,
): Promise<{ session: ReloSession; forked_from: string }> {
  return reloPost(`/api/sessions/${sessionId}/fork`)
}

// ── Conversion helpers (Relo → Chat format) ─────────────────

/** Convert a ReloMessage to the ChatMessage format the frontend expects */
export function toChatMessage(
  msg: ReloMessage,
  options?: { historyIndex?: number },
): Record<string, unknown> {
  let toolCalls: Array<unknown> | undefined
  if (Array.isArray(msg.tool_calls)) {
    toolCalls = msg.tool_calls
  } else if (msg.tool_calls && typeof msg.tool_calls === 'string') {
    try {
      toolCalls = JSON.parse(msg.tool_calls)
    } catch {
      toolCalls = undefined
    }
  }

  const content: Array<Record<string, unknown>> = []

  const streamToolCallsArr: Array<Record<string, unknown>> = []
  if (msg.role === 'assistant' && toolCalls && Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const record = tc as Record<string, unknown>
      const fn = record.function as Record<string, unknown> | undefined
      const toolCallId =
        record.id || `tc-${Math.random().toString(36).slice(2, 8)}`
      const toolName = fn?.name || (record.name as string | undefined) || 'tool'
      const toolArgs = fn?.arguments
      streamToolCallsArr.push({
        id: toolCallId,
        name: toolName,
        args: toolArgs,
        phase: 'complete',
      })
      content.push({
        type: 'toolCall',
        id: toolCallId,
        name: toolName,
        arguments:
          toolArgs && typeof toolArgs === 'object'
            ? (toolArgs as Record<string, unknown>)
            : undefined,
        partialJson: typeof toolArgs === 'string' ? toolArgs : undefined,
      })
    }
  }

  if (msg.role === 'tool') {
    content.push({
      type: 'tool_result',
      toolCallId: msg.tool_call_id,
      toolName: msg.tool_name,
      text: msg.content || '',
    })
  }

  if (msg.content && msg.role !== 'tool') {
    content.push({ type: 'text', text: msg.content })
  }

  return {
    id: `msg-${msg.id}`,
    role: msg.role,
    content,
    text: msg.content || '',
    timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
    createdAt: msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString()
      : undefined,
    sessionKey: msg.session_id,
    ...(typeof options?.historyIndex === 'number'
      ? { __historyIndex: options.historyIndex }
      : {}),
    ...(streamToolCallsArr.length > 0
      ? { streamToolCalls: streamToolCallsArr }
      : {}),
  }
}

/** Convert a ReloSession to the session summary format the frontend expects */
export function toSessionSummary(
  session: ReloSession,
): Record<string, unknown> {
  return {
    key: session.id,
    friendlyId: session.id,
    kind: 'chat',
    status: session.ended_at ? 'ended' : 'idle',
    model: session.model || '',
    label: session.title || session.id,
    title: session.title || session.id,
    derivedTitle: session.title || session.id,
    tokenCount: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    message_count: session.message_count ?? 0,
    tool_call_count: session.tool_call_count ?? 0,
    messageCount: session.message_count ?? 0,
    toolCallCount: session.tool_call_count ?? 0,
    cost: 0,
    createdAt: session.started_at ? session.started_at * 1000 : Date.now(),
    startedAt: session.started_at ? session.started_at * 1000 : Date.now(),
    updatedAt: session.ended_at
      ? session.ended_at * 1000
      : session.started_at
        ? session.started_at * 1000
        : Date.now(),
    usage: {
      promptTokens: session.input_tokens ?? 0,
      completionTokens: session.output_tokens ?? 0,
      totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    },
  }
}

// ── Chat (streaming) ─────────────────────────────────────────────

type StreamChatOptions = {
  signal?: AbortSignal
  onEvent: (payload: { event: string; data: Record<string, unknown> }) => void
}

/**
 * Send a chat message and stream SSE events from the Relo gateway.
 * Returns a promise that resolves when the stream ends.
 */
export async function streamChat(
  sessionId: string,
  body: {
    message: string
    model?: string
    system_message?: string
    attachments?: Array<Record<string, unknown>>
  },
  opts: StreamChatOptions,
): Promise<void> {
  const res = await fetch(
    `${RELO_API}/api/sessions/${sessionId}/chat/stream`,
    {
      method: 'POST',
      headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    },
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Relo chat stream: ${res.status} ${text}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        const dataStr = line.slice(6)
        if (dataStr === '[DONE]') continue
        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>
          opts.onEvent({ event: currentEvent || 'message', data })
        } catch {
          // skip malformed JSON
        }
      }
    }
  }
}

/** Non-streaming chat */
export async function sendChat(
  sessionId: string,
  messageOrOpts: string | { message: string; model?: string },
  model?: string,
): Promise<Record<string, unknown>> {
  const msg =
    typeof messageOrOpts === 'string' ? messageOrOpts : messageOrOpts.message
  const mdl = typeof messageOrOpts === 'string' ? model : messageOrOpts.model
  return reloPost(`/api/sessions/${sessionId}/chat`, {
    message: msg,
    model: mdl,
  })
}

// ── Memory ───────────────────────────────────────────────────────

export async function getMemory(): Promise<unknown> {
  return reloGet('/api/memory')
}

// ── Skills ───────────────────────────────────────────────────────

export async function listSkills(): Promise<unknown> {
  return reloGet('/api/skills')
}

export async function getSkill(name: string): Promise<unknown> {
  return reloGet(`/api/skills/${encodeURIComponent(name)}`)
}

export async function getSkillCategories(): Promise<unknown> {
  return reloGet('/api/skills/categories')
}

// ── Config ───────────────────────────────────────────────────────

export async function getConfig(): Promise<ReloConfig> {
  return reloGet<ReloConfig>('/api/config')
}

export async function patchConfig(
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return reloPatch<Record<string, unknown>>('/api/config', patch)
}

// ── Models ───────────────────────────────────────────────────────

export async function listModels(): Promise<{
  object: string
  data: Array<{ id: string; object: string }>
}> {
  return reloGet('/v1/models')
}

// ── Connection check ─────────────────────────────────────────────

export async function isReloAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${RELO_API}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      await probeGateway({ force: true })
      return false
    }
    await probeGateway({ force: true })
    return true
  } catch {
    await probeGateway({ force: true }).catch(() => undefined)
    return false
  }
}

export {
  ensureGatewayProbed,
  getCapabilities as getGatewayCapabilities,
  RELO_API,
  SESSIONS_API_UNAVAILABLE_MESSAGE,
}
