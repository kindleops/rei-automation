// ─── resolve-scheduled-thread-state.js ───────────────────────────────────────
// Canonical authority for the Inbox "Scheduled" state.
//
// THE ONE RULE
//   A conversation is Scheduled because a real send_queue row for it is still
//   going to run in the future. There is no is_scheduled boolean and there must
//   not be one: send_queue already holds the truth, and a mirrored flag would
//   drift the moment a row is cancelled, sent, or superseded by a seller reply.
//
// WHY THIS IS A SEPARATE LAYER FROM inbox_bucket
//   Scheduled is an OPERATOR ATTENTION state, not a lead-truth state. A hot
//   priority lead whose next touch is already booked is still a hot priority
//   lead -- it just is not something the operator has to act on right now. So
//   this module never rewrites inbox_bucket; callers use it to withhold a
//   thread from the actionable lists while its underlying lifecycle,
//   temperature and priority stay exactly as they were.
//
// SELLER REPLY WINS
//   Scheduling is an assumption about a silent seller. The moment the seller
//   speaks after we booked the follow-up, that assumption is void and the
//   thread is actionable again -- even in the window before the cancellation
//   policy has retired the queue row.

import { parseTimestampMs } from "@/lib/domain/inbox/resolve-waiting-cold-state.js";

/**
 * Queue statuses that still mean "this is going to happen". Anything else --
 * sent, delivered, failed, cancelled, expired, blocked -- is history, and
 * history must never hold a thread out of the actionable Inbox.
 *
 * Kept identical to list-scheduled-followups.js so the Scheduled list and the
 * Scheduled bucket can never disagree about what pending means.
 */
export const PENDING_QUEUE_STATUSES = Object.freeze([
  "scheduled",
  "queued",
  "pending",
  "approved",
  "ready",
]);

const PENDING_STATUS_SET = new Set(PENDING_QUEUE_STATUSES);

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * The effective instant the seller would receive this message.
 *
 * The fallback order matches normalizeSendQueueRow's due-time gate, so the time
 * the Inbox SHOWS and the time the dispatcher ACTS ON are read from the same
 * chain. scheduled_for_local is last and is safe to read because it is stored
 * as a true instant, not a naive wall clock.
 */
export function resolveEffectiveSendAtMs(row = {}) {
  return (
    parseTimestampMs(row.scheduled_for) ||
    parseTimestampMs(row.scheduled_for_utc) ||
    parseTimestampMs(row.scheduled_for_local) ||
    null
  );
}

export function isPendingQueueStatus(status) {
  return PENDING_STATUS_SET.has(clean(status).toLowerCase());
}

/**
 * Collapse many queue rows into ONE entry per thread.
 *
 * A thread with three future follow-ups is still one conversation and must
 * occupy one row in the Inbox. The thread's Scheduled time is the NEAREST
 * future runnable action, because that is the next thing that will actually
 * happen to the seller.
 */
export function buildScheduledThreadIndex(queueRows = [], nowMs = Date.now()) {
  const index = new Map();

  for (const row of queueRows || []) {
    const threadKey = clean(row?.thread_key);
    if (!threadKey) continue;
    if (!isPendingQueueStatus(row?.queue_status)) continue;

    const sendAtMs = resolveEffectiveSendAtMs(row);
    // A pending row with no resolvable time is NOT scheduled. Treating it as
    // scheduled would hide the thread behind a time we cannot show.
    if (!sendAtMs || sendAtMs <= nowMs) continue;

    const createdAtMs = parseTimestampMs(row?.created_at) || 0;
    const existing = index.get(threadKey);

    if (!existing) {
      index.set(threadKey, {
        thread_key: threadKey,
        next_send_at_ms: sendAtMs,
        next_send_at_utc: new Date(sendAtMs).toISOString(),
        scheduled_for_local: row?.scheduled_for_local || null,
        timezone: clean(row?.timezone) || null,
        local_send_hour: Number.isFinite(Number(row?.local_send_hour)) ? Number(row.local_send_hour) : null,
        local_send_date: row?.local_send_date || null,
        next_queue_row_id: row?.id || row?.queue_id || null,
        pending_count: 1,
        // Newest scheduling decision for the thread. A seller message after
        // THIS is what voids the assumption, so it is a max, not the nearest
        // row's own created_at.
        latest_scheduled_created_at_ms: createdAtMs,
      });
      continue;
    }

    existing.pending_count += 1;
    existing.latest_scheduled_created_at_ms = Math.max(
      existing.latest_scheduled_created_at_ms,
      createdAtMs,
    );
    if (sendAtMs < existing.next_send_at_ms) {
      existing.next_send_at_ms = sendAtMs;
      existing.next_send_at_utc = new Date(sendAtMs).toISOString();
      existing.scheduled_for_local = row?.scheduled_for_local || null;
      existing.timezone = clean(row?.timezone) || null;
      existing.local_send_hour = Number.isFinite(Number(row?.local_send_hour)) ? Number(row.local_send_hour) : null;
      existing.local_send_date = row?.local_send_date || null;
      existing.next_queue_row_id = row?.id || row?.queue_id || null;
    }
  }

  return index;
}

/**
 * The newest seller-originated event on the thread. Only INBOUND counts: our
 * own outbound activity is not new information and must not cancel a schedule.
 */
export function latestSellerEventMs(threadRow = {}) {
  return (
    parseTimestampMs(threadRow.last_inbound_at) ||
    parseTimestampMs(threadRow.lastInboundAt) ||
    parseTimestampMs(threadRow.last_seller_response_at) ||
    null
  );
}

/**
 * Should this thread be withheld from the actionable Inbox?
 *
 * True only when there is a real future runnable queue row AND the seller has
 * not spoken since it was booked. Everything else -- no entry, a past time, a
 * fresh inbound -- leaves the thread actionable, which is the safe direction:
 * an operator seeing one extra conversation is recoverable, a seller reply
 * silently parked behind a schedule is not.
 */
export function isScheduleSuppressed(threadRow = {}, entry = null, nowMs = Date.now()) {
  if (!entry) return false;
  if (!entry.next_send_at_ms || entry.next_send_at_ms <= nowMs) return false;

  const sellerMs = latestSellerEventMs(threadRow);
  if (sellerMs && sellerMs > (entry.latest_scheduled_created_at_ms || 0)) return false;

  return true;
}

/**
 * Fields merged onto a thread row so every downstream consumer -- counts, list
 * filters, the client bucket resolver, the list item -- reads ONE derived
 * truth instead of each re-deriving it from queue rows.
 */
export function applyScheduledThreadFields(threadRow = {}, entry = null, nowMs = Date.now()) {
  const suppressed = isScheduleSuppressed(threadRow, entry, nowMs);
  return {
    ...threadRow,
    next_scheduled_send_at_utc: entry?.next_send_at_utc ?? null,
    next_scheduled_send_local: entry?.scheduled_for_local ?? null,
    next_scheduled_timezone: entry?.timezone ?? null,
    next_scheduled_queue_row_id: entry?.next_queue_row_id ?? null,
    scheduled_pending_count: entry?.pending_count ?? 0,
    // The single flag every consumer branches on.
    is_schedule_suppressed: suppressed,
  };
}

export default {
  PENDING_QUEUE_STATUSES,
  resolveEffectiveSendAtMs,
  isPendingQueueStatus,
  buildScheduledThreadIndex,
  latestSellerEventMs,
  isScheduleSuppressed,
  applyScheduledThreadFields,
};
