const HTML_TAG_PATTERN = /<[^>]+>/;

const BLOCK_TAG_BREAK_PATTERN =
  /<(?:br\s*\/?|\/p|\/div|\/li|\/tr|\/h[1-6]|\/ul|\/ol|\/table|\/tbody|\/thead|\/tfoot|\/section|\/article)\s*>/gi;

const OPENING_BLOCK_TAG_PATTERN =
  /<(?:p|div|li|tr|h[1-6]|ul|ol|table|tbody|thead|tfoot|section|article)\b[^>]*>/gi;

const COMMON_ENTITY_REPLACEMENTS = Object.freeze([
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&#39;/gi, "'"],
  [/&quot;/gi, '"'],
]);

function clean(value) {
  return String(value ?? "");
}

function decodeCommonHtmlEntities(value) {
  let decoded = clean(value);

  for (const [pattern, replacement] of COMMON_ENTITY_REPLACEMENTS) {
    decoded = decoded.replace(pattern, replacement);
  }

  return decoded;
}

function stripHtmlTags(value) {
  return clean(value)
    .replace(BLOCK_TAG_BREAK_PATTERN, " ")
    .replace(OPENING_BLOCK_TAG_PATTERN, " ")
    .replace(HTML_TAG_PATTERN, "");
}

function collapseWhitespace(value) {
  return clean(value)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// SMS style rule (permanent): no em dash (U+2014) or en dash (U+2013) ever
// reaches a seller. Replace with a natural comma pause and tidy the resulting
// punctuation. This is defense in depth at the final-body prep; authored
// templates and code-authored SMS bodies are additionally validated dash-free
// by test (no-em-dash-sms.test.mjs).
function replaceLongDashes(value) {
  return clean(value)
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*([.!?])/g, "$1");
}

export function sanitizeSmsTextValue(value) {
  let sanitized = value == null ? "" : String(value);

  // Run a few passes so encoded tags such as "&lt;p&gt;Jose&lt;/p&gt;" decode
  // and then get stripped before the value is used in SMS rendering.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = stripHtmlTags(decodeCommonHtmlEntities(stripHtmlTags(sanitized)));
    if (next === sanitized) break;
    sanitized = next;
  }

  return collapseWhitespace(replaceLongDashes(sanitized));
}

export function sanitizeSmsTextMap(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (
        value === null ||
        value === undefined ||
        typeof value === "string" ||
        typeof value === "number"
      ) {
        return [key, sanitizeSmsTextValue(value)];
      }

      return [key, value];
    })
  );
}

export function containsHtmlTags(value) {
  return HTML_TAG_PATTERN.test(clean(value));
}

export function prepareRenderedSmsForQueue({
  rendered_message_text,
  template_id = null,
  template_source = null,
  sanitizer = sanitizeSmsTextValue,
} = {}) {
  const original_rendered_message_text =
    rendered_message_text == null ? "" : String(rendered_message_text);
  const effective_sanitizer =
    typeof sanitizer === "function" ? sanitizer : sanitizeSmsTextValue;
  const sanitized_value = effective_sanitizer(original_rendered_message_text);
  const sanitized_rendered_message_text =
    sanitized_value == null ? "" : String(sanitized_value);
  const has_html = containsHtmlTags(sanitized_rendered_message_text);

  return {
    ok: !has_html,
    reason: has_html ? "rendered_sms_contains_html" : null,
    text: sanitized_rendered_message_text,
    diagnostics: {
      original_rendered_message_text,
      sanitized_rendered_message_text,
      template_id: template_id ?? null,
      template_source: template_source ?? null,
    },
  };
}

export function normalizeUsPhoneToE164(value) {
  const digits = sanitizeSmsTextValue(value).replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return "";
}

export default {
  sanitizeSmsTextValue,
  sanitizeSmsTextMap,
  containsHtmlTags,
  prepareRenderedSmsForQueue,
  normalizeUsPhoneToE164,
};
