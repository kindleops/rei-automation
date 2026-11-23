// FENCED (founder P0 2026-11-23, round 2). This handler rewrote send_queue
// statuses with the service role, outside the no-automatic-reactivation hold.
// Use POST /api/internal/queue/reconcile (apps/api), which holds and never revives.
// See api/_lib/queueRouteFence.ts. The previous implementation is in git history.
import { fencedQueueHandler } from '../../_lib/queueRouteFence'

export default fencedQueueHandler('reconcile')
