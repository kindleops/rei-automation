/**
 * Template authority — OWNER RULE (P0 2026-10-09, binding, system-wide):
 *
 *   "We never use a hard-coded template. Ever. All templates must be in
 *    Supabase. Every sentence or word that comes out of this system has to be
 *    tracked."
 *
 * Automation may only send copy that comes from an `sms_templates` row. A
 * queue row whose template id is empty, is a code-registry id
 * (`local-template:*`), is a code-authored id (`safe_clarifier_*`, …) or
 * simply has no matching `sms_templates` row is refused at the final send
 * guard and held for a human (paused_operator_review) with reason
 * `template_not_in_supabase`.
 *
 * Operator-typed composer text is the operator's own words and stays allowed.
 *
 * This module is pure apart from the one sms_templates lookup, so every
 * producer (auto-reply, follow-up, nurture, campaign, map ownership check,
 * workflow, agent) is judged by the same rule at the same place.
 */

export const TEMPLATE_NOT_IN_SUPABASE = "template_not_in_supabase";

/** Template ids that are code-registry copy, never an sms_templates row. */
export const REGISTRY_TEMPLATE_ID_PREFIXES = Object.freeze(["local-template:", "safe_clarifier_"]);

/**
 * Condition / repair questions. Owner rule: never asked before we hold the
 * seller's asking price (Stage 3 is ALWAYS the asking price).
 */
export const CONDITION_QUESTION_USE_CASES = Object.freeze(
  new Set([
    "condition_probe",
    "price_high_condition_probe",
    "no_price_condition_probe",
    "ask_condition_clarifier",
    "condition_followup",
    "repairs_followup",
    "repair_clarification",
    // S4 property-detail questions (stage_code S4 in sms_templates): "is it
    // vacant or occupied?" is part of the condition stage, so it is never
    // asked before the seller's price either (owner flow 2026-10-10).
    "occupancy_probe",
    "vacancy_probe",
  ])
);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

/**
 * Automated producers that accept a caller-supplied body next to a template
 * id (workflow `outbound.send_sms`, canonical queue writer, queue_message
 * overrides). For these the body must be a rendering of the row — a real id
 * with free text is still untracked copy.
 */
export const FREE_TEXT_PRODUCER_SOURCES = Object.freeze(
  new Set(["workflow", "workflow_v2", "canonical_queue_writer", "queue_message"])
);

/** Manual surfaces that send a TEMPLATE (not operator-typed words). */
const TEMPLATE_PICKED_MANUAL_SOURCES = new Set(["map_command"]);
const TEMPLATE_PICKED_MANUAL_ACTIONS = new Set(["send_ownership_check"]);

function rowSource(row = {}) {
  return lower(row?.metadata?.source) || lower(row?.source) || null;
}

function normalizeCopy(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Was `body` rendered from `template_body`? Placeholders ({{x}}, {x}) match
 * any short run of text; spintax {a|b} matches one of its options; every
 * other character must be present verbatim (whitespace / quote style aside).
 */
export function bodyMatchesTemplate(template_body, body) {
  const template = normalizeCopy(template_body);
  const text = normalizeCopy(body);
  if (!template || !text) return false;
  let pattern = "";
  let i = 0;
  while (i < template.length) {
    if (template.startsWith("{{", i)) {
      const end = template.indexOf("}}", i + 2);
      if (end > -1) { pattern += "[\\s\\S]{0,160}?"; i = end + 2; continue; }
    }
    if (template[i] === "{") {
      const end = template.indexOf("}", i + 1);
      if (end > -1) {
        const inner = template.slice(i + 1, end);
        pattern += inner.includes("|")
          ? `(?:${inner.split("|").map((part) => escapeRe(normalizeCopy(part))).join("|")})`
          : "[\\s\\S]{0,160}?";
        i = end + 1;
        continue;
      }
    }
    pattern += /\s/.test(template[i]) ? "\\s*" : escapeRe(template[i]);
    i += 1;
  }
  try {
    return new RegExp(`^${pattern}$`, "i").test(text);
  } catch {
    return false;
  }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConditionQuestionUseCase(use_case) {
  return CONDITION_QUESTION_USE_CASES.has(clean(use_case).toLowerCase());
}

export function isRegistryTemplateId(template_id) {
  const id = clean(template_id);
  return Boolean(id) && REGISTRY_TEMPLATE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** The template id a queue row will be sent under (same precedence as the asset guard). */
export function queueRowTemplateId(row = {}) {
  return (
    clean(row?.selected_template_id) ||
    clean(row?.template_id) ||
    clean(row?.metadata?.selected_template_id) ||
    null
  );
}

/**
 * Is this template id an sms_templates row? Matches the catalogue key
 * (`template_id`) or the row uuid (`id`).
 *
 * @returns {Promise<{ found: boolean, read_failed: boolean, row: object|null }>}
 */
export async function lookupSupabaseTemplate(supabase, template_id) {
  const id = clean(template_id);
  if (!id) return { found: false, read_failed: false, row: null };
  if (!supabase || typeof supabase.from !== "function") {
    return { found: false, read_failed: true, row: null };
  }
  try {
    const by_key = await supabase
      .from("sms_templates")
      .select("id,template_id,use_case,is_active,template_body")
      .eq("template_id", id)
      .limit(1);
    if (by_key?.error) return { found: false, read_failed: true, row: null };
    const key_row = Array.isArray(by_key?.data) ? by_key.data[0] : by_key?.data || null;
    if (key_row) return { found: true, read_failed: false, row: key_row };
    if (UUID_RE.test(id)) {
      const by_id = await supabase
        .from("sms_templates")
        .select("id,template_id,use_case,is_active,template_body")
        .eq("id", id)
        .limit(1);
      if (by_id?.error) return { found: false, read_failed: true, row: null };
      const id_row = Array.isArray(by_id?.data) ? by_id.data[0] : by_id?.data || null;
      if (id_row) return { found: true, read_failed: false, row: id_row };
    }
    return { found: false, read_failed: false, row: null };
  } catch {
    return { found: false, read_failed: true, row: null };
  }
}

/**
 * The send-time template authority decision for one queue row.
 *
 *   manual operator send            → allowed (operator's own words)
 *   no template id                  → refused  (detail: missing_template_id)
 *   local-template:* / code id      → refused  (detail: registry_template_id)
 *   id with no sms_templates row    → refused  (detail: template_row_not_found)
 *   sms_templates read failed       → deferred (transient; never sent)
 *
 * `skipLookup` (test runtime with a fake client only) keeps the two static
 * rules and skips the catalogue read.
 */
export async function evaluateTemplateAuthority({
  supabase = null,
  queue_row = {},
  manual_operator_send = false,
  skipLookup = false,
  body = null,
} = {}) {
  const template_id = queueRowTemplateId(queue_row);
  const source = rowSource(queue_row);
  const action = lower(queue_row?.metadata?.action);
  const template_picked_manual =
    manual_operator_send &&
    (TEMPLATE_PICKED_MANUAL_SOURCES.has(source) || TEMPLATE_PICKED_MANUAL_ACTIONS.has(action));

  // Operator-typed composer text: the operator's own words (tracked on the
  // row as manual_composer copy). A template the operator PICKED must be a
  // real row — checked below like any automated send.
  if (manual_operator_send && !template_id && !template_picked_manual) {
    return { allowed: true, reason: "manual_operator_copy", template_id: null };
  }
  if (!template_id) {
    return { allowed: false, reason: TEMPLATE_NOT_IN_SUPABASE, detail: "missing_template_id", template_id: null };
  }
  if (isRegistryTemplateId(template_id)) {
    return { allowed: false, reason: TEMPLATE_NOT_IN_SUPABASE, detail: "registry_template_id", template_id };
  }
  if (skipLookup) {
    return { allowed: true, reason: "template_lookup_skipped_test_runtime", template_id };
  }
  const lookup = await lookupSupabaseTemplate(supabase, template_id);
  if (lookup.read_failed) {
    return { allowed: false, deferred: true, reason: "template_authority_read_failed", template_id };
  }
  if (!lookup.found) {
    return { allowed: false, reason: TEMPLATE_NOT_IN_SUPABASE, detail: "template_row_not_found", template_id };
  }

  // Body ↔ row binding. Enforced for free-text producers (a real id next to
  // caller-supplied words is still untracked copy); observed elsewhere.
  const text = clean(body ?? queue_row?.message_body ?? queue_row?.message_text);
  const template_body = lookup.row?.template_body;
  const body_binding = !text || !clean(template_body)
    ? "unverifiable"
    : bodyMatchesTemplate(template_body, text)
      ? "match"
      : "mismatch";
  if (body_binding === "mismatch" && !manual_operator_send && FREE_TEXT_PRODUCER_SOURCES.has(source)) {
    return {
      allowed: false,
      reason: TEMPLATE_NOT_IN_SUPABASE,
      detail: "body_not_rendered_from_template",
      template_id,
      body_binding,
    };
  }
  return {
    allowed: true,
    reason: "sms_templates_row",
    template_id,
    template_row_id: lookup.row?.id || null,
    body_binding,
  };
}

export default evaluateTemplateAuthority;
