// Read-only research agent (owner GO 10-10): model resolution, price table and
// cost, spend caps, the bounded tool loop, escalation (criteria, 2-call / $2
// caps, pre-call budget check), PII masking, auditing and fail-closed paths.
// No network: the provider, read client and store are injected doubles; the
// Postgres section (cap trigger, grants, concurrency) needs AGENT_PG_TEST_DB_URL.
import test from 'node:test'
import assert from 'node:assert/strict'

import { OWNER, CAMPAIGN, LISTED_MODELS, makeTables, fakeDb, fakeServices, fakeProvider, toolUse, reply, answer, usage } from '../helpers/agent-research-fake.mjs'
import { resolveRoute, createModelResolver, worstCaseUsd, actualUsd, priceTierFor, MODEL_PRICES, DEFAULT_CANDIDATES, parseCandidates } from '../../src/lib/agent/research/models.js'
import { resolveResearchCaps, effectiveCaps, checkBudget, RESEARCH_HARD_CEILINGS, isResearchEnabled } from '../../src/lib/agent/research/research-config.js'
import { createResearchMemoryStore } from '../../src/lib/agent/research/research-store.js'
import { createResearchToolRegistry, findInconsistencies, pinnedPropertyIds, safeFlags, toApiName } from '../../src/lib/agent/research/research-tools.js'
import { createAskService, ESCALATION_TOOL, SYSTEM_PROMPT } from '../../src/lib/agent/research/ask-service.js'
import { maskContacts, maskString, encodeForStore, decodeFromStore, residualContact } from '../../src/lib/agent/research/pii.js'
import { classifyProviderError, providerKeyFrom } from '../../src/lib/ai/anthropic-provider.js'

export const RESEARCH_ENV = Object.freeze({ NODE_ENV: 'development', AGENT_ENABLED: '1', AGENT_LIVE_ROUTES: '1', AGENT_RESEARCH_ENABLED: '1', AGENT_MAX_MODE: 'read', AGENT_SPEND_GLOBAL_DAILY_USD: '10', AGENT_SPEND_USER_DAILY_USD: '10', AGENT_SPEND_CYCLE_USD: '150' })
const IDENTITY = Object.freeze({ verified: true, named: true, user_id: OWNER, method: 'supabase_jwt' })

export function makeAsk({ script, env = RESEARCH_ENV, store = createResearchMemoryStore(), tables = makeTables(), providerOpts = {} } = {}) {
  const dbLog = []
  const db = fakeDb(tables, { log: dbLog })
  const provider = fakeProvider(script, providerOpts)
  const resolver = createModelResolver({ provider, env })
  const registry = createResearchToolRegistry()
  const ask = createAskService({ store, registry, provider, resolver, createServices: () => fakeServices(db), env })
  return { ask, store, provider, resolver, registry, dbLog }
}

const t = (name, input) => toolUse(toApiName(name), input)

// ── models ──────────────────────────────────────────────────────────────────
test('models: Haiku 5.5 / Sonnet 5.5 resolve from GET /v1/models by family; ids are config, not code', () => {
  assert.deepEqual(DEFAULT_CANDIDATES.default, ['family:haiku@5.5', 'claude-haiku-4-5-20251001'])
  assert.deepEqual(DEFAULT_CANDIDATES.escalation, ['family:sonnet@5.5', 'claude-sonnet-5'])
  const d = resolveRoute('default', DEFAULT_CANDIDATES.default, LISTED_MODELS)
  const e = resolveRoute('escalation', DEFAULT_CANDIDATES.escalation, LISTED_MODELS)
  assert.equal(d.id, 'claude-haiku-5-5')
  assert.equal(e.id, 'claude-sonnet-5-5')
  // env can swap ids without a release
  assert.deepEqual(parseCandidates('claude-sonnet-5, family:haiku@5.5', []), ['claude-sonnet-5', 'family:haiku@5.5'])
})

test('models: a 5.5 id missing from /v1/models falls back to the next entry; an unlisted id is never called', () => {
  const without = LISTED_MODELS.filter((m) => !/5-5/.test(m.id))
  assert.equal(resolveRoute('default', DEFAULT_CANDIDATES.default, without).id, 'claude-haiku-4-5-20251001')
  assert.equal(resolveRoute('escalation', DEFAULT_CANDIDATES.escalation, without).id, 'claude-sonnet-5')
  const none = resolveRoute('default', ['claude-haiku-9-9', 'family:haiku@9.9'], LISTED_MODELS)
  assert.equal(none.id, null)
  assert.deepEqual(none.skipped.map((s) => s.reason), ['NOT_LISTED', 'NOT_LISTED'])
})

test('models: escalation never resolves to Opus / Fable; a listed but unpriced model is skipped and reported', () => {
  const opus = resolveRoute('escalation', ['claude-opus-5-5', 'family:opus@5.5', 'claude-sonnet-5'], LISTED_MODELS)
  assert.equal(opus.id, 'claude-sonnet-5')
  assert.deepEqual(opus.skipped.map((s) => s.reason), ['LINE_NOT_ALLOWED', 'LINE_NOT_ALLOWED'])
  const listed = [...LISTED_MODELS, { id: 'claude-haiku-5-6', display_name: 'Claude Haiku 5.6', created_at: '2026-10-09T00:00:00Z' }]
  const r = resolveRoute('default', ['family:haiku@5.6', 'family:haiku@5.5'], listed)
  assert.equal(r.id, 'claude-haiku-5-5')
  assert.deepEqual(r.skipped, [{ candidate: 'family:haiku@5.6', id: 'claude-haiku-5-6', reason: 'UNPRICED' }])
  assert.equal(resolveRoute('default', ['claude-sonnet-5-5'], LISTED_MODELS).id, null, 'the default route is Haiku-line only')
})

test('models: a listing failure is never cached as success and resolves nothing (fail closed)', async () => {
  const p = fakeProvider([], { listFails: true })
  const r = createModelResolver({ provider: p, env: {} })
  const v = await r.resolve()
  assert.equal(v.ok, false)
  assert.equal(v.code, 'MODELS_UNRESOLVED')
  assert.equal(v.default, null)
  assert.equal(r.peek(), null)
})

// ── prices / cost ───────────────────────────────────────────────────────────
test('prices: owner-confirmed rates keyed by model id and prompt tier', () => {
  assert.deepEqual(priceTierFor('claude-haiku-5-5', 50_000), { max_prompt_tokens: 100_000, input: 0.10, cache_write_5m: 0.125, cache_write_1h: 0.20, cache_read: 0.01, output: 0.50 })
  assert.deepEqual(priceTierFor('claude-haiku-5-5', 150_000), { max_prompt_tokens: 1_000_000, input: 0.50, cache_write_5m: 0.625, cache_write_1h: 1.00, cache_read: 0.05, output: 2.50 })
  assert.deepEqual(priceTierFor('claude-sonnet-5-5', 99_999), { max_prompt_tokens: 100_000, input: 2, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.10, output: 10 })
  assert.equal(priceTierFor('claude-sonnet-5-5', 100_001), null, 'Sonnet 5.5 > 100K is unpriced ⇒ fail closed')
  assert.equal(priceTierFor('claude-opus-5-5', 10), null, 'no Opus entry: never spent on')
  assert.ok(MODEL_PRICES['claude-haiku-4-5-20251001'] && MODEL_PRICES['claude-sonnet-5'], 'fallbacks carry their own price entries')
})

test('cost: actual = provider usage × the tier (cache read / write included); worst case ≥ actual', () => {
  const u = { input_tokens: 20_000, output_tokens: 1_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 5_000 }
  const a = actualUsd('claude-haiku-5-5', u)
  // 20k×0.10 + 10k×0.01 + 5k×0.125 + 1k×0.50 per M
  assert.equal(a.usd, Number(((20_000 * 0.10 + 10_000 * 0.01 + 5_000 * 0.125 + 1_000 * 0.50) / 1e6).toFixed(6)))
  assert.equal(a.prompt_tokens, 35_000)
  const s = actualUsd('claude-sonnet-5-5', { input_tokens: 40_000, output_tokens: 3_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
  assert.equal(s.usd, 0.11)
  assert.equal(actualUsd('claude-sonnet-5-5', { input_tokens: 120_000, output_tokens: 1 }), null, 'outside every tier ⇒ never priced at zero')
  const worst = worstCaseUsd('claude-haiku-5-5', { promptTokensBound: 35_000, maxTokens: 3_000 })
  assert.ok(worst >= actualUsd('claude-haiku-5-5', { ...u, output_tokens: 3_000 }).usd)
  // 1h writes are the dearest input: the worst case prices every prompt token at that rate
  assert.equal(worstCaseUsd('claude-haiku-5-5', { promptTokensBound: 1_000_000, maxTokens: 0 }), 1.0)
})

// ── caps ────────────────────────────────────────────────────────────────────
test('caps: $0 unless set; env clamped to $10/day and $150/cycle; lowest of env, DB and code binds', () => {
  assert.deepEqual({ ...resolveResearchCaps({}) }, { day_usd: 0, user_day_usd: 0, cycle_usd: 0, run_usd: 2.5, escalation_calls_per_run: 2, escalation_usd_per_run: 2 })
  const big = resolveResearchCaps({ AGENT_SPEND_GLOBAL_DAILY_USD: '500', AGENT_SPEND_USER_DAILY_USD: '900', AGENT_SPEND_CYCLE_USD: '9999' })
  assert.equal(big.day_usd, 10)
  assert.equal(big.user_day_usd, 10)
  assert.equal(big.cycle_usd, 150)
  assert.equal(resolveResearchCaps({ AGENT_SPEND_GLOBAL_DAILY_USD: '-3' }).day_usd, 0)
  const eff = effectiveCaps(resolveResearchCaps({ AGENT_SPEND_GLOBAL_DAILY_USD: '10', AGENT_SPEND_USER_DAILY_USD: '4', AGENT_SPEND_CYCLE_USD: '150' }), { enabled: true, day_usd: 10, cycle_usd: 100, run_usd: 2.5, escalation_calls_per_run: 2, escalation_usd_per_run: 2 })
  assert.equal(eff.day_usd, 4)
  assert.equal(eff.cycle_usd, 100)
  assert.deepEqual(RESEARCH_HARD_CEILINGS, { day_usd: 10, cycle_usd: 150, run_usd: 2.5, escalation_calls_per_run: 2, escalation_usd_per_run: 2 })
  const totals = { day_usd: 9.99, cycle_usd: 20, run_usd: 0, run_escalation_usd: 0, run_escalation_calls: 0 }
  assert.equal(checkBudget({ caps: eff, totals: { ...totals, day_usd: 3.99 }, worst_usd: 0.02 }).code, 'AGENT_SPEND_CAP_DAY')
  assert.equal(checkBudget({ caps: { ...eff, enabled: false }, totals, worst_usd: 0.01 }).code, 'AGENT_RESEARCH_DISABLED')
})

test('research switch: off unless AGENT_RESEARCH_ENABLED=1, and the AGENT_ENABLED kill switch wins', () => {
  assert.equal(isResearchEnabled({ ...RESEARCH_ENV, AGENT_RESEARCH_ENABLED: '' }), false)
  assert.equal(isResearchEnabled({ ...RESEARCH_ENV, AGENT_ENABLED: '0' }), false)
  assert.equal(isResearchEnabled({ ...RESEARCH_ENV, NODE_ENV: 'production', AGENT_ENABLED: '' }), false)
  assert.equal(isResearchEnabled(RESEARCH_ENV), true)
})

// ── the loop ────────────────────────────────────────────────────────────────
test('loop: investigate HOT LEADS — tool reads, cited answer, cost per call from usage, full audit trail', async () => {
  const { ask, store, provider, dbLog } = makeAsk({ script: [
    reply([t('campaign.audience_top', { campaign_id: CAMPAIGN, limit: 3 })]),
    (body) => { assert.match(JSON.stringify(body.messages), /Test Ave/); return reply([t('eg.distress_signals', { property_id: '2124415662' })], 'tool_use', usage(3000, 150, 2500, 0)) },
    answer('Summary: property 2124415662 ranks first (aos_score 90, campaign_target_graph).'),
  ] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Investigate the strongest HOT LEADS properties.', context: { campaign_id: CAMPAIGN } })
  const r = await done
  assert.equal(r.state, 'completed', JSON.stringify(r))
  assert.match(r.answer_md, /2124415662/, 'a property id the tools returned is not mistaken for a phone')
  // the model never saw a phone, a name or a demographic field
  const sent = JSON.stringify(provider.calls)
  for (const bad of ['6125550147', '+1612', 'Jane Q', 'Testowner', '"gender"', '"age_bucket"', '"language"', 'token=abc']) assert.ok(!sent.includes(bad), bad)
  assert.equal(provider.calls[0].model, 'claude-haiku-5-5')
  assert.deepEqual(provider.calls[0].output_config, { effort: 'low' })
  assert.equal(provider.calls[0].system[0].cache_control.type, 'ephemeral', 'system prompt cached')
  assert.equal(provider.calls[0].tools.at(-1).cache_control.type, 'ephemeral', 'tool definitions cached')
  assert.ok(provider.calls[0].tools.every((x) => /^[a-zA-Z0-9_-]{1,64}$/.test(x.name)))
  const s = await ask.status(run_id, OWNER)
  assert.equal(s.calls.length, 3)
  assert.ok(s.cost_usd > 0)
  assert.equal(s.cost_usd, Number(s.calls.reduce((a, c) => a + c.cost_usd, 0).toFixed(6)))
  assert.equal(s.calls[1].cache_read_input_tokens, 2500)
  const kinds = s.audit.map((a) => a.kind)
  assert.deepEqual(kinds.filter((k) => k === 'tool_call').length, 2)
  assert.equal(kinds[0], 'run_start')
  assert.equal(kinds.at(-1), 'run_end')
  assert.ok(s.audit.filter((a) => a.kind === 'tool_call').every((a) => /^[0-9a-f]{64}$/.test(a.params_sha256) && a.rows_returned >= 1))
  // ledger: every reserve settled from actual usage, none left open
  assert.ok(store._state.ledger.every((l) => l.state === 'settled'))
  // reads only
  assert.ok(dbLog.every((l) => l.method === 'GET'))
  assert.ok(!dbLog.some((l) => /owner_name|canonical_e164|seller_full_name|gender|age_bucket/.test(l.cols) && l.table !== 'campaign_target_graph'))
  assert.ok(!dbLog.some((l) => l.table === 'campaign_target_graph' && /owner_name|seller_full_name|gender|age_bucket|language/.test(l.cols)))
  assert.equal(SYSTEM_PROMPT.includes('READ-ONLY'), true)
})

test('distress: tax / probate / preforeclosure inconsistencies are found deterministically, nothing is changed', async () => {
  const { ask } = makeAsk({ script: [
    reply([t('eg.distress_signals', { property_id: '2124415662' }), t('eg.distress_signals', { property_id: '2124358658' })]),
    (body) => {
      const last = JSON.stringify(body.messages.at(-1))
      for (const code of ['tax_delinquency_sources_disagree', 'estate_sold_but_still_targetable', 'preforeclosure_flag_vs_verified_closed', 'tax_flag_without_recorded_tax_lien']) assert.ok(last.includes(code), code)
      assert.ok(last.includes('facts_table_not_applied'))
      assert.ok(!last.includes('county.example.gov/case'), 'evidence URLs never reach the model (host only)')
      return answer('Inconsistencies found.')
    },
  ] })
  const r = await (await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Find tax, ownership and probate inconsistencies.' })).done
  assert.equal(r.state, 'completed')
  const inc = findInconsistencies({ graph: { tax_delinquent: true, tax_delinquent_year: 2023, sms_eligible: true }, parcel: { tax_delinquent: false }, probate: { validity_class: 'HEIR_OWNED_NOW', has_death_record: true, estate_status: 'no_filing' }, ownerKind: 'estate', preforeclosure: { verdict: 'AUCTION_SCHEDULED', auction_date: '2020-01-01' }, foreclosures: [] })
  assert.deepEqual(inc.map((i) => i.code).sort(), ['auction_date_passed', 'heir_owned_but_record_owner_is_estate', 'tax_delinquency_sources_disagree', 'verified_preforeclosure_without_recorded_filing'])
})

test('campaign audience: the pinned EG selection is read server-side, ranked by a stated score, capped to 25', async () => {
  const reg = createResearchToolRegistry()
  const db = fakeDb(makeTables())
  const out = await reg.get('campaign.audience_top').execute({ campaign_id: CAMPAIGN, limit: 2 }, { services: fakeServices(db) })
  assert.equal(out.audience.source, 'pinned_entity_graph_selection')
  assert.equal(out.audience.member_ids, 4)
  assert.equal(out.rows.length, 2)
  assert.equal(out.rows[0].property_id, '2124415662')
  assert.equal(out.rows[0].graph_rows, 2)
  assert.equal(out.rows[0].sms_eligible_any_phone, true)
  assert.equal(out.ranked_by.field, 'aos_score')
  assert.deepEqual(out.rows[0].distress.flags, ['Tax Delinquent', 'High Equity'])
  assert.deepEqual(safeFlags('Senior Owner;Tax Delinquent;Divorce;Absentee Owner;Spanish Speaker;Veteran;Probate'), ['Tax Delinquent', 'Absentee Owner', 'Probate'], 'protected / personal-attribute flags never reach the model')
  assert.deepEqual(pinnedPropertyIds({ metadata: { target_filters: { properties: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: ['1', 'x;drop'] }] } } }), ['1'])
  const map = await reg.get('eg.contact_map').execute({ property_id: '2124415662' }, { services: fakeServices(db) })
  assert.deepEqual(map.phones.map((p) => p.phone), ['•••-••47', '•••-••99'])
  assert.deepEqual(map.phones.map((p) => p.person), ['P1', 'P1'])
  assert.ok(!JSON.stringify(map).includes('person_2124415662'), 'person keys become handles')
})

// ── escalation ──────────────────────────────────────────────────────────────
const esc = (reason = 'multi_property_synthesis') => toolUse(ESCALATION_TOOL, { reason, justification: 'compare' })

test('escalation: declined until the criteria hold (3+ properties, or reported inconsistencies); logged with the reason', async () => {
  const { ask, provider } = makeAsk({ script: [
    reply([esc('multi_property_synthesis')]),
    reply([esc('contradiction_analysis')]),
    answer('done'),
  ] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })
  await done
  assert.ok(provider.calls.every((c) => c.model === 'claude-haiku-5-5'))
  const s = await ask.status(run_id, OWNER)
  const declined = s.audit.filter((a) => a.kind === 'escalation_declined')
  assert.deepEqual(declined.map((d) => d.outcome), ['ESCALATION_CRITERIA_NOT_MET', 'ESCALATION_CRITERIA_NOT_MET'])
  assert.equal(s.counters.escalated_calls, 0)
})

test('escalation: granted for multi-property synthesis → Sonnet 5.5; hard cap of 2 escalated calls per run (the last must answer)', async () => {
  const { ask, provider } = makeAsk({ script: [
    reply([t('eg.distress_signals', { property_id: '2124415662' }), t('eg.distress_signals', { property_id: '2124358658' }), t('eg.distress_signals', { property_id: '271992000' })]),
    reply([esc('multi_property_synthesis')]),
    reply([t('eg.facts', { property_id: '256582335' })], 'tool_use', usage(9000, 800)), // escalated call 1 (tools allowed)
    answer('synthesis', usage(11000, 1500)), // escalated call 2 (tool_choice none)
    answer('should never be needed'),
  ] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Compare these properties.' })
  const r = await done
  assert.equal(r.state, 'completed')
  assert.deepEqual(provider.calls.map((c) => c.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
  assert.deepEqual(provider.calls[3].tool_choice, { type: 'none' }, 'the 2nd escalated call cannot call tools')
  assert.ok(!provider.calls[2].tools.some((x) => x.name === ESCALATION_TOOL), 'the escalated model cannot re-escalate')
  assert.deepEqual(provider.calls[2].output_config, { effort: 'medium' })
  const s = await ask.status(run_id, OWNER)
  assert.equal(s.counters.escalated_calls, 2)
  assert.ok(s.counters.escalated_usd > 0 && s.counters.escalated_usd <= 2)
  const granted = s.audit.find((a) => a.kind === 'escalation')
  assert.equal(granted.outcome, 'multi_property_synthesis')
  assert.equal(granted.name, 'claude-sonnet-5-5')
})

test('escalation: the pre-call budget check keeps the run on Haiku when day / cycle cannot cover the worst case (logged)', async () => {
  const store = createResearchMemoryStore({ limits: { day_usd: 0.05 } })
  const { ask, provider } = makeAsk({ store, script: [
    reply([t('eg.distress_signals', { property_id: '2124415662' }), t('eg.distress_signals', { property_id: '2124358658' }), t('eg.distress_signals', { property_id: '271992000' })]),
    reply([esc('multi_property_synthesis')]),
    answer('answered on the default model'),
  ] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })
  const r = await done
  assert.equal(r.state, 'completed')
  assert.ok(provider.calls.every((c) => c.model === 'claude-haiku-5-5'), 'no Sonnet call was made')
  const s = await ask.status(run_id, OWNER)
  const d = s.audit.filter((a) => a.kind === 'escalation_declined' || a.kind === 'budget_refused').map((a) => a.outcome)
  assert.ok(d.includes('AGENT_SPEND_CAP_DAY'), JSON.stringify(s.audit))
})

test('escalation: the $2 per-run escalation cap and the 2-call cap are enforced by the store too (DB twin)', async () => {
  const store = createResearchMemoryStore()
  await store.createRun({ run_id: 'ask_testtesttest', operator_id: OWNER, question_sha256: 'a'.repeat(64), question_chars: 1 })
  const r1 = await store.reserve({ run_id: 'ask_testtesttest', operator_id: OWNER, model: 'claude-sonnet-5-5', purpose: 'escalation', reserved_usd: 1.5 })
  await store.settle(r1, { actual_usd: 1.5 })
  await assert.rejects(store.reserve({ run_id: 'ask_testtesttest', operator_id: OWNER, model: 'claude-sonnet-5-5', purpose: 'escalation', reserved_usd: 0.6 }), { code: 'AGENT_ESCALATION_CAP_USD' })
  await store.reserve({ run_id: 'ask_testtesttest', operator_id: OWNER, model: 'claude-sonnet-5-5', purpose: 'escalation', reserved_usd: 0.4 })
  await assert.rejects(store.reserve({ run_id: 'ask_testtesttest', operator_id: OWNER, model: 'claude-sonnet-5-5', purpose: 'escalation', reserved_usd: 0.01 }), { code: 'AGENT_ESCALATION_CAP_CALLS' })
})

// ── fail closed ─────────────────────────────────────────────────────────────
test('fail closed: budget exhausted ⇒ refused before any provider call; nothing reserved', async () => {
  const store = createResearchMemoryStore({ limits: { day_usd: 0.0001 } })
  const { ask, provider } = makeAsk({ store, script: [answer('x')] })
  const r = await (await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done
  assert.equal(r.state, 'refused')
  assert.equal(r.outcome, 'AGENT_SPEND_CAP_DAY')
  assert.equal(provider.calls.length, 0)
  assert.equal(store._state.ledger.length, 0)
})

test('fail closed: env caps unset ($0) ⇒ refused; DB switch off ⇒ refused', async () => {
  const a = makeAsk({ env: { ...RESEARCH_ENV, AGENT_SPEND_GLOBAL_DAILY_USD: '' }, script: [answer('x')] })
  assert.equal((await (await a.ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done).outcome, 'AGENT_SPEND_CAP_DAY')
  assert.equal(a.provider.calls.length, 0)
  const b = makeAsk({ store: createResearchMemoryStore({ limits: { enabled: false } }), script: [answer('x')] })
  assert.equal((await (await b.ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done).outcome, 'AGENT_RESEARCH_DISABLED')
  assert.equal(b.provider.calls.length, 0)
})

test('fail closed: a failed audit write stops the run before the tool result reaches the model', async () => {
  const store = createResearchMemoryStore({ failOn: (op) => op === 'audit:tool_call' })
  const { ask, provider } = makeAsk({ store, script: [reply([t('campaign.overview', { campaign_id: CAMPAIGN })]), answer('x')] })
  const r = await (await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done
  assert.equal(r.state, 'failed')
  assert.equal(provider.calls.length, 1, 'no second model call')
})

test('fail closed: the budget store unavailable ⇒ no provider call', async () => {
  const store = createResearchMemoryStore({ failOn: (op) => op === 'reserve' })
  const { ask, provider } = makeAsk({ store, script: [answer('x')] })
  const r = await (await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done
  assert.notEqual(r.state, 'completed')
  assert.equal(provider.calls.length, 0)
})

test('fail closed: a model id the API rejects (404) ⇒ MODEL_REJECTED_BY_API, reserve released, no guessed fallback', async () => {
  const notFound = Object.assign(new Error('MODEL_NOT_FOUND'), { code: 'MODEL_NOT_FOUND', billed: 'no', status: 404 })
  const { ask, provider, store, resolver } = makeAsk({ script: [notFound, answer('never')] })
  const r = await (await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done
  assert.equal(r.state, 'refused')
  assert.equal(r.outcome, 'MODEL_REJECTED_BY_API')
  assert.equal(provider.calls.length, 1)
  assert.deepEqual(store._state.ledger.map((l) => l.state), ['released'])
  assert.equal(resolver.peek(), null, 'resolution cache dropped')
  assert.equal(classifyProviderError({ status: 404 }).code, 'MODEL_NOT_FOUND')
  assert.equal(classifyProviderError({ status: 503 }).billed, 'unknown')
})

test('fail closed: a provider error after send leaves the reserve counted (unknown), never released', async () => {
  const boom = Object.assign(new Error('x'), { code: 'PROVIDER_UNAVAILABLE', billed: 'unknown', status: 529 })
  const { ask, store } = makeAsk({ script: [boom] })
  await (await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done
  assert.deepEqual(store._state.ledger.map((l) => l.state), ['unknown'])
  assert.ok((await store.totals({})).day_usd > 0)
})

test('kill switch: AGENT_ENABLED off mid-run stops at the next step; no further provider call', async () => {
  const env = { ...RESEARCH_ENV }
  const { ask, provider } = makeAsk({ env, script: [() => { env.AGENT_ENABLED = '0'; return reply([t('campaign.list', {})]) }, answer('never')] })
  const r = await (await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done
  assert.equal(r.state, 'cancelled')
  assert.equal(r.outcome, 'AGENT_DISABLED')
  assert.equal(provider.calls.length, 1)
})

test('loop bounds: the soft prompt cap and tool budget force an answer (tool_choice none)', async () => {
  const many = Array.from({ length: 7 }, () => t('campaign.list', { limit: 25 }))
  const { ask, provider } = makeAsk({ script: [reply(many), reply(many), reply(many), reply(many), reply(many), answer('final')] })
  const r = await (await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })).done
  assert.equal(r.state, 'completed')
  assert.ok(provider.calls.length <= 8)
  assert.deepEqual(provider.calls.at(-1).tool_choice, { type: 'none' })
})

// ── PII ─────────────────────────────────────────────────────────────────────
test('PII: phones / emails / names are masked or dropped before the model; property ids survive; storage encodes ids', () => {
  const ids = new Set(['2124415662'])
  const { value, masked, dropped } = maskContacts({ property_id: '2124415662', note: 'call 612-555-0147 or a@b.co', owner_name: 'X Y', phones: 2, list: [{ e164: '+16125550147' }] }, { knownIds: ids })
  assert.equal(value.property_id, '2124415662')
  assert.equal(value.note, 'call •••-••47 or [email withheld]')
  assert.equal(value.phones, 2)
  assert.ok(!('owner_name' in value))
  assert.equal(masked, 2)
  assert.equal(dropped, 2)
  assert.equal(residualContact('id 2124415662', { knownIds: ids }), null)
  assert.equal(residualContact('call 6125550147'), 'phone')
  assert.equal(residualContact('campaign b8134925-833a-4598-975f-4d77aacd5b2b on 2026-10-09 14:00:00'), null, 'UUIDs and ISO date-times are not phones')
  assert.equal(maskString('run 2026-10-09T14:00:00Z for b8134925-833a-4598-975f-4d77aacd5b2b, ring 612.555.0147')[0], 'run 2026-10-09T14:00:00Z for b8134925-833a-4598-975f-4d77aacd5b2b, ring •••-••47')
  const enc = encodeForStore('see 2124415662 and 21244156620', ids)
  assert.equal(enc, 'see ~e~ihikkhlmmi~ and ~e~ihikkhlmmig~')
  assert.equal(decodeFromStore(enc), 'see 2124415662 and 21244156620')
  assert.equal(providerKeyFrom({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k' }), '', 'production reads only AGENT_ANTHROPIC_API_KEY')
  assert.equal(providerKeyFrom({ NODE_ENV: 'production', AGENT_ANTHROPIC_API_KEY: 'k2' }), 'k2')
})

test('PII: a question containing a phone is masked before it is sent; the stored excerpt is clean', async () => {
  const { ask, provider, store } = makeAsk({ script: [answer('ok')] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Who owns the house for 612 555 0147?' })
  await done
  assert.ok(!JSON.stringify(provider.calls).includes('555 0147'))
  assert.match(JSON.stringify(store._state.runs.get(run_id).doc), /•••-••47/)
})

// ── R1 (10-12): streamed provider calls ─────────────────────────────────────
// A local SSE server stands in for the Messages API so the REAL SDK MessageStream
// path runs (accumulation, usage, connect / headers / stream phases) with no network.
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const STREAM_USAGE = { input_tokens: 1834, output_tokens: 1, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300 }
function toolUseStream() {
  return [
    sse('message_start', { type: 'message_start', message: { id: 'msg_s1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: STREAM_USAGE } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading the property.' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('ping', { type: 'ping' }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'eg__distress_signals', input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"property_id":' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"273435535"}' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 61 } }),
    sse('message_stop', { type: 'message_stop' }),
  ]
}

async function withSseServer(handler, fn) {
  const http = await import('node:http')
  const sockets = new Set()
  const server = http.createServer(handler)
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    for (const s of sockets) s.destroy()
    await new Promise((r) => server.close(r))
  }
}
const sseHead = (res) => res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_local' })
const BODY = { model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'q' }] }

test('stream: createMessage streams (stream:true on the wire), accumulates content + tool input, usage is exact for actualUsd', async () => {
  const { createAnthropicProvider } = await import('../../src/lib/ai/anthropic-provider.js')
  let wire = null
  await withSseServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { wire = JSON.parse(raw); sseHead(res); for (const e of toolUseStream()) res.write(e); res.end() })
  }, async (baseURL) => {
    const p = createAnthropicProvider({ env: { NODE_ENV: 'development', AGENT_ANTHROPIC_API_KEY: 'test-key' }, baseURL })
    const msg = await p.createMessage(BODY)
    assert.equal(wire.stream, true, 'the request asked for a stream')
    assert.equal(msg.stop_reason, 'tool_use')
    assert.deepEqual(msg.content.map((b) => b.type), ['text', 'tool_use'])
    assert.deepEqual(msg.content[1].input, { property_id: '273435535' })
    assert.deepEqual({ ...msg.usage, cache_creation: undefined, server_tool_use: undefined, service_tier: undefined }, { ...STREAM_USAGE, output_tokens: 61, cache_creation: undefined, server_tool_use: undefined, service_tier: undefined })
    const priced = actualUsd('claude-haiku-5-5', msg.usage)
    assert.equal(priced.usd, Number(((1834 * 0.10 + 1200 * 0.01 + 300 * 0.125 + 61 * 0.50) / 1e6).toFixed(6)))
  })
})

test('stream: a stream that goes silent after headers is aborted by the idle watchdog ⇒ PROVIDER_STREAM_STALLED (phase stream, billed unknown)', async () => {
  const { createAnthropicProvider } = await import('../../src/lib/ai/anthropic-provider.js')
  await withSseServer((req, res) => { req.resume(); sseHead(res); res.write(toolUseStream()[0]) /* then nothing */ }, async (baseURL) => {
    const p = createAnthropicProvider({ env: { AGENT_ANTHROPIC_API_KEY: 'k' }, baseURL, idleMs: 150 })
    const t0 = Date.now()
    await assert.rejects(p.createMessage(BODY), (e) => e.code === 'PROVIDER_STREAM_STALLED' && e.phase === 'stream' && e.billed === 'unknown')
    assert.ok(Date.now() - t0 < 5_000)
  })
})

test('stream: the per-call ceiling (caller abort, MODEL_TIMEOUT) before headers ⇒ PROVIDER_HEADERS_TIMEOUT; after headers ⇒ PROVIDER_READ_TIMEOUT; a plain cancel ⇒ PROVIDER_ABORTED', async () => {
  const { createAnthropicProvider } = await import('../../src/lib/ai/anthropic-provider.js')
  // never answers: no headers
  await withSseServer((req) => { req.resume() }, async (baseURL) => {
    const p = createAnthropicProvider({ env: { AGENT_ANTHROPIC_API_KEY: 'k' }, baseURL })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort({ code: 'MODEL_TIMEOUT' }), 120)
    await assert.rejects(p.createMessage(BODY, { signal: ctl.signal }), (e) => e.code === 'PROVIDER_HEADERS_TIMEOUT' && e.phase === 'connect' && e.billed === 'unknown')
    const c2 = new AbortController()
    setTimeout(() => c2.abort(), 80)
    await assert.rejects(p.createMessage(BODY, { signal: c2.signal }), (e) => e.code === 'PROVIDER_ABORTED' && e.billed === 'unknown')
  })
  // headers + a ping every 30 ms (alive, never finishing): the ceiling, not the watchdog, ends it
  await withSseServer((req, res) => { req.resume(); sseHead(res); res.write(toolUseStream()[0]); const iv = setInterval(() => res.write(sse('ping', { type: 'ping' })), 30); res.on('close', () => clearInterval(iv)) }, async (baseURL) => {
    const p = createAnthropicProvider({ env: { AGENT_ANTHROPIC_API_KEY: 'k' }, baseURL, idleMs: 1_000 })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort({ code: 'MODEL_TIMEOUT' }), 250)
    await assert.rejects(p.createMessage(BODY, { signal: ctl.signal }), (e) => e.code === 'PROVIDER_READ_TIMEOUT' && e.phase === 'stream')
  })
})

test('stream: a socket destroyed mid-stream ⇒ PROVIDER_STREAM_INTERRUPTED; an undici connect timeout ⇒ PROVIDER_CONNECT_TIMEOUT with its transport code', async () => {
  const { createAnthropicProvider } = await import('../../src/lib/ai/anthropic-provider.js')
  await withSseServer((req, res) => { req.resume(); sseHead(res); res.write(toolUseStream()[0]); setTimeout(() => res.socket.destroy(), 30) }, async (baseURL) => {
    const p = createAnthropicProvider({ env: { AGENT_ANTHROPIC_API_KEY: 'k' }, baseURL })
    await assert.rejects(p.createMessage(BODY), (e) => e.code === 'PROVIDER_STREAM_INTERRUPTED' && e.phase === 'stream' && e.billed === 'unknown')
  })
  // undici's own shape: TypeError('fetch failed') caused by ConnectTimeoutError (code UND_ERR_CONNECT_TIMEOUT, ~10 s default)
  const connectTimeout = async () => { const cause = Object.assign(new Error('Connect Timeout Error (attempted address: api.example:443, timeout: 10000ms)'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' }); throw new TypeError('fetch failed', { cause }) }
  const p = createAnthropicProvider({ env: { AGENT_ANTHROPIC_API_KEY: 'k' }, baseURL: 'http://127.0.0.1:9', baseFetch: connectTimeout })
  await assert.rejects(p.createMessage(BODY), (e) => {
    assert.equal(e.code, 'PROVIDER_CONNECT_TIMEOUT')
    assert.equal(e.phase, 'connect')
    assert.equal(e.transport, 'UND_ERR_CONNECT_TIMEOUT')
    assert.equal(e.billed, 'unknown', 'never released: the reserve stays counted')
    assert.ok(!/attempted address|api\.example/.test(JSON.stringify({ ...e, message: e.message })), 'no transport message leaks')
    return true
  })
  // a refused connection is not a timeout
  const refused = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }) }
  const p2 = createAnthropicProvider({ env: { AGENT_ANTHROPIC_API_KEY: 'k' }, baseURL: 'http://127.0.0.1:9', baseFetch: refused })
  await assert.rejects(p2.createMessage(BODY), (e) => e.code === 'PROVIDER_UNREACHABLE' && e.transport === 'ECONNREFUSED')
})

test('stream: a provider timeout inside a run keeps the reserve counted (unknown) and persists a diagnosable refusal (phase, transport)', async () => {
  const timeout = Object.assign(new Error('PROVIDER_CONNECT_TIMEOUT'), { code: 'PROVIDER_CONNECT_TIMEOUT', billed: 'unknown', status: null, phase: 'connect', transport: 'UND_ERR_CONNECT_TIMEOUT' })
  const { ask, store } = makeAsk({ script: [timeout] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q', context: { property_ids: ['273435535'] } })
  const r = await done
  assert.equal(r.outcome, 'PROVIDER_CONNECT_TIMEOUT')
  assert.deepEqual(store._state.ledger.map((l) => l.state), ['unknown'])
  const s = await ask.status(run_id, OWNER)
  assert.deepEqual({ code: s.refusal.code, phase: s.refusal.phase, transport: s.refusal.transport, billed: s.refusal.billed }, { code: 'PROVIDER_CONNECT_TIMEOUT', phase: 'connect', transport: 'UND_ERR_CONNECT_TIMEOUT', billed: 'unknown' })
  const refused = s.audit.find((a) => a.kind === 'model_refused')
  assert.equal(refused.outcome, 'PROVIDER_CONNECT_TIMEOUT')
  assert.ok(refused.cost_usd > 0, 'counted at the reserve')
  const row = store._state.runs.get(run_id)
  assert.equal(row.doc.refusal.layer, 'gate')
})

test('models: a listing failure refuses the run with the resolver reason persisted (MODELS_UNRESOLVED ⇒ doc.refusal.reason)', async () => {
  const store = createResearchMemoryStore()
  const provider = fakeProvider([answer('never')], { listFails: true })
  const ask = createAskService({ store, registry: createResearchToolRegistry(), provider, resolver: createModelResolver({ provider, env: RESEARCH_ENV }), createServices: () => fakeServices(fakeDb(makeTables())), env: RESEARCH_ENV })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })
  const r = await done
  assert.equal(r.state, 'refused')
  assert.equal(r.outcome, 'MODELS_UNRESOLVED')
  assert.equal(provider.calls.length, 0)
  assert.deepEqual(store._state.runs.get(run_id).doc.refusal, { code: 'MODELS_UNRESOLVED', layer: 'gate', reason: 'PROVIDER_UNREACHABLE', skipped: [] })
  assert.equal((await ask.status(run_id, OWNER)).refusal.reason, 'PROVIDER_UNREACHABLE')
  // a listing that works but has no qualifying default candidate names the reason and the skips
  const p2 = fakeProvider([answer('never')], { listed: LISTED_MODELS.filter((m) => !/haiku/.test(m.id)) })
  const a2 = createAskService({ store, registry: createResearchToolRegistry(), provider: p2, resolver: createModelResolver({ provider: p2, env: RESEARCH_ENV }), createServices: () => fakeServices(fakeDb(makeTables())), env: RESEARCH_ENV })
  const x = await a2.ask({ operator_id: OWNER, identity: IDENTITY, question: 'q' })
  await x.done
  const d = store._state.runs.get(x.run_id).doc.refusal
  assert.equal(d.code, 'DEFAULT_MODEL_UNRESOLVED')
  assert.equal(d.reason, 'NO_CANDIDATE_QUALIFIED')
  assert.deepEqual(d.skipped.map((k) => k.reason), ['NOT_LISTED', 'NOT_LISTED'])
  // claude-haiku-4-5-20251001 is phone-shaped to the doc CHECK (4-5-20251001): stored encoded, decoded on read
  assert.ok(!/4-5-20251001/.test(JSON.stringify(d)), 'no phone-shaped model id in the stored doc')
  assert.deepEqual((await a2.status(x.run_id, OWNER)).refusal.skipped.map((k) => k.candidate), ['family:haiku@5.5', 'claude-haiku-4-5-20251001'])
})

// ── R1 (10-12): property ids vs phones in free text ─────────────────────────
test('PII: a property id named in the question survives (context allowlist or id cue); phones are still masked', () => {
  const ctx = new Set(['273435535'])
  // the production defect: id + "(1947 …" read as one 13-digit phone
  assert.equal(maskString('property 273435535 (1947 Johnson St NE)', { knownIds: ctx })[0], 'property 273435535 (1947 Johnson St NE)')
  assert.equal(maskString('273435535 (1947 Johnson St NE)', { knownIds: ctx })[0], '273435535 (1947 Johnson St NE)', 'allowlisted: no cue needed')
  assert.equal(maskString('property 273435535 (1947 Johnson St NE)')[0], 'property 273435535 (1947 Johnson St NE)', 'id cue + non-phone shape')
  assert.equal(maskString('Property #273435535 at 1947 Johnson')[0], 'Property #273435535 at 1947 Johnson')
  assert.equal(residualContact('property 273435535 (1947 Johnson St NE)'), null)
  assert.equal(maskString('property 6125550147', { knownIds: new Set(['6125550147']) })[0], 'property 6125550147', 'a 10-digit id survives only via the allowlist')
  // …and the other way: phones stay masked, with or without a cue, next to a kept id
  for (const [input, out] of [
    ['call 612-555-0147', 'call •••-••47'],
    ['property 6125550147', 'property •••-••47'], // bare 10 digits = NANP: the cue never frees it
    ['property 16125550147', 'property •••-••47'],
    ['id 612-555-0147', 'id •••-••47'],
    ['id 612555-0147', 'id •••-••47'], // 6 + 4 glued = a 10-digit phone
    ['property 273435535 612-555-0147', 'property 273435535 •••-••47'],
    ['pid 12345678, (612) 555-0147', 'pid 12345678, (•••-••47'],
    ['+1 612 555 0147 re property 273435535', '•••-••47 re property 273435535'],
    ['273435535 (1947 Johnson St NE)', '•••-••47 Johnson St NE)'], // no cue, not allowlisted: conservative
  ]) assert.equal(maskString(input, { knownIds: input.startsWith('property 273435535 612') ? ctx : null })[0], out, input)
  assert.equal(residualContact('property 6125550147'), 'phone')
  assert.equal(residualContact('id 612555-0147'), 'phone')
  assert.equal(residualContact('pid 12345678, (612) 555-0147'), 'phone')
})

test('context: property_ids (array or string) and the property_id alias reach the model unmasked; the stored excerpt is clean', async () => {
  const { contextPropertyIds } = await import('../../src/lib/agent/research/ask-service.js')
  assert.deepEqual(contextPropertyIds({ property_id: '273435535' }), ['273435535'])
  assert.deepEqual(contextPropertyIds({ property_ids: '273435535' }), ['273435535'])
  assert.deepEqual(contextPropertyIds({ property_ids: ['1', '2'], property_id: '2' }), ['1', '2'])
  assert.deepEqual(contextPropertyIds({ property_ids: [{}, 'x;drop', 7, '3'] }), ['7', '3'])
  assert.equal(contextPropertyIds({ property_ids: Array.from({ length: 20 }, (_, i) => String(1000000 + i)) }).length, 10)
  const { ask, provider, store } = makeAsk({ script: [answer('Property 273435535 (1947 Johnson St NE): no tax lien recorded.')] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'What do we know about property 273435535 (1947 Johnson St NE)?', context: { property_id: '273435535' } })
  const r = await done
  assert.equal(r.state, 'completed')
  const sent = provider.calls[0].messages[0].content
  assert.match(sent, /Properties in context: 273435535/)
  assert.match(sent, /property 273435535 \(1947 Johnson St NE\)/, 'the id is not masked as a phone')
  assert.match(r.answer_md, /273435535 \(1947 Johnson/)
  const doc = store._state.runs.get(run_id).doc
  assert.ok(!/273435535/.test(JSON.stringify(doc)), 'stored text encodes the id run (DB CHECK safe)')
  assert.match(decodeFromStore(doc.question_excerpt), /273435535 \(1947 Johnson/)
})

// ── R1 (10-12): address → property id ───────────────────────────────────────
const lookupTables = () => ({
  ...makeTables(),
  properties: [
    { property_id: '273435535', property_address_full: '1947 Johnson St NE, Minneapolis, MN 55418', property_address_city: 'Minneapolis', property_address_state: 'MN', property_address_zip: '55418', market: 'Minneapolis', property_type: 'SFR', units_count: 1, owner_name: 'Jane Q Testowner', owner_address_full: '1 Owner Way' },
    { property_id: '273435536', property_address_full: '1947 Johnson Ave, Saint Paul, MN 55106', property_address_city: 'Saint Paul', property_address_state: 'MN', property_address_zip: '55106', market: 'Minneapolis', property_type: 'SFR', units_count: 1, owner_name: 'X' },
    { property_id: '273435537', property_address_full: '11947 Johnson St NE, Blaine, MN 55434', property_address_city: 'Blaine', property_address_state: 'MN', property_address_zip: '55434', market: 'Minneapolis', property_type: 'SFR', units_count: 1 },
    { property_id: '273435538', property_address_full: '1947 Elm St, Dallas, TX 75201', property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201', market: 'Dallas', property_type: 'SFR', units_count: 1 },
  ],
})

test('eg.property_lookup: an address fragment resolves to ≤ 5 ranked candidates through one bounded, indexed read; no owner fields', async () => {
  const { parseAddressFragment, LOOKUP_READ_ROWS } = await import('../../src/lib/agent/research/research-tools.js')
  const reg = createResearchToolRegistry()
  const spec = reg.get('eg.property_lookup')
  assert.equal(spec.tier, 'T0')
  assert.equal(spec.side_effect, 'read')
  assert.equal(spec.limits.timeout_ms, 5_000)
  assert.equal(spec.limits.rows_to_model, 5)
  assert.equal(spec.limits.max_rows, LOOKUP_READ_ROWS)
  const log = []
  const db = fakeDb(lookupTables(), { log })
  const out = await spec.execute({ address: '1947 Johnson St NE' }, { services: fakeServices(db) })
  assert.equal(out.candidates[0].property_id, '273435535', 'house number + every street token ranks first')
  assert.ok(out.candidates.length <= 5 && out.ambiguous === true)
  assert.ok(!out.candidates.some((c) => c.property_id === '273435538'), 'another street does not match')
  assert.equal(log.length, 1)
  assert.deepEqual(log[0].ilike, [{ k: 'property_address_full', pattern: '%1947 %JOHNSON%' }], 'one trigram-indexable ILIKE (house + street word)')
  assert.equal(log[0].limit, LOOKUP_READ_ROWS)
  assert.equal(log[0].signal, true, 'the read carries a 5 s abort signal')
  assert.ok(!/owner|mailing/.test(log[0].cols))
  assert.ok(!JSON.stringify(out).includes('Testowner') && !JSON.stringify(out).includes('Owner Way'))
  const z = await spec.execute({ address: '1947 Johnson St', zip: '55106' }, { services: fakeServices(fakeDb(lookupTables())) })
  assert.deepEqual(z.candidates.map((c) => c.property_id), ['273435536'])
  assert.equal(z.ambiguous, false)
  // not selective ⇒ refused before any read (never '%a%')
  for (const bad of ['Johnson St', '12 N St', '1947 NE']) assert.equal(parseAddressFragment(bad), null, bad)
  const log2 = []
  await assert.rejects(spec.execute({ address: 'Johnson St NE' }, { services: fakeServices(fakeDb(lookupTables(), { log: log2 })) }), { code: 'ADDRESS_NOT_SELECTIVE' })
  assert.equal(log2.length, 0)
  // LIKE metacharacters never reach the pattern
  assert.equal(parseAddressFragment('1947 John%son_ St').street_word, 'JOHN')
})

test('loop: a question that names only an address — the model looks it up, then reads the property by id', async () => {
  const { ask, provider } = makeAsk({ tables: lookupTables(), script: [
    reply([t('eg.property_lookup', { address: '1947 Johnson St NE', state: 'MN' })]),
    (body) => {
      const last = JSON.stringify(body.messages.at(-1))
      assert.match(last, /273435535/, 'the candidate id reaches the model unmasked')
      assert.ok(!/•••-••/.test(last))
      return reply([t('eg.distress_signals', { property_id: '273435535' })])
    },
    answer('Property 273435535 (1947 Johnson St NE, Minneapolis): evidence per eg.distress_signals.'),
  ] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Investigate 1947 Johnson St NE in Minneapolis.' })
  const r = await done
  assert.equal(r.state, 'completed', JSON.stringify(r))
  assert.match(r.answer_md, /273435535 \(1947 Johnson/)
  assert.ok(provider.calls[0].tools.some((x) => x.name === 'eg__property_lookup'))
  const s = await ask.status(run_id, OWNER)
  assert.deepEqual(s.audit.filter((a) => a.kind === 'tool_call').map((a) => [a.name, a.outcome]), [['eg.property_lookup', 'ok'], ['eg.distress_signals', 'ok']])
})
