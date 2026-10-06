/**
 * STICKY THREAD SENDER (owner decision 2026-10-02).
 *
 * A seller conversation keeps ONE sending number:
 *   1. the thread's sender (inbox_thread_state.our_number, else the latest
 *      outbound number on the thread) while it passes the canonical sender
 *      eligibility (evaluateSenderDispatchEligibility);
 *   2. otherwise the highest-priority eligible routing fallback — the Sender
 *      Routing 2.0 graph when its gate is on, else the campaign router
 *      (exact market -> approved alias -> approved regional, blocklist
 *      applied) — and the new thread -> sender relationship is PERSISTED
 *      (inbox_thread_state.our_number) with a reason and an audit event;
 *   3. a brand-new conversation (no thread sender) may use the sender the
 *      caller proposed when it is eligible; else the router.
 * The sender is never re-picked per message: a caller's proposal for an
 * established thread is overridden by the thread's own eligible sender.
 *
 * Why: seller •••6497 (Minneapolis) was texted from 0495 -> 2623 (campaign
 * touches, least-used per touch) -> 5670 Miami (dashboard composer: no
 * ourNumber on the thread payload -> client "nationwide_fallback_missing_state"
 * least-used pick, a blocked number that never sends and so is always least
 * used; the server trusted the client's from_phone_number) -> 2382 -> 0495
 * (client per-message market picks). Every hop was a per-message choice.
 */

import { evaluateSenderDispatchEligibility, loadDispatchBlockedSenders } from "@/lib/domain/delivery/sender-dispatch-eligibility.js";

const clean = (value) => String(value ?? "").trim();
function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

async function defaultSupabase(deps) {
  if (deps.supabase) return deps.supabase;
  const { hasSupabaseConfig, supabase } = await import("@/lib/supabase/client.js");
  return hasSupabaseConfig() ? supabase : null;
}

/** The thread's current sender: inbox_thread_state.our_number, else the latest outbound number. */
export async function loadThreadSender(thread_key, deps = {}) {
  if (typeof deps.loadThreadSender === "function") return normalizePhone(await deps.loadThreadSender(thread_key)) || null;
  const key = clean(thread_key);
  if (!key) return null;
  const db = await defaultSupabase(deps);
  if (!db) return null;
  try {
    const { data: state } = await db.from("inbox_thread_state").select("our_number").eq("thread_key", key).maybeSingle();
    const our = normalizePhone(state?.our_number);
    if (our && our !== normalizePhone(key)) return our;
    const { data: events } = await db
      .from("message_events")
      .select("from_phone_number")
      .eq("thread_key", key)
      .eq("direction", "outbound")
      .not("from_phone_number", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const last = normalizePhone(Array.isArray(events) ? events[0]?.from_phone_number : null);
    return last && last !== normalizePhone(key) ? last : null;
  } catch {
    return null;
  }
}

async function loadFleetRow(phone, deps) {
  if (typeof deps.loadOutboundNumberByPhone === "function") return deps.loadOutboundNumberByPhone(phone);
  const db = await defaultSupabase(deps);
  if (!db) return null;
  const { data, error } = await db.from("textgrid_numbers").select("*").eq("phone_number", phone).limit(1);
  if (error) throw error;
  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row) return null;
  const { withDerivedSentToday } = await import("@/lib/domain/delivery/sender-sent-today.js");
  const [derived] = await withDerivedSentToday(db, [row], {});
  return derived;
}

async function verdictFor(phone, blocked, deps) {
  try {
    const row = await loadFleetRow(phone, deps);
    // send_class (send-class.js): a conversational send is not capped by the
    // cold daily limit, only by the total ceiling. Omitted = cold.
    return evaluateSenderDispatchEligibility(row, { blocked, phone, now: deps.now ? new Date(deps.now) : new Date(), send_class: deps.send_class || null });
  } catch {
    return { ok: false, reason: "outbound_number_eligibility_unavailable" };
  }
}

/** The routing fallback: Sender Routing 2.0 when its gate is on, else the campaign router. */
async function routeFallback(ctx, blocked, deps) {
  if (typeof deps.routeThreadFallback === "function") return deps.routeThreadFallback(ctx, blocked);
  const { senderRoutingCeiling } = await import("@/lib/domain/routing/sender-routing/sender-routing-gate.js");
  if (senderRoutingCeiling(deps.env || process.env)) {
    const { routeQueueRowViaPolicy } = await import("@/lib/domain/routing/sender-routing/sender-routing-runtime.js");
    const { loadFleet } = await import("@/lib/domain/routing/sender-routing/sender-routing-service.js");
    const routed = await routeQueueRowViaPolicy(
      { from_phone_number: ctx.thread_sender, thread_key: ctx.thread_key, property_id: ctx.property_id, market: ctx.market, market_id: ctx.canonical_market_id, campaign_id: null },
      { ...deps, blocked_sender_numbers: blocked, loadFleet: () => loadFleet(deps) }
    );
    if (routed) return routed.ok ? { phone: routed.from_phone_number, via: "sender_routing_v2", detail: routed.sender_routing?.label || null } : null;
  }
  const choose = deps.chooseTextgridNumber || (await import("@/lib/domain/outbound/supabase-candidate-feeder.js")).chooseTextgridNumber;
  const r = await choose(
    { market: ctx.market, state: ctx.state, canonical_market_id: ctx.canonical_market_id, touch_number: 2, is_first_touch: false },
    { first_touch: false, blocked_sender_numbers: blocked },
    { ...(deps.supabase ? { supabase: deps.supabase } : {}), ...(Array.isArray(deps.textgridNumberRows) ? { textgridNumberRows: deps.textgridNumberRows } : {}) }
  );
  const phone = normalizePhone(r?.selected_textgrid_number || r?.selected?.phone_number);
  return r?.ok && r?.routing_allowed !== false && phone ? { phone, via: "campaign_router", detail: r.selection_reason || r.routing_tier || null } : null;
}

/** Persist a thread -> sender change: inbox_thread_state.our_number + an audit event. Fail-open. */
export async function persistThreadSenderChange({ thread_key, from = null, to, reason, via = null, actor = "sender_continuity" }, deps = {}) {
  if (typeof deps.persistThreadSenderChange === "function") return deps.persistThreadSenderChange({ thread_key, from, to, reason, via, actor });
  const db = await defaultSupabase(deps);
  if (!db || !clean(thread_key) || !to) return { ok: false, skipped: true };
  try {
    await db.from("inbox_thread_state").update({ our_number: to, updated_at: new Date().toISOString() }).eq("thread_key", clean(thread_key));
    const { persistAutomationEvent } = await import("@/lib/domain/automation/automation-events.js");
    await persistAutomationEvent(
      {
        event_type: "sender_thread_rerouted",
        source: "sender_continuity",
        conversation_thread_id: clean(thread_key),
        payload: { thread_key: clean(thread_key), from_phone_number: from, to_phone_number: to, reason, via, actor, at: new Date().toISOString() },
      },
      { supabaseClient: db }
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve the sender for a reply / follow-up / manual send on a thread.
 * Returns { ok:true, phone, decision, reason?, previous? } | { ok:false, reason, detail }.
 */
export async function resolveStickyThreadSender(ctx = {}, deps = {}) {
  const thread_key = clean(ctx.thread_key);
  const proposed = normalizePhone(ctx.proposed_from);
  const blocked = typeof deps.loadDispatchBlockedSenders === "function"
    ? await deps.loadDispatchBlockedSenders()
    : await loadDispatchBlockedSenders({ getSystemValue: deps.getSystemValue, env: deps.env });
  if (!blocked) return { ok: false, reason: "sender_blocklist_unreadable" };

  const thread_sender = thread_key ? await loadThreadSender(thread_key, deps) : null;
  if (thread_sender) {
    const v = await verdictFor(thread_sender, blocked, deps);
    if (v.ok) {
      return { ok: true, phone: thread_sender, decision: "thread_continuity", overrode_proposed: Boolean(proposed && proposed !== thread_sender) };
    }
    const fallback = await routeFallback({ ...ctx, thread_key, thread_sender }, blocked, deps).catch(() => null);
    if (!fallback) return { ok: false, reason: "no_eligible_sender_for_thread", sender_reason: v.reason, detail: `thread sender ${thread_sender.slice(-4)} ${v.reason}; no eligible routing fallback` };
    const fv = await verdictFor(fallback.phone, blocked, deps);
    if (!fv.ok) return { ok: false, reason: "no_eligible_sender_for_thread", detail: `fallback ${fallback.phone.slice(-4)} ${fv.reason}` };
    const reason = `thread_sender_${String(v.reason || "ineligible").replace(/^outbound_number_/, "")}`;
    await persistThreadSenderChange({ thread_key, from: thread_sender, to: fallback.phone, reason, via: fallback.via }, deps);
    return { ok: true, phone: fallback.phone, decision: "thread_rerouted", reason, previous: thread_sender, via: fallback.via };
  }

  // A new conversation: the caller's proposal when eligible, else the router.
  let proposed_reason = null;
  if (proposed) {
    const v = await verdictFor(proposed, blocked, deps);
    if (v.ok) return { ok: true, phone: proposed, decision: "new_thread_proposed" };
    proposed_reason = v.reason;
  }
  const fallback = await routeFallback({ ...ctx, thread_key, thread_sender: null }, blocked, deps).catch(() => null);
  if (!fallback) {
    return {
      ok: false,
      reason: "no_eligible_sender_for_thread",
      sender_reason: proposed_reason,
      detail: proposed_reason
        ? `proposed sender ${proposed.slice(-4)} ${proposed_reason}; no eligible routing fallback`
        : "no thread sender and no eligible routing fallback",
    };
  }
  const fv = await verdictFor(fallback.phone, blocked, deps);
  if (!fv.ok) return { ok: false, reason: "no_eligible_sender_for_thread", detail: `fallback ${fallback.phone.slice(-4)} ${fv.reason}` };
  return { ok: true, phone: fallback.phone, decision: "new_thread_routed", via: fallback.via };
}
