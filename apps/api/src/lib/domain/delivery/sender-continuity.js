/**
 * SENDER CONTINUITY (owner P0, rc-8.5.21 final directive, phase 1). THE one authority.
 *
 *   Once a seller conversation has an ESTABLISHED sender, every conversation send on it — AI
 *   replies, deterministic / template auto-replies, silence follow-ups, conversation-continuing
 *   nurtures, negotiation replies, operator replies — goes out from THAT number, under the same
 *   persona. Nothing (router, sticky fallback, Sender Routing 2.0 graph, rotation, a forged row)
 *   may substitute another number. A sender that cannot send (cooling / blocked / paused / not in
 *   the fleet / capped) is a VISIBLE HOLD (guard_reason `sender_unavailable`), never a fallback.
 *   Permanent sender loss is resolved ONLY by an explicit, audited operator reassignment
 *   (reassignThreadSender: actor + reason required, automation_events `sender_thread_reassigned`).
 *   New conversations (nothing established) may still use routing.
 *
 * ESTABLISHED SENDER of a thread (read fresh, never trusted from the row):
 *   1. inbox_thread_state.our_number — the sticky thread number (every seller-visible outbound and
 *      every inbound keeps it current; an approved reassignment rewrites it), unless it is the
 *      seller's own number (bad data);
 *   2. else the from number of the latest SELLER-SEEN outbound on the thread (send_queue sent /
 *      delivered);
 *   3. else nothing is established: a new conversation.
 *
 * WHICH ROWS ARE BOUND: every row on a thread EXCEPT a proactive campaign touch (a campaign's own
 * outreach keeps the campaign router's no-silent-replacement rule). A conversation row that merely
 * carries the campaign id for attribution (auto-reply, Inbox reply, follow-up, AI reply) is bound.
 *
 * ENFORCED AT (each layer names the same verdict): planning (persona-continuity resolver: AI replies,
 * follow-ups), materialization (followup-lifecycle: held sender_unavailable), queue insertion
 * (sms-engine insertSupabaseSendQueueRow: a mismatched sender is refused, the established sender is
 * stamped on the row), claim (validateSendQueueRowPreclaim: the stamp vs the row), dispatch
 * (selectAvailableTextgridNumber: no routing for a bound row; ineligible ⇒ visible hold), the FINAL
 * check inside the transport seam (dispatchSellerQueueRow runtime authority, per attempt, immediately
 * before provider submission), and crash recovery / retry (the row keeps its sender; the next attempt
 * passes the same checks). Release after recovery: releaseSenderContinuityHolds (revalidates the
 * latest conversation state, suppression, holds, eligibility and duplicate protection; newer seller
 * activity ⇒ superseded, never sent).
 */

import { isInboundAutoReply, isManualInboxSend, isUnknownAutoReply } from "@/lib/domain/queue/is-manual-inbox-send.js";

export const SENDER_CONTINUITY_VERSION = "sender-continuity.v1";
export const SENDER_UNAVAILABLE = "sender_unavailable";
export const SENDER_CONTINUITY_MISMATCH = "sender_continuity_mismatch";
export const SENDER_CONTINUITY_UNREADABLE = "sender_continuity_unreadable";
export const SENDER_REASSIGNED_EVENT = "sender_thread_reassigned";
export const SENDER_CONTINUITY_HOLD_STATUS = "blocked_sender_ineligible";
/** guard reasons the continuity hold carries (the sender-routing wake never lifts these) */
export const SENDER_CONTINUITY_HOLD_REASONS = Object.freeze(new Set([SENDER_UNAVAILABLE, SENDER_CONTINUITY_MISMATCH]));
export const SENDER_CONTINUITY_REASONS = Object.freeze(new Set([SENDER_UNAVAILABLE, SENDER_CONTINUITY_MISMATCH, SENDER_CONTINUITY_UNREADABLE]));

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const meta = (row) => (row?.metadata && typeof row.metadata === "object" ? row.metadata : {});

export function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

const CAMPAIGN_TOUCH_TYPES = new Set(["campaign_launch", "campaign_recovery"]);
const CONVERSATION_TYPES = new Set(["auto_reply", "followup", "follow_up", "ai_reply", "manual_reply", "nurture"]);
const CONVERSATION_SOURCES = new Set([
  "auto_reply", "seller_inbound_orchestrator", "inbox", "manual_inbox", "ai_conversation", "seller_followup_scheduler",
  "followup_lifecycle", "followup_execution", "negotiation", "negotiation_engine", "seller_autopilot",
]);

/** A row that continues a seller conversation (whatever campaign it is attributed to). Pure. */
export function isConversationContinuationRow(row = {}) {
  const m = meta(row);
  const type = lower(row.type || m.type);
  const source = lower(row.source || m.source);
  const message_type = lower(row.message_type || m.message_type).replace(/[\s-]+/g, "_");
  if (clean(m.followup_intent_id)) return true;
  if (lower(row.message_origin || m.message_origin) === "ai_generated") return true;
  if (CONVERSATION_TYPES.has(type) || CONVERSATION_SOURCES.has(source)) return true;
  if (message_type === "follow_up" || message_type === "followup" || message_type === "manual_reply") return true;
  if (clean(row.inbound_message_id || m.inbound_message_id || m.inbound_message_event_id)) return true;
  if (lower(row.queue_key).startsWith("inbound_auto_reply:") || lower(row.queue_key).startsWith("ai_conversation:") || lower(row.queue_key).startsWith("fui:")) return true;
  return isInboundAutoReply(row) || isUnknownAutoReply(row) || isManualInboxSend(row);
}

/** A campaign's own proactive outreach (first touch / sequence touch / recovery). Pure. */
export function isProactiveCampaignTouch(row = {}) {
  if (!clean(row.campaign_id || meta(row).campaign_id)) return false;
  if (isConversationContinuationRow(row)) return false;
  return true;
}

/** Is this row bound by the continuity rule (when its thread has an established sender)? Pure. */
export function isContinuityBoundRow(row = {}) {
  return !isProactiveCampaignTouch(row);
}

/** The seller thread a row belongs to: the stored thread_key, else the destination phone. */
export function rowThreadKey(row = {}) {
  return clean(row.thread_key || meta(row).thread_key) || normalizePhone(row.to_phone_number || row.phone_number || row.to) || "";
}

async function defaultDb(deps = {}) {
  if (deps.supabase?.from) return deps.supabase;
  if (deps.supabaseClient?.from) return deps.supabaseClient;
  if (deps.noDefaultDb) return null;
  try {
    const { hasSupabaseConfig, supabase } = await import("@/lib/supabase/client.js");
    return hasSupabaseConfig() ? supabase : null;
  } catch {
    return null;
  }
}

const rowsOf = (r) => (Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : []);

const TEST_RESOLVER_KEY = Symbol.for("leadcommand.sender_continuity.test_resolver");
/**
 * Test seam (the automation-hold precedent): install a resolver (thread_key, { to_phone_number }) =>
 * { sender, source } | string | null | { ok:false }. null restores production behaviour. The legacy
 * suites' bespoke Supabase fakes cannot answer the thread-state read; the critical-test environment
 * installs "nothing established" for them and the continuity suites clear it to run the real reads.
 */
export function __setSenderContinuityResolverForTests(fn = null) {
  if (typeof fn === "function") globalThis[TEST_RESOLVER_KEY] = fn;
  else delete globalThis[TEST_RESOLVER_KEY];
}

/**
 * The thread's ESTABLISHED sender, read fresh.
 * @returns {Promise<{ ok: true, established: boolean, sender: string|null, source: string|null } | { ok: false, reason: string }>}
 *   ok:false = unreadable (callers fail closed: defer / hold, never send on a guess).
 *   deps.loadEstablishedSender(thread_key, { to_phone_number }) is the injection seam.
 */
export async function loadEstablishedSender({ thread_key = null, to_phone_number = null } = {}, deps = {}) {
  const key = clean(thread_key) || normalizePhone(to_phone_number);
  if (!key) return { ok: true, established: false, sender: null, source: null };
  const seller = normalizePhone(to_phone_number || key);
  const injected = typeof deps.loadEstablishedSender === "function" ? deps.loadEstablishedSender : typeof globalThis[TEST_RESOLVER_KEY] === "function" ? globalThis[TEST_RESOLVER_KEY] : null;
  if (injected) {
    try {
      const got = await injected(key, { to_phone_number: seller });
      if (got && got.ok === false) return { ok: false, reason: clean(got.reason) || SENDER_CONTINUITY_UNREADABLE };
      const phone = normalizePhone(typeof got === "string" ? got : got?.sender);
      return phone && phone !== seller
        ? { ok: true, established: true, sender: phone, source: clean(got?.source) || "injected" }
        : { ok: true, established: false, sender: null, source: null };
    } catch {
      return { ok: false, reason: SENDER_CONTINUITY_UNREADABLE };
    }
  }
  const db = await defaultDb(deps);
  if (!db) return { ok: true, established: false, sender: null, source: "no_database" };
  try {
    const keys = [...new Set([key, seller].filter(Boolean))];
    const state = await db.from("inbox_thread_state").select("thread_key,our_number").in("thread_key", keys).limit(5);
    if (state?.error) return { ok: false, reason: SENDER_CONTINUITY_UNREADABLE };
    const ours = rowsOf(state).map((r) => normalizePhone(r?.our_number)).find((p) => p && p !== seller) || null;
    if (ours) return { ok: true, established: true, sender: ours, source: "thread_sticky" };
    const seen = await db
      .from("send_queue")
      .select("from_phone_number,queue_status,created_at")
      .in("thread_key", keys)
      .in("queue_status", ["sent", "delivered"])
      .order("created_at", { ascending: false })
      .limit(10);
    if (seen?.error) return { ok: false, reason: SENDER_CONTINUITY_UNREADABLE };
    const last = rowsOf(seen).map((r) => normalizePhone(r?.from_phone_number)).find((p) => p && p !== seller) || null;
    if (last) return { ok: true, established: true, sender: last, source: "last_seller_seen_outbound" };
    return { ok: true, established: false, sender: null, source: null };
  } catch {
    return { ok: false, reason: SENDER_CONTINUITY_UNREADABLE };
  }
}

/**
 * THE continuity verdict for a row about to use `from` (default: the row's own from number).
 * @returns {Promise<{ applies: boolean, established: boolean, ok: boolean, reason: string|null, deferred?: boolean,
 *   established_sender: string|null, established_source: string|null, from: string|null }>}
 *   applies:false — not a bound row (proactive campaign touch) or no thread.
 *   established:false — a new conversation: routing may choose.
 *   ok:false + reason sender_continuity_mismatch — the row names a different number (forged / stale):
 *     refused, never sent, never "corrected".
 *   ok:false + reason sender_continuity_unreadable + deferred — fail closed.
 *   A row with NO from on an established thread is ok: it is bound to the established sender.
 */
export async function evaluateSenderContinuity(row = {}, { from = undefined } = {}, deps = {}) {
  const thread_key = rowThreadKey(row);
  const intended = normalizePhone(from === undefined ? row.from_phone_number : from) || null;
  const base = { applies: false, established: false, ok: true, reason: null, established_sender: null, established_source: null, from: intended, version: SENDER_CONTINUITY_VERSION };
  if (!thread_key || !isContinuityBoundRow(row)) return base;
  const est = await loadEstablishedSender({ thread_key, to_phone_number: row.to_phone_number }, deps);
  if (!est.ok) return { ...base, applies: true, ok: false, reason: SENDER_CONTINUITY_UNREADABLE, deferred: true };
  if (!est.established) return { ...base, applies: true };
  const out = { ...base, applies: true, established: true, established_sender: est.sender, established_source: est.source };
  if (intended && intended !== est.sender) return { ...out, ok: false, reason: SENDER_CONTINUITY_MISMATCH };
  return out;
}

/** The stamp the canonical writer puts on a bound row (the claim-time check compares against it). */
export function continuityStamp(verdict = {}, at = new Date().toISOString()) {
  if (!verdict?.applies || !verdict.established || !verdict.established_sender) return null;
  return { sender: verdict.established_sender, source: verdict.established_source, checked_at: at, version: SENDER_CONTINUITY_VERSION };
}

/** Claim-time (pure): a bound row's from number must still be the sender the writer stamped. */
export function checkContinuityStamp(row = {}) {
  const stamp = meta(row).sender_continuity;
  if (!stamp || typeof stamp !== "object" || !clean(stamp.sender)) return { ok: true, reason: null };
  if (!isContinuityBoundRow(row)) return { ok: true, reason: null };
  const from = normalizePhone(row.from_phone_number);
  if (from && from !== normalizePhone(stamp.sender)) return { ok: false, reason: SENDER_CONTINUITY_MISMATCH };
  return { ok: true, reason: null };
}

// ── human-approved reassignment (never automatic) ──────────────────────────

const AUTOMATED_ACTORS = /^(system|auto|automation|cron|router|sender_continuity|sender_routing|queue|runner|dispatcher|worker|ai|model)(\b|[:_-])/i;

/**
 * An OPERATOR reassigns a thread's sender after a permanent loss. Explicit and audited:
 *   actor (a named operator — never system / router / cron / AI), reason, and an approval reference
 *   are required; the new number must be in the fleet and eligible; the audit event
 *   (automation_events `sender_thread_reassigned`) is written FIRST and the move is refused if it
 *   cannot be; inbox_thread_state.our_number moves compare-and-set on the old value; the thread's
 *   HELD (never sent) continuity rows are re-bound to the new number and stay held, so the release
 *   sweep revalidates each one before anything sends.
 * deps: supabase, now, loadFleetRow(phone), loadBlockedSenders(), evaluateEligibility(row, ctx), persistEvent(event)
 */
export async function reassignThreadSender({ thread_key, to, actor, reason, approval_ref } = {}, deps = {}) {
  const key = clean(thread_key);
  const target = normalizePhone(to);
  const who = clean(actor);
  const why = clean(reason);
  const ref = clean(approval_ref);
  if (!key || !target) return { ok: false, reason: "reassignment_target_required" };
  if (!who || AUTOMATED_ACTORS.test(who)) return { ok: false, reason: "reassignment_requires_named_operator" };
  if (!why) return { ok: false, reason: "reassignment_reason_required" };
  if (!ref) return { ok: false, reason: "reassignment_approval_required" };
  const db = await defaultDb(deps);
  if (!db) return { ok: false, reason: "reassignment_database_unavailable" };
  const now = deps.now ? new Date(deps.now).toISOString() : new Date().toISOString();

  const est = await loadEstablishedSender({ thread_key: key }, { ...deps, supabase: db });
  if (!est.ok) return { ok: false, reason: SENDER_CONTINUITY_UNREADABLE };
  const from = est.sender || null;
  if (from === target) return { ok: false, reason: "reassignment_no_change", sender: from };

  // the new number must be able to send (the same canonical eligibility every send path uses)
  try {
    const { evaluateSenderDispatchEligibility, loadDispatchBlockedSenders } = await import("@/lib/domain/delivery/sender-dispatch-eligibility.js");
    const blocked = typeof deps.loadBlockedSenders === "function" ? await deps.loadBlockedSenders() : await loadDispatchBlockedSenders({ getSystemValue: deps.getSystemValue, env: deps.env });
    if (!blocked) return { ok: false, reason: "sender_blocklist_unreadable" };
    let fleet = null;
    if (typeof deps.loadFleetRow === "function") fleet = await deps.loadFleetRow(target);
    else {
      const r = await db.from("textgrid_numbers").select("*").eq("phone_number", target).limit(1);
      if (r?.error) return { ok: false, reason: "reassignment_target_unreadable" };
      fleet = rowsOf(r)[0] || null;
    }
    const v = evaluateSenderDispatchEligibility(fleet, { blocked, phone: target, now: new Date(now), send_class: "conversational" });
    if (!v.ok) return { ok: false, reason: "reassignment_target_ineligible", target_reason: v.reason };
  } catch {
    return { ok: false, reason: "reassignment_target_unreadable" };
  }

  const event = {
    event_type: SENDER_REASSIGNED_EVENT,
    source: "operator_sender_reassignment",
    conversation_thread_id: key,
    payload: { thread_key: key, from_phone_number: from, to_phone_number: target, reason: why, actor: who, approval_ref: ref, at: now, version: SENDER_CONTINUITY_VERSION },
  };
  try {
    if (typeof deps.persistEvent === "function") {
      const r = await deps.persistEvent(event);
      if (r && r.ok === false) return { ok: false, reason: "reassignment_audit_unwritable" };
    } else {
      const ins = await db.from("automation_events").insert({ event_type: event.event_type, source: event.source, conversation_thread_id: key, payload: event.payload, created_at: now }).select("id").limit(1);
      if (ins?.error) return { ok: false, reason: "reassignment_audit_unwritable" };
    }
  } catch {
    return { ok: false, reason: "reassignment_audit_unwritable" };
  }

  // compare-and-set: only from the sender the audit names
  let q = db.from("inbox_thread_state").update({ our_number: target, updated_at: now }).eq("thread_key", key);
  q = from ? q.eq("our_number", from) : q.is("our_number", null);
  const moved = await q.select("thread_key");
  if (moved?.error || !rowsOf(moved).length) return { ok: false, reason: "reassignment_conflict", audited: true };

  // re-bind the thread's held (never sent) continuity rows; they stay held for the release sweep
  let rebound = 0;
  const held = await db.from("send_queue").select("id,metadata,from_phone_number").eq("thread_key", key).eq("queue_status", SENDER_CONTINUITY_HOLD_STATUS).in("guard_reason", [...SENDER_CONTINUITY_HOLD_REASONS]).limit(100);
  for (const r of rowsOf(held)) {
    const m = meta(r);
    const upd = await db.from("send_queue").update({
      from_phone_number: target,
      textgrid_number_id: null,
      metadata: { ...m, sender_continuity: { ...(m.sender_continuity || {}), sender: target, source: "operator_reassignment", checked_at: now, version: SENDER_CONTINUITY_VERSION }, sender_reassignment: { from: r.from_phone_number || from, to: target, actor: who, approval_ref: ref, at: now } },
      updated_at: now,
    }).eq("id", r.id).eq("queue_status", SENDER_CONTINUITY_HOLD_STATUS).select("id");
    if (!upd?.error && rowsOf(upd).length) rebound += 1;
  }
  return { ok: true, from, to: target, actor: who, approval_ref: ref, rebound_held_rows: rebound, event: event.event_type };
}

// ── the FINAL authoritative check (inside the transport seam, per attempt) ──

const strip = (row) => (row ? { ...row, messages_sent_today: 0, messages_sent_today_total: 0, daily_limit: null } : row);

/**
 * Immediately before provider submission: the number about to be used must be the thread's
 * established sender (read fresh), and that sender must still be able to send (operator blocklist,
 * fleet, status / health / cooling — the caps were applied at selection moments earlier). Not a
 * bound row / a new conversation ⇒ ok. Unreadable ⇒ refused (fail closed).
 * deps: supabase, loadEstablishedSender, loadOutboundNumberByPhone, loadDispatchBlockedSenders, getSystemValue, env, now
 * @returns {Promise<{ ok: boolean, reason: string|null, sender_reason?: string|null, verdict: object }>}
 */
export async function finalSenderContinuityCheck(queue_row = {}, { from = null } = {}, deps = {}) {
  const verdict = await evaluateSenderContinuity(queue_row, { from }, deps);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, verdict };
  if (!verdict.applies || !verdict.established) return { ok: true, reason: null, verdict };
  const sender = verdict.established_sender;
  try {
    const { evaluateSenderDispatchEligibility, loadDispatchBlockedSenders } = await import("@/lib/domain/delivery/sender-dispatch-eligibility.js");
    const blocked = typeof deps.loadDispatchBlockedSenders === "function" ? await deps.loadDispatchBlockedSenders() : await loadDispatchBlockedSenders({ getSystemValue: deps.getSystemValue, env: deps.env });
    if (!blocked) return { ok: false, reason: SENDER_CONTINUITY_UNREADABLE, sender_reason: "sender_blocklist_unreadable", verdict };
    let fleet = null;
    if (typeof deps.loadOutboundNumberByPhone === "function") fleet = await deps.loadOutboundNumberByPhone(sender);
    else {
      const db = await defaultDb(deps);
      if (!db) return { ok: true, reason: null, verdict };
      const r = await db.from("textgrid_numbers").select("*").eq("phone_number", sender).limit(1);
      if (r?.error) return { ok: false, reason: SENDER_CONTINUITY_UNREADABLE, sender_reason: "outbound_number_eligibility_unavailable", verdict };
      fleet = rowsOf(r)[0] || null;
    }
    const v = evaluateSenderDispatchEligibility(strip(fleet), { blocked, phone: sender, now: deps.now ? new Date(deps.now) : new Date(), send_class: "conversational" });
    if (!v.ok) return { ok: false, reason: SENDER_UNAVAILABLE, sender_reason: v.reason, verdict };
    return { ok: true, reason: null, verdict };
  } catch {
    return { ok: false, reason: SENDER_CONTINUITY_UNREADABLE, sender_reason: "outbound_number_eligibility_unavailable", verdict };
  }
}
