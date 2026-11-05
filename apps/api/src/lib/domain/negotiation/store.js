// Negotiation stores. The Supabase store reads/inserts the PROPOSED tables
// (public.negotiation_envelopes / _envelope_revocations / _offer_events) and READS
// public.seller_offers; it has no update or delete method — the tables are
// append-only and the DB refuses both anyway. Until the migration is applied every
// call fails with NEGOTIATION_TABLES_UNAVAILABLE and preparePosition answers
// needs_envelope (no authority ⇒ no amount).
//
// The memory store mirrors the database invariants (version chain, gap-free seq,
// envelope bound on engine moves, immutability) for tests and offline replay.
import { envelopeStatus } from './envelope.js'

const T = Object.freeze({ env: 'negotiation_envelopes', rev: 'negotiation_envelope_revocations', ev: 'negotiation_offer_events' })
const unavailable = (e) => Object.assign(new Error('NEGOTIATION_TABLES_UNAVAILABLE'), { code: 'NEGOTIATION_TABLES_UNAVAILABLE', detail: String(e?.message || e || '').slice(0, 160) })

export function createSupabaseNegotiationStore({ supabase }) {
  if (!supabase?.from) throw Object.assign(new Error('NO_CLIENT'), { code: 'NO_CLIENT' })
  const rows = async (q) => {
    const r = await q
    if (r?.error) throw unavailable(r.error)
    return Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : []
  }
  return Object.freeze({
    kind: 'supabase',
    async latestEnvelope(scope_key) {
      const [env] = await rows(supabase.from(T.env).select('*').eq('scope_key', scope_key).order('version', { ascending: false }).limit(1))
      if (!env) return { envelope: null, revoked: false, latest_version: null }
      const rev = await rows(supabase.from(T.rev).select('envelope_id').eq('envelope_id', env.envelope_id).limit(1))
      return { envelope: env, revoked: rev.length > 0, latest_version: Number(env.version) }
    },
    async insertEnvelope(row) {
      const [stored] = await rows(supabase.from(T.env).insert(row).select('*'))
      return stored
    },
    async revokeEnvelope({ envelope_id, revoked_by, reason }) {
      const [stored] = await rows(supabase.from(T.rev).insert({ envelope_id, revoked_by, reason }).select('*'))
      return stored
    },
    async listEvents(scope_key) {
      return rows(supabase.from(T.ev).select('*').eq('scope_key', scope_key).order('seq', { ascending: true }).limit(500))
    },
    async appendEvent(row) {
      const [stored] = await rows(supabase.from(T.ev).insert(row).select('*'))
      return stored
    },
    /** seller_offers (THE formal-offer authority) for this thread + property — read only. */
    async sellerOffers({ thread_key, property_id }) {
      const r = await supabase.from('seller_offers').select('offer_id,opportunity_id,property_id,thread_key,offer_version,offer_type,direction,purchase_price,authorized_ceiling,status,sent_at,created_at').eq('thread_key', thread_key).limit(50)
      if (r?.error) throw Object.assign(new Error('SELLER_OFFERS_READ_FAILED'), { code: 'SELLER_OFFERS_READ_FAILED' })
      return (r.data || []).filter((o) => !property_id || !o.property_id || String(o.property_id) === String(property_id))
    },
  })
}

/** In-memory store with the same invariants as the PROPOSED tables (tests / offline replay). */
export function createMemoryNegotiationStore({ now = () => Date.now(), sellerOffers = [] } = {}) {
  const envelopes = []
  const revocations = new Map()
  const events = []
  const keys = new Set()
  let n = 0
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  const freeze = (o) => Object.freeze(structuredClone(o))
  return {
    kind: 'memory',
    _dump: () => ({ envelopes: envelopes.map((e) => ({ ...e })), events: events.map((e) => ({ ...e })), revocations: [...revocations.keys()] }),
    async latestEnvelope(scope_key) {
      const env = envelopes.filter((e) => e.scope_key === scope_key).sort((a, b) => b.version - a.version)[0] || null
      return { envelope: env, revoked: env ? revocations.has(env.envelope_id) : false, latest_version: env ? env.version : null }
    },
    async insertEnvelope(row) {
      const prev = envelopes.filter((e) => e.scope_key === row.scope_key).sort((a, b) => b.version - a.version)[0]
      if (!prev && row.version !== 1) fail('ENVELOPE_VERSION_CHAIN')
      if (prev && (row.version !== prev.version + 1 || row.supersedes_envelope_id !== prev.envelope_id)) fail('ENVELOPE_VERSION_CHAIN')
      if (prev && (row.thread_ref !== prev.thread_ref || row.property_id !== prev.property_id)) fail('ENVELOPE_SCOPE_CHANGED')
      if (envelopes.some((e) => e.approval_id === row.approval_id)) fail('ENVELOPE_APPROVAL_REUSED')
      const stored = freeze({ envelope_id: id(), created_at: new Date(now()).toISOString(), ...row })
      envelopes.push(stored)
      return stored
    },
    async revokeEnvelope({ envelope_id, revoked_by, reason }) {
      if (revocations.has(envelope_id)) fail('ALREADY_REVOKED')
      const r = freeze({ envelope_id, revoked_by, reason, created_at: new Date(now()).toISOString() })
      revocations.set(envelope_id, r)
      return r
    },
    async listEvents(scope_key) {
      return events.filter((e) => e.scope_key === scope_key).sort((a, b) => a.seq - b.seq)
    },
    async appendEvent(row) {
      if (keys.has(row.idempotency_key)) fail('DUPLICATE_IDEMPOTENCY_KEY')
      const last = events.filter((e) => e.scope_key === row.scope_key).reduce((m, e) => Math.max(m, e.seq), 0)
      if (row.seq !== last + 1) fail('SEQ_OUT_OF_ORDER')
      if (row.actor === 'engine' && !(row.authority === 'within_envelope' && row.envelope_id)) fail('ENGINE_MOVE_NEEDS_ENVELOPE')
      if (row.envelope_id) {
        const env = envelopes.find((e) => e.envelope_id === row.envelope_id)
        if (!env) fail('ENVELOPE_NOT_FOUND')
        const latest = envelopes.filter((e) => e.scope_key === env.scope_key).reduce((m, e) => Math.max(m, e.version), 0)
        const st = envelopeStatus(env, { scope_key: row.scope_key, now: Date.parse(row.created_at) || now(), revoked: revocations.has(env.envelope_id), latest_version: latest })
        if (!st.live) fail(`ENVELOPE_${st.reason.toUpperCase()}`)
        if (row.amount != null && Number(row.amount) > Number(env.max_price)) fail('ABOVE_ENVELOPE_MAX')
      }
      const stored = freeze({ event_id: id(), ...row })
      keys.add(row.idempotency_key)
      events.push(stored)
      return stored
    },
    async sellerOffers() {
      return sellerOffers.map((o) => ({ ...o }))
    },
  }
}
