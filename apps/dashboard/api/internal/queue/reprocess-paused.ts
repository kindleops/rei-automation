// FENCED (founder P0 2026-11-23, round 2). This handler moved
// paused_invalid_queue_row rows back to 'queued' with the service role and had
// no authentication. A paused row is historical: it goes out only after a
// signed, per-row owner release (POST /api/cockpit/queue/owner-release, apps/api).
// See api/_lib/queueRouteFence.ts. The previous implementation is in git history.
import { fencedQueueHandler } from '../../_lib/queueRouteFence'

export default fencedQueueHandler('reprocess-paused')
