import { getRecords } from '@/lib/domain/analytics/lab/lab-service.js'
import { handle, jsonParam, options } from '../_lab-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const OPTIONS = options
export async function GET(request) {
  return handle(request, async ({ ctx, url }) => getRecords(ctx, jsonParam(url, 'cohort'), {
    page: Number(url.searchParams.get('page') || 1),
    pageSize: Number(url.searchParams.get('pageSize') || 50),
    sort: url.searchParams.get('sort') || null,
    dir: url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
  }))
}
