/** Workflow Observatory system map — real runtime-to-runtime relationships with ledger evidence and window traffic. */
import { getSystemMap } from '@/lib/domain/workflow-studio/observatory/system-map.js'
import { optionsResponse, read } from '../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) { return read(request, (p) => getSystemMap({ window: p.window || '24h' }), 'observatory_system_failed') }
