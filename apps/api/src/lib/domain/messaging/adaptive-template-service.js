/**
 * ADAPTIVE TEMPLATE SERVICE — the Supabase-backed half.
 *
 * `adaptive-template-selection.js` is pure (and therefore testable without a
 * database); this module is the only place that reads the estate and the
 * derived performance views, and the only place that writes variant lineage
 * onto an attempt. Keeping the I/O here is what lets the whole ranking and
 * eligibility contract be proven with fixtures.
 *
 * Canonical sources, all pre-existing:
 *   public.sms_templates                  the approved estate (8,782 active)
 *   public.v_template_performance         derived from send_queue, not a copy
 *   public.v_template_sender_performance  per-sender segment
 *   public.seller_communication_attempts  durable per-attempt ledger
 */

import { child } from "@/lib/logging/logger.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import selectVariant, { buildVariantGroupKey } from "@/lib/domain/messaging/adaptive-template-selection.js";
import evaluateVariantFallback, {
  MAX_VARIANT_ATTEMPTS,
  describeFallbackDecision,
} from "@/lib/domain/messaging/template-fallback-authority.js";
import {
  readVariantHistory,
  recordVariantLineage as storeVariantLineage,
} from "@/lib/domain/communications/record-variant-lineage.js";

const logger = child({ module: "domain.messaging.adaptive_template" });
const clean = (value) => String(value ?? "").trim();

/*
 * Columns read from sms_templates.
 *
 * Named explicitly and kept in sync with the real schema on purpose: PostgREST
 * fails the ENTIRE select on one unknown column, and a swallowed error here
 * would silently return zero candidates — which reads exactly like "this group
 * has no templates" and would send nothing while the estate was full.
 */
const TEMPLATE_COLUMNS = [
  "template_id",
  "template_body",
  "use_case",
  "language",
  "stage_code",
  "stage_label",
  "property_type_scope",
  "allowed_property_groups",
  "prohibited_property_groups",
  "is_active",
  "safe_for_auto_reply",
  "variant_group_key",
  "fallback_rank",
  "minimal_fallback",
  "quarantine_state",
].join(",");

/** Every approved candidate in one variant group. */
export async function loadVariantGroup(context = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const variant_group_key = buildVariantGroupKey(context);

  const { data, error } = await supabase
    .from("sms_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("variant_group_key", variant_group_key)
    .eq("is_active", true)
    .eq("quarantine_state", "active")
    .limit(200);

  if (error) {
    // Surfaced, never swallowed: a failed read must not masquerade as an empty
    // group, because the two call for opposite responses.
    logger.error("adaptive_template.group_load_failed", {
      variant_group_key,
      error: clean(error.message),
    });
    return { ok: false, reason: "template_group_read_failed", variant_group_key, candidates: [] };
  }

  return { ok: true, variant_group_key, candidates: data ?? [] };
}

/** Derived performance for a specific set of templates. */
export async function loadPerformance(templateIds = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const ids = [...new Set(templateIds.map(clean).filter(Boolean))];
  if (ids.length === 0) return { byTemplateId: {} };

  const { data, error } = await supabase
    .from("v_template_performance")
    .select("*")
    .in("template_id", ids);

  if (error) {
    /*
     * Ranking degrades to "unproven" for everything, which orders candidates
     * deterministically by id rather than by evidence. That is a worse
     * selection, not an unsafe one — hard eligibility is untouched — so this
     * warns and continues rather than blocking the send.
     */
    logger.warn("adaptive_template.performance_unavailable", { error: clean(error.message) });
    return { byTemplateId: {} };
  }

  const byTemplateId = {};
  for (const row of data ?? []) byTemplateId[clean(row.template_id)] = row;
  return { byTemplateId };
}

/** Per-sender segment for those templates, when a sender is known. */
export async function loadSenderPerformance(templateIds = [], fromPhoneNumber = null, deps = {}) {
  const from = clean(fromPhoneNumber);
  if (!from) return { byTemplateId: {} };
  const supabase = deps.supabase || defaultSupabase;
  const ids = [...new Set(templateIds.map(clean).filter(Boolean))];
  if (ids.length === 0) return { byTemplateId: {} };

  const { data, error } = await supabase
    .from("v_template_sender_performance")
    .select("*")
    .eq("from_phone_number", from)
    .in("template_id", ids);

  if (error) {
    logger.warn("adaptive_template.sender_performance_unavailable", { error: clean(error.message) });
    return { byTemplateId: {} };
  }
  const byTemplateId = {};
  for (const row of data ?? []) byTemplateId[clean(row.template_id)] = row;
  return { byTemplateId };
}

/**
 * Which templates has this logical communication already burned?
 *
 * Read from the durable ledger rather than held in memory, because the chain
 * spans asynchronous queue execution: the process that handles attempt 2 is
 * usually not the process that sent attempt 1.
 */
export async function loadAttemptedTemplates(logicalCommunicationId, deps = {}) {
  // Delegated: `seller_communication_attempts` has a single-writer/reader home
  // in lib/domain/communications, and duplicating the query here would put a
  // second definition of "has this communication already succeeded" in the
  // codebase — the kind of pair that silently diverges.
  return readVariantHistory(logicalCommunicationId, deps);
}

/**
 * Choose the template for the next attempt of a logical communication.
 *
 * Used for attempt 1 and for every fallback alike — the only difference is
 * that `attempted_template_ids` is non-empty on a fallback, which is what
 * makes "never the same body twice" fall out of the same code path rather than
 * needing a second one.
 */
export async function selectAdaptiveTemplate(context = {}, deps = {}) {
  const group = await loadVariantGroup(context, deps);
  if (!group.ok) return { ok: false, reason: group.reason, variant_group_key: group.variant_group_key };

  if (group.candidates.length === 0) {
    logger.warn("adaptive_template.empty_group", { variant_group_key: group.variant_group_key });
    return { ok: false, reason: "variant_group_empty", variant_group_key: group.variant_group_key };
  }

  let attempted = context.attempted_template_ids ?? [];
  let attemptCount = Number(context.variant_attempt_number ?? 1) - 1;

  if (clean(context.logical_communication_id)) {
    const history = await loadAttemptedTemplates(context.logical_communication_id, deps);
    if (history.ok === false) return { ok: false, reason: history.reason, variant_group_key: group.variant_group_key };
    if (history.succeeded) {
      return { ok: false, reason: "logical_communication_already_succeeded", variant_group_key: group.variant_group_key };
    }
    attempted = [...new Set([...attempted, ...history.attempted])];
    attemptCount = history.attemptCount;
  }

  if (attemptCount >= MAX_VARIANT_ATTEMPTS) {
    return { ok: false, reason: "variant_attempts_exhausted", variant_group_key: group.variant_group_key };
  }

  const ids = group.candidates.map((row) => clean(row.template_id));
  const [performance, senderPerformance] = await Promise.all([
    loadPerformance(ids, deps),
    loadSenderPerformance(ids, context.from_phone_number, deps),
  ]);

  const selection = selectVariant(
    group.candidates,
    { ...context, attempted_template_ids: attempted, variant_attempt_number: attemptCount + 1 },
    {
      performanceByTemplateId: performance.byTemplateId,
      senderPerformanceByTemplateId: senderPerformance.byTemplateId,
    },
  );

  if (!selection.ok) {
    return {
      ok: false,
      reason: selection.reason,
      variant_group_key: group.variant_group_key,
      rejected: selection.rejected,
    };
  }

  return {
    ok: true,
    template: selection.template,
    template_id: clean(selection.template.template_id),
    variant_group_key: group.variant_group_key,
    variant_attempt_number: attemptCount + 1,
    template_selection_reason: selection.selection_reason,
    performance_snapshot: selection.components,
    candidates_considered: selection.of,
  };
}

/**
 * A transport attempt has ended. Should another approved variant be tried, and
 * if so, which one?
 *
 * Returns the full decision either way so the caller can persist WHY nothing
 * further was attempted — "we stopped" with no reason is unauditable.
 */
export async function planVariantFallback(input = {}, deps = {}) {
  const { failure = null, context = {}, logical_communication_id = null } = input;

  const history = await loadAttemptedTemplates(logical_communication_id, deps);
  if (history.ok === false) {
    return { allowed: false, reason: history.reason, decision: null, next: null };
  }

  const group = await loadVariantGroup(context, deps);
  const remaining = (group.candidates ?? []).filter(
    (row) => !history.attempted.includes(clean(row.template_id)),
  ).length;

  const decision = evaluateVariantFallback({
    failure,
    attemptsSoFar: history.attemptCount,
    alreadySucceeded: history.succeeded,
    remainingCandidates: remaining,
  });

  const described = describeFallbackDecision(failure, decision);

  if (!decision.allowed) {
    logger.info("adaptive_template.fallback_declined", {
      logical_communication_id: clean(logical_communication_id),
      reason: decision.reason,
      ...described,
    });
    return { allowed: false, reason: decision.reason, decision: described, next: null };
  }

  const next = await selectAdaptiveTemplate(
    {
      ...context,
      logical_communication_id,
      attempted_template_ids: history.attempted,
      previous_failure_class: clean(failure?.failure_class),
    },
    deps,
  );

  if (!next.ok) {
    return { allowed: false, reason: next.reason, decision: described, next: null };
  }

  logger.info("adaptive_template.fallback_selected", {
    logical_communication_id: clean(logical_communication_id),
    variant_group_key: next.variant_group_key,
    variant_attempt_number: next.variant_attempt_number,
    template_id: next.template_id,
    fallback_from_template_id: clean(context.previous_template_id) || null,
    selection_reason: next.template_selection_reason,
  });

  return { allowed: true, reason: decision.reason, decision: described, next };
}

/**
 * Persist variant lineage onto the durable attempt row (§26).
 *
 * Re-exported from the canonical communications store so callers of this
 * service have one import, while the actual write stays behind the
 * single-writer boundary that guards the attempt table.
 */
export const recordVariantLineage = storeVariantLineage;

export default selectAdaptiveTemplate;
