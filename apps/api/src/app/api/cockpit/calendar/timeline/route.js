/**
 * CALENDAR TIMELINE — read-only projection of every real, time-bearing record
 * (scheduled sends, seller follow-ups, pipeline actions, campaign starts and
 * send windows, closing deadlines, offers) for a bounded date range.
 */
import { NextResponse } from 'next/server.js'
import { getCalendarTimeline } from '@/lib/domain/calendar/calendar-timeline-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ZONE = /^[A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2}$/
const ID = /^[\w:.-]{1,80}$/

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  const url = new URL(request.url)
  const get = (k, re) => { const v = (url.searchParams.get(k) || '').trim(); return v && re.test(v) ? v : null }
  try {
    const data = await getCalendarTimeline({
      from: get('from', DATE),
      to: get('to', DATE),
      tz: get('tz', ZONE),
      propertyId: get('property_id', ID),
    })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    console.error('calendar.timeline_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'calendar_timeline_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
