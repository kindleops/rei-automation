/**
 * THE LIVE QUEUE, SUMMARISED — is a campaign's queued work moving?
 *
 * Pure and dependency-free: the campaign list (every campaign, from rows it
 * already reads) and the cockpit (one campaign) summarise a campaign's active
 * send_queue rows the same way, without a query of their own and without an
 * import cycle through the campaign service.
 *
 * Nothing here decides anything. A row is "due" when its scheduled time has
 * passed and "overdue" when it passed more than OVERDUE_GRACE_MS ago and the
 * row is still sitting in the queue — the processor runs every minute, so work
 * a quarter-hour past its time has not been picked up, whatever the reason.
 */

/** The feeder's own "still in the queue" set (run-campaign-outbound-feeder.js). */
export const ACTIVE_QUEUE_STATUSES = Object.freeze(['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending'])

/** A due row this much past its time without going out is overdue, not merely due. */
export const OVERDUE_GRACE_MS = 15 * 60 * 1000

const clean = (value) => String(value ?? '').trim()
const truthy = (value) => ['true', '1', 'yes', 'on'].includes(clean(value).toLowerCase())

/**
 * The feeder's proof test, verbatim (countActiveLiveQueueRows): `no_send ??
 * proof_no_send`, or the proof launch mode. Reads the projected scalar columns
 * (`no_send:metadata->>no_send`), falling back to a metadata object.
 */
export function isProofQueueRow(row = {}) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const noSend = row.no_send !== undefined ? row.no_send : meta.no_send
  const proofNoSend = row.proof_no_send !== undefined ? row.proof_no_send : meta.proof_no_send
  const launchMode = row.launch_mode !== undefined ? row.launch_mode : meta.launch_mode
  const flag = noSend ?? proofNoSend
  return truthy(flag) || clean(launchMode) === 'proof_hydration_no_send'
}

/** The live queue for one campaign, summarised. Proof rows are counted apart. */
export function summarizeActiveQueue(rows = [], nowMs = Date.now()) {
  const byStatus = {}
  const releaseReasons = {}
  const bySender = {}
  let live = 0
  let proof = 0
  let due = 0
  let overdue = 0
  let processing = 0
  let spamRetries = 0
  let oldestDue = null
  let nextScheduled = null
  let latestScheduled = null
  let lastClaimed = null
  let lastReleased = null
  let lastReleaseReason = null
  for (const row of rows) {
    if (isProofQueueRow(row)) { proof += 1; continue }
    live += 1
    // When the processor last picked a row up, and last put one back — from
    // the row's own metadata (processing_started_at / finalized_at).
    const claimedAt = Date.parse(clean(row.processing_started_at))
    if (Number.isFinite(claimedAt) && (lastClaimed === null || claimedAt > lastClaimed)) lastClaimed = claimedAt
    const releasedAt = Date.parse(clean(row.finalized_at))
    if (Number.isFinite(releasedAt) && clean(row.skip_reason) && (lastReleased === null || releasedAt > lastReleased)) {
      lastReleased = releasedAt
      lastReleaseReason = clean(row.skip_reason)
    }
    const status = clean(row.queue_status) || 'unknown'
    byStatus[status] = (byStatus[status] || 0) + 1
    if (status === 'processing' || status === 'sending') processing += 1
    const reason = clean(row.skip_reason)
    if (reason) releaseReasons[reason] = (releaseReasons[reason] || 0) + 1
    if (Number(row.spam_retry_generation) > 0) spamRetries += 1
    const sender = clean(row.from_phone_number)
    if (sender) bySender[sender] = (bySender[sender] || 0) + 1
    const at = Date.parse(clean(row.scheduled_for))
    if (!Number.isFinite(at)) continue
    if (at <= nowMs) {
      due += 1
      if (at <= nowMs - OVERDUE_GRACE_MS) overdue += 1
      if (oldestDue === null || at < oldestDue) oldestDue = at
    } else if (nextScheduled === null || at < nextScheduled) {
      nextScheduled = at
    }
    if (latestScheduled === null || at > latestScheduled) latestScheduled = at
  }
  const toIso = (t) => (t === null ? null : new Date(t).toISOString())
  return {
    live,
    proof,
    by_status: byStatus,
    due,
    overdue,
    processing,
    spam_retries: spamRetries,
    oldest_due_at: toIso(oldestDue),
    next_scheduled_at: toIso(nextScheduled),
    latest_scheduled_at: toIso(latestScheduled),
    release_reasons: releaseReasons,
    by_sender: bySender,
    last_claimed_at: toIso(lastClaimed),
    last_released_at: toIso(lastReleased),
    last_release_reason: lastReleaseReason,
  }
}

/** The compact form the campaign LIST carries per campaign. */
export function compactLiveQueue(rows = [], nowMs = Date.now()) {
  const q = summarizeActiveQueue(rows, nowMs)
  return {
    live: q.live,
    due: q.due,
    overdue: q.overdue,
    oldest_due_at: q.oldest_due_at,
    next_scheduled_at: q.next_scheduled_at,
    release_reasons: q.release_reasons,
    last_claimed_at: q.last_claimed_at,
    last_released_at: q.last_released_at,
    last_release_reason: q.last_release_reason,
  }
}
