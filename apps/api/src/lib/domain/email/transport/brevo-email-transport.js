/**
 * brevo-email-transport.js
 *
 * The ONE network primitive for email. Bytes out, classified outcome back.
 *
 * WHAT THIS FILE IS FORBIDDEN TO DO, and why each prohibition exists.
 *
 *   No retries.        A retry is a second attempt on a logical communication,
 *                      and only the attempt ledger may authorise one. A loop in
 *                      here would send a second email without a second attempt
 *                      row, making the duplicate invisible to every audit.
 *   No suppression.    Suppressing on a bounce is a durable business decision
 *                      with legal weight; it belongs to the ledger, not to the
 *                      code holding an open socket.
 *   No queue writes.   Projections are written after the dispatcher has decided
 *                      what happened, and they are never authority.
 *   No policy.         `retryable` is not a fact about a response; it is a
 *                      judgement the transition authority makes from one.
 *
 * NO SILENT SUCCESS. A 2xx without a messageId resolves as
 * `provider_ambiguous_accept`, not as a send. Reporting it as success would
 * write a ledger row that can never be matched to a webhook, and the operator
 * would be told an email went out that we cannot prove and cannot trace.
 *
 * CREDENTIALS ARE SERVER-ONLY AND NEVER TRAVEL IN AN ERROR. The API key is read
 * from the environment per brand, used once as a header, and never placed on a
 * result, an error, a log line or a thrown object.
 */

import { resolveBrevoApiKeyForBrand } from "@/lib/email/brevo-client.js";
import { classifyBrevoProviderError } from "@/lib/domain/email/transport/brevo-error-classifier.js";
import { classifyNetworkFailurePhase } from "@/lib/domain/messaging/transport-failure-phase.js";

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";

/** Brevo's documented ceilings. Exceeding them is a 400 we can avoid paying for. */
const MAX_HTML_BYTES = 200_000;
const MAX_TEXT_BYTES = 80_000;
const MAX_SUBJECT_CHARS = 998;   // RFC 5322 line-length ceiling for a header
const MAX_TAG_CHARS = 64;

function clean(value) {
  return String(value ?? "").trim();
}

function truncate(value, max) {
  const text = clean(value);
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Header values may not contain CR or LF. Without this, a subject assembled
 * from seller-supplied text could inject additional headers.
 */
function headerSafe(value) {
  return clean(value).replace(/[\r\n]+/g, " ");
}

function buildPayload(request = {}) {
  const to = clean(request.to);
  const subject = truncate(headerSafe(request.subject), MAX_SUBJECT_CHARS);
  const html = truncate(request.html, MAX_HTML_BYTES);
  const text = truncate(request.text, MAX_TEXT_BYTES);
  const from_email = clean(request.from?.email);
  const from_name = headerSafe(request.from?.name);

  // These are refusals rather than defaults on purpose. A message with no
  // recipient, no subject or no body is not something to repair and send; it is
  // a bug upstream that must surface before a seller sees the result.
  if (!to) return { ok: false, reason: "missing_recipient" };
  if (!from_email) return { ok: false, reason: "missing_sender" };
  if (!subject) return { ok: false, reason: "missing_subject" };
  if (!html && !text) return { ok: false, reason: "missing_body" };

  const tags = Array.isArray(request.tags)
    ? request.tags.map((tag) => truncate(headerSafe(tag), MAX_TAG_CHARS)).filter(Boolean)
    : [];

  return {
    ok: true,
    payload: {
      sender: from_name ? { email: from_email, name: from_name } : { email: from_email },
      to: [{ email: to }],
      subject,
      ...(html ? { htmlContent: html } : {}),
      ...(text ? { textContent: text } : {}),
      ...(clean(request.reply_to?.email) ? { replyTo: { email: clean(request.reply_to.email) } } : {}),
      ...(tags.length ? { tags } : {}),
      ...(request.headers && typeof request.headers === "object" ? { headers: request.headers } : {}),
      ...(request.params && typeof request.params === "object" ? { params: request.params } : {}),
    },
  };
}

/**
 * @param {object} deps
 * @param {Function} [deps.fetch_impl]  injected so tests can drive fault cases
 *                                      and assert the ordering guarantees the
 *                                      dispatcher depends on.
 * @param {Function} [deps.resolve_api_key]
 */
export function createBrevoEmailTransport(deps = {}) {
  const fetch_impl = deps.fetch_impl || fetch;
  const resolve_api_key = deps.resolve_api_key || resolveBrevoApiKeyForBrand;
  const send_url = deps.send_url || BREVO_SEND_URL;

  return {
    provider: "brevo",

    async send(request = {}) {
      const built = buildPayload(request);
      if (!built.ok) {
        // Nothing left this process, and no amount of repetition fixes a payload
        // the caller assembled wrongly.
        return {
          ok: false,
          provider: "brevo",
          failure_class: "provider_configuration_error",
          may_have_transmitted: false,
          provider_code: built.reason,
          provider_message: "Outbound email payload was incomplete",
          transport_phase: "pre_request",
          operator_reason: `The email was not sent because the request was incomplete (${built.reason}).`,
          suppression_action: null,
        };
      }

      const api_key = resolve_api_key(request.brand_key, {
        // A caller that names a brand gets that brand's credential or nothing.
        // Falling back to a shared key would send from the wrong identity, which
        // is worse than not sending.
        allow_legacy_fallback: !clean(request.brand_key),
      });

      if (!api_key) {
        return {
          ok: false,
          provider: "brevo",
          failure_class: "provider_auth_failed",
          may_have_transmitted: false,
          provider_code: "missing_brevo_api_key_for_brand",
          provider_message: "Email provider is not configured for this brand",
          transport_phase: "pre_request",
          operator_reason:
            "No Brevo credential is configured for this brand, so nothing was sent. A human must add it.",
          suppression_action: null,
        };
      }

      let response;
      try {
        response = await fetch_impl(send_url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "api-key": api_key,
          },
          body: JSON.stringify(built.payload),
        });
      } catch (error) {
        // The phase decides everything. A refused connection is provably unsent;
        // a reset mid-request is not, and must never be repeated automatically.
        const phase = classifyNetworkFailurePhase(error);
        return classifyBrevoProviderError({
          network_phase: phase.phase,
          may_have_transmitted: phase.may_have_transmitted,
          message: clean(error?.message) || "brevo_network_error",
          cause: error?.cause,
          name: error?.name,
        });
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        // A body we cannot read is not evidence of refusal. If the status says
        // the provider accepted, we still cannot name what it accepted.
        body = null;
      }

      if (!response.ok) {
        return classifyBrevoProviderError({ status: response.status, data: body });
      }

      const provider_message_id = clean(body?.messageId || body?.message_id);
      if (!provider_message_id) {
        return {
          ok: false,
          provider: "brevo",
          failure_class: "provider_ambiguous_accept",
          may_have_transmitted: true,
          provider_code: null,
          provider_message: "Provider accepted the request without returning a message id",
          transport_phase: "response",
          operator_reason:
            "The provider returned success but no message id, so the send cannot be identified or reconciled. It will not be resent automatically.",
          suppression_action: null,
        };
      }

      return { ok: true, provider: "brevo", provider_message_id };
    },
  };
}

export default createBrevoEmailTransport;
