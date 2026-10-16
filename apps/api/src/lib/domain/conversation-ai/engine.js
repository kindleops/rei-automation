// Conversation Engine 2.0 — R1 + R2 shadow pipeline for ONE inbound message.
// rc-8.5.21: RETIRED. Kept only so a stale import fails loudly (R1_COMPOSER_RETIRED) instead of
// silently running a second writer. The canonical runtime is runtime/canonical.js.
//
//   gate (policy + env + kill switch) → idempotency (one decision per inbound id)
//   → context → R1 understand → R2 compose (decision.proposed_message, normalised)
//   → independent validator (eligibility via the EXISTING engine, dry run)
//   → shadow record (send_status 'not_sent_shadow') → store.put (insert-if-absent)
//
// NOTHING here sends. This module imports no transport, queue or send service
// (static test: conversation-ai-no-send-path). There is no code path from a
// shadow record to a send in R1/R2.
export const ENGINE_VERSION = 'conv-ai.engine.v2-retired'

/** In-process single-flight + memo keyed by the idempotency key (a store adds cross-process uniqueness). */
export function createMemoryShadowStore() {
  const rows = new Map()
  return {
    async get(key) { return rows.get(key) || null },
    async putIfAbsent(record) {
      if (rows.has(record.idempotency_key)) return { inserted: false, record: rows.get(record.idempotency_key) }
      rows.set(record.idempotency_key, record)
      return { inserted: true, record }
    },
    all: () => [...rows.values()],
  }
}

/**
 * RETIRED (rc-8.5.21). The R1 composer — the model's own `decision.proposed_message` used as an
 * outbound draft — is hard-disabled: it was the text the live shadow and the turn engine measured
 * while a canary would have sent a different writer (8.5.20 eval). The ONE writer is
 * runtime/canonical.js#decideAndCompose (playbook v3); R1 understanding remains as its input stage.
 */
export const R1_COMPOSER_RETIRED = 'R1_COMPOSER_RETIRED'
function retired() {
  throw Object.assign(new Error(R1_COMPOSER_RETIRED), { code: R1_COMPOSER_RETIRED, use: 'runtime/canonical.js#decideAndCompose' })
}

/** @deprecated retired: throws R1_COMPOSER_RETIRED. */
export function composeDraft() { return retired() }

/** @deprecated retired: throws R1_COMPOSER_RETIRED (the live shadow is runtime/canonical-shadow.js). */
export async function runConversationAiShadow() { return retired() }
