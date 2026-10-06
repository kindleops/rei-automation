/**
 * SEND CLASS — COLD vs CONVERSATIONAL (owner rule 2026-10-05).
 *
 *   "We only do 800 in terms of outbound campaigns, but any replies that come
 *    in don't count towards that 800."
 *
 * Evidence: Dallas ••1600 (daily_limit 800) sent 784 campaign + 11 auto_reply
 * + 5 inbox = 800, then parked 2 seller auto-replies as
 * outbound_number_daily_limit_reached. Replies to engaged sellers were being
 * spent against the cold-outbound cap.
 *
 * THE PREDICATE (one function, used at dispatch and when counting the ledger):
 *
 *   CONVERSATIONAL iff ANY of
 *     (a) source ∈ { auto_reply, seller_inbound_orchestrator, inbox,
 *                    manual_inbox }                               (reply / operator sources)
 *     (b) type = 'auto_reply'
 *     (c) message_type ∈ { manual_reply, missed_call_autotext }    (operator send / missed-call text)
 *     (d) queue_key starts with 'missed_call:' or 'inbound_auto_reply:'
 *     (d') isManualInboxSend (operator Inbox send-now shapes) or
 *          isUnknownAutoReply (reply to an inbound from an unknown number)
 *     (e) THREAD REPLIED: the row's thread (send_queue.thread_key ->
 *         inbox_thread_state.last_inbound_at) has an inbound at or before the
 *         reference instant and no more than 30 days before it.
 *   otherwise COLD (campaign first touches, campaign follow-ups and bulk /
 *   cleanup follow-ups to sellers who have not replied in 30 days).
 *
 * Reference instant: dispatch = now; ledger count = the row's sent_at. When the
 * thread's latest inbound is AFTER sent_at the ledger cannot tell whether the
 * seller had replied before that send, so it is COLD (over-counts cold, never
 * under-counts it). Any read failure is COLD: the cold cap is the conservative
 * side. A thread check never makes a row cold that (a)-(d) made conversational.
 */

import { isManualInboxSend, isUnknownAutoReply } from "@/lib/domain/queue/is-manual-inbox-send.js";

const clean = (value) => (value === null || value === undefined ? "" : String(value).trim());
const lower = (value) => clean(value).toLowerCase();

export const SEND_CLASS = Object.freeze({ COLD: "cold", CONVERSATIONAL: "conversational" });
export const CONVERSATIONAL_REPLY_WINDOW_DAYS = 30;
const REPLY_WINDOW_MS = CONVERSATIONAL_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const CONVERSATIONAL_SOURCES = Object.freeze(new Set(["auto_reply", "seller_inbound_orchestrator", "inbox", "manual_inbox"]));
export const CONVERSATIONAL_TYPES = Object.freeze(new Set(["auto_reply"]));
export const CONVERSATIONAL_MESSAGE_TYPES = Object.freeze(new Set(["manual_reply", "missed_call_autotext"]));

function meta(row) {
  return row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
}

export function sendRowThreadKey(row = {}) {
  return clean(row?.thread_key || meta(row).thread_key) || null;
}

/** (a)-(d): the class the row's own provenance proves, or null (needs the thread check). */
export function sourceSendClass(row = {}) {
  if (!row || typeof row !== "object") return null;
  if (CONVERSATIONAL_SOURCES.has(lower(row.source))) return { send_class: SEND_CLASS.CONVERSATIONAL, basis: `source:${lower(row.source)}` };
  if (CONVERSATIONAL_TYPES.has(lower(row.type))) return { send_class: SEND_CLASS.CONVERSATIONAL, basis: `type:${lower(row.type)}` };
  const message_type = lower(row.message_type || meta(row).message_type);
  if (CONVERSATIONAL_MESSAGE_TYPES.has(message_type)) return { send_class: SEND_CLASS.CONVERSATIONAL, basis: `message_type:${message_type}` };
  const queue_key = lower(row.queue_key);
  if (queue_key.startsWith("missed_call:")) return { send_class: SEND_CLASS.CONVERSATIONAL, basis: "queue_key:missed_call" };
  if (queue_key.startsWith("inbound_auto_reply:")) return { send_class: SEND_CLASS.CONVERSATIONAL, basis: "queue_key:inbound_auto_reply" };
  if (isManualInboxSend(row)) return { send_class: SEND_CLASS.CONVERSATIONAL, basis: "manual_inbox_send" };
  if (isUnknownAutoReply(row)) return { send_class: SEND_CLASS.CONVERSATIONAL, basis: "unknown_inbound_auto_reply" };
  return null;
}

/** (e): did the seller reply on this thread within 30 days at or before `at`? */
export function threadRepliedWithinWindow(last_inbound_at, at) {
  const inbound = Date.parse(clean(last_inbound_at));
  const reference = at instanceof Date ? at.getTime() : Date.parse(clean(at));
  if (!Number.isFinite(inbound) || !Number.isFinite(reference)) return false;
  return inbound <= reference && reference - inbound <= REPLY_WINDOW_MS;
}

/**
 * Pure. row = send_queue row; last_inbound_at = the thread's latest inbound
 * (or null); at = reference instant. Returns { send_class, basis }.
 */
export function classifySend(row = {}, { last_inbound_at = null, at = new Date() } = {}) {
  const by_source = sourceSendClass(row);
  if (by_source) return by_source;
  if (sendRowThreadKey(row) && threadRepliedWithinWindow(last_inbound_at, at)) {
    return { send_class: SEND_CLASS.CONVERSATIONAL, basis: "thread_replied_30d" };
  }
  return { send_class: SEND_CLASS.COLD, basis: last_inbound_at ? "thread_reply_outside_window" : "no_thread_reply" };
}

export function isConversationalSendClass(value) {
  return lower(value) === SEND_CLASS.CONVERSATIONAL;
}

/**
 * Latest inbound per thread_key: Map<thread_key, iso|null>. Missing / failed
 * lookups are simply absent (=> COLD). `deps.loadThreadLastInbound(keys)` is
 * the test seam.
 */
export async function loadThreadLastInbound(supabase, thread_keys = [], deps = {}) {
  const keys = [...new Set((thread_keys || []).map(clean).filter(Boolean))];
  const out = new Map();
  if (!keys.length) return out;
  if (typeof deps.loadThreadLastInbound === "function") {
    try {
      const got = await deps.loadThreadLastInbound(keys);
      const entries = got instanceof Map ? [...got.entries()] : Object.entries(got || {});
      for (const [k, v] of entries) out.set(clean(k), v || null);
    } catch {
      // unreadable => COLD
    }
    return out;
  }
  if (!supabase?.from) return out;
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    try {
      const { data, error } = await supabase
        .from("inbox_thread_state")
        .select("thread_key,last_inbound_at")
        .in("thread_key", keys.slice(i, i + CHUNK));
      if (error) continue;
      for (const r of Array.isArray(data) ? data : []) {
        if (clean(r?.thread_key)) out.set(clean(r.thread_key), r.last_inbound_at || null);
      }
    } catch {
      // unreadable chunk => those threads are COLD
    }
  }
  return out;
}

/** Dispatch-time class for one queue row (reference = now). Never throws; failure => COLD. */
export async function resolveSendClass(row = {}, deps = {}) {
  if (typeof deps.resolveSendClass === "function") return deps.resolveSendClass(row);
  const by_source = sourceSendClass(row);
  if (by_source) return by_source;
  const thread_key = sendRowThreadKey(row);
  const at = deps.now ? new Date(deps.now) : new Date();
  if (!thread_key) return classifySend(row, { at });
  try {
    const map = await loadThreadLastInbound(deps.supabase || null, [thread_key], deps);
    return classifySend(row, { last_inbound_at: map.get(thread_key) || null, at });
  } catch {
    return { send_class: SEND_CLASS.COLD, basis: "thread_lookup_failed" };
  }
}
