import {
  WAITING_REPLY_WINDOW_MS,
  isFailedDeliveryStatus,
  isOutboundLastWithoutReply,
  parseTimestampMs,
} from "@/lib/domain/inbox/resolve-waiting-cold-state.js";
import {
  NON_ACTIONABLE_REPLY_INTENTS,
  isNewReplyActionableIntent,
  isPriorityReplyIntent,
  isReopeningReplyIntent,
} from "@/lib/domain/inbox/reply-actionability.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeDirection(value) {
  const normalized = lower(value);
  if (normalized === "in" || normalized === "incoming") return "inbound";
  if (normalized === "out" || normalized === "outgoing") return "outbound";
  return normalized;
}

const CANCELLED_DELIVERY_STATUSES = new Set(["cancelled", "canceled", "cancelled_send", "send_cancelled"]);
const VALID_WAITING_DELIVERY_STATUSES = new Set([
  "",
  "sent",
  "delivered",
  "accepted",
  "queued",
  "pending",
  "sending",
  "submitted",
  "delivery_unknown",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// ── New Replies 7.2 (2026-10-01) ────────────────────────────────────────────
// A thread whose LATEST inbound already resolved the conversation is not a new
// reply, whatever its stored bucket says: an opt-out, a wrong person, a sale,
// a decline or a "not now", hostility. Mirrors f_reply_resolved in
// v_inbox_thread_state_buckets (migration 20261001160000).
//
// 8.5 (2026-10-06): widened to every NON-ACTIONABLE reply (reply-actionability.js):
// non-owners, trolls, implausible asks and thanks-only replies join the list.
export const RESOLVED_REPLY_INTENTS = NON_ACTIONABLE_REPLY_INTENTS;
// Replies that carry no engagement: they leave the thread where it was.
export const NON_ENGAGEMENT_REPLY_INTENTS = Object.freeze(["reaction_only", "acknowledgement"]);
// Dispositions that close the thread for this property (derived "dead").
export const CLOSED_DISPOSITIONS = Object.freeze(["sold", "unqualified"]);

function latestInboundIntent(row = {}) {
  const direction = normalizeDirection(row.latest_message_direction || row.latest_direction || row.direction);
  if (direction !== "inbound") return "";
  return lower(row.last_intent || row.latest_intent || row.primary_intent);
}

/** The latest inbound already resolved the conversation (7.2). */
export function isResolvedReplyRow(row = {}) {
  return RESOLVED_REPLY_INTENTS.includes(latestInboundIntent(row));
}

export function isArchivedThread(row = {}) {
  return row.is_archived === true;
}

export function isSuppressedContact(row = {}) {
  if (row.is_suppressed === true || row.opt_out === true) return true;
  // Closure pass 2026-08-26 (M2): disposition=not_interested is a SOFT
  // seller/property disposition, not a communication suppression. Treating it
  // as suppressed-contact hid a re-engaging seller's NEW reply from the
  // New Replies view (the sticky decline outranked the fresh inbound). Hard
  // suppression = is_suppressed/opt_out/suppression_status/suppressed bucket.
  return lower(row.suppression_status) === "suppressed" || lower(row.inbox_bucket) === "suppressed";
}

export function isWrongNumberContact(row = {}) {
  if (row.wrong_number === true) return true;
  const disposition = lower(row.disposition);
  return disposition === "wrong_number" || disposition === "wrong_person";
}

/** Sold / unqualified: the thread is closed for this property (7.2). */
export function isClosedDispositionThread(row = {}) {
  return CLOSED_DISPOSITIONS.includes(lower(row.disposition));
}

export function isTerminalNoContactThread(row = {}) {
  const bucket = lower(row.inbox_bucket);
  if (["dead", "suppressed"].includes(bucket)) return true;
  return isWrongNumberContact(row) || isSuppressedContact(row) || isClosedDispositionThread(row);
}

export function isCancelledDeliveryStatus(status = "") {
  const normalized = lower(status);
  return CANCELLED_DELIVERY_STATUSES.has(normalized) || normalized.includes("cancel");
}

export function isValidWaitingDeliveryStatus(status = "") {
  const normalized = lower(status);
  if (!normalized) return true;
  if (isFailedDeliveryStatus(normalized) || isCancelledDeliveryStatus(normalized)) return false;
  if (VALID_WAITING_DELIVERY_STATUSES.has(normalized)) return true;
  return !normalized.includes("fail") && !normalized.includes("undeliver");
}

export function threadMatchesWaitingFacts(thread = {}, nowMs = Date.now()) {
  if (isArchivedThread(thread)) return false;
  if (isTerminalNoContactThread(thread)) return false;

  const direction = normalizeDirection(
    thread.latest_message_direction || thread.latest_direction || thread.direction,
  );
  if (direction !== "outbound") return false;

  const lastOut = thread.last_outbound_at || thread.lastOutboundAt || thread.latest_message_at;
  const lastIn = thread.last_inbound_at || thread.lastInboundAt;
  if (!isOutboundLastWithoutReply({ lastOutboundAt: lastOut, lastInboundAt: lastIn })) return false;

  const outMs = parseTimestampMs(lastOut);
  if (!outMs) return false;
  // Inclusive 24h boundary: sent_at >= now() - 24h  =>  (now - sent) <= 24h
  if ((nowMs - outMs) > WAITING_REPLY_WINDOW_MS) return false;

  const deliveryStatus = thread.latest_delivery_status
    || thread.latestDeliveryStatus
    || thread.delivery_status
    || thread.deliveryStatus
    || "";
  if (!isValidWaitingDeliveryStatus(deliveryStatus)) return false;

  const metadata = object(thread.metadata);
  if (metadata.terminal_no_contact === true || metadata.do_not_contact === true) return false;

  return true;
}

export function threadMatchesAllMessagesFacts(thread = {}, nowMs = Date.now()) {
  if (isArchivedThread(thread)) return false;
  return !threadMatchesWaitingFacts(thread, nowMs);
}

function threadReplyIntent(thread = {}) {
  return lower(thread.last_intent || thread.latest_intent || thread.primary_intent);
}

// Round 9: New Replies holds only an actionable latest reply (whitelist);
// the rest of the would-be New Replies is the non-alerting Unclear lane.
function threadMatchesReplyCandidateFacts(thread = {}, nowMs = Date.now()) {
  if (isArchivedThread(thread)) return false;
  if (isTerminalNoContactThread(thread)) return false;
  if (isResolvedReplyRow(thread)) return false;

  const bucket = lower(thread.inbox_bucket);
  if (["priority", "needs_review", "waiting", "cold"].includes(bucket)) return false;

  if (bucket === "new_replies" && !isStaleExplicitInboxBucket(thread, "new_replies", nowMs)) {
    return true;
  }

  const direction = normalizeDirection(
    thread.latest_message_direction || thread.latest_direction || thread.direction,
  );
  if (direction !== "inbound") return false;
  if (Number(thread.pending_queue_count || 0) > 0) return false;

  const lastOut = thread.last_outbound_at || thread.lastOutboundAt;
  const lastIn = thread.last_inbound_at || thread.lastInboundAt || thread.latest_message_at;
  const inMs = parseTimestampMs(lastIn);
  const outMs = parseTimestampMs(lastOut);
  if (!inMs) return false;
  if (outMs > 0 && inMs < outMs) return false;

  if (thread.needs_review === true || bucket === "needs_review") return false;
  return true;
}

// No recorded intent = unknown, kept visible in New Replies (see resolveInboxBucketFlags).
function isNewReplyWorthy(thread = {}) {
  const intent = threadReplyIntent(thread);
  return !intent || isNewReplyActionableIntent(intent);
}

export function threadMatchesNewRepliesFacts(thread = {}, nowMs = Date.now()) {
  return threadMatchesReplyCandidateFacts(thread, nowMs) && isNewReplyWorthy(thread);
}

export function threadMatchesUnclearFacts(thread = {}, nowMs = Date.now()) {
  return threadMatchesReplyCandidateFacts(thread, nowMs) && !isNewReplyWorthy(thread);
}

export function isStaleExplicitInboxBucket(row = {}, explicitBucket = "", nowMs = Date.now()) {
  const explicit = lower(explicitBucket || row.inbox_bucket);
  if (!explicit) return false;

  const direction = normalizeDirection(
    row.latest_message_direction || row.latest_direction || row.direction,
  );
  const lastOut = row.last_outbound_at || row.lastOutboundAt;
  const lastIn = row.last_inbound_at || row.lastInboundAt || row.latest_message_at;

  if (explicit === "new_replies") {
    if (direction !== "inbound") return true;
    const inMs = parseTimestampMs(lastIn);
    const outMs = parseTimestampMs(lastOut);
    if (!inMs) return true;
    if (outMs > 0 && inMs < outMs) return true;
    if (isTerminalNoContactThread(row)) return true;
    if (isResolvedReplyRow(row)) return true;
  }

  if (explicit === "waiting") {
    return !threadMatchesWaitingFacts(row, nowMs);
  }

  return false;
}

export function threadMatchesBucketFilter(thread = {}, filter = "all", nowMs = Date.now()) {
  const bucket = lower(thread.inbox_bucket);
  const direction = normalizeDirection(thread.latest_message_direction || thread.latest_direction || thread.direction);

  switch (filter) {
    case "all":
    case "all_messages":
      return threadMatchesAllMessagesFacts(thread, nowMs);
    case "priority":
      if (isArchivedThread(thread) || isTerminalNoContactThread(thread)) return false;
      // 8.5: Priority is high-value actionable only (reply-actionability.js).
      return bucket === "priority" && isPriorityReplyIntent(thread.last_intent || thread.latest_intent || thread.primary_intent);
    case "new_replies":
      return threadMatchesNewRepliesFacts(thread, nowMs);
    case "unclear":
      return threadMatchesUnclearFacts(thread, nowMs);
    case "needs_review":
      if (isArchivedThread(thread)) return false;
      if (bucket === "needs_review") return true;
      return thread.needs_review === true;
    case "follow_up":
      if (isArchivedThread(thread)) return false;
      return bucket === "follow_up";
    case "cold":
      if (isArchivedThread(thread) || isTerminalNoContactThread(thread)) return false;
      if (bucket === "cold" || lower(thread.automation_lane) === "cold_reactivation") return true;
      {
        const lastOut = thread.last_outbound_at || thread.lastOutboundAt;
        const lastIn = thread.last_inbound_at || thread.lastInboundAt;
        if (!isOutboundLastWithoutReply({ lastOutboundAt: lastOut, lastInboundAt: lastIn })) return false;
        const outMs = parseTimestampMs(lastOut);
        if (!outMs) return false;
        return (nowMs - outMs) > WAITING_REPLY_WINDOW_MS;
      }
    case "dead":
      // "NOT INTERESTED" IS NOT DEAD.
      //
      // Operator policy, stated plainly: "most people are gonna be not
      // interested at first, and then we follow up and we get them under
      // contract". A first no is the normal opening of a negotiation, not the
      // end of one. Only an explicit STOP/opt-out or a wrong number is terminal.
      //
      // The suppression predicate above already reached this conclusion in the
      // 2026-08-26 closure pass and stopped treating not_interested as hard
      // suppression - but this branch kept routing the same threads to `dead`,
      // which buries them just as effectively. MEASURED 2026-09-11: 329 threads
      // carry not_interested with ZERO opt-out and ZERO wrong-number, and 301
      // of them sit in suppressed/dead where no follow-up can reach them.
      //
      // Genuine opt-outs are untouched: 309 threads carry opt_out and stay
      // blocked, as do the 173 carrier-level STOP records (TextGrid 21610).
      // Archived leaves every bucket but Archived — the same rule the SQL flags
      // (in_dead/in_suppressed/in_unlinked require !archived) already apply.
      if (isArchivedThread(thread)) return false;
      return bucket === "dead" || isWrongNumberContact(thread) || isClosedDispositionThread(thread);
    case "suppressed":
      if (isArchivedThread(thread)) return false;
      return bucket === "suppressed" || isSuppressedContact(thread);
    case "active":
      if (isArchivedThread(thread) || isTerminalNoContactThread(thread)) return false;
      return ["priority", "new_replies", "needs_review", "follow_up"].includes(bucket);
    case "waiting":
      return threadMatchesWaitingFacts(thread, nowMs);
    case "unlinked":
      if (isArchivedThread(thread)) return false;
      return !thread.property_id;
    case "archived":
      // Without this case, "archived" fell through to `default: return true`,
      // so filter=archived matched EVERY thread and returned output identical
      // to filter=all -- mixed buckets, is_archived null throughout. The count
      // path (threadMatchesInboxTab) already gated archived correctly; only the
      // list path was missing it.
      return isArchivedThread(thread);
    default:
      return true;
  }
}
// ─── Bucket flags: the JS mirror of v_inbox_thread_state_buckets ─────────────
/**
 * ONE predicate per category, expressed twice — deliberately.
 *
 * The SQL view v_inbox_thread_state_buckets is what production reads: it is the
 * only place a category can be evaluated over all 9,778 threads cheaply enough
 * to both count AND paginate from, and having the list and the count share it is
 * what stops a chip disagreeing with its rows. This function is the same
 * predicate in JS, and it exists so the invariant is testable against fixtures
 * without a database.
 *
 * They must be changed together. tests/critical/inbox-bucket-flag-parity.test.mjs
 * pins the shape; the SQL is the deployed authority.
 */
const WAITING_DELIVERY_OK = new Set([
  "", "sent", "delivered", "accepted", "queued", "pending", "sending", "submitted", "delivery_unknown",
]);

function metadataObject(row) {
  return row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
}

/**
 * The DERIVED bucket, mirroring canonical_inbox_threads' COALESCE/CASE.
 * inbox_thread_state.inbox_bucket is NULL on 93% of production rows, so reading
 * the raw column is not a small error — it puts almost every thread nowhere.
 */
export function resolveDerivedInboxBucket(row = {}) {
  const explicit = lower(row.inbox_bucket);
  if (explicit) return explicit;
  const disposition = lower(row.disposition);
  if (row.is_suppressed === true) return "suppressed";
  if (disposition === "wrong_number" || disposition === "wrong_person") return "dead";
  if (CLOSED_DISPOSITIONS.includes(disposition)) return "dead";
  if (disposition === "not_interested") return "follow_up";
  if (normalizeDirection(row.latest_direction ?? row.latest_message_direction) === "inbound") return "new_replies";
  return "cold";
}

export function resolveInboxBucketFlags(row = {}, nowMs = Date.now()) {
  const bucket = resolveDerivedInboxBucket(row);
  const disposition = lower(row.disposition);
  const direction = normalizeDirection(row.latest_direction ?? row.latest_message_direction ?? row.direction);
  const delivery = lower(row.latest_delivery_status);
  const metadata = metadataObject(row);

  const snoozedMs = parseTimestampMs(row.snoozed_until);
  const scheduledMs = parseTimestampMs(row.next_scheduled_for);
  const outAt = row.last_outbound_at ?? row.latest_message_at ?? null;
  const outMs = parseTimestampMs(outAt);
  const inMs = parseTimestampMs(row.last_inbound_at);
  /**
   * The latest_message_at fallback belongs to New Replies ONLY.
   *
   * When the latest message is the inbound one, latest_message_at IS that
   * inbound timestamp, so it is a safe stand-in for a missing last_inbound_at
   * stamp. Feeding it into the WAITING predicate instead inverts that predicate:
   * an outbound-latest thread would compare latest_message_at (the outbound
   * time) against itself, "last reply is not older than last send" would hold,
   * and every genuinely-waiting thread would drop out of Waiting. Mirrors the
   * SQL view, which likewise coalesces only inside in_new_replies.
   * (0 of 834 inbound production threads need the fallback today.)
   */
  const inboundAtMs = inMs || parseTimestampMs(row.latest_message_at);

  const archived = row.is_archived === true;
  const snoozed = snoozedMs > 0 && snoozedMs > nowMs;
  const pendingSchedule = scheduledMs > 0 && scheduledMs > nowMs;
  const needsReviewFlag = row.manual_override === true
    || (row.confidence != null && Number(row.confidence) < 0.5);
  const metadataNoContact = metadata.terminal_no_contact === true || metadata.do_not_contact === true;

  const suppressedContact = row.is_suppressed === true || bucket === "suppressed";
  const wrongNumberContact = disposition === "wrong_number" || disposition === "wrong_person";
  const closedDisposition = CLOSED_DISPOSITIONS.includes(disposition);
  const deliveryOk = WAITING_DELIVERY_OK.has(delivery);
  // NULL last_inbound_at reads as "never replied", which is why it must not be
  // compared numerically against a real outbound timestamp.
  const outboundLastNoReply = outMs > 0 && (!inMs || inMs < outMs);
  const terminal = bucket === "dead" || bucket === "suppressed" || wrongNumberContact || suppressedContact || closedDisposition;
  // 7.2: what the latest inbound was, when the latest message is inbound.
  const lastIntent = direction === "inbound" ? lower(row.last_intent) : "";
  const replyResolved = RESOLVED_REPLY_INTENTS.includes(lastIntent);
  const nonEngagementLatest = NON_ENGAGEMENT_REPLY_INTENTS.includes(lastIntent);
  const realOutMs = parseTimestampMs(row.last_outbound_at);

  const available = !archived && !snoozed && !pendingSchedule;
  const actionable = available && !terminal;

  const inWaiting = (actionable
    && direction === "outbound"
    && outboundLastNoReply
    && (nowMs - outMs) <= WAITING_REPLY_WINDOW_MS
    && deliveryOk
    && !metadataNoContact)
    // 7.2: a reaction / acknowledgement / auto-reply that left nothing open
    // keeps the thread waiting on a real answer inside the reply window.
    || (actionable
      && direction === "inbound"
      && nonEngagementLatest
      && bucket === "cold"
      && realOutMs > 0
      && (nowMs - realOutMs) <= WAITING_REPLY_WINDOW_MS
      && !metadataNoContact);

  // 8.5: the thread's latest inbound intent, whatever was sent after it
  // (last_intent is written on inbound only). Priority is gated on it so a
  // stored 'priority' bucket cannot hold an implausible ask, a troll or a bare
  // "Yes" once the reply is answered.
  const threadIntent = lower(row.last_intent);
  const threadResolved = RESOLVED_REPLY_INTENTS.includes(threadIntent);
  const inPriority = actionable && bucket === "priority" && isPriorityReplyIntent(threadIntent) && !threadResolved;
  const unanswered = direction === "inbound"
    && inboundAtMs > 0
    && (!realOutMs || inboundAtMs >= realOutMs);
  const replyCandidate = actionable
    && !inPriority
    && !needsReviewFlag
    && !replyResolved
    && unanswered;
  // Round 9: New Replies = an ACTIONABLE latest reply only (whitelist). A
  // reply with NO recorded intent is unknown, not unclear: it stays visible in
  // New Replies (the live path always records one; a gap must not hide).
  const newReplyIntent = !lastIntent || isNewReplyActionableIntent(lastIntent);
  const inNewReplies = replyCandidate
    && newReplyIntent
    && (
      !["priority", "needs_review", "waiting", "cold", "follow_up"].includes(bucket)
      // 8.5: a stored 'priority' whose latest reply is not priority-grade is
      // still a reply to work ("Yes", "only for 1.5M") -> New Replies.
      || bucket === "priority"
      // 8.5: a parked nurture re-opens on a later actionable reply (owner
      // rule: dead deals reopen on a new reply). "unclear" alone does not.
      || (bucket === "follow_up" && isReopeningReplyIntent(lastIntent))
    );
  // Round 9: the non-alerting Unclear lane -- an unanswered reply that would
  // have been New Replies but is not actionable (unclear, who-is-this, a bare
  // "No" awaiting its clarifier, a language switch, an unread emoji).
  const inUnclear = replyCandidate
    && !newReplyIntent
    && (!["priority", "needs_review", "waiting", "cold", "follow_up"].includes(bucket) || bucket === "priority");
  const inNeedsReview = available && (bucket === "needs_review" || needsReviewFlag);
  const inFollowUp = available && bucket === "follow_up" && !inNewReplies;

  return {
    derived_bucket: bucket,
    in_archived: archived,
    in_snoozed: !archived && snoozed,
    in_scheduled: !archived && pendingSchedule,
    in_priority: inPriority,
    in_new_replies: inNewReplies,
    in_unclear: inUnclear,
    in_needs_review: inNeedsReview,
    in_follow_up: inFollowUp,
    // `active` is a LENS, not a bucket: the union of the four an operator works.
    // It needs its own flag now that an unknown filter fails closed.
    in_active: inPriority || inNewReplies || inNeedsReview || inFollowUp,
    // Cold is "we sent and the response window has PASSED". Without `!inWaiting`
    // every thread sent in the last 24h sat in Cold and Waiting simultaneously:
    // the derived bucket for any outbound-latest thread is 'cold', and Waiting is
    // a time window on top of it, not a different bucket. Production hid this
    // (Waiting was 0 while sends were paused) and it would have surfaced the
    // moment outbound resumed.
    in_cold: actionable && bucket === "cold" && !inWaiting,
    in_dead: !archived && (bucket === "dead" || wrongNumberContact || closedDisposition),
    in_suppressed: !archived && (bucket === "suppressed" || suppressedContact),
    in_waiting: inWaiting,
    in_all_messages: !archived && !inWaiting,
    in_all: !archived,
    in_unlinked: !archived && row.property_id == null,
  };
}
