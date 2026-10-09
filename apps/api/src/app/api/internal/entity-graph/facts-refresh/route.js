/**
 * POST /api/internal/entity-graph/facts-refresh?mode=incremental|full  (cron auth)
 *
 * Refreshes the PROPOSED public.eg_property_facts read model
 * (entity-graph-facts-refresh.js). INERT until the owner applies
 * PROPOSED_20261009180000_eg_property_facts.sql AND sets
 * EG_FACTS_REFRESH_ENABLED=true; until then it answers ok:false + skipped.
 * Not registered in the Worker's cron table (infra/cloudflare/worker/index.ts):
 * the proposed registration is in the migration's header.
 */
import { NextResponse } from 'next/server'

import { child } from '@/lib/logging/logger.js'
import { requireCronAuth } from '@/lib/security/cron-auth.js'
import { refreshPropertyFacts } from '@/lib/domain/entity-graph/entity-graph-facts-refresh.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const logger = child({ module: 'api.internal.entity-graph.facts-refresh' })

async function handle(request) {
  const auth = requireCronAuth(request, logger)
  if (!auth.authorized) return auth.response
  const mode = new URL(request.url).searchParams.get('mode') === 'full' ? 'full' : 'incremental'
  try {
    const result = await refreshPropertyFacts({ mode, log: (d) => logger.info('eg_facts_refresh.progress', d) })
    logger.info('eg_facts_refresh.completed', { mode, ...result })
    return NextResponse.json({ route: 'internal/entity-graph/facts-refresh', ...result }, { status: 200 })
  } catch (error) {
    const message = error?.message || String(error)
    logger.error('eg_facts_refresh.exception', { mode, error: message })
    return NextResponse.json({ ok: false, error: 'eg_facts_refresh_exception', message }, { status: 500 })
  }
}

export async function POST(request) {
  return handle(request)
}
