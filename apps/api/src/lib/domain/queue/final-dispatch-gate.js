// ─── final-dispatch-gate.js ──────────────────────────────────────────────────
// THE ONE FINAL DISPATCH GATE (founder P0, 2026-11-23, items 1, 2, 5).
//
// Every seller-visible SMS reaches TextGrid through the canonical seam
// (canonical-communication-dispatch.js#executeSellerCommunicationAttempt). The seam
// calls `evaluateRuntimeAuthority` on EVERY attempt, immediately before it
// allocates the attempt and calls the provider. Both bridges into the seam —
// dispatch-seller-queue-row.js (queue runner, auto-reply, follow-ups, campaign
// feeder rows, retries, Cockpit send_one, internal send-now) and
// dispatch-manual-operator-send.js (inbox / Cockpit / map manual sends) — now
// answer that callback with THIS gate, so there is one set of checks, in one
// place, re-read fresh at the last hop:
//
//   1. execution authorization   brake state NOW (canonical or manual authority)
//   2. queue row status          paused_operator_review / quarantine / held /
//                                paused_* / blocked_* / terminal never dispatch
//   3. no automatic reactivation a row that was ever held, paused, brake-expired,
//                                cap-parked, delivery-retry-cloned or recovered
//                                needs an explicit, fresh, per-row authorization
//   4. contact identity          thread_key and destination are the same E.164
//   5. duplicate-send identity   queue rows must carry the atomic claim token;
//                                manual sends an operator_action_id (the seam's
//                                attempt allocation is the atomic second half)
//   6. opt-out + hard suppression live sms_suppression_list + automation_suppressions;
//                                a read failure REFUSES (automated AND manual)
//   7. archive + terminal status archived thread, opted out / wrong number /
//                                blocking contactability, legal and repair holds
//   8. paused review / quarantine on the thread (automated); quarantine (manual)
//   9. automation holds          automated: any active hold; manual: legal /
//                                repair / permanent / precautionary / unreadable
//  10. campaign state            a row's campaign must be live right now
//  11. quiet hours               automated sends: recipient zone required
//                                (unknown = hold), inside the window unless it is
//                                an in-session reply
//  12. sender continuity         the caller's existing final check, run here
//
// Every refusal is a reason string; the seam records it and the provider is
// never called. Nothing here writes, so the gate is safe to call from release
// paths (Cockpit approve / retry) as a preview with `mode: 'release'`.
//
// FAIL CLOSED. Any read error, any missing reader, any thrown check refuses.
//
// TEST RUNTIME. Exactly like enqueue-contact-restrictions.js, the live-fact reads
// (suppression, thread state, holds, campaign) need a real client: under
// NODE_ENV=test with a fake client they are skipped unless a suite enforces them
// (__setFinalDispatchGateModeForTests('enforce')), because ~800 legacy suites
// drive the runner with fakes that cannot answer these reads. Production
// (NODE_ENV !== 'test') ALWAYS reads. The row-level checks (2-5) and the
// authority (1) and sender continuity (12) run in every runtime.

import { normalizePhone } from "@/lib/utils/phones.js";

export const FINAL_DISPATCH_GATE_VERSION = "final_dispatch_gate_v1";

// A reauthorization is a per-row operator decision. It expires: an approval is
// not a standing licence, and a seller can reply, opt out or move on after it.
export const REAUTHORIZATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const GATE_REASONS = Object.freeze({
  AUTHORITY_UNAVAILABLE: "final_gate_authority_unavailable",
  ROW_NOT_DISPATCHABLE: "final_gate_row_status_not_dispatchable",
  PAUSED_OPERATOR_REVIEW: "final_gate_paused_operator_review",
  QUARANTINED: "final_gate_quarantined",
  REAUTHORIZATION_REQUIRED: "final_gate_reauthorization_required",
  REAUTHORIZATION_STALE: "final_gate_reauthorization_stale",
  IDENTITY_MISMATCH: "final_gate_contact_identity_mismatch",
  IDENTITY_UNPROVEN: "final_gate_contact_identity_unproven",
  CLAIM_MISSING: "final_gate_dispatch_claim_missing",
  OPERATOR_ACTION_MISSING: "final_gate_operator_action_missing",
  SUPPRESSION_UNREADABLE: "final_gate_suppression_unreadable",
  SUPPRESSED: "final_gate_phone_suppressed",
  AUTOMATION_SUPPRESSED: "final_gate_automation_suppression_active",
  THREAD_STATE_UNREADABLE: "final_gate_thread_state_unreadable",
  THREAD_ARCHIVED: "final_gate_thread_archived",
  THREAD_SUPPRESSED: "final_gate_thread_suppressed",
  THREAD_TERMINAL: "final_gate_thread_terminal",
  THREAD_PAUSED_REVIEW: "final_gate_thread_paused_review",
  THREAD_QUARANTINED: "final_gate_thread_quarantined",
  LEGAL_HOLD: "final_gate_legal_hold",
  REPAIR_HOLD: "final_gate_repair_hold",
  AUTOMATION_HOLD: "final_gate_automation_hold_active",
  AUTOMATION_HOLD_UNREADABLE: "final_gate_automation_hold_unreadable",
  CAMPAIGN_NOT_LIVE: "final_gate_campaign_not_live",
  CAMPAIGN_UNREADABLE: "final_gate_campaign_unreadable",
  QUIET_HOURS_UNEVALUATED: "final_gate_quiet_hours_unevaluated",
  TIMEZONE_UNKNOWN: "final_gate_recipient_timezone_unknown",
  OUTSIDE_QUIET_HOURS: "final_gate_outside_contact_window",
  SENDER_CONTINUITY_UNAVAILABLE: "final_gate_sender_continuity_unavailable",
  CHECK_THREW: "final_gate_check_failed",
  NO_CLIENT: "final_gate_no_database_client",
});

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const ts = (value) => {
  const t = Date.parse(clean(value));
  return Number.isFinite(t) ? t : null;
};
// Accepts a Date, an epoch-ms number or an ISO string. A number used to go
// through Date.parse(String(n)), which is NaN, so every numeric `now` silently
// became the wall clock and the 24 h reauthorization expiry could not be judged
// against the caller's time.
const toMs = (now) => {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return ts(now) ?? Date.now();
};

// ── queue row status ─────────────────────────────────────────────────────────

/** Review statuses, including the canonical containment status paused_operator_review. */
const PAUSED_REVIEW_STATUSES = new Set([
  "paused_operator_review",
  "paused_review",
  "operator_review",
  "needs_review",
  "review_hold",
]);
const QUARANTINE_STATUSES = new Set(["incident_quarantine", "quarantine", "quarantined"]);
const TERMINAL_STATUSES = new Set([
  "sent", "delivered", "failed", "cancelled", "canceled", "expired", "superseded",
  "archived", "opted_out", "duplicate_blocked", "blocked", "dead", "undeliverable",
]);

/** isPausedReview, shared: the row status OR its paused/guard reason names a review hold. */
export function isPausedReviewRow(row = {}) {
  const status = lower(row?.queue_status);
  if (PAUSED_REVIEW_STATUSES.has(status)) return true;
  const reasons = [row?.paused_reason, row?.guard_reason, row?.blocked_reason].map(lower);
  return reasons.some((r) => PAUSED_REVIEW_STATUSES.has(r));
}

export function isQuarantinedRow(row = {}) {
  const meta = obj(row?.metadata);
  return (
    QUARANTINE_STATUSES.has(lower(row?.queue_status)) ||
    QUARANTINE_STATUSES.has(lower(row?.blocked_reason)) ||
    meta.incident_quarantine === true ||
    meta.quarantine === true
  );
}

/** A status that must never reach the provider, whatever else is true. */
export function rowStatusRefusal(row = {}) {
  const status = lower(row?.queue_status);
  if (isPausedReviewRow(row)) return GATE_REASONS.PAUSED_OPERATOR_REVIEW;
  if (isQuarantinedRow(row)) return GATE_REASONS.QUARANTINED;
  if (!status) return null; // a manual send has no row status yet
  if (status === "held" || status.startsWith("paused") || status.startsWith("blocked") || TERMINAL_STATUSES.has(status)) {
    return `${GATE_REASONS.ROW_NOT_DISPATCHABLE}:${status}`;
  }
  return null;
}

// ── no automatic reactivation ────────────────────────────────────────────────

/**
 * Evidence that a row is historical: it was held, paused, parked, expired by a
 * brake, cloned by a retry engine or recovered from an expired row. Each entry
 * is { marker, at } (at may be null when the marker carries no time).
 *
 * The markers are written by the paths that used to revive rows on their own
 * (lifecycle reconcile, conversational cap release, campaign resume, delivery
 * retry, stale-expiration recovery, sender-continuity release, dispatch holds).
 * Those paths no longer make a row sendable; this is the dispatch-side proof
 * that, even if one did, the row cannot go out without a fresh authorization.
 */
export function rowHoldHistory(row = {}) {
  const m = obj(row?.metadata);
  const out = [];
  const add = (marker, at = null) => out.push({ marker, at: clean(at) || null });

  if (m.send_brake_hold === true || m.send_brake_held_at) add("send_brake_hold", m.send_brake_held_at);
  if (m.expired_due_to_send_brake === true) add("expired_due_to_send_brake", m.send_brake_held_at);
  if (m.send_brake_recovered_at) add("send_brake_recovered", m.send_brake_recovered_at);
  if (m.send_brake_cleared_at) add("send_brake_cleared", m.send_brake_cleared_at);
  if (m.held_through_send_brake) add("held_through_send_brake", obj(m.held_through_send_brake).at);
  if (m.conversational_cap_release) add("conversational_cap_release", obj(m.conversational_cap_release).released_at);
  if (m.conversational_cap_review) add("conversational_cap_review", obj(m.conversational_cap_review).reviewed_at);
  if (m.sender_continuity_release) add("sender_continuity_release", obj(m.sender_continuity_release).released_at || obj(m.sender_continuity_release).at);
  if (m.sender_continuity_hold) add("sender_continuity_hold", obj(m.sender_continuity_hold).at);
  if (clean(m.retry_of_queue_row_id)) add("delivery_retry_clone", row?.created_at);
  if (clean(m.supersedes_queue_row_id) && clean(m.recovered_from_failed_reason)) add("stale_expiration_recovery", m.recovered_at);
  if (m.campaign_resume_hold) add("campaign_resume_hold", obj(m.campaign_resume_hold).at);
  if (m.reauthorization_required) add("reauthorization_required", obj(m.reauthorization_required).at);
  if (m.dispatch_hold !== undefined && m.dispatch_hold !== null && m.dispatch_hold !== false) add("dispatch_hold", m.dispatch_hold_at);
  if (m.owner_release) add("owner_release", obj(m.owner_release).at);
  if (clean(row?.held_at)) add("held_at", row.held_at);
  // No time: updated_at moves on every claim, so it cannot date the pause.
  if (clean(row?.paused_reason)) add(`paused:${lower(row.paused_reason)}`, null);
  return out;
}

/**
 * Is there an explicit, fresh, per-row authorization that post-dates every
 * hold marker and every seller inbound? Only an operator path writes
 * `metadata.reauthorization` (Cockpit owner-release); no release path does.
 */
export function evaluateReauthorization(row = {}, { now = Date.now(), last_inbound_at = null, max_age_ms = REAUTHORIZATION_MAX_AGE_MS } = {}) {
  const history = rowHoldHistory(row);
  // The owner-release record is the authorization itself, not a hold to outlive.
  const holds = history.filter((h) => h.marker !== "owner_release");
  if (!holds.length) return { required: false, ok: true, history };

  const r = obj(obj(row?.metadata).reauthorization);
  const at = ts(r.at);
  if (!at || !clean(r.actor) || !clean(r.reason) || clean(r.queue_row_id) !== clean(row?.id)) {
    return { required: true, ok: false, reason: GATE_REASONS.REAUTHORIZATION_REQUIRED, history };
  }
  const nowMs = toMs(now);
  if (nowMs - at > max_age_ms) return { required: true, ok: false, reason: GATE_REASONS.REAUTHORIZATION_STALE, history, detail: "expired" };
  const newestHold = Math.max(0, ...holds.map((h) => ts(h.at) ?? 0));
  if (newestHold > at) return { required: true, ok: false, reason: GATE_REASONS.REAUTHORIZATION_STALE, history, detail: "hold_after_authorization" };
  const inbound = ts(last_inbound_at);
  if (inbound && inbound > at) return { required: true, ok: false, reason: GATE_REASONS.REAUTHORIZATION_STALE, history, detail: "seller_replied_after_authorization" };
  return { required: true, ok: true, history };
}

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * LeadCommand keys every thread by its E.164 number (inbox_thread_state UNIQUE
 * thread_key), so identity means: the thread this send belongs to IS the
 * destination. A queue row with no thread_key is judged as the destination's
 * thread (the canonical writer's own rule, sms-engine noncanonical_thread_key);
 * a manual send must name its thread, because an operator acts on a thread,
 * never on a bare number.
 */
export function contactIdentityRefusal({ to = null, thread_key = null, automated = true } = {}) {
  const dest = normalizePhone(to);
  if (!dest) return GATE_REASONS.IDENTITY_UNPROVEN;
  const key = clean(thread_key);
  if (!key) return automated ? null : GATE_REASONS.IDENTITY_UNPROVEN;
  const nkey = normalizePhone(key);
  if (!nkey || nkey !== dest) return GATE_REASONS.IDENTITY_MISMATCH;
  return null;
}

// ── thread facts ─────────────────────────────────────────────────────────────

const TERMINAL_THREAD_STATUSES = new Set([
  "opted_out", "opt_out", "dnc", "do_not_contact", "wrong_number", "wrong_person",
  "dead", "suppressed", "closed_lost", "not_owner",
]);
const BLOCKING_CONTACTABILITY = new Set([
  "opted_out", "opt_out", "dnc", "do_not_contact", "wrong_number", "wrong_person",
  "invalid", "invalid_number", "suppressed", "blocked", "no_contact", "hard_bounce",
]);

const LEGAL_RE = /legal/;
const REPAIR_RE = /repair|rehab/;

/** Thread-level refusal from a fresh inbox_thread_state row (null row = no evidence of a block). */
export function threadStateRefusal(thread = null, { automated = true } = {}) {
  if (!thread) return null;
  const meta = obj(thread.metadata);
  if (thread.is_archived === true || clean(thread.archived_at) && thread.is_archived !== false) return GATE_REASONS.THREAD_ARCHIVED;
  if (thread.is_suppressed === true || thread.opt_out === true) return GATE_REASONS.THREAD_SUPPRESSED;
  const status = lower(thread.status);
  if (TERMINAL_THREAD_STATUSES.has(status)) return `${GATE_REASONS.THREAD_TERMINAL}:${status}`;
  const contactability = lower(thread.contactability_status);
  if (BLOCKING_CONTACTABILITY.has(contactability)) return `${GATE_REASONS.THREAD_TERMINAL}:${contactability}`;
  const paused = lower(thread.paused_reason);
  if (LEGAL_RE.test(paused) || meta.legal_hold === true) return GATE_REASONS.LEGAL_HOLD;
  if (REPAIR_RE.test(paused) || meta.repair_hold === true || meta.rehab_hold === true) return GATE_REASONS.REPAIR_HOLD;
  if (meta.incident_quarantine === true || QUARANTINE_STATUSES.has(status)) return GATE_REASONS.THREAD_QUARANTINED;
  // An operator answering a thread in review is the purpose of review; automation is not.
  if (automated && (PAUSED_REVIEW_STATUSES.has(status) || PAUSED_REVIEW_STATUSES.has(paused))) return GATE_REASONS.THREAD_PAUSED_REVIEW;
  return null;
}

/** Hold types a manual send must also honour. Others (ownership attribution) stay manual-allowed. */
const MANUAL_BLOCKING_HOLD_TYPES = new Set(["legal_hold", "repair_hold", "rehab_hold", "permanent_exclusion", "precautionary_no_contact", "lookup_error"]);

export function automationHoldRefusal(hold = null, { automated = true } = {}) {
  if (!hold) return null;
  if (hold.fail_closed === true || hold.hold_type === "lookup_error") return GATE_REASONS.AUTOMATION_HOLD_UNREADABLE;
  if (hold.held !== true) return null;
  if (automated) return GATE_REASONS.AUTOMATION_HOLD;
  const type = lower(hold.hold_type);
  const reason = lower(hold.reason || hold.hold_reason);
  if (MANUAL_BLOCKING_HOLD_TYPES.has(type)) return LEGAL_RE.test(type) ? GATE_REASONS.LEGAL_HOLD : `${GATE_REASONS.AUTOMATION_HOLD}:${type}`;
  if (LEGAL_RE.test(reason)) return GATE_REASONS.LEGAL_HOLD;
  if (REPAIR_RE.test(reason) || REPAIR_RE.test(type)) return GATE_REASONS.REPAIR_HOLD;
  return null;
}

const LIVE_CAMPAIGN_STATUSES = new Set(["active", "live", "running", "live_limited", "scheduled"]);

// ── the pure decision ────────────────────────────────────────────────────────

/**
 * Pure: every check over already-loaded facts. Returns the FIRST refusal (the
 * order is the precedence the operator sees) plus every refusal for audit.
 *
 * facts = {
 *   path: 'queue' | 'manual',
 *   authority: { ok, reason }                         (required)
 *   row, to, thread_key, claim_token, operator_action_id,
 *   facts_loaded: boolean,                            (false only in test runtime)
 *   suppression: { suppressed, lookup_error, reason } | null,
 *   automation_suppression: { active, error } | null,
 *   thread: inbox_thread_state row | null, thread_error,
 *   hold: automation hold verdict | null,
 *   campaign: { status } | null, campaign_error,
 *   contact_window: { allowed, hold, timezone } | null, in_session_reply,
 *   sender_continuity: { ok, reason } | null,
 *   now,
 * }
 */
export function decideFinalDispatch(facts = {}) {
  const automated = facts.path !== "manual";
  const refusals = [];
  const push = (reason) => { if (reason) refusals.push(reason); };

  // 1. execution authorization (brake state now)
  if (!facts.authority || typeof facts.authority !== "object") push(GATE_REASONS.AUTHORITY_UNAVAILABLE);
  else if (facts.authority.ok !== true) push(clean(facts.authority.reason) || GATE_REASONS.AUTHORITY_UNAVAILABLE);

  const row = obj(facts.row);
  // 2. queue row status
  push(rowStatusRefusal(row));
  // 3. no automatic reactivation
  const reauth = evaluateReauthorization(row, { now: facts.now, last_inbound_at: facts.thread?.last_inbound_at || null });
  if (!reauth.ok) push(reauth.reason);
  // 4. contact identity
  push(contactIdentityRefusal({ to: facts.to, thread_key: facts.thread_key, automated }));
  // 5. duplicate-send identity (claim proof; the seam's allocation is atomic)
  if (automated && !clean(facts.claim_token)) push(GATE_REASONS.CLAIM_MISSING);
  if (!automated && !clean(facts.operator_action_id)) push(GATE_REASONS.OPERATOR_ACTION_MISSING);

  if (facts.facts_loaded !== false) {
    // 6. opt-out + hard suppression (fail closed for BOTH automated and manual)
    const s = facts.suppression;
    if (!s || s.lookup_error) push(GATE_REASONS.SUPPRESSION_UNREADABLE);
    else if (s.suppressed) push(GATE_REASONS.SUPPRESSED);
    const a = facts.automation_suppression;
    if (!a || a.error) push(GATE_REASONS.SUPPRESSION_UNREADABLE);
    else if (a.active) push(GATE_REASONS.AUTOMATION_SUPPRESSED);
    // 7-8. archive / terminal / legal / repair / review / quarantine on the thread
    if (facts.thread_error) push(GATE_REASONS.THREAD_STATE_UNREADABLE);
    else push(threadStateRefusal(facts.thread, { automated }));
    // 9. automation holds
    push(automationHoldRefusal(facts.hold, { automated }));
    // 10. campaign
    if (clean(row.campaign_id)) {
      if (facts.campaign_error || !facts.campaign) push(GATE_REASONS.CAMPAIGN_UNREADABLE);
      else if (!LIVE_CAMPAIGN_STATUSES.has(lower(facts.campaign.status))) push(`${GATE_REASONS.CAMPAIGN_NOT_LIVE}:${lower(facts.campaign.status) || "unknown"}`);
    }
    // 11. quiet hours (automated). Unknown zone = hold, never a guessed zone.
    //     A fresh operator-attended inbox row is judged like a manual send.
    if (automated && facts.operator_attended !== true) {
      const w = facts.contact_window;
      if (!w || typeof w !== "object") push(GATE_REASONS.QUIET_HOURS_UNEVALUATED);
      else if (w.hold === true || !clean(w.timezone)) push(GATE_REASONS.TIMEZONE_UNKNOWN);
      else if (w.allowed !== true && facts.in_session_reply !== true) push(GATE_REASONS.OUTSIDE_QUIET_HOURS);
    }
  }

  // 12. sender continuity (the caller's own final check, required for automated)
  const sc = facts.sender_continuity;
  if (sc && sc.ok !== true) push(clean(sc.reason) || GATE_REASONS.SENDER_CONTINUITY_UNAVAILABLE);
  else if (!sc && automated) push(GATE_REASONS.SENDER_CONTINUITY_UNAVAILABLE);

  return {
    ok: refusals.length === 0,
    reason: refusals[0] || null,
    refusals,
    reauthorization: { required: reauth.required, ok: reauth.ok, markers: reauth.history.map((h) => h.marker) },
    gate_version: FINAL_DISPATCH_GATE_VERSION,
  };
}

// ── the fact loader ──────────────────────────────────────────────────────────

let MODE = null; // null = default; 'enforce' | 'skip' (tests only)
/** Test seam: 'enforce' reads facts from any client; 'skip' never reads; null restores the default. */
export function __setFinalDispatchGateModeForTests(mode = null) { MODE = mode; }

async function realClient() {
  try { return (await import("@/lib/supabase/client.js")).supabase; } catch { return null; }
}

export async function finalGateFactsApply(client) {
  if (MODE === "enforce") return true;
  if (MODE === "skip") return process.env.NODE_ENV !== "test" ? true : false;
  if (process.env.NODE_ENV !== "test") return true;
  const real = await realClient();
  return Boolean(client) && client === real;
}

async function settle(fn) {
  try { return { value: await fn(), error: null }; } catch (error) { return { value: null, error: error || new Error("read_failed") }; }
}

/**
 * Read every live fact the decision needs. Each read is independent and fails
 * closed into the decision (an error becomes the refusal, never a pass).
 */
export async function loadFinalDispatchFacts({ to = null, thread_key = null, row = null, path = "queue" } = {}, deps = {}) {
  const supabase = deps.supabase || null;
  if (!(await finalGateFactsApply(supabase))) return { facts_loaded: false };
  if (!supabase?.from) {
    return {
      facts_loaded: true,
      suppression: { lookup_error: GATE_REASONS.NO_CLIENT },
      automation_suppression: { error: GATE_REASONS.NO_CLIENT },
      thread_error: GATE_REASONS.NO_CLIENT,
      campaign_error: GATE_REASONS.NO_CLIENT,
      hold: { fail_closed: true, hold_type: "lookup_error" },
    };
  }
  const dest = normalizePhone(to) || normalizePhone(thread_key);
  const key = normalizePhone(thread_key) || dest;

  const [suppression, automationSuppression, thread, hold, campaign] = await Promise.all([
    settle(async () => {
      if (typeof deps.readSuppression === "function") return deps.readSuppression(dest);
      const { queryActiveSuppression } = await import("@/lib/domain/compliance/query-active-suppression.js");
      const r = await queryActiveSuppression(supabase, dest);
      return { suppressed: r?.suppressed === true, lookup_error: r?.lookup_error || null, reason: r?.suppression_reason || null };
    }),
    settle(async () => {
      if (typeof deps.readAutomationSuppression === "function") return deps.readAutomationSuppression(dest);
      const r = await supabase.from("automation_suppressions").select("id,expires_at,status,suppression_reason").eq("phone_e164", dest).limit(20);
      if (r?.error) throw r.error;
      const nowMs = Date.now();
      const active = (r?.data || []).find((x) => lower(x?.status || "active") === "active" && (!x?.expires_at || Date.parse(x.expires_at) > nowMs));
      return { active: Boolean(active), reason: active?.suppression_reason || null };
    }),
    settle(async () => {
      if (typeof deps.readThreadState === "function") return deps.readThreadState(key);
      // select("*"): a column added or dropped later can never turn this read
      // into an error that blocks (or, worse, a shape that passes) every send.
      const r = await supabase.from("inbox_thread_state").select("*").eq("thread_key", key).limit(2);
      if (r?.error) throw r.error;
      return (r?.data || [])[0] || null;
    }),
    settle(async () => {
      if (typeof deps.readAutomationHold === "function") return deps.readAutomationHold({ thread_key: key, row });
      const { checkAutomationHold } = await import("@/lib/domain/holds/automation-hold.js");
      return checkAutomationHold({
        threadKey: key,
        propertyId: clean(row?.property_id) || null,
        masterOwnerId: clean(row?.master_owner_id) || null,
        // One capability for both paths; automationHoldRefusal decides which
        // hold types bind a manual send.
        capability: "outbound_send",
      }, { supabase });
    }),
    settle(async () => {
      const campaign_id = clean(row?.campaign_id);
      if (!campaign_id) return null;
      if (typeof deps.readCampaign === "function") return deps.readCampaign(campaign_id);
      const r = await supabase.from("campaigns").select("id,status").eq("id", campaign_id).limit(1);
      if (r?.error) throw r.error;
      return (r?.data || [])[0] || null;
    }),
  ]);

  return {
    facts_loaded: true,
    suppression: suppression.error ? { lookup_error: clean(suppression.error?.message) || "suppression_read_failed" } : suppression.value,
    automation_suppression: automationSuppression.error ? { error: clean(automationSuppression.error?.message) || "automation_suppression_read_failed" } : automationSuppression.value,
    thread: thread.error ? null : thread.value,
    thread_error: thread.error ? clean(thread.error?.message) || "thread_state_read_failed" : null,
    hold: hold.error ? { fail_closed: true, hold_type: "lookup_error" } : hold.value,
    campaign: campaign.error ? null : campaign.value,
    campaign_error: campaign.error ? clean(campaign.error?.message) || "campaign_read_failed" : null,
  };
}

/**
 * THE GATE. Called by the seam's evaluateRuntimeAuthority on every attempt.
 *
 * input = { path, row, to, from, thread_key, claim_token, operator_action_id,
 *           contact_window, in_session_reply, now }
 * deps  = { supabase, evaluateAuthority: async () => verdict,
 *           checkSenderContinuity?: async () => { ok, reason }, reader overrides }
 * Never throws.
 */
export async function evaluateFinalDispatchGate(input = {}, deps = {}) {
  const path = input.path === "manual" ? "manual" : "queue";
  try {
    let authority = null;
    try {
      authority = typeof deps.evaluateAuthority === "function"
        ? await deps.evaluateAuthority()
        : { ok: false, reason: GATE_REASONS.AUTHORITY_UNAVAILABLE };
    } catch {
      authority = { ok: false, reason: GATE_REASONS.AUTHORITY_UNAVAILABLE };
    }
    // No brake, no reads: an authority refusal is final and cheaper than the rest.
    if (authority?.ok !== true) {
      return { ...decideFinalDispatch({ path, authority, row: input.row, to: input.to, thread_key: input.thread_key, claim_token: input.claim_token, operator_action_id: input.operator_action_id, facts_loaded: false, sender_continuity: { ok: true } }), authority };
    }

    let sender_continuity = null;
    if (typeof deps.checkSenderContinuity === "function") {
      try {
        sender_continuity = await deps.checkSenderContinuity();
      } catch {
        sender_continuity = { ok: false, reason: GATE_REASONS.SENDER_CONTINUITY_UNAVAILABLE };
      }
    } else if (path === "manual") {
      // The manual path resolves its sender from the thread's own history before
      // dispatch (send-now-service#evaluateManualSendSender); it is not re-derived here.
      sender_continuity = { ok: true, reason: null, delegated: "manual_send_sender_resolution" };
    }

    const loaded = await loadFinalDispatchFacts({ to: input.to, thread_key: input.thread_key, row: input.row, path }, deps);
    const verdict = decideFinalDispatch({
      ...loaded,
      path,
      authority,
      row: input.row,
      to: input.to,
      thread_key: input.thread_key,
      claim_token: input.claim_token,
      operator_action_id: input.operator_action_id,
      contact_window: input.contact_window ?? null,
      in_session_reply: input.in_session_reply === true,
      operator_attended: input.operator_attended === true,
      sender_continuity,
      now: input.now || Date.now(),
    });
    return { ...verdict, authority, sender_continuity };
  } catch (error) {
    return { ok: false, reason: GATE_REASONS.CHECK_THREW, refusals: [GATE_REASONS.CHECK_THREW], detail: clean(error?.message).slice(0, 200), gate_version: FINAL_DISPATCH_GATE_VERSION };
  }
}

/**
 * Release-time preview (Cockpit approve / retry / owner-release): the same live
 * facts and row checks, without the brake, claim, quiet hours or sender checks
 * that only mean something at the moment of dispatch. Never throws.
 */
export async function evaluateReleaseGate(row = {}, deps = {}) {
  try {
    // The row's CURRENT status is what a release changes, so it is not judged
    // here (the caller decides which statuses an action may release); a
    // quarantine is never releasable.
    const status = isQuarantinedRow(row) ? GATE_REASONS.QUARANTINED : null;
    const identity = contactIdentityRefusal({ to: row.to_phone_number, thread_key: row.thread_key, automated: true });
    const loaded = await loadFinalDispatchFacts({ to: row.to_phone_number, thread_key: row.thread_key, row, path: "queue" }, deps);
    const refusals = [status, identity].filter(Boolean);
    if (loaded.facts_loaded !== false) {
      const s = loaded.suppression;
      if (!s || s.lookup_error) refusals.push(GATE_REASONS.SUPPRESSION_UNREADABLE);
      else if (s.suppressed) refusals.push(GATE_REASONS.SUPPRESSED);
      const a = loaded.automation_suppression;
      if (!a || a.error) refusals.push(GATE_REASONS.SUPPRESSION_UNREADABLE);
      else if (a.active) refusals.push(GATE_REASONS.AUTOMATION_SUPPRESSED);
      if (loaded.thread_error) refusals.push(GATE_REASONS.THREAD_STATE_UNREADABLE);
      else { const t = threadStateRefusal(loaded.thread, { automated: true }); if (t) refusals.push(t); }
      const h = automationHoldRefusal(loaded.hold, { automated: true }); if (h) refusals.push(h);
    }
    return { ok: refusals.length === 0, blocked: refusals.length > 0, reason: refusals[0] || null, refusals, thread: loaded.thread || null, facts_loaded: loaded.facts_loaded !== false };
  } catch (error) {
    return { ok: false, blocked: true, reason: GATE_REASONS.CHECK_THREW, refusals: [GATE_REASONS.CHECK_THREW], detail: clean(error?.message).slice(0, 200) };
  }
}

/**
 * Is this row historical (needs an explicit owner release, never a plain
 * approve / retry)? Hold history, or a seller inbound after the row was written,
 * or older than the reauthorization window.
 */
export function isHistoricalRow(row = {}, { now = Date.now(), last_inbound_at = null, max_age_ms = REAUTHORIZATION_MAX_AGE_MS } = {}) {
  const holds = rowHoldHistory(row).filter((h) => h.marker !== "owner_release");
  if (holds.length) return { historical: true, reason: "hold_history", markers: holds.map((h) => h.marker) };
  const created = ts(row?.created_at);
  const inbound = ts(last_inbound_at);
  if (created && inbound && inbound > created) return { historical: true, reason: "seller_replied_after_row_written", markers: [] };
  if (created && toMs(now) - created > max_age_ms) return { historical: true, reason: "row_older_than_reauthorization_window", markers: [] };
  return { historical: false, reason: null, markers: [] };
}

/**
 * The patch every automatic release path uses INSTEAD of re-queueing: the row
 * goes to the canonical review hold with the evidence of why and what revalidation said.
 */
export function buildReauthorizationHoldPatch(row = {}, { trigger, now = new Date().toISOString(), blockers = [] } = {}) {
  const meta = obj(row?.metadata);
  return {
    queue_status: "paused_operator_review",
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: {
      ...meta,
      reauthorization_required: {
        trigger: clean(trigger) || "automatic_release",
        at: now,
        previous_status: clean(row?.queue_status) || null,
        previous_reason: clean(row?.guard_reason || row?.failed_reason || row?.paused_reason) || null,
        revalidation_blockers: Array.isArray(blockers) ? blockers : [],
        policy: "founder_p0_2026-11-23_no_automatic_reactivation",
      },
      // A copied or earlier authorization never survives a new hold.
      reauthorization: null,
    },
  };
}

export default evaluateFinalDispatchGate;
