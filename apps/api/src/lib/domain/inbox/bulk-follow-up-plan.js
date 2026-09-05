// ─── bulk-follow-up-plan.js ──────────────────────────────────────────────────
// Assembles the operator-facing plan for a bulk "Conversation Restart".
//
// Loads canonical thread context, picks a FUS2 variant per seller (anti-repeat),
// renders through the canonical safety gates, and resolves an INDIVIDUAL
// schedule per recipient. Produces a plan only -- it inserts nothing.

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import {
  loadFus2Templates,
  loadThreadTemplateHistory,
  selectFus2Template,
  buildRecipientPlan,
  resolveSellerLanguage,
  FUS2_OPERATOR_LABEL,
} from "@/lib/domain/inbox/fus2-follow-up-service.js";

function clean(value) {
  return String(value ?? "").trim();
}

function firstName(value) {
  const raw = clean(value);
  if (!raw) return "";
  return raw.split(/\s+/)[0];
}

/**
 * Per-thread context for personalization + scheduling.
 *
 * Names/addresses come from canonical_inbox_threads. Timezone and contact
 * window come from the thread's own send_queue history, so scheduling agrees
 * with how this seller was contacted before. Seller-facing AGENT IDENTITY comes
 * only from the master-owner assignment -- never from send history.
 */
export async function loadThreadContexts(threadKeys = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const keys = [...new Set(threadKeys.map(clean).filter(Boolean))];
  const contexts = new Map();
  if (!keys.length) return contexts;

  const { data: rows } = await supabase
    .from("canonical_inbox_threads")
    .select("thread_key,prospect_first_name,prospect_name,owner_name,seller_display_name,property_address_full")
    .in("thread_key", keys);

  for (const row of rows || []) {
    const key = clean(row.thread_key);
    if (!key) continue;
    contexts.set(key, {
      thread_key: key,
      seller_first_name: firstName(
        row.prospect_first_name || row.prospect_name || row.seller_display_name || row.owner_name,
      ),
      property_address: clean(row.property_address_full),
      timezone: null,
      contact_window: null,
      agent_name: null,
      agent_family: null,
      master_owner_id: null,
    });
  }

  // ── Assigned agent ────────────────────────────────────────────────────────
  // The agent assigned to a seller lives on the MASTER OWNER
  // (master_owners.agent_persona, e.g. "Helen Crawford"), reached through
  // inbox_thread_state.master_owner_id. That is the assignment of record and it
  // covers ~99% of threads; the sending number is NOT a proxy for it (a single
  // number has carried seven different agents). personalizeTemplate applies
  // firstNameOnly(), so "Helen Crawford" renders as "Helen".
  const { data: stateRows } = await supabase
    .from("inbox_thread_state")
    .select("thread_key,master_owner_id")
    .in("thread_key", keys);

  const ownerByThread = new Map();
  const ownerIds = [];
  for (const row of stateRows || []) {
    const key = clean(row.thread_key);
    const ownerId = clean(row.master_owner_id);
    if (!key || !ownerId) continue;
    ownerByThread.set(key, ownerId);
    ownerIds.push(ownerId);
  }

  if (ownerIds.length) {
    const { data: owners } = await supabase
      .from("master_owners")
      .select("master_owner_id,agent_persona,agent_family,best_language")
      .in("master_owner_id", [...new Set(ownerIds)]);

    const agentByOwner = new Map();
    for (const row of owners || []) {
      const id = clean(row.master_owner_id);
      if (id) agentByOwner.set(id, {
        agent_persona: clean(row.agent_persona),
        agent_family: clean(row.agent_family),
        best_language: clean(row.best_language),
      });
    }
    for (const [key, ownerId] of ownerByThread.entries()) {
      const ctx = contexts.get(key);
      const assigned = agentByOwner.get(ownerId);
      if (!ctx || !assigned) continue;
      ctx.agent_name = assigned.agent_persona || null;
      ctx.agent_family = assigned.agent_family || null;
      // Seller language and agent identity ride on the same master-owner row
      // but are INDEPENDENT: agent_family ("Spanish Local") describes the
      // AGENT and is never read as a signal about the seller.
      ctx.best_language = assigned.best_language || null;
      ctx.master_owner_id = ownerId;
    }
  }

  // Timezone / contact window come from the thread's own send history.
  //
  // agent_name is DELIBERATELY NOT read here. send_queue history is a record of
  // who texted this seller before, which is not the same thing as who is
  // assigned to them now -- treating it as identity would let a stale or
  // reassigned agent sign a message. The master-owner assignment above is the
  // sole source of seller-facing identity; if it is absent, agent_name stays
  // unresolved and renderSafeTemplate routes the recipient to NEED REVIEW.
  // (send_queue remains the history source for TEMPLATE anti-repeat, which is
  // a different question and lives in loadThreadTemplateHistory.)
  const { data: queueRows } = await supabase
    .from("send_queue")
    .select("thread_key,timezone,contact_window,created_at")
    .in("thread_key", keys)
    .order("created_at", { ascending: false });

  for (const row of queueRows || []) {
    const key = clean(row.thread_key);
    const ctx = contexts.get(key);
    if (!ctx) continue;
    // Most recent non-null wins; rows arrive newest-first.
    if (!ctx.timezone && clean(row.timezone)) ctx.timezone = clean(row.timezone);
    if (!ctx.contact_window && clean(row.contact_window)) ctx.contact_window = clean(row.contact_window);
  }

  for (const key of keys) {
    if (!contexts.has(key)) {
      // No canonical row at all -- still returned, and it will fail eligibility
      // on missing variables rather than being silently dropped.
      contexts.set(key, { thread_key: key, seller_first_name: "", property_address: "", timezone: null, contact_window: null, agent_name: null });
    }
  }
  return contexts;
}

/**
 * @param {string[]} threadKeys  Selected threads.
 *
 * Note there is deliberately NO agent-name override. {{agent_name}} always
 * resolves to the agent assigned to that seller.
 */
export async function buildBulkFollowUpPlan({ threadKeys = [], now = new Date() } = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const keys = [...new Set(threadKeys.map(clean).filter(Boolean))];
  if (!keys.length) {
    return { ok: false, error: "no_recipients_selected", label: FUS2_OPERATOR_LABEL };
  }

  const templateResult = await loadFus2Templates({ supabase });
  if (!templateResult.ok) {
    return { ok: false, error: templateResult.error, label: FUS2_OPERATOR_LABEL };
  }

  const [contexts, history] = await Promise.all([
    loadThreadContexts(keys, { supabase }),
    loadThreadTemplateHistory(keys, { supabase }),
  ]);

  const recipients = [];
  for (const key of keys) {
    const ctx = contexts.get(key) || { thread_key: key };
    // Language follows the SELLER. Candidates are scoped to the seller's own
    // language BEFORE ranking, and a KNOWN language never silently degrades to
    // English: "we have no information" and "we know this seller reads Spanish"
    // are different facts, and only the first one justifies English copy.
    const { language, known } = resolveSellerLanguage(ctx.best_language);
    const candidates = templateResult.byLanguage.get(language) || [];

    if (!candidates.length) {
      recipients.push({
        thread_key: key,
        seller_name: ctx.seller_first_name || null,
        property_address: ctx.property_address || null,
        template_id: null,
        eligible: false,
        reason: "no_fus2_template_for_language",
        seller_language: language,
        language_known: known,
        assigned_agent_name: ctx.agent_name || null,
      });
      continue;
    }

    const selection = selectFus2Template({
      templates: candidates,
      usedTemplateIds: history.get(key) || [],
      context: { language },
    });

    const plan = buildRecipientPlan({
      thread: ctx,
      template: selection.ok ? selection.template : null,
      // The agent ASSIGNED TO THIS SELLER, and nothing else. A batch-level name
      // must never speak for a seller: the templates say "this is {{agent_name}}",
      // so borrowing another agent's name misrepresents who is texting them.
      // No assignment => no agent_name => renderSafeTemplate rejects the
      // recipient into NEED REVIEW, which is the correct outcome.
      agentName: ctx.agent_name,
      now,
    });

    recipients.push({
      ...plan,
      assigned_agent_name: ctx.agent_name || null,
      seller_language: language,
      language_known: known,
      rotation_reason: selection.rotation_reason || null,
      variants_exhausted: selection.exhausted === true,
    });
  }

  const eligible = recipients.filter((r) => r.eligible);
  const needsReview = recipients.filter((r) => !r.eligible);

  return {
    ok: true,
    label: FUS2_OPERATOR_LABEL,
    timing: "best_local_time",
    selected_count: recipients.length,
    eligible_count: eligible.length,
    needs_review_count: needsReview.length,
    template_pool_size: templateResult.templates.length,
    language_breakdown: eligible.reduce((acc, r) => {
      const l = r.seller_language || "Unknown";
      acc[l] = (acc[l] || 0) + 1;
      return acc;
    }, {}),
    distinct_templates_selected: new Set(eligible.map((r) => r.template_id).filter(Boolean)).size,
    recipients,
  };
}

export default buildBulkFollowUpPlan;
