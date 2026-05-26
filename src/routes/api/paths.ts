import path from 'node:path'
import os from 'node:os'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'

const RELO_HOME =
  process.env.RELO_HOME || path.join(os.homedir(), '.relo', 'relo-agent')

export const Route = createFileRoute('/api/paths')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        return json({
          ok: true,
          reloHome: RELO_HOME,
          memoriesDir: path.join(RELO_HOME, 'memories'),
          skillsDir: path.join(RELO_HOME, 'skills'),
        })
      },
    },
  },
})
