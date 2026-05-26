import { URL, fileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

// ---------------------------------------------------------------------------
// Relo Gateway health check (read-only — gateway runs as a separate systemd service)
// ---------------------------------------------------------------------------

async function isReloGatewayHealthy(port = 8642): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return r.ok
  } catch {
    return false
  }
}

const config = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const reloApiUrl =
    env.RELO_API_URL?.trim() ||
    process.env.RELO_API_URL?.trim() ||
    env.HERMES_API_URL?.trim() ||
    process.env.HERMES_API_URL?.trim() ||
    'http://127.0.0.1:8642'
  const reloApiToken =
    env.RELO_API_TOKEN || process.env.RELO_API_TOKEN ||
    env.HERMES_API_TOKEN || process.env.HERMES_API_TOKEN || ''

  // Allow access from Tailscale, LAN, or custom domains via env var
  // e.g. RELO_ALLOWED_HOSTS=my-server.tail1234.ts.net,192.168.1.50
  const allowedHostsRaw =
    env.RELO_ALLOWED_HOSTS?.trim() || env.HERMES_ALLOWED_HOSTS?.trim()
  const _allowedHosts: string[] | true = allowedHostsRaw
    ? allowedHostsRaw
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    : ['.ts.net'] // allow all Tailscale hostnames by default
  let proxyTarget = 'http://127.0.0.1:18789'

  try {
    const parsed = new URL(reloApiUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = ''
    proxyTarget = parsed.toString().replace(/\/$/, '')
  } catch {
    // fallback
  }

  return {
    define: {
      // Client-side process.env is handled per-environment below.
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    ssr: {
      external: [
        'better-sqlite3',
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
    },
    optimizeDeps: {
      exclude: [
        'better-sqlite3',
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
    },
    server: {
      // Force IPv4 — 'localhost' resolves to ::1 (IPv6) on Windows, breaking connectivity
      host: '0.0.0.0',
      port: 3002,
      strictPort: false,
      allowedHosts: true,
      watch: {
        // TanStack Router's file watcher detects its own output as a change → infinite loop
        ignored: ['**/routeTree.gen.ts'],
      },
      proxy: {
        '/api/relo-proxy': {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/relo-proxy/, ''),
        },
      },
    },
    plugins: [
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
      {
        name: 'relo-webui-middleware',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const requestPath = req.url?.split('?')[0]
            if (req.method === 'GET' && requestPath === '/api/healthcheck') {
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
              return
            }

            if (
              req.method === 'GET' &&
              requestPath === '/api/connection-status'
            ) {
              try {
                const [modelsRes, sessionsRes] = await Promise.all([
                  fetch(`${reloApiUrl}/v1/models`, {
                    signal: AbortSignal.timeout(3000),
                  }).catch(() => null),
                  fetch(`${reloApiUrl}/api/sessions?limit=1`, {
                    signal: AbortSignal.timeout(3000),
                  }).catch(() => null),
                ])
                const hasModels = modelsRes?.ok ?? false
                const hasSessions = sessionsRes?.ok ?? false
                if (hasModels && hasSessions) {
                  res.statusCode = 200
                  res.setHeader('content-type', 'application/json')
                  res.end(
                    JSON.stringify({
                      ok: true,
                      mode: 'enhanced',
                      backend: reloApiUrl,
                    }),
                  )
                  return
                }
                if (hasModels) {
                  res.statusCode = 200
                  res.setHeader('content-type', 'application/json')
                  res.end(
                    JSON.stringify({
                      ok: true,
                      mode: 'portable',
                      backend: reloApiUrl,
                    }),
                  )
                  return
                }
                const healthRes = await fetch(`${reloApiUrl}/health`, {
                  signal: AbortSignal.timeout(3000),
                })
                res.statusCode = healthRes.ok ? 200 : 502
                res.setHeader('content-type', 'application/json')
                res.end(
                  JSON.stringify({
                    ok: healthRes.ok,
                    mode: 'enhanced',
                    backend: reloApiUrl,
                  }),
                )
              } catch {
                res.statusCode = 502
                res.setHeader('content-type', 'application/json')
                res.end(
                  JSON.stringify({
                    ok: false,
                    mode: 'disconnected',
                    backend: reloApiUrl,
                  }),
                )
              }
              return
            }

            next()
          })

          // Log Relo Gateway health status at startup (no auto-start)
          void (async () => {
            if (await isReloGatewayHealthy()) {
              console.log(`[relo-webui] Relo gateway reachable at ${reloApiUrl}`)
            } else {
              console.warn(
                `[relo-webui] Relo gateway not reachable at ${reloApiUrl} — ensure the systemd service is running`,
              )
            }
          })()
        },
      },
      // Client-only: replace process.env references in client bundles
      {
        name: 'client-process-env',
        enforce: 'pre',
        transform(code, _id) {
          const envName = this.environment?.name
          if (envName !== 'client') return null
          if (
            !code.includes('process.env') &&
            !code.includes('process.platform')
          )
            return null

          let result = code
          result = result.replace(
            /process\.env\.RELO_API_URL/g,
            JSON.stringify(reloApiUrl),
          )
          result = result.replace(
            /process\.env\.HERMES_API_URL/g,
            JSON.stringify(reloApiUrl),
          )
          result = result.replace(
            /process\.env\.RELO_API_TOKEN/g,
            JSON.stringify(reloApiToken),
          )
          result = result.replace(
            /process\.env\.HERMES_API_TOKEN/g,
            JSON.stringify(reloApiToken),
          )
          result = result.replace(
            /process\.env\.NODE_ENV/g,
            JSON.stringify(mode),
          )
          result = result.replace(/process\.env/g, '{}')
          result = result.replace(/process\.platform/g, '"browser"')
          return result
        },
      },
      // Copy pty-helper.py into the server assets directory after build
      {
        name: 'copy-pty-helper',
        closeBundle() {
          const src = resolve('src/server/pty-helper.py')
          const destDir = resolve('dist/server/assets')
          const dest = resolve(destDir, 'pty-helper.py')
          if (existsSync(src)) {
            mkdirSync(destDir, { recursive: true })
            copyFileSync(src, dest)
          }
        },
      },
    ],
  }
})

export default config
