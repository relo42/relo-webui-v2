import { createFileRoute } from '@tanstack/react-router'
import {
  RELO_API,
  ensureGatewayProbed,
} from '../../server/gateway-capabilities'
import { requireLocalOrAuth } from '../../server/auth-middleware'

type PingResponse = {
  ok: boolean
  error?: string
  status?: number
  reloUrl: string
}

export const Route = createFileRoute('/api/ping')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!requireLocalOrAuth(request)) {
          return Response.json(
            {
              ok: false,
              error: 'Authentication required',
              status: 401,
              reloUrl: RELO_API,
            } satisfies PingResponse,
            { status: 401 },
          )
        }

        const caps = await ensureGatewayProbed()
        if (!caps.health) {
          return Response.json(
            {
              ok: false,
              error: 'Relo Gateway unavailable',
              status: 503,
              reloUrl: RELO_API,
            } satisfies PingResponse,
            { status: 503 },
          )
        }

        return Response.json(
          {
            ok: true,
            status: 200,
            reloUrl: RELO_API,
          } satisfies PingResponse,
          { status: 200 },
        )
      },
    },
  },
})
