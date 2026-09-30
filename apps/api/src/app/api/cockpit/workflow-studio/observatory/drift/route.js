/** Internal: unmapped ledger keys + topology drift per system workflow. */
import { getDrift } from '@/lib/domain/workflow-studio/observatory/service.js'
import { optionsResponse, read } from '../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) { return read(request, (p) => getDrift({ days: p.days }), 'observatory_drift_failed') }
