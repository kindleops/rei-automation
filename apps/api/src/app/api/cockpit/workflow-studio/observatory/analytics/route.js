/** Analytics aggregates for one workflow over a period (every figure drills to runs). */
import { getAnalytics } from '@/lib/domain/workflow-studio/observatory/analytics.js'
import { optionsResponse, read } from '../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) { return read(request, (p) => getAnalytics({ key: p.key || 'seller_inbound', period: p.period || '7d' }), 'observatory_analytics_failed') }
