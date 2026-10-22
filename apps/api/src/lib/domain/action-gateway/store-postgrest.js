// The Action Gateway store over the database entry points (PROPOSED_20261019160000_action_gateway.sql).
//
// `db` is a Supabase-shaped client whose requests run AS lc_action_gateway with the tenant claim
// lc_org: in production supabase-js over PostgREST with the owner-minted role JWT (the MCP server's
// only data path); in tests the same builder over a disposable PostgreSQL connection that runs as the
// role. Every call is ONE rpc (one transaction). There is no from() write here: the role has none.
import { gwErr } from './errors.js'

async function rpc(db, fn, args) {
  let res
  try {
    res = await db.rpc(fn, args)
  } catch (e) {
    throw Object.assign(new Error(`ACTION_STORE_UNAVAILABLE ${fn}`), { code: 'ACTION_STORE_UNAVAILABLE', cause_code: e?.code || null })
  }
  if (res?.error) {
    const err = new Error(String(res.error.message || res.error.code || 'rpc failed'))
    err.code = res.error.code || null
    err.fn = fn
    throw err
  }
  return res?.data ?? null
}

/** @param {{ db: { rpc: Function } }} o */
export function createPostgrestActionStore({ db }) {
  if (!db || typeof db.rpc !== 'function') throw new Error('action store: a Supabase-shaped client is required')
  const parseControls = (c) => ({
    enabled: c?.enabled === true,
    tiers: new Set(String(c?.tiers || '').toUpperCase().split(',').map((t) => t.trim()).filter(Boolean)),
    killed: new Set(String(c?.killed_capabilities || '').toLowerCase().split(',').map((t) => t.trim()).filter(Boolean)),
    org: c?.org || null,
  })
  return Object.freeze({
    kind: 'postgrest',
    async controls() { return parseControls(await rpc(db, 'action_gateway_controls', {})) },
    principal: (digest) => rpc(db, 'action_gateway_principal', { p_credential_digest: digest }),
    openIntent: (row) => rpc(db, 'action_gateway_intent_open', { p: row }),
    getIntent: (id) => rpc(db, 'action_gateway_intent_get', { p_intent_id: id }),
    refuse: (id, code, detail = {}) => rpc(db, 'action_gateway_refuse', { p_intent_id: id, p_code: code, p_detail: detail }),
    expire: (id, code) => rpc(db, 'action_gateway_expire', { p_intent_id: id, p_code: code }),
    awaitApproval: (id, approval_id) => rpc(db, 'action_gateway_await_approval', { p_intent_id: id, p_approval_id: approval_id }),
    authorize: (id, digest, p) => rpc(db, 'action_gateway_authorize', { p_intent_id: id, p_credential_digest: digest, p }),
    claim: (id, worker, leaseSeconds) => rpc(db, 'action_gateway_claim', { p_intent_id: id, p_worker: worker, p_lease_seconds: leaseSeconds }),
    complete: (id, token, status, code, result = {}) => rpc(db, 'action_gateway_complete', { p_intent_id: id, p_lease_token: token, p_status: status, p_code: code, p_result: result }),
    markUnknown: (id, code) => rpc(db, 'action_gateway_mark_unknown', { p_intent_id: id, p_code: code }),
    async recoverable(limit = 20) { return (await rpc(db, 'action_gateway_recoverable', { p_limit: limit })) || [] },
    async audit(ev) {
      try { await rpc(db, 'action_gateway_audit_append', { p: ev }) } catch { /* an audit sink failure never turns a refusal into a success; it is counted by the caller */ return false }
      return true
    },
    domainWrite(fn, id, token) {
      if (!/^action_gateway_dw_[a-z_]+$/.test(String(fn))) throw gwErr('internal', 'DOMAIN_WRITE_UNKNOWN')
      return rpc(db, fn, { p_intent_id: id, p_lease_token: token })
    },
    approvalRequest: (row) => rpc(db, 'action_gateway_approval_request', { p: row }),
    approvalGet: (id) => rpc(db, 'action_gateway_approval_get', { p_approval_id: id }),
    async pipelineFacts({ after = null, limit = 200 } = {}) { return (await rpc(db, 'action_gateway_pipeline_facts', { p_after: after, p_limit: limit })) || [] },
    workItemGet: (id) => rpc(db, 'action_gateway_work_item_get', { p_work_item_id: id }),
    replyPolicy: () => rpc(db, 'action_gateway_reply_policy', {}),
    // T3 / T4 (PROPOSED_20261020110000_action_gateway_t34.sql)
    authorizeEnvelope: (id, digest, p) => rpc(db, 'action_gateway_authorize_envelope', { p_intent_id: id, p_credential_digest: digest, p }),
    receiptGet: (id) => rpc(db, 'action_gateway_receipt_get', { p_intent_id: id }),
    negotiationState: (threadId, propertyId) => rpc(db, 'action_gateway_negotiation_state', { p_thread_id: threadId, p_property_id: String(propertyId) }),
    offerAuthority: (propertyId) => rpc(db, 'action_gateway_offer_authority', { p_property_id: String(propertyId) }),
    selfCheck: () => rpc(db, 'action_gateway_self_check', {}),
    // Workforce × Agntei (PROPOSED_20261022110000_workforce_agntei.sql): the principal-bound read (the digest selects the principal)
    workforceRead: (digest, kind, p = {}) => rpc(db, 'action_gateway_workforce_read', { p_credential_digest: digest, p_kind: kind, p }),
  })
}
