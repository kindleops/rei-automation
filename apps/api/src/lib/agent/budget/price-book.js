// Price book AS CONFIGURATION (agent.price_book seeds; 10-08 list prices).
// Estimates read it; actuals = provider usage × the row effective at call
// time. An op type with no row is refused (UNPRICED_OP). Worst-case formulas
// assume no cache discount. Opus is present but unrouted (opus_enabled=false).
import { AgentError } from '../runtime/store.js'
import { round6 } from './budget-config.js'

export const DEFAULT_PRICE_BOOK = Object.freeze([
  { id: 1, provider: 'anthropic', model: 'claude-haiku-4-5', unit: 'input_mtok', rate_usd: 1, effective_from: '2026-10-08', source_note: 'list price 10-08' },
  { id: 2, provider: 'anthropic', model: 'claude-haiku-4-5', unit: 'output_mtok', rate_usd: 5, effective_from: '2026-10-08', source_note: 'list price 10-08' },
  { id: 3, provider: 'anthropic', model: 'claude-sonnet-5', unit: 'input_mtok', rate_usd: 2, effective_from: '2026-10-08', source_note: 'list price 10-08' },
  { id: 4, provider: 'anthropic', model: 'claude-sonnet-5', unit: 'output_mtok', rate_usd: 10, effective_from: '2026-10-08', source_note: 'list price 10-08' },
  { id: 5, provider: 'anthropic', model: 'claude-opus-5', unit: 'input_mtok', rate_usd: 5, effective_from: '2026-10-08', source_note: 'list price 10-08 · unrouted' },
  { id: 6, provider: 'anthropic', model: 'claude-opus-5', unit: 'output_mtok', rate_usd: 25, effective_from: '2026-10-08', source_note: 'list price 10-08 · unrouted' },
  { id: 7, provider: 'anthropic', model: '*', unit: 'cache_read_multiplier', rate_usd: 0.1, effective_from: '2026-10-08', source_note: '0.1× input' },
  { id: 8, provider: 'anthropic', model: '*', unit: 'cache_write_5m_multiplier', rate_usd: 1.25, effective_from: '2026-10-08', source_note: '1.25× input' },
  { id: 9, provider: 'anthropic', model: '*', unit: 'batch_multiplier', rate_usd: 0.5, effective_from: '2026-10-08', source_note: 'Message Batches' },
  { id: 10, provider: 'anthropic', model: '*', unit: 'web_search_use', rate_usd: 0.01, effective_from: '2026-10-08', source_note: '$10 / 1k searches' },
])

function row(book, provider, model, unit, at) {
  const t = Date.parse(at || '9999-12-31')
  const rows = book
    .filter((r) => r.provider === provider && (r.model === model || r.model === '*') && r.unit === unit && Date.parse(r.effective_from) <= t)
    .sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from) || (a.model === '*' ? 1 : -1))
  return rows[0] || null
}

function requireRow(book, provider, model, unit, at) {
  const r = row(book, provider, model, unit, at)
  if (!r) throw new AgentError('UNPRICED_OP', `no price-book row for ${provider}/${model}/${unit}`)
  return r
}

/**
 * Worst-case cost of a billable op BEFORE it runs.
 * op: { op_type:'model', provider, model, max_input_tokens, max_tokens, batch? }
 *   | { op_type:'web_search', provider, max_uses }
 *   | { op_type:'paid_lookup'|'provider_fee', provider, fee_usd, cost_bound }
 */
export function worstCaseUsd(op, book = DEFAULT_PRICE_BOOK, at = null) {
  if (!op || !op.op_type) throw new AgentError('UNPRICED_OP', 'op_type required')
  if (op.op_type === 'model') {
    const inp = requireRow(book, op.provider, op.model, 'input_mtok', at)
    const out = requireRow(book, op.provider, op.model, 'output_mtok', at)
    const maxIn = Number(op.max_input_tokens)
    const maxOut = Number(op.max_tokens)
    if (!(maxIn > 0) || !(maxOut > 0)) throw new AgentError('UNBOUNDED_OP', 'model ops need max_input_tokens and max_tokens')
    let usd = (maxIn / 1e6) * inp.rate_usd + (maxOut / 1e6) * out.rate_usd // no cache discount
    if (op.batch) usd *= requireRow(book, op.provider, op.model, 'batch_multiplier', at).rate_usd
    return { usd: round6(usd), price_book_ids: [inp.id, out.id] }
  }
  if (op.op_type === 'web_search') {
    const r = requireRow(book, op.provider, '*', 'web_search_use', at)
    if (!(Number(op.max_uses) > 0)) throw new AgentError('UNBOUNDED_OP', 'web_search needs max_uses')
    return { usd: round6(r.rate_usd * Number(op.max_uses)), price_book_ids: [r.id] }
  }
  if (op.op_type === 'paid_lookup' || op.op_type === 'provider_fee') {
    if (!(Number(op.fee_usd) >= 0) || op.fee_usd === undefined) throw new AgentError('UNPRICED_OP', `${op.op_type} needs a priced fee`)
    return { usd: round6(Number(op.fee_usd)), price_book_ids: [] }
  }
  throw new AgentError('UNPRICED_OP', `unknown op_type ${op.op_type}`)
}

/** Actual cost from provider usage × price book at call time. */
export function actualUsd(op, usage = {}, book = DEFAULT_PRICE_BOOK, at = null) {
  if (op.op_type === 'model') {
    const inp = requireRow(book, op.provider, op.model, 'input_mtok', at)
    const out = requireRow(book, op.provider, op.model, 'output_mtok', at)
    const cr = requireRow(book, op.provider, op.model, 'cache_read_multiplier', at).rate_usd
    const cw = requireRow(book, op.provider, op.model, 'cache_write_5m_multiplier', at).rate_usd
    const usd =
      (Number(usage.input_tokens || 0) / 1e6) * inp.rate_usd +
      (Number(usage.cache_read_input_tokens || 0) / 1e6) * inp.rate_usd * cr +
      (Number(usage.cache_creation_input_tokens || 0) / 1e6) * inp.rate_usd * cw +
      (Number(usage.output_tokens || 0) / 1e6) * out.rate_usd
    const mult = op.batch ? requireRow(book, op.provider, op.model, 'batch_multiplier', at).rate_usd : 1
    const search = Number(usage.server_tool_uses || 0) ? Number(usage.server_tool_uses) * requireRow(book, op.provider, '*', 'web_search_use', at).rate_usd : 0
    return round6(usd * mult + search)
  }
  if (op.op_type === 'web_search') return round6(Number(usage.uses || 0) * requireRow(book, op.provider, '*', 'web_search_use', at).rate_usd)
  return round6(Number(usage.actual_usd ?? op.fee_usd ?? 0))
}
