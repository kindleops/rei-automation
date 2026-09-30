/** One run: path, why, facts, decisions, structured AI output, timeline, links, trace. */
import { getRun } from '@/lib/domain/workflow-studio/observatory/service.js'
import { optionsResponse, read } from '../../../../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request, ctx) {
  const { key, run_id } = await ctx.params
  return read(request, () => getRun(key, run_id), 'observatory_run_failed')
}
