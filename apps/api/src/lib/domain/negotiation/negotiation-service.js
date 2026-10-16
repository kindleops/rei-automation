// ─── Negotiation service (8.5.19 Phase 8) ────────────────────────────────────
// preparePosition()        load envelope + ledger + seller_offers + economics → decidePosition()
// recordNegotiationEvent() validate against the state machine (+ envelope) → append to the ledger
// grantEnvelope()          ONLY from an approved agent.approval_request (capability
//                          pipeline.grant_negotiation_envelope → executeApproved)
// revokeEnvelope()         append a revocation (operator)
// loadThreadFactLedger()   the conversation-ai FACT LEDGER for one thread (read-only)
//
// Nothing here sends, persists a seller_offers row, or moves a stage. A formal offer is
// persisted by the send path through seller-offer-authority.persistActiveOffer (see
// ledger.toSellerOfferArgs); stage moves go through stage-advance.js.
import { factLedgerOf, threadLedgerFromRows } from '../conversation-ai/ledger.js'
import { stripProtectedAttributes } from '../opportunity-economics/classify-opportunity.js'
import { buildEnvelopeRow, scopeOf, underwritingBasis, underwritingHash } from './envelope.js'
import { applyLedgerEvent, buildLedgerEventRow, reconcileWithSellerOffers, replayLedger, validateLedgerEvent } from './ledger.js'
import { decidePosition } from './position.js'

const fail = (code, detail = null) => Object.assign(new Error(code), { code, detail })

/**
 * One thread → THE canonical conversation ledger (rc-8.5.20: the same ledger the conversation
 * pipeline reads; review item a). Read-only, bounded (≤ 40 rows, 75 days). Both directions are
 * read: a bare "No" is an ownership denial only against OUR ownership question.
 * Returns the facts.js-shaped view (`ledger`, what assessEconomics reads) AND the canonical one.
 */
export async function loadThreadFactLedger({ supabase, thread_key, now = new Date() }) {
  const since = new Date((now instanceof Date ? now.getTime() : Date.parse(now)) - 75 * 864e5).toISOString()
  const r = await supabase.from('message_events').select('id,message_body,event_timestamp,created_at,detected_intent,direction,property_id').eq('thread_key', thread_key).gte('created_at', since).order('created_at', { ascending: true }).limit(40)
  if (r?.error) throw fail('THREAD_READ_FAILED')
  const rows = r.data || []
  const canonical = threadLedgerFromRows(rows, { now: (now instanceof Date ? now : new Date(now)).toISOString() })
  return { ledger: factLedgerOf(canonical), canonical, inbound_count: rows.filter((m) => String(m.direction || 'inbound').toLowerCase() !== 'outbound').length }
}

async function loadAuthorityState(store, scope, { thread_key }) {
  let latest = { envelope: null, revoked: false, latest_version: null }
  let events = []
  let sellerOffers = []
  const notes = []
  try {
    latest = await store.latestEnvelope(scope.scope_key)
    events = await store.listEvents(scope.scope_key)
  } catch (e) {
    if (e?.code !== 'NEGOTIATION_TABLES_UNAVAILABLE') throw e
    notes.push('authority_store_unavailable')
  }
  try { sellerOffers = (await store.sellerOffers?.({ thread_key, property_id: scope.property_id })) || [] } catch { notes.push('seller_offers_unreadable') }
  return { latest, events, sellerOffers, notes }
}

/**
 * THE interface the conversation engine calls for PREPARE_OFFER / NEGOTIATE_WITHIN_AUTHORITY.
 * @param {object} context
 * @param {string} context.thread_key
 * @param {string} context.property_id
 * @param {string|null} [context.opportunity_id]
 * @param {{ kind?: string, amount?: number|null, terms?: object }} [context.seller_request]
 * @param {object} [context.fact_ledger]   conversation-ai canonical ledger (ledger.js) or its factLedgerOf() view
 * @param {object} [context.economics]     a precomputed classifyOpportunityEconomics() result
 * @param {number|string} [context.now]
 * @param {{ store, assessEconomics?: Function }} deps
 */
export async function preparePosition(context = {}, deps = {}) {
  const { value: ctx } = stripProtectedAttributes(context)
  const now = typeof ctx.now === 'number' ? ctx.now : Date.parse(ctx.now || '') || Date.now()
  let scope
  try { scope = scopeOf(ctx) } catch { return decidePosition({ scope: {}, now }) }
  const store = deps.store
  if (!store) throw fail('NO_NEGOTIATION_STORE')
  const { latest, events, sellerOffers, notes } = await loadAuthorityState(store, scope, ctx)
  const replay = replayLedger(events, { scope_key: scope.scope_key })
  if (!replay.ok) return { contract_version: 'negotiation.position.v1', status: 'escalate', move: null, escalation: { reasons: [`ledger_integrity:${replay.code}`], operator_action: 'inspect_ledger' }, notes }
  const ledger = reconcileWithSellerOffers(replay.state, sellerOffers)
  let economics = ctx.economics || null
  if (!economics && typeof deps.assessEconomics === 'function') {
    economics = await deps.assessEconomics({ property_id: scope.property_id, thread_key: ctx.thread_key, ledger: ctx.fact_ledger || {}, now: new Date(now) }).catch(() => null)
  }
  const position = decidePosition({
    scope: { thread_key: ctx.thread_key, property_id: scope.property_id, opportunity_id: scope.opportunity_id },
    economics,
    envelope: latest.envelope,
    envelope_meta: { revoked: latest.revoked, latest_version: latest.latest_version },
    ledger,
    seller_request: ctx.seller_request || {},
    now,
  })
  return {
    ...position,
    scope: { thread_ref: scope.thread_ref, property_id: scope.property_id },
    economics: economics ? { class: economics.class, reasons: economics.reasons, uncertainty: economics.uncertainty } : null,
    ledger: { status: ledger.status, seq: ledger.seq, last_our_amount: ledger.last_our_amount, last_seller_amount: ledger.last_seller_amount, flags: ledger.flags },
    notes,
  }
}

/**
 * Append one negotiation event after validating it against the replayed state (and
 * the live envelope for engine moves). Returns { ok, event } or { ok:false, code }.
 */
export async function recordNegotiationEvent({ thread_key, property_id, opportunity_id = null, event, now = Date.now() }, { store }) {
  const { value: ev } = stripProtectedAttributes(event || {})
  const scope = scopeOf({ thread_key, property_id, opportunity_id })
  const latest = await store.latestEnvelope(scope.scope_key)
  const events = await store.listEvents(scope.scope_key)
  const replay = replayLedger(events, { scope_key: scope.scope_key })
  if (!replay.ok) return { ok: false, code: `LEDGER_INTEGRITY:${replay.code}` }
  const nowMs = typeof now === 'number' ? now : Date.parse(now)
  const row = buildLedgerEventRow({ scope, seq: replay.state.seq + 1, ...ev, now: nowMs })
  const envelope = row.envelope_id && latest.envelope?.envelope_id === row.envelope_id ? latest.envelope : null
  const v = validateLedgerEvent(replay.state, row, { envelope, envelope_meta: { revoked: latest.revoked, latest_version: latest.latest_version }, now: nowMs })
  if (!v.ok) return { ok: false, code: v.code }
  const stored = await store.appendEvent(row)
  return { ok: true, event: stored, state: applyLedgerEvent(replay.state, stored) }
}

/**
 * Persist an envelope. Called ONLY from the approvals plane after a human approved the
 * exact intended change (approval_id + granted_by required; the DB re-checks the chain).
 */
export async function grantEnvelope({ thread_key, property_id, opportunity_id = null, grant, approval_id, granted_by, economics, now = Date.now() }, { store }) {
  const scope = scopeOf({ thread_key, property_id, opportunity_id })
  const latest = await store.latestEnvelope(scope.scope_key)
  const version = latest.envelope ? Number(latest.envelope.version) + 1 : 1
  const row = buildEnvelopeRow({
    grant, scope, version,
    supersedes_envelope_id: latest.envelope?.envelope_id || null,
    approval_id, granted_by,
    underwriting: { basis: underwritingBasis(economics), class: economics?.class ?? null, reasons: (economics?.reasons || []).slice(0, 12) },
    underwriting_hash: underwritingHash(economics),
    now,
  })
  const stored = await store.insertEnvelope(row)
  return { ok: true, envelope_id: stored.envelope_id, version: stored.version, envelope_hash: stored.envelope_hash }
}

export async function revokeEnvelope({ envelope_id, revoked_by, reason }, { store }) {
  if (!String(revoked_by || '').trim()) return { ok: false, code: 'OPERATOR_REQUIRED' }
  if (String(reason || '').trim().length < 3) return { ok: false, code: 'REASON_REQUIRED' }
  await store.revokeEnvelope({ envelope_id, revoked_by: String(revoked_by).trim(), reason: String(reason).trim().slice(0, 240) })
  return { ok: true, envelope_id }
}
