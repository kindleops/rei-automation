// THE CANONICAL THREAD LEDGER API (rc-8.5.20, review item a).
//
// Before 8.5.20 two fact ledgers existed side by side:
//   facts.js        buildFactLedger / factSummary — the deterministic EXTRACTOR ledger
//                   ({ key: { current, history } }), read by the 8.5.19 negotiation service
//                   and the opportunity-economics classifier;
//   fact-ledger.js  buildCanonicalLedger — the 8.5.16 pipeline ledger: the extractor facts
//                   PLUS what the conversation proves (a bare "No" to our ownership question,
//                   a stop request, a representative, an offer request, questions asked /
//                   answered / deflected, the evidence stage).
// The same thread could therefore read "ownership denied" in the pipeline and "no ownership
// fact" in negotiation / economics. Now there is ONE ledger (buildCanonicalLedger) and every
// consumer reads it, through this module:
//
//   buildThreadLedger(args)            the canonical ledger (fact-ledger.js)
//   threadLedgerFromContextInput(...)  the canonical ledger as of one inbound
//   factLedgerOf(ledger)               ADAPTER → the facts.js shape over the SAME facts
//                                      (a facts.js ledger passes through unchanged)
//   factSummaryOf(ledger)              ADAPTER → the factSummary shape (economics input)
//   isCanonicalLedger(x)
// facts.js stays the extractor primitive the canonical ledger is built from; nothing outside
// the conversation-ai ledger modules should call buildFactLedger directly any more.
import { buildCanonicalLedger, FACT_LEDGER_VERSION, ledgerFromContextInput, legacyFactLedgerView } from './fact-ledger.js'
import { factSummary } from './facts.js'

export const THREAD_LEDGER_API_VERSION = 'conv-ai.thread-ledger.v1'

export function isCanonicalLedger(x) {
  return Boolean(x && typeof x === 'object' && x.version === FACT_LEDGER_VERSION && x.facts && x.questions)
}

/** @param {Parameters<typeof buildCanonicalLedger>[0]} args */
export function buildThreadLedger(args = {}) {
  return buildCanonicalLedger(args)
}

export function threadLedgerFromContextInput(input, opts) {
  return ledgerFromContextInput(input, opts)
}

/** The facts.js-shaped view of a canonical ledger (or the facts.js ledger itself). */
export function factLedgerOf(ledger) {
  if (!ledger || typeof ledger !== 'object') return {}
  if (isCanonicalLedger(ledger)) return ledger.fact_ledger || legacyFactLedgerView({}, ledger.facts)
  return ledger
}

export function factSummaryOf(ledger) {
  return factSummary(factLedgerOf(ledger))
}

/**
 * Rows read by a consumer (message_events shape) → canonical ledger. Both directions are
 * needed: a bare "No" is only an ownership denial read against OUR question.
 * @param {Array<{ id: string|number, direction?: string, message_body?: string, body?: string, event_timestamp?: string, created_at?: string, at?: string, detected_intent?: string|null, intent?: string|null, queue_id?: string|null, use_case?: string|null }>} rows
 */
export function threadLedgerFromRows(rows = [], { offers = [], recordFacts = {}, now = new Date().toISOString() } = {}) {
  const messages = (rows || []).filter(Boolean).map((m) => ({
    id: String(m.id),
    direction: String(m.direction || 'inbound').toLowerCase() === 'outbound' ? 'outbound' : 'inbound',
    body: m.body ?? m.message_body ?? '',
    at: m.at || m.event_timestamp || m.created_at || null,
    intent: m.intent ?? m.detected_intent ?? null,
    use_case: m.use_case || null,
    queue_id: m.queue_id || null,
  }))
  return buildCanonicalLedger({ messages, offers, recordFacts, now })
}
