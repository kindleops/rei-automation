// rc-8.5.21 operations reads (owner directive: operations results "through authenticated, scoped
// MCP reads"): ops supervisor status, the Inbound Action Center / lost conversations, the hold
// status of one thread, follow-up intent health. FIXTURE data only (synthetic projections).
//
// Each tool: behind its OWN opt-in scope (none in the default grant); read-only; a source that is
// missing or failing is unavailable / unknown — never 0, never "all clear", never "not held";
// nothing beyond the projection leaves (no hold ids / keys / reason text, no evidence refs or
// opportunity ids, no thread keys, no contact values).
import test from 'node:test'
import assert from 'node:assert/strict'
import { connect, call, fixtureEnv } from './helpers.mjs'
import { FIXTURE, FIXTURE_THREADS, INJECTION } from '../fixtures/dataset.mjs'
import { DEFAULT_SCOPES, OPT_IN_SCOPES, SCOPE_NAMES } from '../src/authz/scopes.mjs'
import { ACTION_STATES } from '@/lib/agent/operations/action-center.js'
import { ALL_HOLD_CAPABILITIES, STATIC_PERMANENT_EXCLUSIONS } from '@/lib/domain/holds/automation-hold-core.js'
import { OWNERSHIP_UNRESOLVED_HOLD_REASON, ownershipHoldKey } from '@/lib/domain/holds/ownership-attribution-hold.js'
import { readFileSync } from 'node:fs'

const OPS = Object.freeze({
  leadcommand_get_ops_supervisor_status: ['leadcommand.ops_supervisor.read', {}],
  leadcommand_search_action_center: ['leadcommand.action_center.read', { limit: 5 }],
  leadcommand_get_thread_hold_status: ['leadcommand.holds.read', { thread_id: FIXTURE_THREADS.held }],
  leadcommand_get_followup_intent_health: ['leadcommand.followups.read', {}],
})
const OPS_SCOPES = Object.values(OPS).map(([s]) => s).join(' ')
const ok = (r) => { assert.ok(!r.isError, JSON.stringify(r.structuredContent?.error)); return r.structuredContent.result }
const errOf = (r) => { assert.ok(r.isError, 'expected an error'); return r.structuredContent.error }
const withRpc = (over) => ({ ...FIXTURE, rpc: { ...FIXTURE.rpc, ...over } })

test('scopes: each operations tool has its own opt-in scope; none is in the default grant; a default server refuses all four', async () => {
  for (const [, [scope]] of Object.entries(OPS)) {
    assert.ok(SCOPE_NAMES.includes(scope), scope)
    assert.ok(OPT_IN_SCOPES.includes(scope), `${scope} is opt-in`)
    assert.ok(!DEFAULT_SCOPES.includes(scope), `${scope} is not in the default grant`)
  }
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: '' }) })
  try {
    for (const [name, [scope, args]] of Object.entries(OPS)) {
      const e = errOf(await call(c.client, name, args))
      assert.equal(e.class, 'forbidden', name)
      assert.equal(e.code, 'SCOPE_NOT_GRANTED', name)
      assert.equal(e.details.required_scope, scope)
    }
    const refused = c.audit.filter((a) => a.event === 'tool_call' && Object.keys(OPS).includes(a.tool))
    assert.equal(refused.length, 4)
    assert.ok(refused.every((a) => a.outcome === 'refused' && a.error_code === 'SCOPE_NOT_GRANTED'), 'every refusal is audited')
  } finally { await c.close() }
  // one scope grants exactly its tool
  const d = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: 'leadcommand.holds.read' }) })
  try {
    assert.ok(!(await call(d.client, 'leadcommand_get_thread_hold_status', OPS.leadcommand_get_thread_hold_status[1])).isError)
    assert.equal(errOf(await call(d.client, 'leadcommand_search_action_center', { limit: 5 })).code, 'SCOPE_NOT_GRANTED')
    assert.equal(errOf(await call(d.client, 'leadcommand_get_ops_supervisor_status', {})).code, 'SCOPE_NOT_GRANTED')
  } finally { await d.close() }
})

test('supervisor status: the domain tool (opsIntelTool) over the read projections; a source not run is unavailable, never 0', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }) })
  try {
    const r = ok(await call(c.client, 'leadcommand_get_ops_supervisor_status', {}))
    assert.deepEqual(r.sections_requested, ['supervisor', 'research_valuation', 'valuation_dry_run', 'recovery'])
    assert.equal(r.read_only, true)
    assert.equal(r.sections.supervisor.available, true)
    assert.equal(r.sections.supervisor.job_id, 'job_fx_sup_2')
    assert.equal(r.sections.supervisor.value.all_clear, false)
    assert.equal(r.sections.supervisor.provenance.kind, 'fact')
    // valuation.refresh_batch has never run: unavailable with the domain code, provenance missing
    assert.deepEqual([r.sections.valuation_dry_run.available, r.sections.valuation_dry_run.code], [false, 'VALUATION_REFRESH_NOT_RUN'])
    assert.equal(r.sections.valuation_dry_run.provenance.kind, 'missing')
    assert.equal(r.sections.research_valuation.value.offers.overdue_no_reply_72h, 2)
    // recovery linkage: counts only (the property refs of the valuation requests never leave)
    assert.equal(r.sections.recovery.linkage.valuation_requests, 2)
    assert.doesNotMatch(JSON.stringify(r), /pr_fx_/)
    const only = ok(await call(c.client, 'leadcommand_get_ops_supervisor_status', { sections: ['supervisor'] }))
    assert.deepEqual(Object.keys(only.sections), ['supervisor'])
    assert.equal(errOf(await call(c.client, 'leadcommand_get_ops_supervisor_status', { sections: ['brief'] })).class, 'invalid_input')
    assert.equal(errOf(await call(c.client, 'leadcommand_get_ops_supervisor_status', { finding_type: 'recovery.candidate' })).class, 'invalid_input')
  } finally { await c.close() }
})

test('supervisor status: a failing finding read makes those sections unavailable (the call still answers); a contact value is withheld', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }), faults: { failRpcs: ['lc_mcp_ops_finding'] } })
  try {
    const r = ok(await call(c.client, 'leadcommand_get_ops_supervisor_status', {}))
    for (const k of ['supervisor', 'valuation_dry_run', 'recovery']) {
      assert.equal(r.sections[k].available, false, k)
      assert.equal(r.sections[k].code, 'SOURCE_UNAVAILABLE', k)
      assert.equal(r.sections[k].provenance.kind, 'missing', k)
    }
    assert.equal(r.sections.research_valuation.available, true, 'an independent section still reads')
  } finally { await c.close() }
  const leaky = withRpc({ lc_mcp_ops_finding: ({ p_finding_type }) => (p_finding_type === 'supervisor.summary' ? { job_id: 'j', retrieved_at: '2026-10-14T00:00:00Z', value: { note: 'call +1 555 010 0199' } } : null) })
  const d = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }), fixture: leaky })
  try {
    const e = errOf(await call(d.client, 'leadcommand_get_ops_supervisor_status', {}))
    assert.equal(e.code, 'CONTACT_VALUE_IN_OUTPUT')
    assert.doesNotMatch(JSON.stringify(e), /555/)
  } finally { await d.close() }
})

test('action center: lost conversations by default, every state counted, ids / codes / dates only', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }) })
  try {
    const res = await call(c.client, 'leadcommand_search_action_center', { limit: 10 })
    const r = ok(res)
    assert.equal(r.available, true)
    assert.equal(r.filters.lost_only, true, 'lost_only defaults to true')
    assert.deepEqual(r.rows.map((x) => x.conversation_id), [FIXTURE_THREADS.held, FIXTURE_THREADS.opp_held])
    assert.ok(r.rows.every((x) => x.lost === true && x.state === 'needs_attention' && x.active_queue === true && x.state_label === 'Needs Attention'))
    assert.deepEqual(Object.keys(r.summary.counts).sort(), [...ACTION_STATES].sort(), 'every state is counted (0 when absent)')
    assert.equal(r.summary.counts.resolved, 0)
    assert.deepEqual([r.summary.total, r.summary.lost, r.summary.active_queue], [4, 2, 2])
    for (const row of r.rows) for (const k of ['evidence_refs', 'opportunity_id', 'property_ref', 'org_id', 'job_id', 'derived_from']) assert.ok(!(k in row), `${k} never leaves`)
    // seller-influenced text is data at a declared untrusted path
    assert.match(r.rows[1].next_action, /IGNORE ALL PREVIOUS/)
    assert.ok(res.structuredContent.untrusted_fields.includes('result.rows[].next_action'))
    const w = ok(await call(c.client, 'leadcommand_search_action_center', { state: 'waiting_on_seller', lost_only: false, limit: 10 }))
    assert.deepEqual(w.rows.map((x) => [x.conversation_id, x.state, x.owner]), [[FIXTURE_THREADS.static_excluded, 'waiting_on_seller', 'ai']])
    assert.equal(errOf(await call(c.client, 'leadcommand_search_action_center', { state: 'lost' })).class, 'invalid_input')
    assert.equal(errOf(await call(c.client, 'leadcommand_search_action_center', { owner: 'ai' })).code, 'UNSUPPORTED_FILTER')
  } finally { await c.close() }
})

test('action center: keyset pages (no duplicates or gaps) and the cursor is bound to its filters', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }) })
  try {
    const seen = []
    let cursor
    let pages = 0
    do {
      const res = await call(c.client, 'leadcommand_search_action_center', { lost_only: false, limit: 1, ...(cursor ? { cursor } : {}) })
      const r = ok(res)
      seen.push(...r.rows.map((x) => x.conversation_id))
      cursor = res.structuredContent.page.next_cursor
      pages += 1
    } while (cursor && pages < 10)
    assert.deepEqual(seen, Object.values(FIXTURE_THREADS).sort())
    assert.equal(pages, 4)
    const first = await call(c.client, 'leadcommand_search_action_center', { lost_only: false, limit: 1 })
    const e = errOf(await call(c.client, 'leadcommand_search_action_center', { lost_only: true, limit: 1, cursor: first.structuredContent.page.next_cursor }))
    assert.equal(e.code, 'CURSOR_MISMATCH')
  } finally { await c.close() }
})

test('action center: an empty read model is "not run", never an all clear', async () => {
  const empty = withRpc({ lc_mcp_action_center: () => ({ summary: [], items: [], limit: 10 }) })
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }), fixture: empty })
  try {
    const r = ok(await call(c.client, 'leadcommand_search_action_center', {}))
    assert.deepEqual([r.available, r.code, r.summary, r.rows.length], [false, 'ACTION_CENTER_NOT_RUN', null, 0])
    assert.equal(r.provenance.kind, 'missing')
  } finally { await c.close() }
})

test('hold status: held / not held with the reason CATEGORY, the matched scope and the capabilities; never an id, key or reason text', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }) })
  try {
    const held = ok(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_id: FIXTURE_THREADS.held }))
    assert.deepEqual([held.status, held.held, held.reason_categories], ['held', true, ['ownership_attribution_unresolved']])
    assert.deepEqual(held.holds.map((h) => [h.source, h.matched_on]), [['registry', 'thread']])
    assert.deepEqual(held.blocked_capabilities, ['ai_action', 'auto_reply', 'follow_up', 'outbound_send'])
    const opp = ok(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_id: FIXTURE_THREADS.opp_held }))
    assert.deepEqual([opp.status, opp.holds[0].matched_on, opp.holds[0].reason_category], ['held', 'opportunity', 'operator_hold'])
    assert.deepEqual(opp.holds[0].blocked_capabilities, ['offer_acceptance', 'stage_advance'], 'an unknown capability name is dropped')
    // the code-level permanent exclusion (matched on the property id, as staticExclusionFor does)
    const st = ok(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_id: FIXTURE_THREADS.static_excluded }))
    assert.deepEqual([st.status, st.holds[0].source, st.holds[0].reason_category, st.holds[0].matched_on], ['held', 'static', 'permanent_exclusion', 'property'])
    assert.deepEqual(st.holds[0].blocked_capabilities, [...ALL_HOLD_CAPABILITIES])
    const clear = ok(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_id: FIXTURE_THREADS.clear }))
    assert.deepEqual([clear.status, clear.held, clear.holds.length], ['not_held', false, 0])
    // nothing beyond the thread: the internal static keys (thread-key hash, property id) never leave
    const text = JSON.stringify([held, opp, st, clear])
    for (const s of ['fx1111', 'fx2222', 'fx3333', 'FX1001', 'FX1002', 'FX1003', STATIC_PERMANENT_EXCLUSIONS[0].property_id, STATIC_PERMANENT_EXCLUSIONS[0].key, 'static_keys', 'hold_key', 'approval_ref']) assert.ok(!text.includes(s), `${s} leaked`)
    assert.equal(errOf(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_id: '00000000-0000-4000-8000-0000000009ff' })).code, 'NOT_FOUND')
    assert.equal(errOf(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_id: '+15550100101' })).class, 'invalid_input')
    assert.equal(errOf(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_key: '+15550100101' })).class, 'invalid_input')
  } finally { await c.close() }
})

test('hold status: a lookup that fails is UNKNOWN, never "not held" (fail closed, like the hold authority)', async () => {
  for (const code of ['PGRST000', '42883', '42501']) {
    const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }), faults: { failRpcs: ['lc_mcp_thread_hold_status'], rpcErrorCode: code } })
    try {
      const r = ok(await call(c.client, 'leadcommand_get_thread_hold_status', { thread_id: FIXTURE_THREADS.clear }))
      assert.deepEqual([r.status, r.held, r.thread_found], ['unknown', null, null], code)
      assert.equal(r.provenance.kind, 'missing')
    } finally { await c.close() }
  }
})

test('hold status: the SQL category rule matches the hold writer (ownership-attribution-hold.js)', () => {
  // the definer derives the category from the reason / key the writer records; drift here would mislabel holds
  const sql = readFileSync(new URL('../../../supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql', import.meta.url), 'utf8')
  assert.ok(sql.includes(`u.reason = '${OWNERSHIP_UNRESOLVED_HOLD_REASON}'`), 'reason code')
  assert.ok(sql.includes(`u.hold_key like '${ownershipHoldKey('')}%'`), 'hold key prefix')
})

test('follow-up health: counts, the supervisor\'s own verdict, reason codes as untrusted data; a failure is an error, never zeros', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }) })
  try {
    const res = await call(c.client, 'leadcommand_get_followup_intent_health', {})
    const r = ok(res)
    assert.equal(r.available, true)
    assert.deepEqual([r.counts.planned, r.counts.planned_overdue, r.counts.held, r.counts.delivered], [6, 2, 2, 14])
    // supervisor-checks#evaluateSupervisor followup_lifecycle: 2 overdue planned → warn, stuck 2, nothing to review
    assert.deepEqual([r.verdict.status, r.verdict.stuck, r.verdict.needs_review], ['warn', 2, 0])
    assert.equal(r.verdict.issue.action, 'run_followup_reconcile_report_then_review')
    assert.match(r.verdict.rule, /evaluateSupervisor/)
    assert.equal(r.reasons.length, 3)
    assert.ok(r.reasons.some((x) => /IGNORE ALL PREVIOUS/.test(x.reason)))
    assert.ok(res.structuredContent.untrusted_fields.includes('result.reasons[].reason'))
    assert.equal(errOf(await call(c.client, 'leadcommand_get_followup_intent_health', { state: 'held' })).class, 'invalid_input')
  } finally { await c.close() }
  const d = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }), faults: { failRpcs: ['lc_mcp_followup_intent_health'], rpcErrorCode: '42P01' } })
  try {
    const e = errOf(await call(d.client, 'leadcommand_get_followup_intent_health', {}))
    assert.deepEqual([e.class, e.code], ['data_unavailable', 'SOURCE_NOT_APPLIED'])
  } finally { await d.close() }
  const leaky = withRpc({ lc_mcp_followup_intent_health: () => ({ health: { planned: 1, computed_at: '2026-10-14T00:00:00Z' }, reasons: [{ state: 'failed', kind: 'k', reason: 'bad number +1 555 010 0177', writer: 'w', n: 1 }] }) })
  const e2 = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }), fixture: leaky })
  try {
    assert.equal(errOf(await call(e2.client, 'leadcommand_get_followup_intent_health', {})).code, 'CONTACT_VALUE_IN_OUTPUT')
  } finally { await e2.close() }
})

test('read-only: the operations tools reach only their read functions; fixture data unchanged; every call audited without inputs', async () => {
  const before = JSON.stringify(FIXTURE.tables)
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: OPS_SCOPES }) })
  try {
    for (const [name, [, args]] of Object.entries(OPS)) ok(await call(c.client, name, args))
    const db = c.app.source
    assert.equal(db.mode, 'fixture')
    const lines = c.audit.filter((a) => a.event === 'tool_call')
    assert.equal(lines.length, 4)
    assert.ok(lines.every((a) => a.outcome === 'ok' && a.scope && typeof a.input_hash === 'string'))
    assert.doesNotMatch(JSON.stringify(lines), new RegExp(FIXTURE_THREADS.held), 'inputs are hashed, never logged')
    assert.doesNotMatch(JSON.stringify(lines), new RegExp(INJECTION.slice(0, 20)))
  } finally { await c.close() }
  assert.equal(JSON.stringify(FIXTURE.tables), before)
})
