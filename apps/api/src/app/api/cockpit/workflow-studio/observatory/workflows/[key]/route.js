/** One workflow: stable topology + period telemetry per node and edge. */
import { getWorkflow } from '@/lib/domain/workflow-studio/observatory/service.js'
import { optionsResponse, read } from '../../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request, ctx) {
  const { key } = await ctx.params
  return read(request, (p) => getWorkflow(key, { period: p.period }), 'observatory_workflow_failed')
}
