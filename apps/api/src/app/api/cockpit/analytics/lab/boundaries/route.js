/**
 * GET /api/cockpit/analytics/lab/boundaries?zips=55411,55412 — ZIP outlines for
 * the Lab heat map (read-only, ≤ 400 ZIPs). Answers { available: false } until
 * public.analytics_zip_boundaries exists; never fails the map.
 */
import { readZipBoundaries } from '@/lib/domain/analytics/lab/zip-boundaries.js'
import { handle, options } from '../_lab-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const OPTIONS = options
export async function GET(request) {
  return handle(request, async ({ url }) => readZipBoundaries(url.searchParams.get('zips') || ''), { needsContext: false })
}
