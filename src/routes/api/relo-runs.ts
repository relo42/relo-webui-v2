/**
 * Runs API proxy — forwards POST /v1/runs to Hermes gateway.
 * Returns { run_id, status: "started" } immediately (202).
 */
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  RELO_API,
  ensureGatewayProbed,
  getCapabilities,
} from '../../server/gateway-capabilities'

export const Route = createFileRoute('/api/relo-runs')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().jobs) {
          return new Response(
            JSON.stringify({ error: 'Runs API not available — gateway not connected' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const body = await request.text()
        const res = await fetch(`${RELO_API}/v1/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        return new Response(await res.text(), {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})
