/**
 * Asset-type template RESELECTION — what happens to a pending row whose
 * template does not describe its property.
 *
 * The row is the logical communication: same seller, property, sender,
 * schedule, logical_communication_id, dedupe/queue keys and compliance
 * state. Only its template and body change — to a template of the SAME
 * use case, stage and language that IS eligible for the property's asset
 * type, ranked by the existing adaptive selector after eligibility.
 *
 * The replacement is rendered with the exact values the seller was going to
 * read (name, agent, address, city), recovered by aligning the original
 * template with its rendered body — so reselection never re-derives
 * identity and never produces a blank greeting. When nothing eligible
 * renders, the caller blocks the row (fail closed).
 *
 * Used at dispatch (process-send-queue) and by the pending-row remediation.
 */
import { selectVariant } from "@/lib/domain/messaging/adaptive-template-selection.js";
import {
  canonicalPropertyGroupOf,
  filterTemplatesForProperty,
  isTemplateCompatibleWithProperty,
} from "@/lib/domain/templates/template-asset-compatibility.js";
import { loadPropertyAssetRecord, queueTemplateIdOf } from "@/lib/domain/queue/template-asset-guard.js";
import { normalizePunctuation } from "@/lib/sms/personalize_template.js";
import { prepareRenderedSmsForQueue } from "@/lib/sms/sanitize.js";

export const ASSET_RESELECTION_REASON = "asset_type_incompatible";

const clean = (v) => String(v ?? "").trim();
const lower = (v) => clean(v).toLowerCase();

// Placeholder spellings in the catalog → one identity key each.
const PLACEHOLDER_KEY = Object.freeze({
  seller_first_name: "seller", seller_name: "seller", first_name: "seller", owner_first_name: "seller",
  agent_name: "agent", agent_first_name: "agent", sms_agent_name: "agent", sender_name: "agent", rep_name: "agent",
  property_address: "address",
  city: "city", property_city: "city",
});
const PLACEHOLDER_RE = /\{\{\s*([\w]+)\s*\}\}|\{\s*([\w]+)\s*\}/g;
const keyOf = (name) => PLACEHOLDER_KEY[lower(name)] || `raw:${lower(name)}`;

const squash = (s) => normalizePunctuation(String(s ?? "")).replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The placeholder values a rendered body was built from, by aligning it with
 * its template. Returns null when the two do not align (edited body, other
 * template) — the caller then falls back to the row's own fields.
 */
export function recoverRenderedValues(template_body, rendered_body) {
  const tpl = squash(template_body);
  const out = squash(rendered_body);
  if (!tpl || !out) return null;
  const keys = [];
  let pattern = "^";
  let last = 0;
  for (const m of tpl.matchAll(PLACEHOLDER_RE)) {
    pattern += escapeRe(tpl.slice(last, m.index)) + "(.+?)";
    keys.push(keyOf(m[1] || m[2]));
    last = m.index + m[0].length;
  }
  if (!keys.length) return null;
  pattern += escapeRe(tpl.slice(last)) + "$";
  const match = new RegExp(pattern, "s").exec(out);
  if (!match) return null;
  const values = {};
  for (let i = 0; i < keys.length; i += 1) {
    const v = clean(match[i + 1]);
    if (!v) return null;
    if (values[keys[i]] != null && values[keys[i]] !== v) return null;
    values[keys[i]] = v;
  }
  return values;
}

/** Render with identity values only; any unresolved placeholder fails. */
export function renderWithValues(template_body, values = {}) {
  let missing = false;
  const text = String(template_body ?? "").replace(PLACEHOLDER_RE, (_, a, b) => {
    const v = clean(values[keyOf(a || b)]);
    if (!v) missing = true;
    return v;
  });
  if (missing) return null;
  return squash(text) || null;
}

function rowFallbackValues(row = {}) {
  const snap = row?.metadata?.candidate_snapshot || {};
  return {
    seller: clean(row.seller_first_name) || null,
    agent: clean(row.agent_name) || null,
    address: clean(row.property_address) || null,
    city: clean(row.property_city) || clean(snap.property_city) || null,
  };
}

const TEMPLATE_SELECT =
  "template_id,template_body,use_case,language,stage_code,property_type_scope,allowed_property_groups," +
  "prohibited_property_groups,is_active,safe_for_auto_reply,minimal_fallback,fallback_rank,quarantine_state";

/**
 * Find and render an asset-eligible replacement for a row.
 *
 * @returns {Promise<{ resolved: boolean, reason: string, template_id?: string, message_body?: string,
 *   use_case?: string, stage_code?: string|null, language?: string, property_group: string, previous_template_id: string|null }>}
 */
export async function reselectTemplateForAsset({ supabase, queue_row, body, property = undefined } = {}) {
  const row = queue_row || {};
  const previous_template_id = queueTemplateIdOf(row);
  const assetRecord = property !== undefined ? property : await loadPropertyAssetRecord(supabase, row.property_id).catch(() => null);
  const property_group = canonicalPropertyGroupOf(
    assetRecord || { property_type: row.property_type, ...(row?.metadata?.candidate_snapshot || {}) },
  );
  const effective_group = property_group === "residential" || property_group === "unknown" ? "sfr" : property_group;
  const fail = (reason) => ({ resolved: false, reason, property_group, previous_template_id });

  let original = null;
  if (previous_template_id) {
    const { data } = await supabase.from("sms_templates").select(TEMPLATE_SELECT).eq("template_id", previous_template_id).maybeSingle();
    original = data || null;
  }
  const snapshot = row?.metadata?.template_snapshot || {};
  const use_case = clean(original?.use_case) || clean(row.use_case_template) || clean(snapshot.template_use_case);
  const language = clean(original?.language) || clean(row.language) || clean(snapshot.language) || "English";
  const stage_code = clean(original?.stage_code) || clean(snapshot.stage_code) || null;
  if (!use_case) return fail("reselection_use_case_unknown");

  let query = supabase
    .from("sms_templates")
    .select(TEMPLATE_SELECT)
    .eq("is_active", true)
    .eq("quarantine_state", "active")
    .eq("use_case", use_case)
    .eq("language", language)
    .limit(500);
  if (stage_code) query = query.eq("stage_code", stage_code);
  const { data: pool, error } = await query;
  if (error) return fail("reselection_template_lookup_failed");

  // Eligibility BEFORE ranking — the ranker never sees an ineligible template.
  const eligible = filterTemplatesForProperty(
    (pool || []).filter((t) => clean(t.template_id) && clean(t.template_id) !== previous_template_id),
    { propertyGroup: property_group },
  ).kept;
  if (!eligible.length) return fail("no_asset_eligible_template");

  let performanceByTemplateId = {};
  try {
    const { data } = await supabase.from("v_template_performance").select("*").in("template_id", eligible.map((t) => t.template_id));
    for (const p of data ?? []) performanceByTemplateId[clean(p.template_id)] = p;
  } catch {
    performanceByTemplateId = {};
  }
  const selection = selectVariant(
    eligible,
    { stage_code, use_case, language, property_group: effective_group, require_auto_reply_safe: false, skip_variable_check: true },
    { performanceByTemplateId },
  );
  const ordered = selection.ok ? [selection.template, ...eligible.filter((t) => t !== selection.template)] : eligible;

  const values = {
    ...rowFallbackValues(row),
    ...((original && recoverRenderedValues(original.template_body, body)) || {}),
  };

  for (const template of ordered) {
    const rendered = renderWithValues(template.template_body, values);
    if (!rendered) continue;
    const prepared = prepareRenderedSmsForQueue({ rendered_message_text: rendered, template_id: template.template_id, template_source: "sms_templates" });
    if (!prepared.ok || !clean(prepared.text)) continue;
    if (!isTemplateCompatibleWithProperty({ template: { template_body: prepared.text }, propertyGroup: property_group, wordsOnly: true }).compatible) continue;
    return {
      resolved: true,
      reason: "asset_eligible_template_reselected",
      template_id: clean(template.template_id),
      message_body: prepared.text,
      use_case: clean(template.use_case) || use_case,
      stage_code: clean(template.stage_code) || stage_code,
      language: clean(template.language) || language,
      selection_reason: selection.ok ? selection.selection_reason : "unranked_fallback",
      property_group,
      previous_template_id,
    };
  }
  return fail("no_renderable_asset_eligible_template");
}

/**
 * Write a reselection onto the row. Identity, schedule, sender, keys and
 * compliance columns are untouched; the prior template is recorded. The
 * update is conditional on the row still carrying the template it was
 * judged with (and, when given, still being in `expectStatus`), so a row
 * that moved on concurrently is never rewritten.
 */
export async function applyAssetReselection({ supabase, queue_row, reselection, now = new Date().toISOString(), expectStatus = null, guard = null }) {
  const row = queue_row || {};
  const metadata = {
    ...(row.metadata ?? {}),
    template_reselection_reason: ASSET_RESELECTION_REASON,
    template_reselected_at: now,
    template_reselected_from: {
      template_id: reselection.previous_template_id,
      body: clean(row.message_body || row.message_text).slice(0, 320),
      guard_reason: guard?.reason ?? null,
    },
    template_reselection: {
      template_id: reselection.template_id,
      property_group: reselection.property_group,
      use_case: reselection.use_case,
      stage_code: reselection.stage_code,
      language: reselection.language,
      selection_reason: reselection.selection_reason,
    },
    template_snapshot: {
      ...(row?.metadata?.template_snapshot ?? {}),
      template_id: reselection.template_id,
      selected_template_id: reselection.template_id,
      rendered_message_preview: reselection.message_body,
      character_count: reselection.message_body.length,
    },
  };
  const patch = {
    message_body: reselection.message_body,
    message_text: reselection.message_body,
    rendered_message: reselection.message_body,
    template_id: reselection.template_id,
    selected_template_id: reselection.template_id,
    template_key: reselection.template_id,
    character_count: reselection.message_body.length,
    metadata,
    updated_at: now,
  };
  let q = supabase.from("send_queue").update(patch).eq("id", row.id);
  if (reselection.previous_template_id) q = q.eq("selected_template_id", reselection.previous_template_id);
  if (expectStatus) q = q.eq("queue_status", expectStatus);
  const { data, error } = await q.select("id");
  if (error) return { ok: false, reason: error.message || "reselection_update_failed" };
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "reselection_row_changed_concurrently" };
  return { ok: true, row: { ...row, ...patch } };
}
