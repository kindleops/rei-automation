/**
 * send-now-outcome.js
 *
 * "DID THAT SEND GO OUT?" -- ANSWERED FROM THE DURABLE ROW, BY client_send_id.
 *
 * A phone that loses the send-now response (a dropped connection, a request the
 * OS timed out, the app backgrounded mid-flight) knows nothing about the send:
 * it may not have reached the server, may still be running, or may already have
 * been delivered. On 2026-09-30 the composer reported that last case as
 * "Send Failed" with a Retry button -- an invitation to text the seller twice.
 *
 * The composer already stamps every send with a client_send_id that the server
 * persists on the send_queue row (metadata.client_send_id) before the provider
 * is called, and the row is finalized with the provider SID as soon as the
 * provider accepts. So the answer exists server-side; this reads it. READ ONLY:
 * it never creates, retries or mutates anything.
 */

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { isUuid } from "@/lib/utils/is-uuid.js";

const CANONICAL_THREAD_KEY = /^\+1\d{10}$/;

export const SEND_OUTCOME_STATES = Object.freeze({
  DELIVERED: "delivered",
  SENT: "sent",
  IN_FLIGHT: "in_flight",
  FAILED: "failed",
  NOT_FOUND: "not_found",
});

/**
 * Row states that can still become a send. A manual row is inserted `queued`,
 * claimed `processing`, and finalized `sent`/`failed` within one request, so
 * these mean "the request is (or was, until it died) still working".
 */
const IN_FLIGHT_STATUSES = new Set([
  "queued",
  "processing",
  "sending",
  "scheduled",
  "pending",
  "ready",
  "approval",
  "awaiting_approval",
  "retry",
]);

const STATE_RANK = Object.freeze({
  [SEND_OUTCOME_STATES.DELIVERED]: 4,
  [SEND_OUTCOME_STATES.SENT]: 3,
  [SEND_OUTCOME_STATES.IN_FLIGHT]: 2,
  [SEND_OUTCOME_STATES.FAILED]: 1,
});

function clean(value) {
  return String(value ?? "").trim();
}

/** Map one send_queue row to the operator-facing outcome. Pure. */
export function classifyManualSendRow(row = {}) {
  const status = clean(row?.queue_status).toLowerCase();
  if (status === "delivered") return SEND_OUTCOME_STATES.DELIVERED;
  if (status === "sent") return SEND_OUTCOME_STATES.SENT;
  if (IN_FLIGHT_STATUSES.has(status)) return SEND_OUTCOME_STATES.IN_FLIGHT;
  // failed, failed_transport, cancelled, blocked*, expired, paused_invalid_queue_row, ...
  return SEND_OUTCOME_STATES.FAILED;
}

/**
 * One click can own more than one row (an operator-override retry reuses the
 * click's client_send_id). The most advanced state wins: a send that went out
 * is the answer even if an earlier attempt of the same click was blocked.
 * Ties go to the newest row. Pure.
 */
export function summarizeManualSendOutcome(rows = [], client_send_id = null) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return {
      found: false,
      state: SEND_OUTCOME_STATES.NOT_FOUND,
      terminal: false,
      client_send_id: client_send_id || null,
      queue_row_id: null,
      queue_status: null,
      provider_message_id: null,
      sent_at: null,
      delivered_at: null,
      failed_reason: null,
      row_count: 0,
    };
  }

  let best = null;
  let best_state = null;
  for (const row of list) {
    const state = classifyManualSendRow(row);
    if (!best) {
      best = row;
      best_state = state;
      continue;
    }
    const better = STATE_RANK[state] > STATE_RANK[best_state];
    const same_but_newer =
      STATE_RANK[state] === STATE_RANK[best_state] &&
      Date.parse(row?.created_at || 0) > Date.parse(best?.created_at || 0);
    if (better || same_but_newer) {
      best = row;
      best_state = state;
    }
  }

  return {
    found: true,
    state: best_state,
    terminal: best_state !== SEND_OUTCOME_STATES.IN_FLIGHT,
    client_send_id: client_send_id || null,
    queue_row_id: clean(best?.id) || null,
    queue_status: clean(best?.queue_status) || null,
    provider_message_id: clean(best?.provider_message_id) || null,
    sent_at: best?.sent_at || null,
    delivered_at: best?.delivered_at || null,
    failed_reason: clean(best?.failed_reason) || null,
    row_count: list.length,
  };
}

/**
 * Look up the outcome of one composer send.
 *
 * thread_key is required: it is the indexed column (idx_send_queue_thread_key),
 * so the client_send_id match runs over one thread's rows, never the table.
 */
export async function lookupManualSendOutcome(
  { client_send_id, thread_key } = {},
  { supabase = defaultSupabase } = {}
) {
  const id = clean(client_send_id);
  const key = clean(thread_key);
  if (!isUuid(id)) {
    return { ok: false, status: 400, error: "invalid_client_send_id" };
  }
  if (!CANONICAL_THREAD_KEY.test(key)) {
    return { ok: false, status: 400, error: "invalid_thread_key" };
  }

  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_status,provider_message_id,sent_at,delivered_at,failed_reason,created_at")
    .eq("thread_key", key)
    .eq("metadata->>client_send_id", id)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    // Not knowing is not "not found": the caller must keep treating the send
    // as unconfirmed rather than as never sent.
    return { ok: false, status: 503, error: "send_outcome_lookup_failed" };
  }

  return { ok: true, status: 200, ...summarizeManualSendOutcome(data || [], id) };
}

export default lookupManualSendOutcome;
