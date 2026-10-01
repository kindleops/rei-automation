/** Run ledger for one workflow (paginated, filtered; runtime-supported statuses only). */
import { listRuns } from '@/lib/domain/workflow-studio/observatory/service.js'
import { optionsResponse, read } from '../../../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request, ctx) {
  const { key } = await ctx.params
  return read(request, (p) => listRuns(key, { period: p.period, status: p.status || null, q: p.q || '', cursor: p.cursor || null, limit: p.limit, node: p.node || null, reason: p.reason || null, version: p.version || null, from: p.from || null, to: p.to || null, human: p.human === '1', edge: p.edge || null }), 'observatory_runs_failed')
}
