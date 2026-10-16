// TURN STORE (rc-8.5.20). The durable record of every reply turn lives in
// public.conversation_reply_turns (PROPOSED_20261016120000_conversation_reply_turns.sql); every state change
// is ONE SQL function call, so the invariants (one open turn per thread, version-checked claims,
// stale-draft refusal, the all-or-none inbound_reply reservation) hold across processes and
// restarts. Three adapters over the same function contract:
//   createSupabaseTurnStore(supabase)  production (service role, rpc)
//   createPgTurnStore(pool)            disposable-PG tests (the same SQL)
//   createMemoryTurnStore()            unit tests: an in-process mirror of the SQL semantics
//                                      (proven equal by the PG tests; never used in production)

export const TURN_STORE_VERSION = 'conv-ai.turn-store.v1'

const ARGS = Object.freeze({
  conversation_reply_turn_open: ['p_thread_key', 'p_inbound_id', 'p_inbound_at', 'p_due_at', 'p_plan', 'p_persona_name', 'p_sender_number'],
  conversation_reply_turn_claim: ['p_turn_id', 'p_version', 'p_worker', 'p_lease_seconds'],
  conversation_reply_turn_finalize: ['p_turn_id', 'p_token', 'p_version', 'p_outcome', 'p_result', 'p_reserve', 'p_reply_origin'],
  conversation_reply_turn_cancel: ['p_thread_key', 'p_reason'],
  conversation_reply_turn_reopen: ['p_turn_id', 'p_reason', 'p_due_at', 'p_plan'],
  conversation_reply_turn_due: ['p_limit', 'p_grace_seconds'],
})

function storeOver(call) {
  return {
    version: TURN_STORE_VERSION,
    open: ({ thread_key, inbound_id, inbound_at, due_at, plan = {}, persona_name = null, sender_number = null }) =>
      call('conversation_reply_turn_open', { p_thread_key: thread_key, p_inbound_id: String(inbound_id), p_inbound_at: inbound_at, p_due_at: due_at, p_plan: plan, p_persona_name: persona_name, p_sender_number: sender_number }),
    claim: ({ turn_id, version, worker, lease_seconds = 120 }) => call('conversation_reply_turn_claim', { p_turn_id: turn_id, p_version: version, p_worker: worker, p_lease_seconds: lease_seconds }),
    finalize: ({ turn_id, token, version, outcome, result = null, reserve = false, reply_origin = null }) =>
      call('conversation_reply_turn_finalize', { p_turn_id: turn_id, p_token: token, p_version: version, p_outcome: outcome, p_result: result, p_reserve: reserve, p_reply_origin: reply_origin }),
    cancel: ({ thread_key, reason }) => call('conversation_reply_turn_cancel', { p_thread_key: thread_key, p_reason: reason }),
    reopen: ({ turn_id, reason, due_at, plan = {} }) => call('conversation_reply_turn_reopen', { p_turn_id: turn_id, p_reason: reason, p_due_at: due_at, p_plan: plan }),
    due: ({ limit = 50, grace_seconds = 60 } = {}) => call('conversation_reply_turn_due', { p_limit: limit, p_grace_seconds: grace_seconds }),
  }
}

const OPEN_COLUMNS = 'turn_id,version,state,due_at,inbound_ids,latest_inbound_id'

export function createSupabaseTurnStore(supabase) {
  const store = storeOver(async (fn, args) => {
    const r = await supabase.rpc(fn, args)
    if (r?.error) throw Object.assign(new Error('TURN_STORE_FAILED'), { code: 'TURN_STORE_FAILED', fn })
    return r?.data ?? null
  })
  /** The thread's open turn (read-only), or null. */
  store.peekOpen = async (thread_key) => {
    const r = await supabase.from('conversation_reply_turns').select(OPEN_COLUMNS).eq('thread_key', thread_key).in('state', ['pending', 'claimed']).limit(1)
    if (r?.error) throw Object.assign(new Error('TURN_STORE_FAILED'), { code: 'TURN_STORE_FAILED', fn: 'peekOpen' })
    return r?.data?.[0] || null
  }
  return store
}

export function createPgTurnStore(pool) {
  const store = storeOver(async (fn, args) => {
    const names = ARGS[fn]
    const vals = names.map((k) => {
      const v = args[k]
      return v != null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v ?? null
    })
    const r = await pool.query(`select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, vals)
    return r.rows[0].r
  })
  store.peekOpen = async (thread_key) => (await pool.query(`select ${OPEN_COLUMNS} from public.conversation_reply_turns where thread_key = $1 and state in ('pending','claimed') limit 1`, [thread_key])).rows[0] || null
  return store
}

/**
 * In-process mirror of the SQL contract (unit tests only). `reservations` is the shared
 * inbound_reply ledger: Map(key → { status, turn_id, origin }).
 */
export function createMemoryTurnStore({ now = () => Date.now(), reservations = new Map() } = {}) {
  const turns = new Map()
  let seq = 0
  const nowMs = () => (typeof now === 'function' ? now() : Date.parse(now))
  const t = (x) => Date.parse(x)
  const open = (thread_key) => [...turns.values()].find((x) => x.thread_key === thread_key && ['pending', 'claimed'].includes(x.state))
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
  const pub = (x) => structuredClone(x)
  const api = {
    version: TURN_STORE_VERSION,
    turns,
    reservations,
    async open({ thread_key, inbound_id, inbound_at, due_at, plan = {}, persona_name = null, sender_number = null }) {
      const id = String(inbound_id)
      const member = [...turns.values()].filter((x) => x.thread_key === thread_key && x.inbound_ids.includes(id)).sort((a, b) => b.turn_seq - a.turn_seq)[0]
      if (member) return { ok: true, deduped: true, turn_id: member.turn_id, version: member.version, state: member.state, due_at: member.due_at }
      const o = open(thread_key)
      if (o) {
        const wasClaimed = o.state === 'claimed'
        o.inbound_ids.push(id)
        if (t(inbound_at) >= t(o.latest_inbound_at)) { o.latest_inbound_id = id; o.latest_inbound_at = inbound_at }
        o.version += 1; o.due_at = due_at; o.plan = plan
        o.persona_name = persona_name ?? o.persona_name; o.sender_number = sender_number ?? o.sender_number
        Object.assign(o, { state: 'pending', claim_token: null, claimed_by: null, lease_until: null })
        return { ok: true, extended: true, turn_id: o.turn_id, version: o.version, state: o.state, due_at: o.due_at, members: o.inbound_ids.length, revoked_claim: wasClaimed }
      }
      const turn_seq = Math.max(0, ...[...turns.values()].filter((x) => x.thread_key === thread_key).map((x) => x.turn_seq)) + 1
      const row = { turn_id: uuid(), thread_key, turn_seq, state: 'pending', version: 1, inbound_ids: [id], latest_inbound_id: id, first_inbound_at: inbound_at, latest_inbound_at: inbound_at, due_at, plan, persona_name, sender_number, stale_drafts: 0, claim_token: null, claimed_by: null, lease_until: null, outcome: null, result: null, reserved_inbound_ids: null, reply_origin: null, close_reason: null }
      turns.set(row.turn_id, row)
      return { ok: true, created: true, turn_id: row.turn_id, version: 1, state: 'pending', due_at, turn_seq }
    },
    async claim({ turn_id, version, worker, lease_seconds = 120 }) {
      const x = turns.get(turn_id)
      if (!x) return { ok: false, reason: 'turn_not_found' }
      if (x.state === 'claimed' && t(x.lease_until) < nowMs()) Object.assign(x, { state: 'pending', claim_token: null, claimed_by: null, lease_until: null })
      if (x.state !== 'pending') return { ok: false, reason: `state_${x.state}`, version: x.version }
      if (x.version !== version) return { ok: false, reason: 'stale_version', version: x.version, due_at: x.due_at }
      if (t(x.due_at) > nowMs()) return { ok: false, reason: 'not_due', version: x.version, due_at: x.due_at }
      Object.assign(x, { state: 'claimed', claim_token: `tok-${turn_id}-${version}-${++seq}`, claimed_by: worker, lease_until: new Date(nowMs() + Math.min(Math.max(lease_seconds, 10), 900) * 1000).toISOString() })
      return { ok: true, token: x.claim_token, version: x.version, thread_key: x.thread_key, inbound_ids: [...x.inbound_ids], latest_inbound_id: x.latest_inbound_id, lease_until: x.lease_until, persona_name: x.persona_name, sender_number: x.sender_number }
    },
    async finalize({ turn_id, token, version, outcome, result = null, reserve = false, reply_origin = null }) {
      const x = turns.get(turn_id)
      if (!x) return { ok: false, reason: 'turn_not_found' }
      if (reserve && !['template', 'ai_generated', 'operator_manual'].includes(reply_origin)) return { ok: false, reason: 'reply_origin_required' }
      if (x.state !== 'claimed' || x.claim_token !== token || x.version !== version) {
        x.stale_drafts += 1
        return { ok: false, reason: x.version !== version ? 'stale_version' : 'claim_revoked', state: x.state, version: x.version }
      }
      if (reserve) {
        const conflict = x.inbound_ids.find((id) => reservations.has(id) && reservations.get(id).status !== 'failed')
        if (conflict) {
          Object.assign(x, { state: 'answered_elsewhere', close_reason: 'inbound_reply_reserved_by_other', outcome: 'answered_elsewhere', claim_token: null, lease_until: null })
          return { ok: true, reserved: false, state: 'answered_elsewhere', conflict_inbound_id: conflict }
        }
        for (const id of x.inbound_ids) reservations.set(id, { status: 'processing', turn_id, origin: reply_origin })
      }
      Object.assign(x, { state: 'decided', outcome, result, reply_origin: reserve ? reply_origin : null, reserved_inbound_ids: reserve ? [...x.inbound_ids] : null, claim_token: null, lease_until: null })
      return { ok: true, reserved: reserve, state: 'decided', inbound_ids: [...x.inbound_ids] }
    },
    async cancel({ thread_key, reason }) {
      let n = 0
      for (const x of turns.values()) if (x.thread_key === thread_key && ['pending', 'claimed'].includes(x.state)) { Object.assign(x, { state: 'cancelled', close_reason: reason, claim_token: null, lease_until: null }); n += 1 }
      return { ok: true, cancelled: n }
    },
    async reopen({ turn_id, reason, due_at, plan = {} }) {
      const x = turns.get(turn_id)
      if (!x) return { ok: false, reason: 'turn_not_found' }
      if (x.state !== 'decided') return { ok: false, reason: `state_${x.state}` }
      for (const id of x.reserved_inbound_ids || []) if (reservations.get(id)?.turn_id === turn_id) reservations.delete(id)
      const o = open(x.thread_key)
      if (o) {
        o.inbound_ids = [...new Set([...o.inbound_ids, ...x.inbound_ids])].sort()
        o.version += 1; o.due_at = t(o.due_at) < t(due_at) ? o.due_at : due_at
        Object.assign(o, { state: 'pending', claim_token: null, lease_until: null })
        Object.assign(x, { state: 'superseded', close_reason: reason, reserved_inbound_ids: null })
        return { ok: true, merged_into: o.turn_id, version: o.version, due_at: o.due_at }
      }
      Object.assign(x, { state: 'pending', version: x.version + 1, due_at, plan, outcome: null, result: null, reply_origin: null, reserved_inbound_ids: null, close_reason: reason })
      return { ok: true, reopened: true, turn_id, version: x.version, due_at }
    },
    async due({ limit = 50, grace_seconds = 60 } = {}) {
      return [...turns.values()]
        .filter((x) => (x.state === 'pending' && t(x.due_at) <= nowMs() - grace_seconds * 1000) || (x.state === 'claimed' && t(x.lease_until) < nowMs()))
        .sort((a, b) => t(a.due_at) - t(b.due_at)).slice(0, limit)
        .map((x) => ({ turn_id: x.turn_id, version: x.version, state: x.state, due_at: x.due_at }))
    },
    get: (turn_id) => (turns.has(turn_id) ? pub(turns.get(turn_id)) : null),
    async peekOpen(thread_key) { const o = open(thread_key); return o ? pub(o) : null },
  }
  return api
}
