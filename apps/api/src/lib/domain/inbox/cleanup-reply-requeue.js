/**
 * RC 7.1 — RE-QUEUE the 16 cleanup replies the runner paused
 * (paused_invalid_queue_row / missing_candidate_snapshot, 2026-10-02 ~19:00Z).
 *
 * Per thread:
 *   1. read every row for the thread's cleanup keys (unreadable -> refuse);
 *   2. a SENT row ends it (never a second text); a LIVE row ends it (the
 *      thread already has one: idempotent);
 *   3. only threads that carry one of the paused rows are in scope (the 16);
 *   4. cancel the paused row: queue_status='cancelled',
 *      guard_reason='rc71_replies_requeue', audit in metadata (CAS on status);
 *   5. queue again through the FIXED executor (queueCleanupReply), which
 *      re-evaluates every hold NOW: vendor DNC, suppression, relationship,
 *      seller identity, template, sender engine, contact window, and the
 *      runner's own invariants. A hold writes no row.
 *
 * Keys: the per-thread dedupe_key is unchanged; the new row's queue_key is
 * `<dedupe_key>:requeue:rc71`. queue_key is unique over ALL rows, the
 * dedupe_key over LIVE rows (uq_send_queue_active_dedupe_key), so a cancelled
 * row never blocks the re-queue and a second run can never add a second row.
 * Dry run (deps.dryRun): the same reads and chain, ZERO writes.
 */
const clean = (v) => String(v ?? "").trim();

export const REQUEUE_TAG = "rc71_replies_requeue";
export const REQUEUE_QUEUE_KEY_SUFFIX = "requeue:rc71";
export const PAUSED_STATUS = "paused_invalid_queue_row";
export const PAUSED_GUARD = "missing_candidate_snapshot";

/**
 * One re-queue PASS per runner refusal. Each pass names the dead rows it may
 * cancel, the tag it cancels them with, and its own queue_key suffix (unique
 * per pass, so a pass's second run replays instead of inserting).
 */
export const REQUEUE_PASSES = Object.freeze({
  // 2026-10-02 ~19:00Z: no candidate snapshot.
  snapshot: Object.freeze({
    tag: REQUEUE_TAG,
    suffix: REQUEUE_QUEUE_KEY_SUFFIX,
    status: PAUSED_STATUS,
    guard: PAUSED_GUARD,
    why: "runner paused the row: missing_candidate_snapshot (executor defect, fixed); re-queued through the fixed path",
  }),
  // 2026-10-02 20:16Z: the selector chose operator-blocked senders.
  sender: Object.freeze({
    tag: "rc71_replies_requeue_sender",
    suffix: "requeue:rc71:sender",
    status: "blocked_by_health_guard",
    guard: "blocked_sender_number",
    why: "runner refused the row: blocked_sender_number (selector ignored the operator blocklist, fixed); re-queued through the fixed sender selection",
  }),
  // 2026-10-02 20:18Z on: a QUEUED row the dispatcher refuses every cycle
  // (queue_row_identity_underivable: no action anchor). It is technically live,
  // so this pass alone may cancel it, and only while it is unlocked, never
  // sent, has no provider id and still carries no anchor.
  identity: Object.freeze({
    tag: "rc71_replies_requeue_identity",
    suffix: "requeue:rc71:identity",
    status: "queued",
    guard: "queue_row_identity_underivable",
    targets_live_row: true,
    why: "dispatcher refused the row every cycle: queue_row_identity_underivable (no seller_operator_actions anchor, fixed); replaced through the fixed path",
  }),
});

const anchorOf = (r) => clean(r?.logical_communication_id || r?.metadata?.operator_action_id || r?.metadata?.decision_id || r?.metadata?.follow_up_id);

/** A stuck identity-refused row this pass may cancel. */
function isIdentityStranded(r) {
  return clean(r.queue_status) === "queued"
    && clean(r?.metadata?.skip_reason) === "queue_row_identity_underivable"
    && !r.sent_at && !clean(r.provider_message_id)
    && r.is_locked !== true && !clean(r.lock_token)
    && !anchorOf(r);
}

// Mirrors the predicate of uq_send_queue_active_dedupe_key.
export const LIVE_STATUSES = new Set([
  "queued", "ready", "runnable", "scheduled", "pending", "paused", "paused_after_hours",
  "processing", "approved", "approval", "held", "sending",
]);
const SENT_STATUSES = new Set(["sent", "delivered", "sending_confirmed"]);

const guardOf = (r) => clean(r?.guard_reason || r?.metadata?.guard_reason || r?.metadata?.skip_reason || r?.paused_reason);

export function classifyCleanupRows(rows = [], { source, pass = REQUEUE_PASSES.snapshot }) {
  const mine = rows.filter((r) => clean(r?.metadata?.source) === source);
  const target = (r) => (pass.targets_live_row ? isIdentityStranded(r) : clean(r.queue_status) === pass.status && guardOf(r) === pass.guard);
  return {
    sent: mine.filter((r) => r.sent_at || clean(r.provider_message_id) || SENT_STATUSES.has(clean(r.queue_status))),
    // The stranded row this pass replaces is not "a live row" for it; any OTHER
    // live row still ends the pass (one live row per thread).
    live: mine.filter((r) => !r.sent_at && LIVE_STATUSES.has(clean(r.queue_status)) && !target(r)),
    paused: mine.filter(target),
    cancelled_by_requeue: mine.filter((r) => clean(r.queue_status) === "cancelled" && guardOf(r) === pass.tag),
  };
}

export function requeueCancelPatch(row, { now, pass = REQUEUE_PASSES.snapshot }) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    queue_status: "cancelled",
    guard_reason: pass.tag,
    guard_status: "cancelled",
    updated_at: now,
    metadata: {
      ...metadata,
      final_queue_status: "cancelled",
      [pass === REQUEUE_PASSES.snapshot ? "requeue_audit" : `requeue_audit_${pass.tag}`]: {
        tag: pass.tag,
        cancelled_at: now,
        prior_queue_status: clean(row.queue_status) || null,
        prior_guard_reason: guardOf(row) || null,
        prior_from_phone_masked: clean(row.from_phone_number) ? `•••${clean(row.from_phone_number).slice(-4)}` : null,
        reason: pass.why,
        replacement_queue_key_suffix: pass.suffix,
      },
    },
  };
}

/**
 * @param {object} plan  { category, reply, deal }
 * @param {object} ctx   queueCleanupReply ctx
 * @param {object} deps  queueCleanupReply deps + { source, loadCleanupRows(thread_key), cancelPausedRow(row, patch), queueReply }
 */
export async function requeueCleanupReply(plan, ctx, deps = {}) {
  const threadKey = clean(ctx?.thread?.thread_key);
  const dryRun = deps.dryRun === true;
  const now = deps.now ? new Date(deps.now).toISOString() : new Date().toISOString();
  let rows = null;
  try {
    rows = await deps.loadCleanupRows(threadKey);
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) return { ok: false, outcome: "refused", reason: "existing_rows_unreadable", thread_key: threadKey };
  const pass = deps.pass || REQUEUE_PASSES.snapshot;
  const c = classifyCleanupRows(rows, { source: deps.source, pass });
  if (c.sent.length) return { ok: true, outcome: "skipped", reason: "already_sent", queue_row_id: c.sent[0].id, thread_key: threadKey };
  if (c.live.length) return { ok: true, outcome: "skipped", reason: "live_row_exists", queue_row_id: c.live[0].id, queue_status: c.live[0].queue_status, thread_key: threadKey };
  if (!c.paused.length && !c.cancelled_by_requeue.length) {
    return { ok: true, outcome: "skipped", reason: "not_in_requeue_set", thread_key: threadKey };
  }

  const cancelled = [];
  for (const row of c.paused) {
    if (dryRun) {
      cancelled.push({ id: row.id, would_cancel: true });
      continue;
    }
    const res = await deps.cancelPausedRow(row, requeueCancelPatch(row, { now, pass }));
    if (!res?.ok) return { ok: false, outcome: "refused", reason: `cancel_failed:${res?.reason || "unknown"}`, queue_row_id: row.id, thread_key: threadKey };
    // The row moved (claimed, sent, re-statused) between read and cancel:
    // stop; a re-run re-reads and decides again.
    if (res.changed === false) return { ok: false, outcome: "refused", reason: "row_changed_since_read", queue_row_id: row.id, thread_key: threadKey };
    cancelled.push({ id: row.id, cancelled: true });
  }
  const replaced = [...c.paused, ...c.cancelled_by_requeue].map((r) => r.id);

  const r = await deps.queueReply(plan, ctx, {
    ...deps,
    queueKeySuffix: pass.suffix,
    extraMetadata: { requeue: { tag: pass.tag, replaces_queue_row_ids: replaced, requeued_at: now } },
  });
  const outcome = r.would_queue === true ? "would_queue" : r.queued ? "queued" : r.held ? "held" : r.ok === false ? "refused" : "unknown";
  return { ...r, outcome, cancelled, replaces_queue_row_ids: replaced };
}
