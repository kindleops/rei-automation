// ─── manual-send-burst-guard.js ─────────────────────────────────────────────
// Burst controls for the manual Inbox send path (P0 round 4, launch condition 6,
// 2026-09-24 incident at 410 Roxbury Dr).
//
// WHAT HAPPENED. TextGrid's content filter blocked a manual reply
// (failure_class content_filter_blocked, retry_allowed false). The operator
// reworded and pressed Send again, five times in 4.5 minutes; each reword was a
// NEW send_queue row with its own client_send_id, so nothing treated it as a
// retry. The old duplicate guard compared the exact body inside a 5-minute
// bucket, ignored failed rows, and let the send through when its query errored.
// The same pattern recurs on 06-17, 09-10, 09-23, 09-25 (16 attempts on one
// thread) and 10-25 (10).
//
// THREE CONTROLS, ONE READ. All three are judged from the thread's own
// send_queue history, read once, so they cannot disagree with each other:
//
// SCOPE (carry-over of review task_e46cf83a). Controls 1 and 2 apply to EVERY
// operator path that writes a seller-thread send through
// createInboxSendNowQueueRow: send now, queue reply, auto reply, schedule
// reply, map command and the internal send-now route, whatever the action,
// source or schedule. Round 4 applied them to immediate manual sends only, so
// a reworded Queue reply / Auto-reply / Schedule reply after a block went
// through. The lock is ALSO re-checked at dispatch (contentFilterDispatchRefusal,
// called by final-dispatch-gate.js on every path), so a row queued before the
// block, or written by any other path, cannot leave on a locked thread.
//
//   1. ATTEMPT CAP + COOLDOWN (every operator send). At most `cap` outbound
//      attempts per thread per `window_minutes`, where a FAILED attempt
//      (failed, failed_transport, undelivered, content_filter_blocked, ...)
//      counts exactly like a sent one. Then a hard stop until the oldest
//      counted attempt leaves the window; the reason and the time it lifts are
//      returned. Configured through system_control (keys below); absent,
//      blank or out-of-range values use the strict default.
//
//   2. CONTENT-FILTER LOCK (every operator send, and every dispatch). After a
//      content_filter_blocked failure the THREAD is locked for sends
//      until a person explicitly clears it (content_filter_lock_clearance with
//      a reason, by a server-identified operator). The lock is per thread, not
//      per sender: on 09-24 the sender changed (…88 -> …70) through the
//      nationwide fallback after …88 was blocked, so a per-sender lock would
//      have been bypassed exactly the way the incident happened. The blocked
//      sender is reported with the lock.
//
//   3. DUPLICATE GUARD (every row this path writes). Any outbound attempt on
//      the thread inside the duplicate window whose normalized body is the
//      same or similar (token overlap) is a duplicate, failed rows included.
//
// FAIL CLOSED. An explicit read error always refuses. A thrown read refuses in
// production always, and in the test runtime when the client is real or the
// suite enforces it (same rule as final-dispatch-gate.js finalGateFactsApply,
// because legacy suites drive this path with partial fakes).
//
// No row is written for a refused attempt; that is what "no silent
// reword-and-resend" means here: the operator gets the reason, not a new row.

import { normalizePhone } from "@/lib/utils/phones.js";

// v2: lock + cap on every operator path (not only immediate send-now), and
// the dispatch-time lock check used by final-dispatch-gate.js.
export const MANUAL_BURST_GUARD_VERSION = "manual_send_burst_guard_v2";

export const MANUAL_BURST_REASONS = Object.freeze({
  ATTEMPT_CAP: "manual_send_attempt_cap_reached",
  CONTENT_FILTER_LOCKED: "manual_send_content_filter_locked",
  DUPLICATE: "duplicate_blocked",
  HISTORY_UNREADABLE: "manual_send_attempt_history_unreadable",
  CLEARANCE_INVALID: "content_filter_lock_clearance_invalid",
});

export const MANUAL_BURST_CONTROL_KEYS = Object.freeze({
  ATTEMPT_CAP: "manual_send_thread_attempt_cap",
  ATTEMPT_WINDOW_MINUTES: "manual_send_thread_attempt_window_minutes",
  DUPLICATE_WINDOW_MINUTES: "manual_send_duplicate_window_minutes",
});

export const MANUAL_BURST_DEFAULTS = Object.freeze({
  attempt_cap: 2,
  attempt_window_minutes: 10,
  duplicate_window_minutes: 30,
});

// Bounds a control value must sit inside. Outside them the default applies, so
// a typo cannot switch the brake off (cap 0 / 9999, window 0).
const BOUNDS = Object.freeze({
  attempt_cap: [1, 10],
  attempt_window_minutes: [1, 1440],
  duplicate_window_minutes: [1, 1440],
});

export const CLEARANCE_MIN_REASON = 10;
export const CLEARANCE_MAX_REASON = 500;

const HISTORY_LIMIT = 200;
export const HISTORY_COLUMNS =
  "id,thread_key,to_phone_number,from_phone_number,queue_status,message_body,message_text,failed_reason,provider_message_id,created_at,updated_at,sent_at,scheduled_for,metadata";

// A provider attempt was made (or its outcome is known) for these.
const ATTEMPTED_STATUSES = new Set([
  "processing",
  "sending",
  "sent",
  "delivered",
  "failed",
  "failed_transport",
  "undelivered",
  "content_filter_blocked",
  "carrier_blocked",
  "invalid_number",
  "delivery_failed",
]);

// Not yet attempted. An OPERATOR row in one of these (send now, queue reply,
// auto reply, schedule reply, map command, internal send-now) is an operator
// send in flight (written, waiting to be claimed), so it counts; an automated
// row parked in one of them is not an attempt yet.
const IN_FLIGHT_STATUSES = new Set(["queued", "scheduled", "pending", "ready", "approval", "retry", "retrying"]);

/**
 * Metadata stamped on every row an operator path writes through
 * createInboxSendNowQueueRow, whatever its action or source (review
 * task_e46cf83a). It is server-written (stripped from caller metadata) and
 * makes a queued / scheduled operator row count against the attempt cap.
 */
export const OPERATOR_SEND_MARKER = "operator_seller_send";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function objectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function ms(value) {
  const t = Date.parse(clean(value));
  return Number.isFinite(t) ? t : NaN;
}

function maskPhone(value = "") {
  const digits = clean(value).replace(/\D/g, "");
  return digits.length >= 2 ? `•••${digits.slice(-2)}` : "•••";
}

function boundedInt(raw, key) {
  const text = clean(raw);
  if (!text) return MANUAL_BURST_DEFAULTS[key];
  if (!/^\d+$/.test(text)) return MANUAL_BURST_DEFAULTS[key];
  const n = Number(text);
  const [lo, hi] = BOUNDS[key];
  return n >= lo && n <= hi ? n : MANUAL_BURST_DEFAULTS[key];
}

/**
 * Read the controls. Never throws. An unreadable control falls back to the
 * strict default (it can only tighten, never loosen, what is configured).
 */
export async function loadManualBurstConfig({ getSystemValue = null } = {}) {
  const read = async (key) => {
    if (typeof getSystemValue !== "function") return null;
    try {
      return await getSystemValue(key);
    } catch {
      return null;
    }
  };
  const [cap, window_minutes, duplicate_minutes] = await Promise.all([
    read(MANUAL_BURST_CONTROL_KEYS.ATTEMPT_CAP),
    read(MANUAL_BURST_CONTROL_KEYS.ATTEMPT_WINDOW_MINUTES),
    read(MANUAL_BURST_CONTROL_KEYS.DUPLICATE_WINDOW_MINUTES),
  ]);
  return {
    attempt_cap: boundedInt(cap, "attempt_cap"),
    attempt_window_minutes: boundedInt(window_minutes, "attempt_window_minutes"),
    duplicate_window_minutes: boundedInt(duplicate_minutes, "duplicate_window_minutes"),
  };
}

// ── row classification ──────────────────────────────────────────────────────

const CONTENT_FILTER_TOKENS = ["content_filter_blocked", "blocked_by_textgrid_content_filter"];

function looksContentFiltered(value) {
  const text = lower(value).replace(/[-\s]+/g, "_");
  if (!text) return false;
  if (CONTENT_FILTER_TOKENS.some((t) => text.includes(t))) return true;
  return lower(value).includes("content filter");
}

/** Did TextGrid's content filter block this row (at send time or by receipt)? */
export function isContentFilterFailureRow(row = {}) {
  const m = objectOf(row?.metadata);
  const pe = objectOf(m.provider_error);
  return [
    row?.queue_status,
    row?.failure_class,
    row?.failed_reason,
    m.failure_class,
    m.normalized_reason,
    m.provider_failure_reason,
    m.failure_bucket,
    pe.failure_class,
    pe.normalized_reason,
    pe.message,
  ].some(looksContentFiltered);
}

function isManualRow(row = {}) {
  const m = objectOf(row?.metadata);
  return (
    m.manual_operator_send === true ||
    lower(m.manual_operator_send) === "true" ||
    m[OPERATOR_SEND_MARKER] === true
  );
}

/** When this row's attempt happened (never a later receipt/updated_at). */
export function attemptTimeMs(row = {}) {
  const m = objectOf(row?.metadata);
  const candidates = [row?.created_at, row?.sent_at, m.manual_send_attempted_at].map(ms).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : NaN;
}

/** Is this row an outbound ATTEMPT (sent, failed or a manual send in flight)? */
export function isAttemptRow(row = {}) {
  const status = lower(row?.queue_status);
  if (ATTEMPTED_STATUSES.has(status)) return true;
  if (isContentFilterFailureRow(row)) return true;
  if (clean(row?.provider_message_id)) return true;
  if (IN_FLIGHT_STATUSES.has(status) && isManualRow(row)) return true;
  return false;
}

// ── body similarity ─────────────────────────────────────────────────────────

export function normalizeBody(value = "") {
  return lower(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9$ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return new Set(normalizeBody(value).split(" ").filter(Boolean));
}

/** Token-overlap similarity in [0, 1] of two bodies after normalization. */
export function bodySimilarity(a = "", b = "") {
  const na = normalizeBody(a);
  const nb = normalizeBody(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  // Very short bodies ("ok", "thanks john") only match exactly: two words in
  // common is not evidence of the same message.
  if (Math.min(ta.size, tb.size) < 4) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  // Overlap relative to the SHORTER body: a reword that keeps most of the
  // original's words, or trims it, still reads as the same message.
  return shared / Math.max(1, Math.min(ta.size, tb.size));
}

export const SIMILARITY_THRESHOLD = 0.6;

// ── content-filter lock clearance ───────────────────────────────────────────

/**
 * An explicit, audited clearance of a content-filter lock. The actor is the
 * SERVER-identified operator (deps.operator.id, or the route-stamped actor);
 * a name in the request body is never the actor.
 *
 * Returns { requested:false } | { requested:true, ok:true, clearance } |
 * { requested:true, ok:false, reason, detail }.
 */
export function buildContentFilterLockClearance(input = {}, { operator = null, server_actor = null, now = new Date().toISOString() } = {}) {
  const raw = input?.content_filter_lock_clearance;
  const requested = Boolean(raw) && (typeof raw === "object" || raw === true || lower(raw) === "true");
  if (!requested) return { requested: false };
  const actor =
    (operator && typeof operator === "object" && operator.authenticated === true ? clean(operator.id) : "") ||
    clean(server_actor);
  if (!actor) {
    return {
      requested: true,
      ok: false,
      reason: MANUAL_BURST_REASONS.CLEARANCE_INVALID,
      detail: "Clearing a content-filter lock needs an identified operator; this session has no operator id.",
    };
  }
  const reason = clean(objectOf(raw).reason || input?.content_filter_lock_clearance_reason).replace(/\s+/g, " ");
  if (reason.length < CLEARANCE_MIN_REASON || reason.length > CLEARANCE_MAX_REASON) {
    return {
      requested: true,
      ok: false,
      reason: MANUAL_BURST_REASONS.CLEARANCE_INVALID,
      detail: `Clearing a content-filter lock needs a reason of ${CLEARANCE_MIN_REASON}-${CLEARANCE_MAX_REASON} characters.`,
    };
  }
  return {
    requested: true,
    ok: true,
    clearance: {
      actor,
      operator_email: clean(operator?.email) || null,
      reason,
      cleared_at: now,
      guard_version: MANUAL_BURST_GUARD_VERSION,
    },
  };
}

function rowClearance(row = {}) {
  const c = objectOf(objectOf(row?.metadata).content_filter_lock_clearance);
  return clean(c.actor) && clean(c.cleared_at) ? c : null;
}

/**
 * The thread's content-filter lock state from its history. The newest row that
 * is either content-filter-blocked or carries a clearance decides: a block
 * newer than every clearance locks; a clearance newer than every block
 * unlocks. A cleared send that is itself blocked again locks again.
 */
export function contentFilterLockOf(rows = []) {
  const ordered = [...rows].sort((a, b) => (ms(b?.created_at) || 0) - (ms(a?.created_at) || 0));
  for (const row of ordered) {
    if (isContentFilterFailureRow(row)) {
      return {
        locked: true,
        blocked_row_id: clean(row?.id) || null,
        blocked_at: clean(row?.created_at) || null,
        blocked_from_phone_number: normalizePhone(row?.from_phone_number) || clean(row?.from_phone_number) || null,
      };
    }
    if (rowClearance(row)) return { locked: false, cleared_by_row_id: clean(row?.id) || null };
  }
  return { locked: false };
}

/**
 * DISPATCH-TIME lock check (final-dispatch-gate.js, every path: queue runner,
 * Cockpit, internal send-now, manual send, automation). Pure.
 *
 * A send must not leave while the thread is locked, and a row written BEFORE
 * the thread's latest content-filter block never leaves even after a person
 * has cleared the lock: the clearance reviewed the new wording on the
 * clearance row, not the older row's. The row being dispatched counts as
 * history (a cleared row is itself the clearance that unlocks the thread).
 *
 * @returns {null | { reason, content_filter_lock }}
 */
export function contentFilterDispatchRefusal({ row = null, rows = [] } = {}) {
  const history = Array.isArray(rows) ? [...rows] : [];
  const row_id = clean(row?.id);
  if (row && typeof row === "object" && (!row_id || !history.some((r) => clean(r?.id) === row_id))) {
    history.push(row);
  }
  const lock = contentFilterLockOf(history);
  if (lock.locked) {
    return { reason: "content_filter_locked", content_filter_lock: lock };
  }
  const created = ms(row?.created_at);
  if (row_id && Number.isFinite(created)) {
    const later_block = history.find(
      (r) => clean(r?.id) !== row_id && isContentFilterFailureRow(r) && ms(r?.created_at) > created
    );
    if (later_block) {
      return {
        reason: "content_filter_blocked_after_row_written",
        content_filter_lock: {
          locked: false,
          blocked_row_id: clean(later_block.id) || null,
          blocked_at: clean(later_block.created_at) || null,
        },
      };
    }
  }
  return null;
}

// ── the decision (pure) ─────────────────────────────────────────────────────

function refusal(reason, detail, extra = {}) {
  return {
    ok: false,
    status: 423,
    reason,
    detail_reason: detail,
    message: detail,
    hard_block: true,
    guard_version: MANUAL_BURST_GUARD_VERSION,
    ...extra,
  };
}

/**
 * Decide whether an operator send may create a row.
 *
 * The content-filter lock and the attempt cap apply to EVERY call, whatever
 * the action (send now, queue reply, auto reply, schedule reply, map command,
 * internal send-now) or the schedule. Round 4 gated them on an
 * `immediate_manual` flag, so a queue-reply / auto-reply / schedule-reply
 * written with scheduled_for = now went round both (review task_e46cf83a).
 * There is no longer any argument that switches them off; an
 * `immediate_manual` passed by an old caller is ignored.
 *
 * @param {object} args
 * @param {Array}   args.rows            the thread's send_queue history
 * @param {string}  args.message_body    the body about to be written
 * @param {object}  args.config          loadManualBurstConfig() result
 * @param {object}  args.clearance       buildContentFilterLockClearance() result
 * @param {string}  args.now             ISO instant
 */
export function evaluateManualSendBurst({
  rows = [],
  message_body = "",
  config = MANUAL_BURST_DEFAULTS,
  clearance = { requested: false },
  now = new Date().toISOString(),
} = {}) {
  const now_ms = ms(now);
  const history = Array.isArray(rows) ? rows : [];
  let cleared_lock = null;

  {
    // 2. CONTENT-FILTER LOCK first: it is the most specific reason, and the
    //    one the operator must act on (a reword will be blocked again).
    const lock = contentFilterLockOf(history);
    if (lock.locked) {
      if (clearance?.ok) cleared_lock = lock;
      if (clearance?.requested && !clearance.ok) {
        return refusal(clearance.reason, clearance.detail, { content_filter_lock: lock, clearance_required: true });
      }
      if (!clearance?.ok) {
        return refusal(
          MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED,
          `TextGrid's content filter blocked the last message on this thread (from ${maskPhone(lock.blocked_from_phone_number)} at ${lock.blocked_at || "unknown time"}). ` +
            "Manual sends to this thread are locked: rewording and resending is not allowed. " +
            "A person must review the thread and clear the lock (content_filter_lock_clearance with a reason) before another manual send.",
          { content_filter_lock: lock, clearance_required: true }
        );
      }
    }

    // 1. ATTEMPT CAP + COOLDOWN, failed attempts included.
    const window_ms = config.attempt_window_minutes * 60 * 1000;
    const counted = history
      .filter(isAttemptRow)
      .map((row) => ({ row, at: attemptTimeMs(row) }))
      .filter(({ at }) => Number.isFinite(at) && at > now_ms - window_ms && at <= now_ms + 60 * 1000)
      .sort((a, b) => a.at - b.at);
    if (counted.length >= config.attempt_cap) {
      // Lifts when enough of the oldest counted attempts have left the window.
      const release_index = counted.length - config.attempt_cap;
      const retry_after = new Date(counted[release_index].at + window_ms).toISOString();
      const failed = counted.filter(({ row }) => !["sent", "delivered"].includes(lower(row?.queue_status))).length;
      return refusal(
        MANUAL_BURST_REASONS.ATTEMPT_CAP,
        `This thread already had ${counted.length} outbound attempt(s) in the last ${config.attempt_window_minutes} minutes ` +
          `(${failed} failed or in flight; failed attempts count). The limit is ${config.attempt_cap}. ` +
          `Manual sends to this thread are stopped until ${retry_after}.`,
        {
          attempt_cap: {
            cap: config.attempt_cap,
            window_minutes: config.attempt_window_minutes,
            counted_attempts: counted.length,
            counted_failed_or_in_flight: failed,
            counted_row_ids: counted.map(({ row }) => clean(row?.id) || null),
            retry_after,
          },
        }
      );
    }
  }

  // 3. DUPLICATE GUARD: per thread, failed rows included, similar bodies.
  const dup_window_ms = config.duplicate_window_minutes * 60 * 1000;
  for (const row of history) {
    if (!isAttemptRow(row)) continue;
    const at = attemptTimeMs(row);
    if (!Number.isFinite(at) || at <= now_ms - dup_window_ms) continue;
    const similarity = bodySimilarity(message_body, row?.message_body || row?.message_text);
    if (similarity >= SIMILARITY_THRESHOLD) {
      return refusal(
        MANUAL_BURST_REASONS.DUPLICATE,
        `A message ${similarity === 1 ? "with the same text" : "with nearly the same text"} was already attempted on this thread ` +
          `in the last ${config.duplicate_window_minutes} minutes (status ${lower(row?.queue_status) || "unknown"}). Nothing was sent.`,
        {
          duplicate: {
            matched_row_id: clean(row?.id) || null,
            matched_status: lower(row?.queue_status) || null,
            similarity: Math.round(similarity * 100) / 100,
            window_minutes: config.duplicate_window_minutes,
          },
          detail_code: "thread_outbound_similar_in_window",
        }
      );
    }
  }

  return {
    ok: true,
    reason: null,
    guard_version: MANUAL_BURST_GUARD_VERSION,
    content_filter_lock_cleared: Boolean(cleared_lock),
    ...(cleared_lock ? { content_filter_lock: cleared_lock } : {}),
  };
}

// ── the read ────────────────────────────────────────────────────────────────

function quotePostgrestValue(value) {
  return `"${clean(value).replaceAll('"', '""')}"`;
}

/**
 * The thread's send_queue history (by thread_key, and by recipient phone so a
 * second thread key for the same seller is not a way round the cap).
 *
 * @returns {Promise<{ ok:true, rows:Array } | { ok:false, error:string }>}
 */
export async function readThreadSendHistory({ supabase, thread_key, to_phone_number, live_reads = true } = {}) {
  const tk = clean(thread_key);
  const to = normalizePhone(to_phone_number) || null;
  if (!supabase?.from) return { ok: false, error: "supabase_client_missing" };
  if (!tk && !to) return { ok: false, error: "no_thread_or_recipient" };
  const filter = [
    tk ? `thread_key.eq.${quotePostgrestValue(tk)}` : null,
    to ? `to_phone_number.eq.${quotePostgrestValue(to)}` : null,
  ].filter(Boolean).join(",");
  try {
    const { data, error } = await supabase
      .from("send_queue")
      .select(HISTORY_COLUMNS)
      .or(filter)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) return { ok: false, error: clean(error.message) || clean(error.code) || "read_error" };
    if (!Array.isArray(data)) {
      // A real client always returns an array for a list read.
      return live_reads ? { ok: false, error: "history_not_a_list" } : { ok: true, rows: [], skipped: true };
    }
    return { ok: true, rows: data };
  } catch (error) {
    return live_reads
      ? { ok: false, error: clean(error?.message) || "read_threw" }
      : { ok: true, rows: [], skipped: true };
  }
}

/**
 * Read + decide. Fails closed: history that cannot be read refuses.
 */
export async function runManualSendBurstGuard(
  { thread_key, to_phone_number, message_body, clearance = { requested: false }, now = new Date().toISOString() } = {},
  { supabase, getSystemValue = null, live_reads = true, readHistory = readThreadSendHistory } = {}
) {
  const config = await loadManualBurstConfig({ getSystemValue });
  const history = await readHistory({ supabase, thread_key, to_phone_number, live_reads });
  if (!history?.ok) {
    return refusal(
      MANUAL_BURST_REASONS.HISTORY_UNREADABLE,
      "This thread's send history could not be read, so the attempt limit, duplicate check and content-filter lock cannot be checked. Nothing was sent.",
      { history_error: history?.error || "unknown", config }
    );
  }
  const verdict = evaluateManualSendBurst({ rows: history.rows, message_body, config, clearance, now });
  return { ...verdict, config, history_rows_read: history.rows.length, history_skipped: history.skipped === true };
}

export default runManualSendBurstGuard;
