/**
 * Render-time validation for outbound template bodies.
 *
 * WHY
 * The pre-claim validator in lib/supabase/sms-engine.js checks that a queue row
 * has a body, a phone, a template reference, a candidate snapshot and a seller
 * first name. It does not inspect the body's CONTENT. Nothing anywhere checks
 * that every merge field actually resolved.
 *
 * That gap is reachable today. All five current canary-eligible templates
 * contain `{{agent_name}}`, and `agent_name` resolves through a fallback chain
 * in build-send-queue-item.js that terminates in `""` — partly sourced from
 * Podio, which has been unavailable since early August. Every LA row ever sent
 * carries agent_name = NULL.
 *
 * So the failure mode is not hypothetical: a body renders as
 *
 *     "Hola Rodolfo,  aqui. Pregunta rapida. Sigues siendo el dueno de ...?"
 *
 * with a blank where the agent's name belongs — or, if substitution is skipped
 * entirely, ships the literal token to a seller. Both pass every existing rail.
 *
 * This is the same class of defect as the S1 blank-greeting incident, one field
 * over. That one was caught by a provider-side guard on "Hi ,". A blank in the
 * middle of a sentence has no such backstop.
 *
 * FAIL CLOSED
 * A body may be sent only when every `{{token}}` has a non-empty replacement
 * and no token survives into the rendered text.
 */

const clean = (value) => String(value ?? "").trim();

/** Matches {{ token }} with optional inner whitespace. */
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export const RENDER_FAILURE = {
  EMPTY_TEMPLATE: "empty_template_body",
  MISSING_VALUE: "missing_merge_value",
  UNRESOLVED_TOKEN: "unresolved_placeholder_token",
  EMPTY_RESULT: "empty_rendered_body",
};

/**
 * Every distinct merge field a template requires, in first-appearance order.
 */
export function requiredMergeFields(templateBody) {
  const body = clean(templateBody);
  if (!body) return [];

  const seen = new Set();
  const fields = [];
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const field = match[1];
    if (!seen.has(field)) {
      seen.add(field);
      fields.push(field);
    }
  }
  return fields;
}

/**
 * Render a template body, failing closed on anything unresolved.
 *
 * @param {string} templateBody
 * @param {Record<string, unknown>} values
 * @returns {{ok: boolean, body: string|null, reason?: string, missing?: string[], required: string[]}}
 */
export function renderTemplateBody(templateBody, values = {}) {
  const body = clean(templateBody);
  if (!body) {
    return { ok: false, body: null, reason: RENDER_FAILURE.EMPTY_TEMPLATE, required: [] };
  }

  const required = requiredMergeFields(body);

  // A field counts as supplied only when it has a non-empty trimmed value.
  // `null`, `undefined`, `""` and "   " are all absences — treating whitespace
  // as a value is exactly how a blank lands mid-sentence.
  const missing = required.filter((field) => !clean(values[field]));
  if (missing.length > 0) {
    return {
      ok: false,
      body: null,
      reason: RENDER_FAILURE.MISSING_VALUE,
      missing,
      required,
    };
  }

  const rendered = body.replace(TOKEN_PATTERN, (_match, field) => clean(values[field]));

  // Belt and braces: if any token survived substitution — a malformed token, a
  // nested brace, a value that itself contained a token — refuse rather than
  // ship braces to a seller.
  const survivors = requiredMergeFields(rendered);
  if (survivors.length > 0) {
    return {
      ok: false,
      body: null,
      reason: RENDER_FAILURE.UNRESOLVED_TOKEN,
      missing: survivors,
      required,
    };
  }

  const finalBody = clean(rendered);
  if (!finalBody) {
    return { ok: false, body: null, reason: RENDER_FAILURE.EMPTY_RESULT, required };
  }

  return { ok: true, body: finalBody, required };
}

/**
 * Can this target's outbound content be fully determined before send?
 *
 * This is the auditability gate: a canary candidate must have a body we can
 * show an operator in advance, with no field left to chance at send time.
 */
export function canDetermineOutboundContent(templateBody, values = {}) {
  return renderTemplateBody(templateBody, values).ok;
}
