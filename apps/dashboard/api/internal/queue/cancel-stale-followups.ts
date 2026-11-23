// FENCED (founder P0 2026-11-23, round 2). This handler wrote send_queue with
// the browser Supabase client and no authentication. Use
// POST /api/cockpit/queue/cancel-stale-followups (apps/api).
// See api/_lib/queueRouteFence.ts; the old code is in git history.
import { fencedQueueHandler } from '../../_lib/queueRouteFence'

export default fencedQueueHandler('cancel-stale-followups')
