// FENCED (founder P0 2026-11-23, round 2). This handler moved failed rows back
// to 'queued' with the service role, guarded only by NEXUS_ALLOW_BACKEND_MUTATION.
// A row that was ever 'failed' is historical: it goes out only after a signed,
// per-row owner release (POST /api/cockpit/queue/owner-release, apps/api).
// See api/_lib/queueRouteFence.ts. The previous implementation is in git history.
import { fencedQueueHandler } from '../../_lib/queueRouteFence'

export default fencedQueueHandler('retry-failed')
