// ─── resolve-deferred-queue-message.js ──────────────────────────────────────
// Dispatch-time template resolution for deferred follow-up queue rows.
//
// The canonical follow-up scheduler (seller-followup-scheduler.js) writes
// nurture rows with metadata.deferred_message_resolution=true and no message
// body — "message/template resolution happens later at send time". This module
// IS that send-time resolution: it maps the nurture intent to canonical
// template use cases, selects an active safe template from sms_templates, and
// renders it from the queue row's own personalization fields.
//
// An unresolvable row must pause for review — never hard-fail the queue run
// and never send an empty/blank message.

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import { prepareRenderedSmsForQueue } from "@/lib/sms/sanitize.js";
import { info, warn } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Nurture intent → ordered canonical template use-case candidates.
 * First active, safe, renderable template wins. Keys match the intents the
 * follow-up scheduler persists as `use_case_template: nurture_<intent>`.
 */
export const NURTURE_TEMPLATE_CANDIDATES = Object.freeze({
  // Last-resort fallbacks (consider_selling / seller_asking_price) are the
  // catalog's approved safe_for_auto_reply pools, so a nurture follow-up can
  // always execute even while stage-specific variants await safety approval.
  not_interested: ["consider_selling_follow_up", "not_ready", "consider_selling"],
  listed_or_unavailable: ["listed_or_unavailable", "not_ready", "consider_selling"],
  tenant_or_occupancy: ["tenant_or_occupancy", "consider_selling_follow_up", "consider_selling"],
  condition_signal: ["condition_probe", "consider_selling_follow_up", "consider_selling"],
  asking_price_value: ["asking_price_follow_up", "seller_asking_price"],
  conditional_interest: ["consider_selling_follow_up", "not_ready", "consider_selling"],
  maybe_depends_on_price: ["consider_selling_follow_up", "not_ready", "seller_asking_price"],
  need_time: ["not_ready", "consider_selling_follow_up", "consider_selling"],
  unclear: ["soft_followup", "consider_selling_follow_up", "consider_selling"],
});

export function isDeferredQueueRow(queue_row = {}) {
  const metadata = queue_row?.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  return (
    metadata.deferred_message_resolution === true &&
    !clean(queue_row.message_body || queue_row.message_text || queue_row.rendered_message)
  );
}

export function nurtureIntentFromRow(queue_row = {}) {
  const metadata = queue_row?.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  const direct = lower(metadata.intent);
  if (direct) return direct;
  const from_template = lower(queue_row.use_case_template);
  if (from_template.startsWith("nurture_")) return from_template.slice("nurture_".length);
  return "unclear";
}

function buildRowPersonalization(queue_row = {}) {
  const first_name = clean(queue_row.seller_first_name);
  const display_name = clean(queue_row.seller_display_name);
  return {
    first_name: first_name || null,
    seller_first_name: first_name || null,
    owner_name: display_name || first_name || null,
    seller_display_name: display_name || first_name || null,
    property_address: clean(queue_row.property_address) || null,
    property_city: clean(queue_row.property_city) || null,
    city: clean(queue_row.property_city) || null,
    market_name: clean(queue_row.market) || null,
    property_type: clean(queue_row.property_type) || null,
    phone_e164: clean(queue_row.to_phone_number) || null,
  };
}

async function fetchCandidateTemplates(supabase, useCases, language) {
  const languages = lower(language) === "english" || !language ? ["English"] : [language, "English"];
  const { data, error } = await supabase
    .from("sms_templates")
    .select("*")
    .eq("is_active", true)
    .eq("safe_for_auto_reply", true)
    .in("language", languages)
    .in("use_case", useCases)
    .limit(50);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * Resolve a deferred follow-up row into a sendable message.
 * Returns { ok, resolved, message_body, template_id, use_case, reason }.
 */
export async function resolveDeferredQueueMessage(queue_row = {}, deps = {}) {
  if (!isDeferredQueueRow(queue_row)) {
    return { ok: true, resolved: false, reason: "not_deferred" };
  }

  const supabase = deps.supabase || deps.supabaseClient || getDefaultSupabaseClient();
  if (!supabase) {
    return { ok: false, resolved: false, reason: "missing_supabase" };
  }

  const intent = nurtureIntentFromRow(queue_row);
  const candidates = NURTURE_TEMPLATE_CANDIDATES[intent] || NURTURE_TEMPLATE_CANDIDATES.unclear;

  let templates = [];
  try {
    templates = await fetchCandidateTemplates(supabase, candidates, clean(queue_row.language));
  } catch (error) {
    warn("[DEFERRED_FOLLOWUP_TEMPLATE_LOOKUP_FAILED]", {
      queue_row_id: queue_row.id || null,
      intent,
      error: error?.message || "template_lookup_failed",
    });
    return { ok: false, resolved: false, reason: "template_lookup_failed" };
  }

  // Preserve candidate priority order, then language preference.
  const rowLanguage = lower(queue_row.language) || "english";
  const ordered = candidates
    .flatMap((useCase) => {
      const matching = templates.filter((t) => lower(t.use_case) === useCase);
      return [
        ...matching.filter((t) => lower(t.language) === rowLanguage),
        ...matching.filter((t) => lower(t.language) !== rowLanguage),
      ];
    });

  const personalization = buildRowPersonalization(queue_row);

  for (const template of ordered) {
    if (!clean(template.template_body)) continue;
    const rendered = personalizeTemplate(template.template_body, personalization);
    if (!rendered.ok || !clean(rendered.text)) continue;

    const prepared = prepareRenderedSmsForQueue({
      rendered_message_text: rendered.text,
      template_id: template.template_id || template.id || null,
      template_source: "sms_templates",
    });
    if (!prepared.ok || !clean(prepared.text)) continue;

    info("[DEFERRED_FOLLOWUP_RESOLVED]", {
      queue_row_id: queue_row.id || null,
      intent,
      use_case: template.use_case || null,
      template_id: template.template_id || template.id || null,
    });

    return {
      ok: true,
      resolved: true,
      message_body: prepared.text,
      template_id: clean(template.template_id || template.id) || null,
      use_case: clean(template.use_case) || null,
      stage_code: clean(template.stage_code) || null,
      language: clean(template.language) || null,
      intent,
      reason: "deferred_template_resolved",
    };
  }

  warn("[DEFERRED_FOLLOWUP_UNRESOLVED]", {
    queue_row_id: queue_row.id || null,
    intent,
    candidates,
    templates_considered: ordered.length,
  });

  return { ok: false, resolved: false, intent, reason: "no_renderable_followup_template" };
}

export default resolveDeferredQueueMessage;
