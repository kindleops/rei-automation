/** Live execution: runs in flight + events since a cursor (polled; cadence stated in the payload). */
import { getLive } from '@/lib/domain/workflow-studio/observatory/service.js'
import { optionsResponse, read } from '../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) { return read(request, (p) => getLive({ since: p.since || null }), 'observatory_live_failed') }
