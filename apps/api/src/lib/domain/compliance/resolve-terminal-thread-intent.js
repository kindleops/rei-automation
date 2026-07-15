import { COMPLIANCE_TERMINAL_INTENTS } from "@/lib/domain/compliance/canonical-no-contact-states.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Resolve terminal compliance intent without deal_thread_state.primary_intent.
 * Precedence: inbox reply_intent → message detected_intent → universal_stage.
 */
export function resolveTerminalThreadIntents({
  inbox_thread_state = null,
  deal_thread_state = null,
  message_events = [],
} = {}) {
  const intents = [];

  const inbox_reply =
    lower(inbox_thread_state?.reply_intent) ||
    lower(inbox_thread_state?.metadata?.reply_intent);
  if (inbox_reply) intents.push(inbox_reply);

  if (Array.isArray(message_events)) {
    for (const row of message_events) {
      const detected = lower(row?.detected_intent);
      if (detected) intents.push(detected);
    }
  }

  const stage = lower(deal_thread_state?.universal_stage);
  if (stage) intents.push(stage);

  return intents.filter(Boolean);
}

export function hasTerminalComplianceIntent(intent_sources = []) {
  return intent_sources.some((intent) => COMPLIANCE_TERMINAL_INTENTS.has(lower(intent)));
}

export default resolveTerminalThreadIntents;