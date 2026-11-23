// FENCED (founder P0 2026-11-23, round 2). This handler inserted reply rows
// into send_queue with the service role, outside the backend's enqueue
// restrictions. Replies are written by apps/api and judged by the final
// dispatch gate. See api/_lib/queueRouteFence.ts; the old code is in git history.
import { fencedQueueHandler } from '../../_lib/queueRouteFence'

export default fencedQueueHandler('build-replies')
