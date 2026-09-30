import { getOverview } from '@/lib/domain/analytics/lab/lab-service.js'
import { handle, options } from '../_lab-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const OPTIONS = options
export async function GET(request) {
  return handle(request, async ({ ctx }) => getOverview(ctx))
}
