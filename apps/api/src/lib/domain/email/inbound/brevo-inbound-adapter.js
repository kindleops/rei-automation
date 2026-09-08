/**
 * brevo-inbound-adapter.js
 *
 * The ONLY file that knows what a Brevo inbound parse payload looks like.
 *
 * ── WHAT BREVO ACTUALLY PROVIDES FOR INBOUND AUTHENTICATION ────────────────
 *
 * Investigated for EMAIL-2 (transactional webhooks) and again here, because the
 * two are NOT the same product and must not be assumed to share security:
 *
 *   Transactional event webhooks  a caller-chosen URL. No signature.
 *   INBOUND PARSE webhooks        a caller-chosen URL. No signature either.
 *
 * Brevo publishes no HMAC, no shared-secret header, and no per-request signing
 * key for inbound parsing. Its documented protections are that the URL is chosen
 * by us and that requests originate from its infrastructure.
 *
 * SO WE MUST NOT CLAIM CRYPTOGRAPHIC AUTHENTICATION WE DO NOT HAVE.
 * What we actually have, and what is therefore implemented:
 *
 *   1. A SECRET CAPABILITY URL. The webhook path carries a high-entropy token
 *      that only Brevo and this deployment know. Possession of the URL is the
 *      credential. This is the strongest control the provider genuinely
 *      supports, and it is real -- but it is a bearer secret in a URL, so it can
 *      leak through logs, proxies and browser history in a way an HMAC cannot.
 *   2. A SHARED-SECRET HEADER where a proxy can add one, reusing the EMAIL-2
 *      verifier so both surfaces agree about what "authenticated" means.
 *   3. SCHEMA VALIDATION AFTER authentication, never before.
 *   4. IDEMPOTENCY, so a replayed capture of a real request cannot create a
 *      second seller message.
 *   5. REPLY-TOKEN CORRELATION, which is the compensating control that actually
 *      matters: a forged callback still has to name a 128-bit alias that only
 *      appears in mail we sent to that seller.
 *
 * THE HONEST SUMMARY: inbound authenticity rests on URL secrecy plus alias
 * unguessability, not on a signature. That is why nothing downstream treats an
 * inbound message as authority over acquisition state -- it is evidence, and
 * EMAIL-3 stops there deliberately.
 *
 * ── PAYLOAD SHAPE ──────────────────────────────────────────────────────────
 *
 * Brevo posts an array of items, or an object with `items`. Field names vary
 * across their documentation revisions, so each read below accepts the spellings
 * that have appeared rather than betting on one. An unrecognised shape produces
 * a refusal, never a half-populated message.
 */

import { child } from "@/lib/logging/logger.js";
import { INBOUND_MESSAGE_CLASS } from "@/lib/domain/email/inbound/inbound-email-contract.js";
import { classifyInboundMessage } from "@/lib/domain/email/inbound/inbound-message-classification.js";
import { verifyBrevoWebhook } from "@/lib/domain/email/brevo-webhook-verification.js";
import { TRUST_CLASS } from "@/lib/domain/communications/callback-trust-policy.js";
import crypto from "node:crypto";
import { asObject } from "@/lib/hostile-input.js";

const logger = child({ module: "domain.email.brevo_inbound" });

export const BREVO_INBOUND_ADAPTER_VERSION = "brevo_inbound_v1";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return "";
}

/**
 * Brevo renders an address as a bare string, as `{ Address, Name }`, or as
 * `{ address, name }` depending on the field and the API revision.
 */
function readAddress(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const raw = clean(value);
    if (!raw) return null;
    const angle = raw.match(/^(.*?)<([^>]+)>\s*$/);
    if (angle) {
      return { email: lower(angle[2]), name: clean(angle[1]).replace(/^"|"$/g, "") || null, raw };
    }
    return { email: lower(raw), name: null, raw };
  }
  if (typeof value === "object") {
    const email = lower(value.Address ?? value.address ?? value.Email ?? value.email);
    if (!email) return null;
    return { email, name: clean(value.Name ?? value.name) || null, raw: clean(value.raw) || email };
  }
  return null;
}

function readAddressList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(readAddress).filter(Boolean);
}

/**
 * Headers, lowercased. Brevo has used an object map and an array of
 * `{ Name, Value }` pairs. A repeated header (Received, References) keeps the
 * LAST value, which is the one closest to us.
 */
function readHeaders(value) {
  const out = {};
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const name = lower(entry?.Name ?? entry?.name ?? entry?.key);
      if (name) out[name] = clean(entry?.Value ?? entry?.value);
    }
    return out;
  }
  if (typeof value === "object") {
    for (const [name, raw] of Object.entries(value)) {
      out[lower(name)] = Array.isArray(raw) ? clean(raw[raw.length - 1]) : clean(raw);
    }
  }
  return out;
}

/**
 * References is a space-separated list of Message-IDs, oldest first. Some clients
 * separate with commas or newlines, so split on any whitespace or comma and keep
 * only things shaped like a Message-ID.
 */
function parseReferences(value) {
  const raw = clean(value);
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => clean(entry))
    .filter((entry) => /^<[^>]+>$/.test(entry));
}

function toIso(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const number = Number(raw);
    return new Date(number > 9_999_999_999 ? number : number * 1000).toISOString();
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function readAttachments(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map((entry) => ({
    filename: firstNonEmpty(entry?.Name, entry?.name, entry?.filename, entry?.FileName) || null,
    content_type: firstNonEmpty(entry?.ContentType, entry?.contentType, entry?.content_type, entry?.type) || null,
    byte_size: Number.isFinite(Number(entry?.ContentLength ?? entry?.size ?? entry?.byte_size))
      ? Number(entry?.ContentLength ?? entry?.size ?? entry?.byte_size)
      : null,
    content_id: firstNonEmpty(entry?.ContentID, entry?.contentId, entry?.content_id) || null,
    // Brevo serves attachments from a token-scoped URL that EXPIRES. Anything
    // that needs the bytes must fetch them during ingestion, not later.
    download_url: firstNonEmpty(entry?.DownloadToken ? null : entry?.Url, entry?.url, entry?.DownloadUrl) || null,
    provider_token: firstNonEmpty(entry?.DownloadToken, entry?.token) || null,
    content_base64: firstNonEmpty(entry?.Content, entry?.content, entry?.data) || null,
  }));
}

export function createBrevoInboundProvider(deps = {}) {
  return {
    provider: "brevo",

    /**
     * Authenticate an inbound request.
     *
     * Two independent credentials, either of which suffices:
     *
     *   the CAPABILITY TOKEN in the URL path -- the control Brevo actually
     *   supports, since it lets us choose an unguessable endpoint;
     *   a SHARED-SECRET HEADER, for a proxy that can add one, verified by the
     *   same code EMAIL-2 uses so both surfaces agree on what authenticated
     *   means.
     *
     * Fails closed. An absent configuration is a 503-shaped refusal reported
     * separately from a bad credential, because they need different fixes.
     */
    verify(raw_input) {
      const input = asObject(raw_input);
      const expected_path_token = clean(
        input.expected_path_token ?? process.env.BREVO_INBOUND_URL_TOKEN
      );
      const presented_path_token = clean(input.path_token);
      const header_secret_configured = clean(
        input.secret ?? process.env.BREVO_INBOUND_WEBHOOK_SECRET ?? process.env.BREVO_WEBHOOK_SECRET
      );

      if (!expected_path_token && !header_secret_configured) {
        return {
          ok: false,
          configured: false,
          trust_class: TRUST_CLASS.UNAUTHENTICATED,
          mode: null,
          reason: "brevo_inbound_security_not_configured",
          policy_version: BREVO_INBOUND_ADAPTER_VERSION,
        };
      }

      if (expected_path_token && presented_path_token) {
        // Constant-time over fixed-width digests: comparing the raw strings
        // would leak length, and length is a meaningful hint for a token.
        const a = crypto.createHash("sha256").update(presented_path_token, "utf8").digest();
        const b = crypto.createHash("sha256").update(expected_path_token, "utf8").digest();
        if (crypto.timingSafeEqual(a, b)) {
          return {
            ok: true,
            configured: true,
            trust_class: TRUST_CLASS.AUTHENTICATED,
            mode: "capability_url",
            reason: null,
            policy_version: BREVO_INBOUND_ADAPTER_VERSION,
          };
        }
      }

      if (header_secret_configured) {
        const header_result = verifyBrevoWebhook({
          headers: input.headers,
          raw_body: input.raw_body,
          url: input.url,
          secret: header_secret_configured,
        });
        if (header_result.ok) {
          return { ...header_result, mode: "shared_secret", policy_version: BREVO_INBOUND_ADAPTER_VERSION };
        }
      }

      return {
        ok: false,
        configured: true,
        trust_class: TRUST_CLASS.UNAUTHENTICATED,
        mode: null,
        reason: presented_path_token
          ? "brevo_inbound_credential_mismatch"
          : "brevo_inbound_credential_absent",
        policy_version: BREVO_INBOUND_ADAPTER_VERSION,
      };
    },

    /**
     * Brevo payload -> the canonical shape. No decisions, no IO, no guesses.
     */
    normalizeInbound(payload = {}, options = {}) {
      const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
      const headers = readHeaders(body.Headers ?? body.headers);

      const from = readAddress(body.From ?? body.from ?? headers.from);
      if (!from?.email) {
        // No sender means the message cannot be attributed, replied to or
        // explained. That is a refusal, not a message with a blank field.
        return { ok: false, reason: "inbound_payload_missing_sender" };
      }

      const to = readAddressList(body.To ?? body.to);
      const cc = readAddressList(body.Cc ?? body.cc);

      // The envelope recipient is the only field that proves where the mail was
      // DELIVERED. To and Cc are seller-controlled text.
      const envelope_to = firstNonEmpty(
        readAddress(body.RecipientAddress ?? body.recipient ?? body.envelope_to)?.email,
        readAddress(body.DeliveredTo ?? body.delivered_to)?.email,
        headers["delivered-to"],
        headers["x-envelope-to"]
      ) || null;

      const references = parseReferences(
        body.References ?? body.references ?? headers.references
      );

      const text_body = firstNonEmpty(body.RawTextBody, body.TextBody, body.text, body.text_body) || null;
      const html_body = firstNonEmpty(body.RawHtmlBody, body.HtmlBody, body.html, body.html_body) || null;
      // Brevo's own extraction of the newest reply, when it supplies one. Kept
      // separately rather than merged: it is the provider's opinion, and the
      // original body remains the record.
      const provider_reply_text = firstNonEmpty(body.ExtractedMarkdownMessage, body.ReplyBody) || null;

      const normalized = {
        provider: "brevo",
        // PROVIDER-ISSUED IDS ONLY. The RFC Message-ID is deliberately absent
        // from this chain: it is chosen by the SENDER's mail client, so a
        // hostile sender could pin it to a value already ingested and suppress
        // their own reply, or vary it per retry and defeat de-duplication. When
        // Brevo issues no id of its own, the ingest layer derives a stable
        // content digest instead -- never a random UUID.
        provider_event_id: firstNonEmpty(body.Uuid, body.uuid, body.id) || null,
        rfc_message_id: firstNonEmpty(body.MessageId, body["Message-Id"], headers["message-id"]) || null,
        in_reply_to: firstNonEmpty(body.InReplyTo, body.in_reply_to, headers["in-reply-to"]) || null,
        references,

        envelope_from: readAddress(body.SenderAddress ?? body.envelope_from)?.email || from.email,
        envelope_to,
        from: { email: from.email, name: from.name },
        to,
        cc,
        subject: firstNonEmpty(body.Subject, body.subject, headers.subject) || null,

        text_body,
        html_body,
        provider_reply_text,
        headers,

        received_at: toIso(body.ReceivedAt ?? body.received_at) || options.received_at || new Date().toISOString(),
        sent_at: toIso(body.SentAtDate ?? body.Date ?? headers.date),
        attachments: readAttachments(body.Attachments ?? body.attachments),
        provider_metadata: {
          adapter_version: BREVO_INBOUND_ADAPTER_VERSION,
          item_id: firstNonEmpty(body.Uuid, body.uuid) || null,
        },
      };

      // Transport classification only. See inbound-message-classification.js.
      const classification = classifyInboundMessage(normalized);
      normalized.message_class = classification.message_class;
      normalized.classification_reason = classification.reason;
      normalized.classification_evidence = classification.evidence;

      return { ok: true, normalized };
    },

    /**
     * Brevo posts an array, or an object with `items`. A single object is also
     * accepted because their webhook test button sends one.
     */
    splitBatch(parsed) {
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.items)) return parsed.items;
      if (parsed && typeof parsed === "object") return [parsed];
      return [];
    },
  };
}

export { INBOUND_MESSAGE_CLASS };
export default createBrevoInboundProvider;
