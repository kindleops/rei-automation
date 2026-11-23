// FENCED (founder P0 2026-11-23, round 2). This handler ran the dashboard's
// own queue runner (runner.ts) outside the final dispatch gate. The only queue
// runner is POST /api/internal/queue/run (apps/api).
// See api/_lib/queueRouteFence.ts; the old code is in git history.
import { fencedQueueHandler } from '../../_lib/queueRouteFence'

export default fencedQueueHandler('run-safe-batch')
