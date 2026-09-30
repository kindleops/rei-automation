/** Meaningful domain events grouped per run (filters: family, human, q). */
import { getActivity } from '@/lib/domain/workflow-studio/observatory/service.js'
import { optionsResponse, read } from '../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) { return read(request, (p) => getActivity({ hours: p.hours, family: p.family || null, human: p.human === '1', q: p.q || '', limit: p.limit }), 'observatory_activity_failed') }
