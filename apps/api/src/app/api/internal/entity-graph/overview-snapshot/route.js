/**
 * POST /api/internal/entity-graph/overview-snapshot  (cron auth)
 *
 * Rewrites the Overview snapshot — every scope's UNFILTERED universe
 * (properties, owners, people, contacts, buyers, companies) — into
 * public.eg_overview_snapshot (entity-graph-overview-service.js
 * writeOverviewSnapshots). The live Overview never scans a universe; it reads
 * these rows ("computing" until they exist).
 *
 * INERT until the owner applies PROPOSED_20261009190000_eg_overview_snapshot.sql
 * AND sets EG_OVERVIEW_SNAPSHOT_ENABLED=true; until then it answers ok:false +
 * skipped. Proposed cadence (D8): once after the morning read-model refresh
 * (09:17 UTC) and after property imports — never inside 11:15–14:30 UTC. Not
 * registered in the Worker's cron table; separate from the property facts
 * refresh (owned by the sort / facts release).
 */
import { NextResponse } from 'next/server'

import { child } from '@/lib/logging/logger.js'
import { requireCronAuth } from '@/lib/security/cron-auth.js'
import { writeOverviewSnapshots } from '@/lib/domain/entity-graph/entity-graph-overview-service.js'
import { getPgPool } from '@/lib/postgres/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const logger = child({ module: 'api.internal.entity-graph.overview-snapshot' })

async function handle(request) {
  const auth = requireCronAuth(request, logger)
  if (!auth.authorized) return auth.response
  const tabs = (new URL(request.url).searchParams.get('tabs') || '').split(',').map((t) => t.trim()).filter(Boolean)
  try {
    const result = await writeOverviewSnapshots({ pool: getPgPool(), ...(tabs.length ? { tabs } : {}) })
    logger.info('eg_overview_snapshot.completed', result)
    return NextResponse.json({ route: 'internal/entity-graph/overview-snapshot', ...result }, { status: 200 })
  } catch (error) {
    const message = error?.message || String(error)
    logger.error('eg_overview_snapshot.exception', { error: message })
    return NextResponse.json({ ok: false, error: 'eg_overview_snapshot_exception', message }, { status: 500 })
  }
}

export async function POST(request) {
  return handle(request)
}
