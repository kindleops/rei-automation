/**
 * RELEASE SENDER-CONTINUITY HOLDS (owner P0, rc-8.5.21; delivery/sender-continuity.js).
 *
 * A conversation row whose thread sender could not send is parked VISIBLY, still bound to that
 * sender: queue_status 'blocked_sender_ineligible', guard_reason 'sender_unavailable' (or
 * 'sender_continuity_mismatch' for a row that named another number). The sender-routing wake never
 * lifts these reasons. This sweep is the ONLY automatic way back, and it never sends: a release
 * returns the row to 'queued' (compare-and-set on the held state) and the runner re-applies every
 * gate — including the final continuity check inside the transport seam.
 *
 * Per held row, in order (the first verdict that applies wins):
 *   already dispatched   the row carries a provider id / sent_at, or an attempt for it exists    → superseded (duplicate protection)
 *   newer seller activity  the seller wrote after the row was planned                             → superseded (never sent)
 *   newer outbound         another message already continued the thread after the row            → superseded (duplicate protection)
 *   sender continuity      the row's number is not the thread's established sender (now)         → stays held
 *   sender eligibility     the established sender still cannot send                              → stays held
 *   automation hold        a registry hold on the thread / property / owner                       → stays held (reason recorded)
 *   send-time guard        STOP / opt-out / wrong number / property denial / declined            → blocked (terminal, reason recorded)
 *   stale reply            an immediate reply older than the reply window                        → stays held, relabelled for review
 *   otherwise              → released to 'queued'
 * Unreadable facts never release (fail closed). Kill switch: env SENDER_CONTINUITY_RELEASE=off.
 */

import { SENDER_CONTINUITY_HOLD_REASONS, SENDER_CONTINUITY_HOLD_STATUS, SENDER_CONTINUITY_VERSION, evaluateSenderContinuity, normalizePhone, rowThreadKey } from "@/lib/domain/delivery/sender-continuity.js";

export const SENDER_HOLD_STALE_REVIEW_REASON = "sender_unavailable_stale_needs_review";
export const SENDER_HOLD_SUPERSEDED_REASON = "superseded_by_newer_seller_activity";
export const SENDER_HOLD_DUPLICATE_REASON = "superseded_duplicate_already_dispatched";
export const SENDER_HOLD_NEWER_OUTBOUND_REASON = "superseded_by_newer_outbound";
/** an immediate reply (answering an inbound) is not sent later than this after it was planned */
export const SENDER_HOLD_REPLY_MAX_AGE_MINUTES = 60;
const BATCH = 50;

const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());
const lower = (v) => clean(v).toLowerCase();
const ts = (v) => { const t = Date.parse(clean(v)); return Number.isFinite(t) ? t : null; };
const meta = (row) => (row?.metadata && typeof row.metadata === "object" ? row.metadata : {});
const rowsOf = (r) => (Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : []);

/** An immediate reply to an inbound (auto-reply / AI reply / unknown-inbound reply), not a scheduled follow-up. */
export function isImmediateReplyRow(row = {}) {
  const m = meta(row);
  if (clean(m.followup_intent_id)) return false;
  const type = lower(row.type);
  const source = lower(row.source || m.source);
  const key = lower(row.queue_key);
  return type === "auto_reply" || source === "ai_conversation" || lower(row.message_origin || m.message_origin) === "ai_generated" ||
    key.startsWith("inbound_auto_reply:") || key.startsWith("ai_conversation:") || Boolean(clean(row.inbound_message_id));
}

/**
 * Pure verdict for one held row from loaded facts.
 * facts: { thread: { last_inbound_at, last_outbound_at }|null, newer_outbound: bool, attempt_dispatched: bool,
 *          continuity: verdict, sender_eligible: bool, sender_reason, hold: { held, reason }|null, guard: { blocked, reason }|null }
 * @returns {{ action: 'release'|'hold'|'supersede'|'block'|'review'|'skip', reason: string }}
 */
export function decideSenderHoldRelease(row = {}, facts = {}, { now = new Date(), reply_max_age_minutes = SENDER_HOLD_REPLY_MAX_AGE_MINUTES } = {}) {
  if (clean(row.queue_status) !== SENDER_CONTINUITY_HOLD_STATUS) return { action: "skip", reason: "not_held" };
  if (!SENDER_CONTINUITY_HOLD_REASONS.has(clean(row.guard_reason))) return { action: "skip", reason: "not_a_sender_continuity_hold" };
  if (clean(row.provider_message_id) || clean(row.textgrid_message_id) || clean(row.sent_at) || facts.attempt_dispatched) {
    return { action: "supersede", reason: SENDER_HOLD_DUPLICATE_REASON };
  }
  const planned = ts(row.created_at);
  const lastIn = ts(facts.thread?.last_inbound_at);
  if (planned !== null && lastIn !== null && lastIn > planned) return { action: "supersede", reason: SENDER_HOLD_SUPERSEDED_REASON };
  if (facts.newer_outbound) return { action: "supersede", reason: SENDER_HOLD_NEWER_OUTBOUND_REASON };
  const c = facts.continuity;
  if (!c || !c.ok) return { action: "hold", reason: c?.reason || "sender_continuity_unreadable" };
  if (c.applies && c.established && normalizePhone(row.from_phone_number) && normalizePhone(row.from_phone_number) !== c.established_sender) {
    return { action: "hold", reason: "sender_continuity_mismatch" };
  }
  if (!facts.sender_eligible) return { action: "hold", reason: `sender_still_unavailable:${clean(facts.sender_reason) || "ineligible"}` };
  if (facts.hold?.held) return { action: "hold", reason: `automation_hold:${clean(facts.hold.reason) || "hold"}` };
  if (facts.guard?.blocked) return { action: "block", reason: `send_time_guard:${clean(facts.guard.reason) || "blocked"}` };
  if (isImmediateReplyRow(row)) {
    const reference = now instanceof Date ? now.getTime() : Date.parse(now);
    if (planned === null || reference - planned > reply_max_age_minutes * 60_000) return { action: "review", reason: SENDER_HOLD_STALE_REVIEW_REASON };
  }
  return { action: "release", reason: "sender_available_conversation_current" };
}

async function defaultDb(deps) {
  if (deps.supabase?.from) return deps.supabase;
  const { hasSupabaseConfig, supabase } = await import("@/lib/supabase/client.js");
  return hasSupabaseConfig() ? supabase : null;
}

/** Load every fact for one row (fail closed: an unreadable fact is reported, never assumed clean). */
async function loadFacts(db, row, deps) {
  const thread_key = rowThreadKey(row);
  const facts = {};
  const t = await db.from("inbox_thread_state").select("thread_key,last_inbound_at,last_outbound_at").eq("thread_key", thread_key).limit(1);
  if (t?.error) throw new Error("thread_state_unreadable");
  facts.thread = rowsOf(t)[0] || null;
  const since = clean(row.created_at) || new Date(0).toISOString();
  const out = await db.from("send_queue").select("id,queue_status,created_at,sent_at").eq("thread_key", thread_key).in("queue_status", ["sent", "delivered"]).gt("sent_at", since).limit(5);
  if (out?.error) throw new Error("thread_outbound_unreadable");
  facts.newer_outbound = rowsOf(out).some((r) => clean(r.id) !== clean(row.id));
  const att = await db.from("seller_communication_attempts").select("id,provider_message_id,provider_request_started_at").eq("queue_row_id", String(row.id)).limit(5);
  // the attempt ledger is the duplicate authority when present; absent table = no attempts recorded
  facts.attempt_dispatched = att?.error ? false : rowsOf(att).some((a) => clean(a.provider_message_id) || clean(a.provider_request_started_at));
  facts.continuity = await evaluateSenderContinuity(row, {}, { ...deps, supabase: db });
  const sender = facts.continuity?.established_sender || normalizePhone(row.from_phone_number);
  const { evaluateSenderDispatchEligibility, loadDispatchBlockedSenders } = await import("@/lib/domain/delivery/sender-dispatch-eligibility.js");
  const blocked = typeof deps.loadDispatchBlockedSenders === "function" ? await deps.loadDispatchBlockedSenders() : await loadDispatchBlockedSenders({ getSystemValue: deps.getSystemValue, env: deps.env });
  if (!blocked) throw new Error("sender_blocklist_unreadable");
  let fleet = null;
  if (typeof deps.loadOutboundNumberByPhone === "function") fleet = await deps.loadOutboundNumberByPhone(sender);
  else {
    const f = await db.from("textgrid_numbers").select("*").eq("phone_number", sender).limit(1);
    if (f?.error) throw new Error("fleet_unreadable");
    fleet = rowsOf(f)[0] || null;
  }
  const v = evaluateSenderDispatchEligibility(fleet ? { ...fleet, messages_sent_today: 0, messages_sent_today_total: 0 } : null, { blocked, phone: sender, now: deps.now ? new Date(deps.now) : new Date(), send_class: "conversational" });
  facts.sender_eligible = v.ok;
  facts.sender_reason = v.reason || null;
  if (typeof deps.holdCheck === "function") facts.hold = await deps.holdCheck({ thread_key, property_id: row.property_id || null, master_owner_id: row.master_owner_id || null });
  else {
    const { resolveAutomationHold, HOLD_CAPABILITIES } = await import("@/lib/domain/holds/automation-hold.js");
    const h = await resolveAutomationHold({ thread_key, property_id: row.property_id || null, master_owner_id: row.master_owner_id || null }, { capability: HOLD_CAPABILITIES.OUTBOUND_SEND, supabase: db });
    facts.hold = { held: h?.held !== false, reason: h?.fail_closed ? "lookup_error" : h?.holds?.[0]?.hold_type || h?.reason || null };
  }
  if (typeof deps.runSendTimeContactGuard === "function") facts.guard = await deps.runSendTimeContactGuard(row);
  else {
    const { loadSendTimeContactFacts, evaluateSendTimeContactGuard } = await import("@/lib/domain/queue/send-time-contact-guard.js");
    facts.guard = evaluateSendTimeContactGuard(row, await loadSendTimeContactFacts(db, row));
  }
  return facts;
}

/**
 * One sweep. dry_run reports decisions without writing.
 * deps: supabase, now, loadHeldRows, loadFacts(row), applyDecision(id, payload, decision), holdCheck, runSendTimeContactGuard,
 *       loadOutboundNumberByPhone, loadDispatchBlockedSenders, getSystemValue, env, notify
 */
export async function releaseSenderContinuityHolds({ dry_run = false, limit = BATCH } = {}, deps = {}) {
  const env = deps.env || process.env;
  if (lower(env.SENDER_CONTINUITY_RELEASE) === "off") return { ok: true, skipped: true, reason: "disabled_by_env" };
  const db = await defaultDb(deps);
  if (!db && typeof deps.loadHeldRows !== "function") return { ok: true, skipped: true, reason: "no_database" };
  const now = deps.now ? new Date(deps.now) : new Date();
  const at = now.toISOString();
  const rows = typeof deps.loadHeldRows === "function"
    ? await deps.loadHeldRows()
    : rowsOf(await db.from("send_queue").select("*").eq("queue_status", SENDER_CONTINUITY_HOLD_STATUS).in("guard_reason", [...SENDER_CONTINUITY_HOLD_REASONS]).order("created_at", { ascending: true }).limit(limit));
  const outcomes = [];
  for (const row of rows) {
    let decision;
    try {
      const facts = typeof deps.loadFacts === "function" ? await deps.loadFacts(row) : await loadFacts(db, row, deps);
      decision = decideSenderHoldRelease(row, facts, { now });
    } catch (error) {
      decision = { action: "hold", reason: `facts_unreadable:${clean(error?.message).slice(0, 60) || "error"}` };
    }
    const outcome = { id: row.id, ...decision, applied: false };
    outcomes.push(outcome);
    if (dry_run || decision.action === "skip") continue;
    const m = meta(row);
    const record = { decided_at: at, action: decision.action, reason: decision.reason, version: SENDER_CONTINUITY_VERSION };
    let payload;
    if (decision.action === "release") {
      payload = { queue_status: "queued", guard_status: null, guard_reason: null, failed_reason: null, is_locked: false, locked_at: null, lock_token: null, updated_at: at, metadata: { ...m, skip_reason: null, final_queue_status: null, sender_continuity_release: { ...record, previous_reason: clean(row.guard_reason) } } };
    } else if (decision.action === "supersede") {
      // the follow-up intent sync reads a reason starting "superseded" as SUPERSEDED (never failed)
      payload = { queue_status: "cancelled", guard_status: "blocked", guard_reason: decision.reason, failed_reason: decision.reason, is_locked: false, locked_at: null, lock_token: null, updated_at: at, metadata: { ...m, skip_reason: decision.reason, cancellation_reason: decision.reason, superseded_by_newer_inbound: decision.reason === SENDER_HOLD_SUPERSEDED_REASON, final_queue_status: "cancelled", finalized_at: at, sender_continuity_release: record } };
    } else if (decision.action === "block") {
      payload = { queue_status: "blocked", guard_status: "blocked", guard_reason: decision.reason, failed_reason: decision.reason, is_locked: false, locked_at: null, lock_token: null, updated_at: at, metadata: { ...m, skip_reason: decision.reason, final_queue_status: "blocked", finalized_at: at, sender_continuity_release: record } };
    } else if (decision.action === "review") {
      payload = { guard_reason: SENDER_HOLD_STALE_REVIEW_REASON, failed_reason: SENDER_HOLD_STALE_REVIEW_REASON, updated_at: at, metadata: { ...m, skip_reason: SENDER_HOLD_STALE_REVIEW_REASON, sender_continuity_release: record } };
    } else {
      // stays held: record the latest verdict on the row (visible), nothing else changes
      payload = { updated_at: at, metadata: { ...m, sender_continuity_release: record } };
    }
    try {
      if (typeof deps.applyDecision === "function") outcome.applied = Boolean(await deps.applyDecision(row.id, payload, decision));
      else {
        const r = await db.from("send_queue").update(payload).eq("id", row.id).eq("queue_status", SENDER_CONTINUITY_HOLD_STATUS).eq("guard_reason", clean(row.guard_reason)).select("id");
        outcome.applied = !r?.error && rowsOf(r).length === 1;
      }
    } catch {
      outcome.applied = false;
    }
  }
  const count = (a) => outcomes.filter((o) => o.action === a && (dry_run || o.applied)).length;
  return { ok: true, dry_run, examined: rows.length, released: count("release"), superseded: count("supersede"), blocked: count("block"), review: count("review"), still_held: count("hold"), outcomes };
}
