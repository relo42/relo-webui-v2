import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const RELO_HEALTH_TIMEOUT_MS = 2_000
const RELO_GATEWAY_PORT = 8642

export type StartReloAgentResult =
  | {
      ok: true
      message: string
    }
  | {
      ok: false
      error: string
    }

/**
 * Read ~/.relo/relo-agent/auth.json and return parsed config.
 * Silently returns {} if the file doesn't exist or can't be parsed.
 */
export function readReloConfig(): Record<string, unknown> {
  const authPath = join(homedir(), '.relo', 'relo-agent', 'auth.json')
  try {
    const raw = readFileSync(authPath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed
  } catch {
    return {}
  }
}

/** Read the webui auth token from auth.json. */
export function readReloAuthToken(): string {
  const config = readReloConfig()
  const token = config.webui_token
  return typeof token === 'string' ? token : ''
}

/** Return the canonical Relo Agent install directory. */
export function resolveReloAgentDir(): string {
  return join(homedir(), '.relo', 'relo-agent')
}

export async function isReloGatewayHealthy(
  port = RELO_GATEWAY_PORT,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(RELO_HEALTH_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Report whether the Relo gateway is reachable.
 *
 * The Relo gateway runs as a separate systemd service — this webui does NOT
 * spawn or manage it. This function only reports current reachability.
 */
export async function startReloAgent(): Promise<StartReloAgentResult> {
  if (await isReloGatewayHealthy()) {
    return { ok: true, message: 'relo_gateway_reachable' }
  }
  return {
    ok: false,
    error:
      'Relo gateway not reachable on http://127.0.0.1:8642. Ensure the systemd service is running.',
  }
}
