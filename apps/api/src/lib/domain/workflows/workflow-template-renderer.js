import { applyWorkflowSpinSyntax } from "@/lib/domain/workflows/workflow-spin-syntax.js";
import { PERSONALIZATION_TOKENS } from "@/lib/domain/workflows/workflow-node-types.js";

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ" +
  " !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

function clean(value) {
  return String(value ?? "").trim();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function tokenValue(context = {}, token) {
  const direct = context[token];
  if (direct !== undefined && direct !== null) return String(direct);
  const nested = ensureObject(context.tokens)[token];
  if (nested !== undefined && nested !== null) return String(nested);
  return "";
}

function replaceTokens(text = "", context = {}) {
  const replacements = {};
  const missing_tokens = new Set();
  const rendered = String(text ?? "").replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (raw, token) => {
    if (!PERSONALIZATION_TOKENS.includes(token)) return raw;
    const value = tokenValue(context, token);
    replacements[token] = value;
    if (!clean(value)) missing_tokens.add(token);
    return value;
  });

  return {
    text: rendered,
    replacements,
    missing_tokens: Array.from(missing_tokens),
  };
}

function isGsmChar(char) {
  return GSM_BASIC.includes(char) || GSM_EXTENDED.includes(char);
}

export function calculateSmsSegments(text = "") {
  const body = String(text ?? "");
  let character_count = 0;
  let is_gsm_7 = true;

  for (const char of body) {
    if (!isGsmChar(char)) is_gsm_7 = false;
    character_count += GSM_EXTENDED.includes(char) ? 2 : 1;
  }

  const singleLimit = is_gsm_7 ? 160 : 70;
  const segmentLimit = is_gsm_7 ? 153 : 67;
  const segment_count =
    character_count === 0 ? 0 : character_count <= singleLimit ? 1 : Math.ceil(character_count / segmentLimit);

  return {
    character_count,
    segment_count,
    encoding: is_gsm_7 ? "gsm-7" : "ucs-2",
  };
}

export function renderWorkflowTemplate(variant = {}, context = {}) {
  const subjectTokenResult = replaceTokens(variant.subject || "", context);
  const bodyTokenResult = replaceTokens(variant.body || "", context);
  const spinContext = {
    ...context,
    step_id: context.step_id || context.workflow_step_id,
  };
  const subjectSpin = variant.spin_syntax_enabled === false
    ? { text: subjectTokenResult.text, substitutions: [] }
    : applyWorkflowSpinSyntax(subjectTokenResult.text, spinContext);
  const bodySpin = variant.spin_syntax_enabled === false
    ? { text: bodyTokenResult.text, substitutions: [] }
    : applyWorkflowSpinSyntax(bodyTokenResult.text, spinContext);

  return {
    variant_id: variant.id || null,
    variant_key: variant.variant_key || null,
    language: variant.language || context.language || "en",
    subject: subjectSpin.text || null,
    body: bodySpin.text,
    token_replacements: {
      ...subjectTokenResult.replacements,
      ...bodyTokenResult.replacements,
    },
    missing_tokens: Array.from(new Set([
      ...subjectTokenResult.missing_tokens,
      ...bodyTokenResult.missing_tokens,
    ])),
    spin_substitutions: [
      ...subjectSpin.substitutions.map((entry) => ({ field: "subject", ...entry })),
      ...bodySpin.substitutions.map((entry) => ({ field: "body", ...entry })),
    ],
    sms: calculateSmsSegments(bodySpin.text),
  };
}

export function renderWorkflowTemplatePreviews(variant = {}, context = {}, count = 10) {
  const total = Math.max(1, Math.min(Number(count) || 10, 25));
  return Array.from({ length: total }, (_, index) => renderWorkflowTemplate(variant, {
    ...context,
    seed: `${clean(context.seed) || "render-preview"}:${index + 1}`,
  }));
}
