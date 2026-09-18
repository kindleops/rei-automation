import type { QueueModel } from '../../domain/queue/queue.types'
import { fetchQueueModel } from '../../lib/data/queueData'
import { shouldUseSupabase } from '../../lib/data/shared'
import { PRODUCTION_TEXTGRID_FLEET } from '../../lib/data/textgridFleet'

/**
 * §42/§44/§46 — AN EMPTY QUEUE, NOT AN INVENTED ONE.
 *
 * This module used to generate ~600 fabricated rows: seller names drawn from
 * FIRST_NAMES/LAST_NAMES, synthetic `+1214555xxxx` destinations, `Math.random()`
 * timestamps, and randomised `safeCapacityRemaining` / `optOutRiskCount` /
 * `apiPressureLevel`. `loadQueue` returned them from a bare `catch`, so ANY
 * failure of the real read — a network blip, an expired token, a bad filter —
 * showed the operator a Queue full of pending sends that do not exist, on the
 * one surface that governs real outbound. The warning was `isDev`-only, so
 * production logged nothing at all.
 *
 * §46 is explicit: no fake queue rows. The read either succeeds or says so.
 *
 * The TextGrid fleet survives because it is real production data
 * (`lib/data/textgridFleet`), and the market directory derived from it is a true
 * statement about sender coverage whatever the queue contains.
 */
export const emptyQueueModel = (): QueueModel => {
  const marketDirectory = PRODUCTION_TEXTGRID_FLEET.reduce<Array<{ market: string; senderCount: number; active: boolean }>>((acc, n) => {
    const existing = acc.find((m) => m.market === n.market)
    if (existing) {
      existing.senderCount++
      if (n.isActive) existing.active = true
    } else {
      acc.push({ market: n.market, senderCount: 1, active: n.isActive })
    }
    return acc
  }, [])

  return {
    items: [],
    readyCount: 0,
    scheduledCount: 0,
    approvalCount: 0,
    failedCount: 0,
    retryCount: 0,
    heldCount: 0,
    sentTodayCount: 0,
    deliveredTodayCount: 0,
    safeCapacityRemaining: 0,
    optOutRiskCount: 0,
    apiPressureLevel: 'low',
    sendEngine: 'real-estate-automation',
    engineMode: 'proxy',
    marketDirectory,
    textgridFleet: PRODUCTION_TEXTGRID_FLEET,
  }
}


export const loadQueue = async (): Promise<QueueModel> => {
  // No catch. The route loader already renders a truthful error state with the
  // real message (CommandCenterApp routeState 'error'); swallowing the failure
  // here is what let fabricated rows stand in for the operator's real queue.
  if (!shouldUseSupabase()) {
    throw new Error('Queue unavailable: Supabase is not configured for this build.')
  }
  return fetchQueueModel()
}
