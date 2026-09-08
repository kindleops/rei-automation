/**
 * inbound-email-contract.js
 *
 * The boundary between "a provider posted something at us" and "a seller sent us
 * a message".
 *
 * WHY A CONTRACT RATHER THAN PASSING THE BREVO PAYLOAD AROUND.
 *   Brevo's inbound parse payload has its own field names, its own idea of how
 *   recipients are shaped, and its own conventions for headers and attachments.
 *   If those spread into the resolver, the message model and the tests, then the
 *   day a second provider appears -- or the day Brevo changes a field -- the
 *   change is everywhere instead of in one adapter. Worse, the domain starts
 *   reasoning in a vocabulary that belongs to a vendor.
 *
 *   So the domain sees ONLY the shape below, and exactly one file knows how to
 *   produce it from Brevo.
 *
 * EMAIL-4 IS THE REAL AUDIENCE.
 *   The next phase turns seller messages into seller intelligence. It should
 *   receive clean communication evidence -- who wrote, in which conversation,
 *   when, what they said, what they attached -- and never need to know that
 *   Brevo spells a recipient `To` and puts the envelope somewhere else.
 *
 * WHAT IS DELIBERATELY ABSENT FROM THIS SHAPE.
 *   Anything resembling intent. No sentiment, no interest, no asking price, no
 *   urgency, no next action. EMAIL-3's job ends at trustworthy evidence, and a
 *   field here called `looks_interested` would be an invitation for a later
 *   phase to trust a guess this phase had no business making.
 */

export const INBOUND_EMAIL_CONTRACT_VERSION = "inbound_email_v1";

/**
 * Transport-level classification. NOT seller intent.
 *
 * The distinction matters enough to name: `auto_reply` means RFC headers say a
 * machine generated this, which is a fact about the message. It says nothing
 * about whether the seller is interested, and EMAIL-4 must not read it as if it
 * did -- its only job is to stop an out-of-office being mistaken for a reply.
 */
export const INBOUND_MESSAGE_CLASS = Object.freeze({
  HUMAN_REPLY: "human_reply",
  AUTO_REPLY: "auto_reply",
  DELIVERY_STATUS: "delivery_status",
  SYSTEM_OR_LIST: "system_or_list",
  MALFORMED: "malformed",
});

/**
 * @typedef {object} NormalizedInboundEmail
 *
 * @property {string}  provider              e.g. "brevo"
 * @property {string|null} provider_event_id provider's own id, when it gives one
 * @property {string|null} rfc_message_id    RFC 5322 Message-ID of THIS message
 * @property {string|null} in_reply_to       RFC 5322 In-Reply-To
 * @property {string[]}    references        RFC 5322 References, oldest first
 *
 * @property {string|null} envelope_from     SMTP MAIL FROM
 * @property {string|null} envelope_to       SMTP RCPT TO -- the only recipient
 *                                           that proves where mail was DELIVERED
 * @property {{email,name}|null} from        header From
 * @property {Array}   to                    header To, seller-controlled text
 * @property {Array}   cc
 * @property {string|null} subject
 *
 * @property {string|null} text_body         as supplied
 * @property {string|null} html_body         as supplied, UNTRUSTED
 * @property {string|null} provider_reply_text  the provider's own extraction of
 *                                           the newest reply, when it offers one
 * @property {object}  headers               lowercased header name -> value
 *
 * @property {string}  received_at           ISO instant
 * @property {string|null} sent_at
 * @property {Array<InboundAttachmentDescriptor>} attachments
 * @property {object}  provider_metadata     kept for traceability, never read
 *                                           for meaning by the domain
 *
 * @typedef {object} InboundAttachmentDescriptor
 * @property {string}  filename              as the provider reported it
 * @property {string|null} content_type
 * @property {number|null} byte_size
 * @property {string|null} content_id        for inline/cid: parts
 * @property {string|null} download_url      often SHORT-LIVED
 * @property {string|null} content_base64    when the provider inlines the bytes
 * @property {string|null} provider_token
 */

/**
 * Structural check on an adapter's output, run by tests rather than at call time.
 *
 * A normalizer that silently returns a half-shaped object would produce an
 * inbound message with no sender or no timestamp, and the failure would surface
 * hours later as an unattributable row. Better to state the shape and check it.
 */
export function assertNormalizedInboundShape(value) {
  const problems = [];
  if (!value || typeof value !== "object") return { ok: false, problems: ["not_an_object"] };

  if (!value.provider) problems.push("missing_provider");
  if (!value.received_at) problems.push("missing_received_at");
  // from is the one identity field with no substitute: a message with no sender
  // cannot be attributed, replied to, or explained.
  if (!value.from || !value.from.email) problems.push("missing_from");
  if (!Array.isArray(value.references)) problems.push("references_not_an_array");
  if (!Array.isArray(value.attachments)) problems.push("attachments_not_an_array");
  if (!value.headers || typeof value.headers !== "object") problems.push("headers_not_an_object");

  return problems.length ? { ok: false, problems } : { ok: true, problems: [] };
}

/**
 * Structural check on an inbound provider adapter.
 */
export function assertInboundProviderShape(provider) {
  const problems = [];
  if (!provider || typeof provider !== "object") {
    return { ok: false, problems: ["provider_is_not_an_object"] };
  }
  if (typeof provider.verify !== "function") problems.push("missing_verify");
  if (typeof provider.normalizeInbound !== "function") problems.push("missing_normalizeInbound");
  if (typeof provider.provider !== "string" || !provider.provider.trim()) {
    problems.push("missing_provider_name");
  }
  return problems.length ? { ok: false, problems } : { ok: true, problems: [] };
}

export default assertNormalizedInboundShape;
