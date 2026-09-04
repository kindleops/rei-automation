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
 * Names/addresses come from canonical_inbox_threads; timezone, contact_window
 * and agent_name come from the thread's OWN send_queue history, so a follow-up
 * agrees with how this seller was contacted before instead of inventing values.
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
    });
  }

  const { data: queueRows } = await supabase
    .from("send_queue")
    .select("thread_key,timezone,contact_window,agent_name,created_at")
    .in("thread_key", keys)
    .order("created_at", { ascending: false });

  for (const row of queueRows || []) {
    const key = clean(row.thread_key);
    const ctx = contexts.get(key);
    if (!ctx) continue;
    // Most recent non-null wins; rows arrive newest-first.
    if (!ctx.timezone && clean(row.timezone)) ctx.timezone = clean(row.timezone);
    if (!ctx.contact_window && clean(row.contact_window)) ctx.contact_window = clean(row.contact_window);
    if (!ctx.agent_name && clean(row.agent_name)) ctx.agent_name = clean(row.agent_name);
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
 * @param {string} [agentName]   Operator override for {{agent_name}}.
 */
export async function buildBulkFollowUpPlan({ threadKeys = [], agentName = null, now = new Date() } = {}, deps = {}) {
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
    const selection = selectFus2Template({
      templates: templateResult.templates,
      usedTemplateIds: history.get(key) || [],
      context: { language: "English" },
    });

    const plan = buildRecipientPlan({
      thread: ctx,
      template: selection.ok ? selection.template : null,
      agentName: clean(agentName) || ctx.agent_name,
      now,
    });

    recipients.push({
      ...plan,
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
    distinct_templates_selected: new Set(eligible.map((r) => r.template_id).filter(Boolean)).size,
    recipients,
  };
}

export default buildBulkFollowUpPlan;
