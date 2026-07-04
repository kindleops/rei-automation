import { normalizePhone } from "@/lib/utils/phones.js";
import { detectEntityOwner } from "@/lib/identity/ownerProspectAlignment.js";

function clean(v) {
  return String(v ?? "").trim();
}

// Final safety rail before provider dispatch: never let an SMS go out addressed to
// an entity/LLC/trust name (e.g. "Hey West 7th Apartments LLC,"). Checks only the
// greeting-name slot, not the whole message body, since the body may legitimately
// reference a company/property name elsewhere (e.g. in the property address).
const GREETING_NAME_PATTERN = /^\s*(?:hi|hey|hello|hola|ola|marhaba)\s+([^,]+),/i;

function hasEntityNameInGreeting(message_body) {
  const match = String(message_body || "").trim().match(GREETING_NAME_PATTERN);
  if (!match) return false;
  return detectEntityOwner(match[1]);
}

/**
 * Single shared validator for all outbound SMS payloads.
 * Used by canSend(), send-now-service, and Discord reply paths.
 *
 * Checks the message itself — NOT routing fields (from_phone, thread_key).
 * Returns { ok: true } or { ok: false, reason: string }.
 */
export function validateOutboundSmsPayload(payload = {}) {
  const to_phone = normalizePhone(clean(payload.to_phone_number));
  const message_body = clean(payload.message_body || payload.message_text || "");
  const message_type = clean(payload.message_type).toLowerCase();
  const is_deferred = Boolean(payload.metadata?.deferred_message_resolution);

  if (!to_phone) return { ok: false, reason: "missing_to_phone_number" };

  if (!is_deferred) {
    if (!message_body) return { ok: false, reason: "missing_message_body" };

    const is_manual = !message_type || message_type === "manual_reply";
    const min_len = is_manual ? 2 : 10;
    if (message_body.length < min_len) return { ok: false, reason: "message_too_short" };

    if (/^(hi|hey|hello|hola)\s+,/i.test(message_body))
      return { ok: false, reason: "blank_greeting_message_body" };

    if (hasEntityNameInGreeting(message_body))
      return { ok: false, reason: "entity_name_in_greeting" };

    if (/<\s*script/i.test(message_body))
      return { ok: false, reason: "html_content_blocked" };
  }

  return { ok: true, reason: null };
}
