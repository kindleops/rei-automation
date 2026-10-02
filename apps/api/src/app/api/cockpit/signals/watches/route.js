/**
 * WATCHLIST — the only operator path to notification_watchlist (service role).
 *   GET                         active watches + supported entity types
 *   POST   { entity_type, entity_id, label?, … }            watch (idempotent)
 *   POST   { action:'toggle', watch_type, watch_key, … }    legacy WatchBell toggle
 *   DELETE ?entity_type=&entity_id=                          unwatch
 */
import { addWatch, listWatches, removeWatch, toggleWatch } from '@/lib/domain/signals/signal-service.js'
import { corsHeaders, parseJsonSafe } from '../../_shared.js'
import { fail, guard, ok } from '../_signal-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const g = guard(request)
  if (g.denied) return g.denied
  try {
    return ok(await listWatches(), g.headers)
  } catch (error) {
    return fail(error, g.headers, 'signals.watches_read_failed')
  }
}

export async function POST(request) {
  const g = guard(request)
  if (g.denied) return g.denied
  try {
    const body = await parseJsonSafe(request)
    const fn = body.action === 'toggle' ? toggleWatch : addWatch
    return ok(await fn(body, { operatorId: g.operatorId }), g.headers)
  } catch (error) {
    return fail(error, g.headers, 'signals.watch_write_failed')
  }
}

export async function DELETE(request) {
  const g = guard(request)
  if (g.denied) return g.denied
  try {
    const q = Object.fromEntries(new URL(request.url).searchParams.entries())
    return ok(await removeWatch(q), g.headers)
  } catch (error) {
    return fail(error, g.headers, 'signals.unwatch_failed')
  }
}
