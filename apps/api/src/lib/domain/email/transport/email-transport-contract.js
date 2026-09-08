/**
 * email-transport-contract.js
 *
 * The boundary between "we decided to send an email" and "an ESP was asked to".
 *
 * WHY A CONTRACT RATHER THAN JUST CALLING BREVO.
 *   The canonical dispatcher already owns every decision that matters: identity,
 *   whether an attempt may be allocated, whether we are allowed to send now,
 *   what a provider outcome means for retry. A transport that also had opinions
 *   about any of those would be a second authority, and two authorities on one
 *   question is how a seller receives the same message twice.
 *
 *   So an adapter has exactly one job: put bytes on the wire and report, in the
 *   platform's own vocabulary, what happened. It does not retry. It does not
 *   decide whether a failure is safe to repeat. It does not suppress, log to the
 *   ledger, or touch the queue.
 *
 * THE VOCABULARY IS NOT NEGOTIABLE.
 *   `failure_class` values must come from the set
 *   domain/communications/transport-outcome-mapping.js already understands. A
 *   new provider does not get to introduce a new outcome shape; it gets to
 *   translate its own error codes into the existing one. That is the whole
 *   reason a second ESP is one file and not a migration.
 *
 * SUCCESS MEANS A PROVIDER MESSAGE ID, AND NOTHING ELSE.
 *   A 2xx with no message id is NOT a success. It is `provider_ambiguous_accept`:
 *   the provider may well have accepted the message, but we cannot name what it
 *   accepted, so we can neither confirm delivery nor safely repeat the request.
 *   Returning ok:true there would let the ledger record a send it can never
 *   reconcile against a webhook.
 */

/**
 * The failure classes an email adapter may return. Every one of these is already
 * meaningful to mapTransportOutcome(); this list exists so an adapter can be
 * checked against it rather than trusted.
 */
export const EMAIL_FAILURE_CLASSES = Object.freeze([
  // transport
  "provider_unreachable_before_request",  // socket never opened; provably unsent, safe to repeat
  "provider_ambiguous_transport",         // timeout/reset after the request left; acceptance cannot be excluded
  "provider_ambiguous_accept",            // 2xx without a message id
  // provider verdicts, definitively unsent and never worth repeating
  "invalid_to_address",
  "recipient_opted_out",
  "content_filter_blocked",
  // provider verdicts, definitively unsent and needing a human
  "provider_auth_failed",
  "provider_configuration_error",
  "sender_not_provisioned",
  // deliberately unmapped; see brevo-error-classifier.js
  "provider_rate_limited",
]);

const FAILURE_CLASS_SET = new Set(EMAIL_FAILURE_CLASSES);

export function isKnownEmailFailureClass(value) {
  return FAILURE_CLASS_SET.has(String(value ?? "").trim());
}

/**
 * The shape every adapter's `send` must resolve to.
 *
 * @typedef {object} EmailSendRequest
 * @property {string} to                 single normalized recipient
 * @property {{email:string,name?:string}} from
 * @property {{email:string}} [reply_to]
 * @property {string} subject
 * @property {string} [html]
 * @property {string} [text]
 * @property {string[]} [tags]
 * @property {object} [headers]          provider-neutral custom headers
 * @property {string} [brand_key]        selects the server-side API credential
 *
 * @typedef {object} EmailSendResult
 * @property {true} ok
 * @property {string} provider           e.g. "brevo"
 * @property {string} provider_message_id
 *
 * @typedef {object} EmailSendFailure
 * @property {false} ok
 * @property {string} provider
 * @property {string} failure_class      from EMAIL_FAILURE_CLASSES
 * @property {boolean} may_have_transmitted
 * @property {string|null} provider_code
 * @property {string|null} provider_message   sanitized; never carries credentials
 * @property {string|null} transport_phase
 */

/**
 * Structural check on an adapter, run by tests rather than at call time.
 * A transport that fails this must not be wired in: the dispatcher's guarantees
 * all rest on the adapter returning what it says it returns.
 */
export function assertEmailTransportShape(transport) {
  const problems = [];
  if (!transport || typeof transport !== "object") {
    return { ok: false, problems: ["transport_is_not_an_object"] };
  }
  if (typeof transport.send !== "function") problems.push("missing_send");
  if (typeof transport.provider !== "string" || !transport.provider.trim()) {
    problems.push("missing_provider_name");
  }
  return problems.length ? { ok: false, problems } : { ok: true, problems: [] };
}

/**
 * Normalize whatever an adapter resolved or threw into the failure shape the
 * dispatcher expects. An adapter that throws an unrecognised error must not be
 * able to make the dispatcher guess: an unknown throw is ambiguous, because we
 * cannot prove from it that nothing left this process.
 */
export function toEmailSendFailure(provider, error = {}) {
  const failure_class = isKnownEmailFailureClass(error.failure_class)
    ? error.failure_class
    : "provider_ambiguous_transport";

  return {
    ok: false,
    provider,
    failure_class,
    may_have_transmitted:
      error.may_have_transmitted === undefined
        // Fail closed. "We do not know" is treated as "it may have gone out",
        // because the opposite default sends a second email to a real person.
        ? failure_class !== "provider_unreachable_before_request"
        : error.may_have_transmitted !== false,
    provider_code: error.provider_code ?? null,
    provider_message: error.provider_message ?? null,
    transport_phase: error.transport_phase ?? null,
  };
}

export default assertEmailTransportShape;
