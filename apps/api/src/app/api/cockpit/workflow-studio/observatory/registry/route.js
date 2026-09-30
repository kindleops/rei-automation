/** Workflow Observatory registry — every automation with its resolved status and stats. */
import { getRegistry } from '@/lib/domain/workflow-studio/observatory/service.js'
import { optionsResponse, read } from '../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) { return read(request, (p) => getRegistry({ dayStart: p.day_start || null }), 'observatory_registry_failed') }
