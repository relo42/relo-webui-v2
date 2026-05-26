/**
 * Probes the Relo gateway to detect which API groups are available.
 * Results are cached and refreshed periodically so route handlers can
 * degrade cleanly against older gateways.
 *
 * Two-tier capability model:
 *   - Core: portable chat readiness (health, chat completions, models)
 *   - Enhanced: Relo-native extras (sessions, skills, memory, config, jobs)
 */

// RELO_API_URL takes precedence; HERMES_API_URL kept as fallback for backward compat
export let RELO_API =
  process.env.RELO_API_URL ||
  process.env.HERMES_API_URL ||
  'http://127.0.0.1:8642'

export const RELO_UPGRADE_INSTRUCTIONS =
  'Update Relo Agent and restart the relo-gateway systemd service.'

export const SESSIONS_API_UNAVAILABLE_MESSAGE = `Your Relo gateway does not support the sessions API. ${RELO_UPGRADE_INSTRUCTIONS}`

const PROBE_TIMEOUT_MS = 3_000
const PROBE_TTL_MS = 120_000

// ── Types ─────────────────────────────────────────────────────────

export type CoreCapabilities = {
  health: boolean
  chatCompletions: boolean
  models: boolean
  streaming: boolean
  probed: boolean
}

export type EnhancedCapabilities = {
  sessions: boolean
  enhancedChat: boolean
  skills: boolean
  memory: boolean
  config: boolean
  jobs: boolean
}

/** Full capabilities — backward compat with existing code */
export type GatewayCapabilities = CoreCapabilities & EnhancedCapabilities

export type ChatMode = 'enhanced-relo' | 'portable' | 'disconnected'

export type ConnectionStatus =
  | 'connected'
  | 'enhanced'
  | 'partial'
  | 'disconnected'

// ── State ─────────────────────────────────────────────────────────

let capabilities: GatewayCapabilities = {
  health: false,
  chatCompletions: false,
  models: false,
  streaming: false,
  sessions: false,
  enhancedChat: false,
  skills: false,
  memory: false,
  config: false,
  jobs: false,
  probed: false,
}

let probePromise: Promise<GatewayCapabilities> | null = null
let lastProbeAt = 0
let lastLoggedSummary = ''

/** Optional bearer token for authenticated endpoints. */
export const BEARER_TOKEN =
  process.env.RELO_API_TOKEN || process.env.HERMES_API_TOKEN || ''

function authHeaders(): Record<string, string> {
  return BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
}

// ── Probing ───────────────────────────────────────────────────────

async function probe(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${RELO_API}${path}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    // 404 = endpoint doesn't exist.
    // 403 = likely a catch-all rejection.
    // Only 2xx, 400, 405, 422 reliably indicate the endpoint exists.
    if (res.status === 404 || res.status === 403) return false
    return true
  } catch {
    return false
  }
}

/** Probe /v1/chat/completions to check if the endpoint exists.
 *  First tries a lightweight GET (405 = endpoint exists, just wrong method).
 *  This avoids creating real sessions on the gateway. */
async function probeChatCompletions(): Promise<boolean> {
  try {
    const getRes = await fetch(`${RELO_API}/v1/chat/completions`, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (getRes.status === 405) return true
    if (getRes.ok) return true
    if (getRes.status === 400 || getRes.status === 422) return true
    if (getRes.status === 404) return false
    return true
  } catch {
    return false
  }
}

const OPTIONAL_APIS = new Set(['jobs', 'chatCompletions', 'streaming'])

function logCapabilities(next: GatewayCapabilities): void {
  const core: Array<string> = []
  const enhanced: Array<string> = []
  const missing: Array<string> = []

  const coreKeys: Array<keyof CoreCapabilities> = [
    'health',
    'chatCompletions',
    'models',
    'streaming',
  ]
  const enhancedKeys: Array<keyof EnhancedCapabilities> = [
    'sessions',
    'enhancedChat',
    'skills',
    'memory',
    'config',
    'jobs',
  ]

  for (const key of coreKeys) {
    if (key === 'probed') continue
    ;(next[key] ? core : missing).push(key)
  }
  for (const key of enhancedKeys) {
    ;(next[key] ? enhanced : missing).push(key)
  }

  const mode = getChatMode()
  const summary = `[gateway] ${RELO_API} mode=${mode} core=[${core.join(', ')}] enhanced=[${enhanced.join(', ')}] missing=[${missing.join(', ')}]`
  if (summary === lastLoggedSummary) return
  lastLoggedSummary = summary
  console.log(summary)

  const criticalMissing = missing.filter((key) => !OPTIONAL_APIS.has(key))
  if (criticalMissing.length > 0 && next.health) {
    console.warn(
      `[gateway] Missing Relo APIs detected. ${RELO_UPGRADE_INSTRUCTIONS}`,
    )
  }
}

export async function probeGateway(options?: {
  force?: boolean
}): Promise<GatewayCapabilities> {
  const force = options?.force === true
  if (!force && capabilities.probed) {
    return capabilities
  }
  if (probePromise) {
    return probePromise
  }

  probePromise = (async () => {
    // Auto-detect port if no explicit env var set
    if (!process.env.RELO_API_URL && !process.env.HERMES_API_URL) {
      const healthOn8642 = await probe('/health')
      if (!healthOn8642) {
        const fallback = 'http://127.0.0.1:8643'
        const healthOn8643 = await fetch(`${fallback}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
          .then((r) => r.ok)
          .catch(() => false)
        if (healthOn8643) {
          RELO_API = fallback
          console.log(`[gateway] Connected to Relo at ${RELO_API}`)
        } else {
          console.warn('[gateway] Could not reach Relo on 8642 or 8643')
        }
      } else {
        console.log(`[gateway] Connected to Relo at ${RELO_API}`)
      }
    }

    const [
      health,
      chatCompletions,
      models,
      sessions,
      enhancedChat,
      skills,
      memory,
      config,
      jobs,
    ] = await Promise.all([
      probe('/health'),
      probeChatCompletions(),
      probe('/v1/models'),
      probe('/api/sessions'),
      probe('/api/sessions/__probe__/chat/stream'),
      probe('/api/skills'),
      probe('/api/memory'),
      probe('/api/config'),
      probe('/api/jobs'),
    ])

    capabilities = {
      health,
      chatCompletions,
      models,
      streaming: chatCompletions,
      probed: true,
      sessions,
      enhancedChat,
      skills,
      memory,
      config,
      jobs,
    }
    lastProbeAt = Date.now()
    logCapabilities(capabilities)
    return capabilities
  })()

  try {
    return await probePromise
  } finally {
    probePromise = null
  }
}

export async function ensureGatewayProbed(): Promise<GatewayCapabilities> {
  const isStale = Date.now() - lastProbeAt > PROBE_TTL_MS
  if (!capabilities.probed || isStale) {
    return probeGateway({ force: isStale })
  }
  return capabilities
}

// ── Accessors ─────────────────────────────────────────────────────

/** Full capabilities — backward compatible */
export function getCapabilities(): GatewayCapabilities {
  return capabilities
}

/** Core portable capabilities only */
export function getCoreCapabilities(): CoreCapabilities {
  return {
    health: capabilities.health,
    chatCompletions: capabilities.chatCompletions,
    models: capabilities.models,
    streaming: capabilities.streaming,
    probed: capabilities.probed,
  }
}

/** Relo-native enhanced capabilities only */
export function getEnhancedCapabilities(): EnhancedCapabilities {
  return {
    sessions: capabilities.sessions,
    enhancedChat: capabilities.enhancedChat,
    skills: capabilities.skills,
    memory: capabilities.memory,
    config: capabilities.config,
    jobs: capabilities.jobs,
  }
}

/**
 * Current chat transport mode:
 * - 'enhanced-relo': full Relo session API available
 * - 'portable': OpenAI-compatible /v1/chat/completions available
 * - 'disconnected': no usable chat backend
 */
export function getChatMode(): ChatMode {
  if (capabilities.sessions && capabilities.enhancedChat)
    return 'enhanced-relo'
  if (capabilities.chatCompletions || capabilities.health) return 'portable'
  return 'disconnected'
}

/**
 * Connection status for UI display:
 * - 'enhanced': full Relo APIs detected
 * - 'connected': chat works
 * - 'partial': chat works, some advanced features unavailable
 * - 'disconnected': no backend
 */
export function getConnectionStatus(): ConnectionStatus {
  if (!capabilities.health && !capabilities.chatCompletions)
    return 'disconnected'
  const enhanced =
    capabilities.sessions &&
    capabilities.enhancedChat &&
    capabilities.skills &&
    capabilities.memory &&
    capabilities.config
  if (enhanced) return 'enhanced'
  if (capabilities.chatCompletions || capabilities.sessions) return 'partial'
  return 'connected'
}

export function isReloConnected(): boolean {
  return capabilities.health
}

void ensureGatewayProbed()
