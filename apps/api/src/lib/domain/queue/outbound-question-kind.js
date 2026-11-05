// ─── outbound-question-kind.js ───────────────────────────────────────────────
// Stamps metadata.question_kind on EVERY send_queue row at insert time
// (rc-8.5.15.1), so the repeat-asking-price guard (public.block_repeat_asking_price,
// PROPOSED_20261015120000) does not depend on use_case_template alone.
//
// Called by every writer: the canonical writer (sms-engine buildSendQueueInsertPayload:
// manual send-now / queue / schedule, template auto-reply, no-response and nurture
// follow-ups, AI conversation rows, retries, buyers, closings), the campaign batch
// insert, and the Discord reply route.
//
//   question_kind = 'asking_price' when
//     - the message text is an asking-price question (asking-price-question.js), or
//     - the use case is an asking-price ask (…asking_price…, s3_no_response_*), or
//     - the caller declared it (an AI decision whose intent is the S3 ask).
//   A caller can make a row STRICTER (declare an ask) but never looser: a text the
//   classifier recognises is stamped whatever the caller said.
//
// metadata.repeat_ask_override (the audited Inbox override) survives ONLY on a
// manual operator send carrying the full server-built shape; on any other row it is
// removed here, so no automated path can carry it to the guard.

import {
  ASKING_PRICE_CLASSIFIER_VERSION,
  classifyAskingPriceQuestion,
  isAskingPriceUseCase,
} from "@/lib/domain/seller-flow/asking-price-question.js";

export const QUESTION_KIND_ASKING_PRICE = "asking_price";
export const REPEAT_ASK_OVERRIDE_SCOPE = "repeat_asking_price";
export const REPEAT_ASK_OVERRIDE_MIN_REASON = 10;
export const REPEAT_ASK_OVERRIDE_MAX_REASON = 500;

function clean(value) {
  return String(value ?? "").trim();
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Is a metadata.repeat_ask_override object complete and well-formed? Pure. */
export function isValidRepeatAskOverride(override) {
  const o = objectOrEmpty(override);
  const reason = clean(o.reason);
  return (
    o.scope === REPEAT_ASK_OVERRIDE_SCOPE &&
    Boolean(clean(o.actor)) &&
    reason.length >= REPEAT_ASK_OVERRIDE_MIN_REASON &&
    reason.length <= REPEAT_ASK_OVERRIDE_MAX_REASON &&
    Number.isFinite(Date.parse(clean(o.at)))
  );
}

/**
 * Resolve the question kind of one outbound row. Pure.
 * @returns {{ question_kind: string|null, source: string|null, rule: string|null }}
 */
export function resolveOutboundQuestionKind({ message_body = "", use_case_template = null, metadata = {} } = {}) {
  const verdict = classifyAskingPriceQuestion(message_body);
  if (verdict.asking_price) return { question_kind: QUESTION_KIND_ASKING_PRICE, source: "text_classifier", rule: verdict.rule };
  if (isAskingPriceUseCase(use_case_template)) return { question_kind: QUESTION_KIND_ASKING_PRICE, source: "use_case", rule: clean(use_case_template).toLowerCase() };
  const declared = clean(objectOrEmpty(metadata).question_kind).toLowerCase();
  if (declared === QUESTION_KIND_ASKING_PRICE) return { question_kind: QUESTION_KIND_ASKING_PRICE, source: "caller", rule: null };
  return { question_kind: declared || null, source: declared ? "caller" : null, rule: null };
}

/**
 * Return a NEW metadata object for a send_queue row with question_kind stamped and
 * any illegitimate repeat_ask_override removed. Never throws; never mutates.
 * @param {{ message_body?: string, message_text?: string, rendered_message?: string, use_case_template?: string|null, metadata?: object }} row
 */
export function stampOutboundQuestionKind(row = {}) {
  const metadata = { ...objectOrEmpty(row.metadata) };
  try {
    const text = clean(row.message_body) || clean(row.message_text) || clean(row.rendered_message);
    const kind = resolveOutboundQuestionKind({ message_body: text, use_case_template: row.use_case_template, metadata });
    if (kind.question_kind === QUESTION_KIND_ASKING_PRICE) {
      metadata.question_kind = QUESTION_KIND_ASKING_PRICE;
      metadata.question_kind_source = kind.source;
      if (kind.rule) metadata.question_kind_rule = kind.rule;
      metadata.question_kind_version = ASKING_PRICE_CLASSIFIER_VERSION;
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "repeat_ask_override")) {
      const manual = metadata.manual_operator_send === true;
      if (!manual || !isValidRepeatAskOverride(metadata.repeat_ask_override)) {
        delete metadata.repeat_ask_override;
        metadata.repeat_ask_override_stripped = manual ? "malformed" : "not_a_manual_operator_send";
      }
    }
  } catch {
    // Stamping must never block a send; the guard still keys on use_case_template.
  }
  return metadata;
}

/** Is a send_queue row the guard cancelled as a repeat asking-price ask? Pure. */
export function repeatAskBlockOf(row = {}) {
  const status = clean(row?.queue_status).toLowerCase();
  const reason = clean(row?.paused_reason);
  if (status !== "cancelled" || !/^blocked_repeat_asking_price/.test(reason)) return null;
  return {
    paused_reason: reason,
    seller_replied: reason === "blocked_repeat_asking_price_seller_replied",
  };
}
