// ─── fus2-follow-up-service.js ───────────────────────────────────────────────
// Bulk "Conversation Restart" follow-ups (FUS2 family).
//
// This module OWNS NOTHING that already exists. Template ranking comes from
// templateSelector.rankTemplateCandidates, rendering and every malformed-copy
// gate come from templateSelector.renderSafeTemplate (which wraps
// personalizeTemplate), and schedule resolution comes from resolveInboxSchedule.
// The only genuinely new logic here is the per-seller anti-repeat layer, which
// did not exist anywhere.
//
// FUS2 is an INTERNAL code. Operator-facing copy says "Conversation Restart".

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { rankTemplateCandidates, renderSafeTemplate } from "@/lib/automation/templateSelector.js";
import { resolveInboxSchedule } from "@/lib/domain/inbox/resolve-inbox-schedule.js";

export const FUS2_STAGE_CODE = "FUS2";
export const FUS2_TEMPLATE_FAMILY = "bulk_conversation_restart";
/** Operator-facing label. FUS2 never appears as primary product copy. */
export const FUS2_OPERATOR_LABEL = "Conversation Restart";

// How far back a variant counts as "recently used" for one seller.
const HISTORY_LOOKBACK = 25;

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * The canonical FUS2 query. Deliberately narrow: this must NEVER widen into
 * "any reengagement template in the library". All four predicates are required.
 */
export async function loadFus2Templates(deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const { data, error } = await supabase
    .from("sms_templates")
    .select("id,template_id,template_name,template_body,variables,language,agent_persona,stage_code,is_active,is_follow_up,metadata,reply_mode,safe_for_auto_reply")
    .eq("stage_code", FUS2_STAGE_CODE)
    .eq("is_active", true)
    .eq("is_follow_up", true)
    .eq("metadata->>template_family", FUS2_TEMPLATE_FAMILY);

  if (error) {
    return { ok: false, error: error.message || "fus2_template_query_failed", templates: [] };
  }
  const templates = (data || []).filter((row) => clean(row.template_body));
  if (!templates.length) {
    return { ok: false, error: "no_fus2_templates_available", templates: [] };
  }
  return { ok: true, templates };
}

/**
 * Template ids this thread has already been sent, most recent first.
 * Reads the existing send_queue lineage; there is no separate history store.
 */
export async function loadThreadTemplateHistory(threadKeys = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const keys = [...new Set(threadKeys.map(clean).filter(Boolean))];
  const history = new Map();
  if (!keys.length) return history;

  const { data, error } = await supabase
    .from("send_queue")
    .select("thread_key,template_id,selected_template_id,created_at")
    .in("thread_key", keys)
    .order("created_at", { ascending: false })
    .limit(keys.length * HISTORY_LOOKBACK);

  if (error) return history; // no history == no anti-repeat, never a hard failure

  for (const row of data || []) {
    const key = clean(row.thread_key);
    const tpl = clean(row.template_id) || clean(row.selected_template_id);
    if (!key || !tpl) continue;
    if (!history.has(key)) history.set(key, []);
    history.get(key).push(tpl);
  }
  return history;
}

/**
 * Rank normally, then prefer a variant this seller has not seen.
 *
 * Deliberately NOT random: ranking still decides quality order, and anti-repeat
 * only reorders among already-valid candidates. If every variant has prior use
 * we fall back to the highest-ranked one rather than inventing anything.
 */
export function selectFus2Template({ templates = [], usedTemplateIds = [], context = {} } = {}) {
  if (!templates.length) return { ok: false, reason: "no_fus2_templates_available" };

  const ranked = rankTemplateCandidates(templates, {
    language: context.language || "English",
    agent_style_fit: context.agent_persona || null,
    seller_temperature: context.seller_temperature || "warming",
    touch_number: context.touch_number || 1,
  });

  const used = new Set(usedTemplateIds.map(clean).filter(Boolean));
  const unused = ranked.filter((tpl) => !used.has(clean(tpl.template_id)));

  if (unused.length > 0) {
    return { ok: true, template: unused[0], rotation_reason: "unused_variant_preferred", exhausted: false };
  }

  // Every approved variant has been used before. Fall back to the best-ranked
  // one, and say so, rather than repeating the single most recent send.
  const leastRecent = [...ranked].sort((a, b) => {
    const ai = usedTemplateIds.indexOf(clean(a.template_id));
    const bi = usedTemplateIds.indexOf(clean(b.template_id));
    return (bi === -1 ? Infinity : bi) - (ai === -1 ? Infinity : ai);
  });
  return {
    ok: true,
    template: leastRecent[0] || ranked[0],
    rotation_reason: "all_variants_used_least_recent",
    exhausted: true,
  };
}

/**
 * Build the per-recipient plan: eligibility, rendered copy, and an individually
 * resolved schedule. Renders nothing itself and schedules nothing itself.
 */
export function buildRecipientPlan({ thread = {}, template = null, agentName = null, now = new Date() } = {}) {
  const threadKey = clean(thread.thread_key) || clean(thread.threadKey);
  const base = {
    thread_key: threadKey,
    seller_name: clean(thread.seller_first_name) || null,
    property_address: clean(thread.property_address) || null,
    template_id: template ? clean(template.template_id) : null,
  };

  if (!template) return { ...base, eligible: false, reason: "no_fus2_templates_available" };

  // Canonical renderer + every canonical safety gate. A rejection here is an
  // ELIGIBILITY verdict, never something to paper over with partial copy.
  const rendered = renderSafeTemplate(template, {
    seller_first_name: clean(thread.seller_first_name),
    agent_name: clean(agentName) || clean(thread.agent_name),
    property_address: clean(thread.property_address),
  });

  if (!rendered.ok) {
    return {
      ...base,
      eligible: false,
      reason: rendered.reason || "render_rejected",
      missing: rendered.missing || null,
    };
  }

  const schedule = resolveInboxSchedule({
    // "Best local time": the next eligible moment in the recipient's own window.
    // Deliberately resolved PER RECIPIENT -- a bulk selection must never collapse
    // to one wall-clock instant across timezones.
    requested_at: new Date(now.getTime() + 60_000).toISOString(),
    timezone: thread.timezone,
    contact_window: thread.contact_window,
    now,
  });

  if (!schedule.ok) {
    return { ...base, eligible: false, reason: schedule.reason || "schedule_unresolvable" };
  }

  return {
    ...base,
    eligible: true,
    reason: null,
    message_body: rendered.text,
    template_name: clean(template.template_name) || null,
    agent_name: clean(agentName) || clean(thread.agent_name) || null,
    schedule,
  };
}

export default { loadFus2Templates, loadThreadTemplateHistory, selectFus2Template, buildRecipientPlan };
