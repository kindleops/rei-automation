// 1.3 Operation Hidden Gold acquisition reads (FIXTURE data only): the five per-thread tools through the REAL
// gateway and SDK client — scopes enforced (each behind its opt-in scope), every tool answers for the fixture
// thread, masking (no phone / email / thread key / body / payload / detail anywhere), the eligibility rule and its
// blocking reasons, the org filter of the operator tasks, untrusted text handling, the not-found and bounds paths,
// and the optional-link rule (an unapplied 1.3 migration → SOURCE_NOT_APPLIED; every other tool keeps working).
import test from 'node:test'
import assert from 'node:assert/strict'
import { connect, call, fixtureEnv } from './helpers.mjs'
import { FIXTURE, FIXTURE_PHONES, FIXTURE_SECRET_NAMES } from '../fixtures/dataset.mjs'
import { FIXTURE_CONV } from '../fixtures/conversations.mjs'
import { FIXTURE_ACQ, ACQ_INJECTION } from '../fixtures/acquisitions.mjs'
import { DEFAULT_SCOPES, OPT_IN_SCOPES, SCOPE_NAMES } from '../src/authz/scopes.mjs'
import { OPTIONAL_RPC_SIGNATURES, DEFINER_READS, DEFINER_ONLY_SOURCES, RELATION_NAMES } from '../src/data/inventory.mjs'
import { ELIGIBILITY_REASONS } from '../src/adapters/acquisitions.mjs'

const ACQ = Object.freeze({
  leadcommand_get_thread_followups: ['leadcommand.followups.read', { thread_id: FIXTURE_CONV.a }],
  leadcommand_get_thread_execution_log: ['leadcommand.conversations.read', { thread_id: FIXTURE_CONV.a, limit: 10 }],
  leadcommand_get_thread_offers: ['leadcommand.conversations.read', { thread_id: FIXTURE_CONV.a }],
  leadcommand_get_thread_contact_eligibility: ['leadcommand.contact_status.read', { thread_id: FIXTURE_CONV.a }],
  leadcommand_search_operator_tasks: ['leadcommand.action_center.read', { limit: 10 }],
})
const RPCS = ['lc_mcp_thread_followups', 'lc_mcp_thread_execution_log', 'lc_mcp_thread_offers', 'lc_mcp_thread_contact_eligibility', 'lc_mcp_operator_tasks']
const ok = (r) => { assert.ok(!r.isError, JSON.stringify(r.structuredContent?.error)); return r.structuredContent.result }
const errOf = (r) => { assert.ok(r.isError, 'expected an error'); return r.structuredContent.error }
const withRpc = (over) => ({ ...FIXTURE, rpc: { ...FIXTURE.rpc, ...over } })
const digits = (s) => s.replace(/[^0-9]/g, '')
const UNKNOWN = '00000000-0000-4000-8000-0000000009ff'

test('scopes: each acquisition tool sits behind an opt-in scope; a default server refuses all five and audits it; one scope grants its tools only', async () => {
  for (const [, [scope]] of Object.entries(ACQ)) {
    assert.ok(SCOPE_NAMES.includes(scope), scope)
    assert.ok(OPT_IN_SCOPES.includes(scope) && !DEFAULT_SCOPES.includes(scope), `${scope} is opt-in`)
  }
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: '' }) })
  try {
    for (const [name, [scope, args]] of Object.entries(ACQ)) {
      const e = errOf(await call(c.client, name, args))
      assert.equal(e.class, 'forbidden', name)
      assert.equal(e.code, 'SCOPE_NOT_GRANTED', name)
      assert.equal(e.details.required_scope, scope)
    }
    const refused = c.audit.filter((a) => a.event === 'tool_call' && Object.keys(ACQ).includes(a.tool))
    assert.equal(refused.length, 5)
    assert.ok(refused.every((a) => a.outcome === 'refused' && a.error_code === 'SCOPE_NOT_GRANTED'))
  } finally { await c.close() }
  const d = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: 'leadcommand.followups.read' }) })
  try {
    ok(await call(d.client, 'leadcommand_get_thread_followups', { thread_id: FIXTURE_CONV.a }))
    assert.equal(errOf(await call(d.client, 'leadcommand_get_thread_offers', { thread_id: FIXTURE_CONV.a })).code, 'SCOPE_NOT_GRANTED')
    assert.equal(errOf(await call(d.client, 'leadcommand_search_operator_tasks', { limit: 5 })).code, 'SCOPE_NOT_GRANTED')
  } finally { await d.close() }
})

test('every acquisition tool answers for the fixture thread; an unknown thread is not_found; bounds are refused before the source', async () => {
  const c = await connect()
  try {
    for (const [name, [, args]] of Object.entries(ACQ)) {
      const r = await call(c.client, name, args)
      ok(r)
      assert.equal(r.structuredContent.trust.content, 'data_only')
      assert.ok(Array.isArray(r.structuredContent.untrusted_fields))
    }
    for (const name of ['leadcommand_get_thread_followups', 'leadcommand_get_thread_execution_log', 'leadcommand_get_thread_offers', 'leadcommand_get_thread_contact_eligibility']) {
      assert.equal(errOf(await call(c.client, name, { thread_id: UNKNOWN })).code, 'NOT_FOUND', name)
      assert.equal(errOf(await call(c.client, name, { thread_id: 'not-a-uuid' })).class, 'invalid_input', name)
      assert.equal(errOf(await call(c.client, name, { thread_id: FIXTURE_CONV.a, org_id: 'x' })).class, 'invalid_input', `${name}: closed input`)
    }
    assert.equal(errOf(await call(c.client, 'leadcommand_get_thread_execution_log', { thread_id: FIXTURE_CONV.a, limit: 101 })).class, 'invalid_input')
    assert.equal(errOf(await call(c.client, 'leadcommand_search_operator_tasks', { limit: 0 })).class, 'invalid_input')
    assert.ok(c.audit.filter((a) => a.outcome === 'failed').every((a) => a.error_code === 'NOT_FOUND'), 'only the unknown-thread calls failed')
  } finally { await c.close() }
})

test('followups: the thread\'s intents newest first with states, materialized flag, reason code and counts by state', async () => {
  const c = await connect()
  try {
    const r = ok(await call(c.client, 'leadcommand_get_thread_followups', { thread_id: FIXTURE_CONV.a }))
    assert.equal(r.property_id, 'FX1001')
    assert.equal(r.available, true)
    assert.deepEqual(r.rows.map((x) => x.state), ['planned', 'cancelled', 'delivered'])
    for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1].created_at >= r.rows[i].created_at, 'newest first')
    assert.equal(r.rows[0].kind, 'offer_silence')
    assert.equal(r.rows[0].next_action, 'await_counter')
    assert.equal(r.rows[0].materialized, false)
    assert.equal(r.rows[2].materialized, true)
    assert.equal(r.rows[2].outcome, 'delivered')
    assert.equal(r.rows[1].reason_code, 'superseded_by_offer')
    assert.deepEqual(r.counts_by_state, { planned: 1, cancelled: 1, delivered: 1 })
    assert.equal(r.total, 3)
    assert.equal(r.has_more, false)
    assert.equal(r.provenance.kind, 'fact')
    const empty = ok(await call(c.client, 'leadcommand_get_thread_followups', { thread_id: FIXTURE_CONV.d }))
    assert.deepEqual(empty.rows, [])
    assert.deepEqual(empty.counts_by_state, {})
    const line = c.audit.find((a) => a.tool === 'leadcommand_get_thread_followups')
    assert.equal(line.rows, 3)
  } finally { await c.close() }
})

test('execution log: queue rows newest first with states, origin and the gateway receipt; events without payload; the limit; failed reasons masked', async () => {
  const c = await connect()
  try {
    const r = ok(await call(c.client, 'leadcommand_get_thread_execution_log', { thread_id: FIXTURE_CONV.a, limit: 10 }))
    assert.deepEqual(r.rows.map((x) => x.id), ['9003', '9002', '9001'])
    assert.deepEqual(r.rows.map((x) => x.queue_status), ['queued', 'failed', 'sent'])
    assert.equal(r.rows[0].message_origin, 'ai_generated')
    assert.equal(r.rows[0].receipt.state, 'enqueued')
    assert.equal(r.rows[1].receipt.code, 'PROVIDER_REJECTED')
    assert.equal(r.rows[2].receipt, null)
    assert.match(r.rows[1].failed_reason, /\[digits withheld\]/)
    assert.doesNotMatch(r.rows[1].failed_reason, /[0-9]{7}/)
    assert.equal(r.rows[2].delivered_at !== null, true)
    assert.deepEqual(r.events.map((x) => x.event_type), ['seller_replied', 'follow_up_due'])
    assert.equal(r.events[1].error_code, 'PROVIDER_REJECTED')
    assert.deepEqual(r.sources, { send_queue: true, seller_action_receipts: true, automation_events: true })
    // the injection in a paused reason is returned as quoted, flagged data
    assert.equal(r.rows[0].paused_reason, ACQ_INJECTION)
    const text = JSON.stringify(r)
    assert.doesNotMatch(text, /"message_body"|"payload"|"to_phone_number"|"from_phone_number"/)
    const one = ok(await call(c.client, 'leadcommand_get_thread_execution_log', { thread_id: FIXTURE_CONV.a, limit: 1 }))
    assert.equal(one.rows.length, 1)
    assert.equal(one.events.length, 1)
    assert.equal(one.rows[0].id, '9003')
    const dflt = ok(await call(c.client, 'leadcommand_get_thread_execution_log', { thread_id: FIXTURE_CONV.b }))
    assert.equal(dflt.limit, 50)
    assert.equal(dflt.rows.length, 1)
  } finally { await c.close() }
})

test('offers: both offers newest first (the seller\'s counter is inbound), the active offer, the opportunity with its stage; nothing identifying', async () => {
  const c = await connect()
  try {
    const r = ok(await call(c.client, 'leadcommand_get_thread_offers', { thread_id: FIXTURE_CONV.a }))
    assert.deepEqual(r.offers.map((o) => [o.offer_id, o.direction, o.offer_type, o.purchase_price, o.status]), [['OFF-FX1001-2', 'inbound', 'counter', 175000, 'active'], ['OFF-FX1001-1', 'outbound', 'cash', 150000, 'superseded']])
    assert.equal(r.offers[1].send_bound, true)
    assert.equal(r.offers[1].authorized_ceiling, 160000)
    assert.deepEqual(r.active_offer, { offer_id: 'OFF-FX1001-2', direction: 'inbound', purchase_price: 175000, authorized_ceiling: 160000 })
    assert.equal(r.opportunities.length, 1)
    assert.equal(r.opportunities[0].id, FIXTURE_ACQ.opp_a)
    assert.equal(r.opportunities[0].acquisition_stage, 'negotiation')
    assert.equal(r.opportunities[0].asking_price, 185000)
    assert.match(r.opportunities[0].next_action, /\[digits withheld\]/)
    assert.equal(r.offers_total, 2)
    assert.equal(r.offers_has_more, false)
    const none = ok(await call(c.client, 'leadcommand_get_thread_offers', { thread_id: FIXTURE_CONV.b }))
    assert.deepEqual(none.offers, [])
    assert.equal(none.active_offer, null)
    assert.deepEqual(none.opportunities, [])
    assert.doesNotMatch(JSON.stringify(r), /dedupe_key|thread_key|metadata/)
  } finally { await c.close() }
})

test('contact eligibility: the rule and its blocking reasons — held thread blocked by ai_action, opted-out thread blocked by flags and suppressions, a clean thread eligible', async () => {
  const c = await connect()
  try {
    const held = ok(await call(c.client, 'leadcommand_get_thread_contact_eligibility', { thread_id: FIXTURE_CONV.a }))
    assert.equal(held.eligible_for_outreach, false)
    assert.deepEqual(held.blocking_reasons, ['hold_blocks_ai_action'])
    assert.equal(held.holds.active, 1)
    assert.equal(held.holds.blocks_ai_action, true)
    assert.equal(held.holds.rows[0].reason_category, 'ownership_attribution_unresolved')
    assert.ok(held.holds.rows[0].blocked_capabilities.includes('ai_action'))
    assert.equal(held.contact_property.role, 'confirmed_owner')
    assert.equal(held.suppression_list.active, 0)
    assert.match(held.rule, /^eligible = /)
    assert.equal(held.provenance.kind, 'derived')
    const out = ok(await call(c.client, 'leadcommand_get_thread_contact_eligibility', { thread_id: FIXTURE_CONV.c }))
    assert.equal(out.eligible_for_outreach, false)
    assert.deepEqual(out.blocking_reasons, ['thread_suppressed', 'thread_opt_out', 'contactability_opted_out', 'suppression_list_active', 'automation_suppression_active'])
    assert.equal(out.suppression_list.rows[0].type, 'opt_out')
    assert.equal(out.automation_suppressions.active, 1)
    assert.equal(out.thread_flags.contactability_status, 'opted_out')
    for (const reason of [...held.blocking_reasons, ...out.blocking_reasons]) assert.ok(ELIGIBILITY_REASONS.includes(reason), reason)
    const clean = ok(await call(c.client, 'leadcommand_get_thread_contact_eligibility', { thread_id: FIXTURE_CONV.b }))
    assert.equal(clean.eligible_for_outreach, true)
    assert.deepEqual(clean.blocking_reasons, [])
    assert.equal(clean.holds.active, 0)
    assert.equal(clean.contact_property, null)
    assert.match(clean.policy_notes.join(' '), /never an authorization to send/)
    // a projection that claims eligible while naming a blocker is read as NOT eligible (fail closed)
    const leaky = withRpc({ lc_mcp_thread_contact_eligibility: (a) => ({ ...FIXTURE.rpc.lc_mcp_thread_contact_eligibility(a), eligible_for_outreach: true, blocking_reasons: ['thread_opt_out'] }) })
    const d = await connect({ fixture: leaky })
    try {
      assert.equal(ok(await call(d.client, 'leadcommand_get_thread_contact_eligibility', { thread_id: FIXTURE_CONV.b })).eligible_for_outreach, false)
    } finally { await d.close() }
  } finally { await c.close() }
})

test('operator tasks: open / acknowledged items newest first, the resolved one absent, another org\'s item withheld, counts, the limit', async () => {
  const c = await connect()
  try {
    const r = ok(await call(c.client, 'leadcommand_search_operator_tasks', { limit: 10 }))
    assert.equal(r.available, true)
    assert.deepEqual(r.rows.map((x) => x.kind), ['lost_conversation', 'escalation', 'pipeline_mismatch'])
    assert.deepEqual(r.rows.map((x) => x.state), ['open', 'acknowledged', 'open'])
    assert.equal(r.other_org_rows_withheld, 1)
    assert.ok(!r.rows.some((x) => /Another org/.test(x.title)))
    assert.equal(r.rows[0].subject_id, FIXTURE_CONV.a)
    assert.match(r.rows[0].title, /\[digits withheld\]/)
    assert.equal(r.rows[1].escalated, true)
    assert.ok(r.rows[1].acknowledged_at)
    assert.match(r.rows[2].title, /IGNORE ALL PREVIOUS/, 'the injection is quoted data')
    assert.ok(c.audit.find((a) => a.tool === 'leadcommand_search_operator_tasks').rows === 3)
    assert.deepEqual(r.counts, { open: 3, acknowledged: 1, critical: 1, warning: 1, info: 2, escalated: 1, total: 4 })
    assert.equal(r.has_more, false)
    assert.doesNotMatch(JSON.stringify(r), /"detail"|call back/)
    const two = ok(await call(c.client, 'leadcommand_search_operator_tasks', { limit: 2 }))
    assert.equal(two.rows.length, 2)
    assert.equal(two.has_more, true)
    // a database without agent.ops_work_item: available=false, never an empty "all clear"
    const absent = withRpc({ lc_mcp_operator_tasks: () => ({ rows: [], returned: 0, limit: 10, has_more: false, counts: null, sources: { ops_work_item: false }, as_of: new Date().toISOString() }) })
    const d = await connect({ fixture: absent })
    try {
      const a = ok(await call(d.client, 'leadcommand_search_operator_tasks', { limit: 10 }))
      assert.equal(a.available, false)
      assert.equal(a.code, 'OPS_WORK_ITEMS_NOT_IN_DATABASE')
      assert.equal(a.provenance.kind, 'missing')
    } finally { await d.close() }
  } finally { await c.close() }
})

test('masking: no fixture phone (any format), email, name, thread key, body, payload or detail in any acquisition output', async () => {
  const c = await connect()
  try {
    const calls = [...Object.entries(ACQ).map(([n, [, a]]) => [n, a]),
      ...['leadcommand_get_thread_followups', 'leadcommand_get_thread_execution_log', 'leadcommand_get_thread_offers', 'leadcommand_get_thread_contact_eligibility'].flatMap((n) => [FIXTURE_CONV.b, FIXTURE_CONV.c, FIXTURE_CONV.d].map((t) => [n, { thread_id: t }]))]
    for (const [name, args] of calls) {
      const r = await call(c.client, name, args)
      ok(r)
      const text = JSON.stringify(r)
      for (const p of FIXTURE_PHONES) {
        assert.equal(text.includes(p), false, `${name} leaks ${p.slice(0, 4)}…`)
        assert.equal(digits(text).includes(digits(p).slice(1)), false, `${name} leaks phone digits`)
      }
      for (const n of FIXTURE_SECRET_NAMES) assert.equal(text.toLowerCase().includes(n.toLowerCase()), false, `${name} leaks a name / email`)
      assert.doesNotMatch(text, /@example\.|"thread_key"|"message_body"|"payload"|"detail"|"hold_key"|"intent_key"|"row_spec"/, name)
    }
    // a projection that somehow carried a number is masked by the gateway before it leaves
    const leaky = withRpc({ lc_mcp_thread_followups: (a) => { const r = FIXTURE.rpc.lc_mcp_thread_followups(a); return { ...r, rows: [{ ...r.rows[0], reason_code: 'seller asked for a call at +1 555 010 0199 or seller@example.test' }] } } })
    const d = await connect({ fixture: leaky })
    try {
      const r = ok(await call(d.client, 'leadcommand_get_thread_followups', { thread_id: FIXTURE_CONV.a }))
      assert.doesNotMatch(JSON.stringify(r), /5550100199|555 010 0199|seller@example\.test/)
    } finally { await d.close() }
  } finally { await c.close() }
})

test('a database without the 1.3 functions: each tool answers SOURCE_NOT_APPLIED; a failing source is data_unavailable; every other tool keeps working', async () => {
  const c = await connect({ faults: { failRpcs: RPCS, rpcErrorCode: 'PGRST202' } })
  try {
    for (const [name, [, args]] of Object.entries(ACQ)) assert.equal(errOf(await call(c.client, name, args)).code, 'SOURCE_NOT_APPLIED', name)
    ok(await call(c.client, 'leadcommand_get_lead', { property_id: 'FX1001' }))
    ok(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_id: '00000000-0000-4000-8000-0000000001a1' }))
  } finally { await c.close() }
  const d = await connect({ faults: { failRpcs: ['lc_mcp_thread_offers'] } })
  try {
    const e = errOf(await call(d.client, 'leadcommand_get_thread_offers', { thread_id: FIXTURE_CONV.a }))
    assert.equal(e.class, 'data_unavailable')
    assert.equal(e.code, 'SOURCE_UNAVAILABLE')
    assert.ok(d.audit.find((a) => a.tool === 'leadcommand_get_thread_offers').outcome === 'failed')
  } finally { await d.close() }
})

test('inventory: the five functions are OPTIONAL definers whose sources are never granted to the role', () => {
  const sigs = ['public.lc_mcp_thread_followups(uuid)', 'public.lc_mcp_thread_execution_log(uuid,integer)', 'public.lc_mcp_thread_offers(uuid)', 'public.lc_mcp_thread_contact_eligibility(uuid)', 'public.lc_mcp_operator_tasks(integer)']
  for (const s of sigs) {
    assert.ok(OPTIONAL_RPC_SIGNATURES.includes(s), s)
    assert.ok(DEFINER_READS[s]?.length > 0, `${s}: DEFINER_READS`)
  }
  for (const src of ['public.send_queue', 'public.seller_offers', 'public.automation_events', 'public.automation_suppressions', 'agent.ops_work_item', 'action_gateway.seller_action_receipts', 'public.followup_intents']) {
    assert.ok(DEFINER_ONLY_SOURCES.includes(src), src)
    assert.ok(!RELATION_NAMES.includes(src.replace(/^public\./, '')), `${src} is not granted`)
  }
})
