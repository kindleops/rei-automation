// ─── queueRouteFence.ts ──────────────────────────────────────────────────────
// FOUNDER P0 2026-11-23 (round 2, Sentry task_783e03da blocking item 2).
//
// The dashboard's own api/internal/queue/* handlers wrote send_queue with the
// SERVICE ROLE, guarded only by NEXUS_ALLOW_BACKEND_MUTATION (reprocess-paused
// had no authentication at all). They bypassed the no-reactivation hold, the
// owner release and the final dispatch gate: retry-failed and reprocess-paused
// put failed / paused_invalid_queue_row rows straight back to 'queued'.
//
// WHERE THEY RUN. Production (ops.leadcommand.ai, infra/cloudflare/
// wrangler.production.jsonc) serves apps/dashboard/dist as STATIC ASSETS only
// and sends every /api/* request to the apps/api container, so these files are
// not served there. They ARE built as Vercel serverless functions by any Vercel
// project rooted at apps/dashboard (vercel.json: framework vite, api/ folder),
// and that project's rewrites do not cover /api/internal/queue/*.
//
// NOT NEEDED. Every one has a canonical, gated equivalent in apps/api (queue
// runner, reconcile, Cockpit retry / owner release), and this project's own
// boundary rule already says queue mutations must run from the backend. So each
// handler is FENCED: authenticate (fail closed), then 410 Gone, always, with no
// database client created and nothing written, whatever NEXUS_ALLOW_BACKEND_MUTATION says.
//
// This file starts with '_' inside a '_lib' folder, so Vercel never deploys it
// as a function of its own.

import crypto from 'node:crypto'

export type FenceRequest = {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
}

export type FenceResponse = {
  status: (code: number) => FenceResponse
  json: (body: unknown) => void
}

const header = (req: FenceRequest, name: string): string => {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim()
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** Internal-secret authentication. No configured secret authorizes nobody. */
export function authenticateQueueRoute(req: FenceRequest, env: Record<string, string | undefined> = process.env): { ok: boolean; status: number; reason: string } {
  const secret = String(env.INTERNAL_API_SECRET ?? '').trim()
  if (!secret) return { ok: false, status: 503, reason: 'internal_api_secret_not_configured' }
  const presented = header(req, 'x-internal-api-secret')
  if (!presented) return { ok: false, status: 401, reason: 'missing_internal_api_secret' }
  if (!safeEqual(presented, secret)) return { ok: false, status: 401, reason: 'invalid_internal_api_secret' }
  return { ok: true, status: 200, reason: 'authorized' }
}

/** The canonical backend route that replaces each fenced dashboard handler. */
export const FENCED_QUEUE_ROUTES: Record<string, string> = Object.freeze({
  'build-followups': 'apps/api follow-up schedulers (queue rows are judged by the final dispatch gate)',
  'build-outbound': 'apps/api campaign feeder (/api/internal/campaigns/feed)',
  'build-replies': 'apps/api inbound auto-reply (queue rows are judged by the final dispatch gate)',
  'cancel-stale-followups': 'POST /api/cockpit/queue/cancel-stale-followups (apps/api)',
  reconcile: 'POST /api/internal/queue/reconcile (apps/api; holds, never revives)',
  'reprocess-paused': 'POST /api/cockpit/queue/owner-release (apps/api; signed, per row, logged-in operator)',
  'retry-failed': 'POST /api/cockpit/queue/owner-release (apps/api; a failed row is historical)',
  run: 'POST /api/internal/queue/run (apps/api; final dispatch gate)',
  'run-safe-batch': 'POST /api/internal/queue/run (apps/api; final dispatch gate)',
  runner: 'POST /api/internal/queue/run (apps/api; final dispatch gate)',
})

export function fencedQueueHandler(route: string) {
  return async function handler(req: FenceRequest, res: FenceResponse): Promise<void> {
    const auth = authenticateQueueRoute(req)
    if (!auth.ok) {
      res.status(auth.status).json({ ok: false, error: auth.reason, route: `dashboard/api/internal/queue/${route}` })
      return
    }
    res.status(410).json({
      ok: false,
      error: 'QUEUE_ROUTE_FENCED',
      route: `dashboard/api/internal/queue/${route}`,
      message: 'This dashboard route no longer writes send_queue (founder P0 2026-11-23). Use the backend route.',
      use_instead: FENCED_QUEUE_ROUTES[route] || 'apps/api',
      writes: 0,
    })
  }
}
