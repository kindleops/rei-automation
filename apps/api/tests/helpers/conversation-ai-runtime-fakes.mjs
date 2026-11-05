// Fakes for the conversation.decide runtime tests (8.5.15): a read-only Supabase that
// counts every row it serves and refuses every write except the shadow row, a thread
// fixture, and a fake Anthropic provider. No network, $0.
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'

// ── a fake read-only Supabase that counts every row it serves and refuses every write ──
export function fakeSupabase(tables, { shadowStoreRows = null } = {}) {
  const log = { reads: [], rowsServed: 0, writes: [] }
  const from = (table) => {
    const q = { table, filters: [], limitN: null, order: null }
    const exec = () => {
      let rows = [...(tables[table] || [])]
      for (const [op, col, v] of q.filters) {
        if (op === 'eq') rows = rows.filter((r) => r[col] === v)
        if (op === 'gte') rows = rows.filter((r) => String(r[col]) >= String(v))
        if (op === 'in') rows = rows.filter((r) => v.includes(r[col]))
      }
      if (q.order) rows.sort((a, b) => (q.order.ascending ? 1 : -1) * String(a[q.order.col]).localeCompare(String(b[q.order.col])))
      if (q.limitN != null) rows = rows.slice(0, q.limitN)
      log.reads.push({ table, n: rows.length, limit: q.limitN })
      log.rowsServed += rows.length
      return { data: rows, error: null }
    }
    const b = {
      select: () => b,
      eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
      gte: (c, v) => { q.filters.push(['gte', c, v]); return b },
      in: (c, v) => { q.filters.push(['in', c, v]); return b },
      order: (col, o = {}) => { q.order = { col, ascending: o.ascending !== false }; return b },
      limit: (n) => { q.limitN = n; return b },
      then: (res, rej) => Promise.resolve(exec()).then(res, rej),
      upsert: (row) => {
        log.writes.push({ table, row })
        if (table !== 'conversation_ai_shadow_decisions' || !shadowStoreRows) return { select: async () => ({ data: null, error: { message: 'write refused in test' } }) }
        const dup = shadowStoreRows.has(row.idempotency_key)
        if (!dup) shadowStoreRows.set(row.idempotency_key, row)
        return { select: async () => ({ data: dup ? [] : [{ idempotency_key: row.idempotency_key }], error: null }) }
      },
      insert: (row) => { log.writes.push({ table, row }); throw new Error(`write to ${table} refused in test`) },
      update: (row) => { log.writes.push({ table, row }); throw new Error(`write to ${table} refused in test`) },
    }
    if (table === 'conversation_ai_shadow_decisions' && shadowStoreRows) {
      // reads of the shadow table come from the map
      b.then = (res, rej) => {
        const key = q.filters.find(([, c]) => c === 'idempotency_key')?.[2]
        const row = shadowStoreRows.get(key)
        log.reads.push({ table, n: row ? 1 : 0, limit: q.limitN })
        return Promise.resolve({ data: row ? [{ record: row.record }] : [], error: null }).then(res, rej)
      }
    }
    return b
  }
  return { from, log }
}

export const SID = 'SMa1b2c3d4'
export const NOW = new Date().toISOString()
export function threadTables({ body = 'What would you offer me for it?', events = 6 } = {}) {
  const thread = []
  for (let i = 0; i < events; i += 1) {
    const out = i % 2 === 0
    thread.push({ id: `m${i}`, direction: out ? 'outbound' : 'inbound', thread_key: 'tk1', from_phone_number: out ? '+15555550100' : '+15555550123', to_phone_number: out ? '+15555550123' : '+15555550100', message_body: out ? 'Hi Jane, are you still the owner of the house on Elm?' : 'Yes I am', event_timestamp: new Date(Date.parse(NOW) - (events - i + 5) * 60_000).toISOString(), created_at: new Date(Date.parse(NOW) - (events - i + 5) * 60_000).toISOString(), property_id: 'p1', detected_intent: null, queue_id: null })
  }
  // OWNER DECISION 2026-10-18 (offer before price): an offer request we have NOT asked a price for is
  // answered with the price question; this fixture's offer request is the authority-bound turn, so the
  // thread has already asked for their number
  if (/\b(?:offer|pay)\b/i.test(body)) {
    const lastOut = [...thread].reverse().find((m) => m.direction === 'outbound')
    if (lastOut) lastOut.message_body = 'Thanks Jane. Do you have a price in mind for it?'
  }
  const inbound = { id: 'in-1', provider_message_sid: SID, direction: 'inbound', thread_key: 'tk1', from_phone_number: '+15555550123', to_phone_number: '+15555550100', message_body: body, event_timestamp: new Date(Date.parse(NOW) - 60_000).toISOString(), received_at: null, created_at: new Date(Date.parse(NOW) - 60_000).toISOString(), property_id: 'p1', prospect_id: 'pr1', detected_intent: 'asks_offer', language: 'en', queue_id: null }
  return {
    message_events: [...thread, inbound],
    send_queue: [],
    seller_offers: [],
    properties: [{ property_id: 'p1', property_type: 'SFR', property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201', timezone: 'America/Chicago', owner_1_name: 'Jane Q Seller' }],
    prospects: [{ prospect_id: 'pr1', first_name: 'Jane', full_name: 'Jane Q Seller', timezone: 'America/Chicago' }],
    conversation_ai_reply_policy: [{ id: 1, shadow_enabled: true, kill_switch_engaged: false, enabled: false }],
  }
}

/** A fake provider: haiku + sonnet listed; respond(params, n) → tool input | Error. */
export function fakeProvider(respond) {
  const calls = []
  return {
    calls,
    async listModels() { return [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z' }, { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01T00:00:00Z' }] },
    async createMessage(params, opts = {}) {
      calls.push(params)
      const out = typeof respond === 'function' ? await respond(params, calls.length, opts) : respond
      if (out instanceof Error) throw out
      return { content: [{ type: 'tool_use', name: params.tools[0].name, input: out }], stop_reason: 'tool_use', usage: { input_tokens: 1500, output_tokens: 150 } }
    },
  }
}
export const routineDecision = (over = {}) => makeDecision({ intent: 'asks_offer', seller_interest: 'interested', outcome: 'REPLY_CANDIDATE', next_objective: 'get_condition', response_needed: true, proposed_message: 'Happy to put a number together. How is the condition overall, any repairs needed?', confidence: 0.92, source_message_ids: ['in-1'], stage_evidence: { stage: 'S4_condition', evidence_message_ids: ['in-1'], rationale: 'asked for an offer' }, ...over })
export const semanticOk = { duplicate: false, already_answered: false, irrelevant: false, reason: 'ok' }
