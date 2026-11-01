// Link 10 (PROPOSED_20261101120000_record_sync) on a DISPOSABLE PostgreSQL 17: agntei ↔ LeadCommand bidirectional
// record sync. LeadCommand stays the system of record; every synchronized field of a lead carries a version and an
// audited history whoever changes it, and each change is on the lead event feed in the same transaction. Proven here,
// against the database rows themselves:
//   * a LeadCommand-side change (its registry / screens / jobs writing the canonical columns) is versioned, attributed
//     from the row's own *_source columns, and published (record_changed) — no event without its change, none lost;
//   * an agent's routine change (apply_record_change, standing T2: no per-change approval) moves the pipeline stage of
//     the thread AND its opportunity, with source, actor, via, intent, evidence, reason, old/new value and version;
//   * optimistic concurrency per field: a stale write is refused with the current value; two racing writes with the same
//     version — exactly one wins; separate dimensions (stage, temperature, status) never conflict with each other;
//   * a person's edit from agntei (apply_person_record_change, the console's capability alone) is protected from stale
//     automated writes; an agent's newer evidence still moves it; an operator's lock in LeadCommand is final;
//   * agents never regress a stage nor reach a contract stage without a signed production agreement; a person may;
//   * archival (sold / unavailable / duplicate / dead) takes the lead out of active work (open follow-ups closed),
//     deletes nothing, and is restored from the lead's own history;
//   * replays are idempotent; agents cannot use the person capability; reads return versions and history; rollback.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason, applyInTransaction } from '../pg/agent-pg-harness.mjs'
import { recordSyncDb, RECORD_ROLLBACK } from '../helpers/record-sync-pg.mjs'
import { makeGateway, seedThread, sel, registerAgent } from '../helpers/action-gateway-pg.mjs'
import { seedT34, setControls, crypto } from '../helpers/action-gateway-t34-world.mjs'
const agent = (env, o) => registerAgent(env.owner, { ...o, read_scopes: ['conversation_context.read'] })
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)
const READS = [['records.read', 1]]
const AGENT_GRANTS = [...READS, ['records.apply_change', 2]]
const CONSOLE_GRANTS = [...READS, ['records.apply_person_change', 2]]
const key = (p) => `${p}-${crypto.randomUUID().slice(0, 8)}`
const call = (g, cred, tool, args) => g.call({ credential: cred, tool, args })
const settle = () => new Promise((res) => setTimeout(res, 1100))

async function world() {
  const env = await recordSyncDb()
  await seedT34(env)
  await setControls(env.owner, {})
  const creds = {
    sterling: await agent(env, { agent_id: 'agt_sterling', grants: AGENT_GRANTS, tier_ceiling: 2 }),
    scout: await agent(env, { agent_id: 'agt_scout', grants: AGENT_GRANTS, tier_ceiling: 2 }),
    console: await agent(env, { agent_id: 'agt_agntei_console', grants: CONSOLE_GRANTS, tier_ceiling: 2 }),
  }
  const { gateway } = makeGateway(env)
  const t = await seedThread(env.owner, { phone: '+13125550150', property: 'p150' })
  const tk = t.phone
  await env.owner.query(`insert into public.acquisition_opportunities (dedupe_key, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status, market) values ($1, 'p150', $2, 'ownership_confirmation', 'active', 'Chicago')`, [`opp:${tk}`, tk])
  return { env, creds, gateway, t }
}
const state = async (g, cred, thread_id) => (await call(g, cred, 'get_record_state', { thread_id })).result?.record ?? (await call(g, cred, 'get_record_state', { thread_id }))
const field = async (g, cred, thread_id, f) => { const r = await call(g, cred, 'get_record_state', { thread_id }); return (r.record || r.result?.record || r.data?.record || r).fields?.[f] }
const changes = (env, thread_id) => sel(env.owner, `select * from lc_sync.record_changes where thread_id = $1 order by created_at`, [thread_id])
const events = (env, thread_id) => sel(env.owner, `select * from action_gateway.lead_events where kind = 'record_changed' and thread_id = $1 order by cursor`, [thread_id])
const versionOf = async (env, entity, id, f) => Number((await sel(env.owner, `select version from lc_sync.field_versions where entity = $1 and entity_id = $2 and field = $3`, [entity, id, f]))[0]?.version ?? 0)
const apply = (g, cred, args) => call(g, cred, 'apply_record_change', { client_request_id: key('rc'), reason: 'routine pipeline maintenance', ...args })
const personApply = (g, cred, args) => call(g, cred, 'apply_person_record_change', { client_request_id: key('pc'), reason: 'edited in agntei', ...args })
const SELLER_EVIDENCE = (at = new Date().toISOString()) => ({ source: 'seller_message', quote: 'Yes, I would consider selling if the price is right.', at })

test('PG record sync: a LeadCommand-side change is versioned, attributed from the row, recorded and published in the same transaction', { skip }, async () => {
  const { env, t } = await world()
  try {
    // LeadCommand's registry writes the canonical columns (here as its manual path does: temperature_source manual)
    await env.owner.query(`update public.inbox_thread_state set lead_temperature = 'warm', temperature = 'warm', temperature_source = 'manual', updated_by = 'operator_dana' where id = $1`, [t.thread_id])
    const ch = (await changes(env, t.thread_id)).filter((c) => c.field === 'temperature')
    assert.equal(ch.length, 1)
    assert.deepEqual([ch[0].source, ch[0].actor_kind, ch[0].actor_id, ch[0].old_value, ch[0].new_value, Number(ch[0].version)], ['leadcommand', 'person', 'operator_dana', null, 'warm', 1])
    const fv = (await sel(env.owner, `select * from lc_sync.field_versions where entity = 'thread' and entity_id = $1 and field = 'temperature'`, [t.thread_id]))[0]
    assert.equal(fv.protected, 'manual', 'a person\'s edit in LeadCommand is protected from stale automated writes')
    const ev = (await events(env, t.thread_id)).find((e) => e.payload.field === 'temperature')
    assert.ok(ev, 'its record_changed event is on the feed')
    assert.equal(ev.event_id, `record_changed:${ch[0].change_id}`)
    assert.deepEqual([ev.payload.to, ev.payload.version, ev.payload.source, ev.payload.actor_kind], ['warm', 1, 'leadcommand', 'person'])
    // the change and its event are one transaction: a rolled-back change leaves neither
    const before = (await events(env, t.thread_id)).length
    await env.owner.query('begin'); await env.owner.query(`update public.inbox_thread_state set lead_temperature = 'hot' where id = $1`, [t.thread_id]); await env.owner.query('rollback')
    assert.equal((await events(env, t.thread_id)).length, before)
    assert.equal(await versionOf(env, 'thread', t.thread_id, 'temperature'), 1)
    // unrelated writes (read flags, latest message) are not changes of synchronized fields
    await env.owner.query(`update public.inbox_thread_state set is_read = true, latest_message_at = now() where id = $1`, [t.thread_id])
    assert.equal((await events(env, t.thread_id)).length, before)
  } finally { await env.db.drop() }
})

test('PG record sync: an agent advances the pipeline stage on its own (standing grant, no approval) — thread and opportunity together, fully attributed', { skip }, async () => {
  const { env, creds, gateway, t } = await world()
  try {
    const opp = (await sel(env.owner, `select id from public.acquisition_opportunities where primary_thread_key = $1`, [t.phone]))[0].id
    const v0 = await versionOf(env, 'thread', t.thread_id, 'pipeline_stage')
    const r = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'pipeline_stage', value: 'offer_interest', expected_version: v0, evidence: { ...SELLER_EVIDENCE(), message_id: t.inbound_id } })
    assert.equal(r.status, 'succeeded', JSON.stringify(r)); assert.equal(r.code, 'RECORD_CHANGED')
    assert.equal(Number((await sel(env.owner, 'select count(*) n from agent.approval_request'))[0].n), 0, 'no approval was asked for')
    const th = (await sel(env.owner, `select lifecycle_stage, seller_stage, stage_source, updated_by from public.inbox_thread_state where id = $1`, [t.thread_id]))[0]
    assert.deepEqual([th.lifecycle_stage, th.seller_stage, th.stage_source, th.updated_by], ['offer_interest', 'offer_interest', 'ai', 'agt_sterling'])
    assert.equal((await sel(env.owner, `select acquisition_stage from public.acquisition_opportunities where id = $1`, [opp]))[0].acquisition_stage, 'offer_interest')
    const c = (await changes(env, t.thread_id)).find((x) => x.field === 'pipeline_stage' && x.new_value === 'offer_interest')
    assert.deepEqual([c.source, c.actor_kind, c.actor_id, c.via, c.intent_id, c.evidence.source, c.reason], ['agntei', 'agent', 'agt_sterling', 'agt_sterling', r.intent_id, 'seller_message', 'routine pipeline maintenance'])
    assert.equal(c.old_value, null); assert.equal(Number(c.version), v0 + 1)
    const oc = (await sel(env.owner, `select * from lc_sync.record_changes where entity = 'opportunity' and entity_id = $1 and field = 'deal_stage' order by created_at desc limit 1`, [opp]))[0]
    assert.deepEqual([oc.old_value, oc.new_value, oc.source, oc.intent_id], ['ownership_confirmation', 'offer_interest', 'agntei', r.intent_id])
    assert.equal(r.result.fields.pipeline_stage.version, v0 + 1, 'the answer carries the new versions')
    // the read returns the canonical value, its version and provenance
    const s = await call(gateway, creds.sterling, 'get_record_state', { thread_id: t.thread_id })
    const rec = s.record || s.result?.record || s.data?.record
    assert.deepEqual([rec.fields.pipeline_stage.value, rec.fields.pipeline_stage.version, rec.fields.pipeline_stage.source, rec.fields.pipeline_stage.actor_id], ['offer_interest', v0 + 1, 'agntei', 'agt_sterling'])
    // replay: the same client_request_id answers the recorded outcome, never a second change
    const args = { thread_id: t.thread_id, field: 'temperature', value: 'warm', expected_version: await versionOf(env, 'thread', t.thread_id, 'temperature'), evidence: SELLER_EVIDENCE(), reason: 'seller engaged', client_request_id: key('replay') }
    const a1 = await call(gateway, creds.sterling, 'apply_record_change', args)
    const a2 = await call(gateway, creds.sterling, 'apply_record_change', args)
    assert.equal(a1.status, 'succeeded'); assert.equal(a2.replayed, true)
    assert.equal((await changes(env, t.thread_id)).filter((x) => x.field === 'temperature' && x.new_value === 'warm').length, 1)
  } finally { await env.db.drop() }
})

test('PG record sync: optimistic concurrency per field — stale refused with the current value, racing writers: one wins, dimensions independent', { skip }, async () => {
  const { env, creds, gateway, t } = await world()
  try {
    const ok = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'temperature', value: 'warm', expected_version: 0, evidence: SELLER_EVIDENCE() })
    assert.equal(ok.status, 'succeeded')
    const stale = await apply(gateway, creds.scout, { thread_id: t.thread_id, field: 'temperature', value: 'cold', expected_version: 0, evidence: { source: 'research' } })
    assert.equal(stale.status, 'refused'); assert.equal(stale.code, 'VERSION_CONFLICT')
    assert.deepEqual([stale.result.current.version, stale.result.current.value, stale.result.current.actor_id], [1, 'warm', 'agt_sterling'])
    assert.equal((await sel(env.owner, `select lead_temperature from public.inbox_thread_state where id = $1`, [t.thread_id]))[0].lead_temperature, 'warm', 'the newer value stands')
    // another dimension at its own version is unaffected by the temperature's history
    const st = await apply(gateway, creds.scout, { thread_id: t.thread_id, field: 'status', value: 'waiting_on_seller', expected_version: 0, evidence: { source: 'leadcommand_record' } })
    assert.equal(st.status, 'succeeded', JSON.stringify(st))
    // two writers race on the same version of the same field: exactly one wins, the other is told what won
    const v = await versionOf(env, 'thread', t.thread_id, 'temperature')
    const [x, y] = await Promise.all([
      apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'temperature', value: 'hot', expected_version: v, evidence: SELLER_EVIDENCE() }),
      apply(gateway, creds.scout, { thread_id: t.thread_id, field: 'temperature', value: 'cold', expected_version: v, evidence: { source: 'research' } }),
    ])
    const outcomes = [x, y].map((o) => o.status === 'succeeded' ? 'won' : o.code)
    assert.equal(outcomes.filter((o) => o === 'won').length, 1, JSON.stringify([x, y]))
    assert.ok(outcomes.includes('VERSION_CONFLICT') || outcomes.includes('RESOURCE_BUSY') || outcomes.includes('IN_PROGRESS'), JSON.stringify(outcomes))
    assert.equal(await versionOf(env, 'thread', t.thread_id, 'temperature'), v + 1)
  } finally { await env.db.drop() }
})

test('PG record sync: a person\'s edit from agntei stands against stale automated writes; newer evidence moves it; an operator lock is final', { skip }, async () => {
  const { env, creds, gateway, t } = await world()
  try {
    const p = await personApply(gateway, creds.console, { thread_id: t.thread_id, field: 'temperature', value: 'hot', expected_version: 0, edited_by: 'person_ryan' })
    assert.equal(p.status, 'succeeded', JSON.stringify(p))
    const c = (await changes(env, t.thread_id)).find((x) => x.field === 'temperature')
    assert.deepEqual([c.source, c.actor_kind, c.actor_id, c.via], ['agntei', 'person', 'person_ryan', 'agt_agntei_console'])
    assert.equal((await sel(env.owner, `select temperature_source from public.inbox_thread_state where id = $1`, [t.thread_id]))[0].temperature_source, 'manual')
    // an automated write with older (or no newer) evidence is refused even at the right version
    const old = await apply(gateway, creds.scout, { thread_id: t.thread_id, field: 'temperature', value: 'cold', expected_version: 1, evidence: { source: 'research', at: new Date(Date.now() - 86_400_000).toISOString() } })
    assert.equal(old.code, 'PROTECTED_MANUAL')
    // the seller's newer message is evidence the person did not have: the agent may act on it
    const newer = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'temperature', value: 'warm', expected_version: 1, evidence: SELLER_EVIDENCE(new Date(Date.now() + 1000).toISOString()) })
    assert.equal(newer.status, 'succeeded', JSON.stringify(newer))
    // an operator's lock set in LeadCommand is final for automation, whatever the evidence
    await env.owner.query(`update public.inbox_thread_state set manual_temperature_lock = true where id = $1`, [t.thread_id])
    const locked = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'temperature', value: 'hot', expected_version: 2, evidence: SELLER_EVIDENCE(new Date(Date.now() + 5000).toISOString()) })
    assert.equal(locked.code, 'PROTECTED_MANUAL_LOCK')
    // a person may still edit it (from agntei), at the current version
    const again = await personApply(gateway, creds.console, { thread_id: t.thread_id, field: 'temperature', value: 'hot', expected_version: 2, edited_by: 'person_ryan' })
    assert.equal(again.status, 'succeeded')
    // the person capability is the console's alone: an agent's own credential cannot claim to be a person
    const imposter = await personApply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'temperature', value: 'cold', expected_version: 3, edited_by: 'person_ryan' })
    assert.notEqual(imposter.status, 'succeeded')
    assert.equal((await changes(env, t.thread_id)).filter((x) => x.actor_kind === 'person' && x.via !== 'agt_agntei_console').length, 0)
  } finally { await env.db.drop() }
})

test('PG record sync: stage rules — agents never regress a stage nor reach a contract stage without a signed production agreement; a person may', { skip }, async () => {
  const { env, creds, gateway, t } = await world()
  try {
    assert.equal((await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'pipeline_stage', value: 'asking_price', expected_version: 0, evidence: SELLER_EVIDENCE() })).status, 'succeeded')
    const back = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'pipeline_stage', value: 'ownership_confirmation', expected_version: 1, evidence: SELLER_EVIDENCE() })
    assert.equal(back.code, 'STAGE_REGRESSION_REQUIRES_PERSON')
    const noEvidence = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'pipeline_stage', value: 'formal_contract', expected_version: 1, evidence: SELLER_EVIDENCE() })
    assert.equal(noEvidence.code, 'CONTRACT_STAGE_REQUIRES_SIGNED_AGREEMENT')
    const simulated = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'pipeline_stage', value: 'formal_contract', expected_version: 1, evidence: { source: 'agreement', ref: 'agr_1', agreement_status: 'completed', environment: 'simulated' } })
    assert.equal(simulated.code, 'CONTRACT_STAGE_REQUIRES_SIGNED_AGREEMENT', 'a simulated signature never moves a deal')
    const signed = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'pipeline_stage', value: 'formal_contract', expected_version: 1, evidence: { source: 'agreement', ref: 'agr_1', agreement_status: 'completed', environment: 'production' } })
    assert.equal(signed.status, 'succeeded', JSON.stringify(signed))
    const personBack = await personApply(gateway, creds.console, { thread_id: t.thread_id, field: 'pipeline_stage', value: 'offer', expected_version: 2, edited_by: 'person_ryan', reason: 'contract cancelled; back to offer' })
    assert.equal(personBack.status, 'succeeded', JSON.stringify(personBack))
    // an agent needs named evidence for a pipeline field
    const bare = await call(gateway, creds.scout, 'apply_record_change', { client_request_id: key('bare'), thread_id: t.thread_id, field: 'disposition', value: 'interested', expected_version: 0, evidence: { source: 'person' }, reason: 'x x' })
    assert.equal(bare.status, 'succeeded', 'a named evidence class is enough for a disposition')
    // the seller-conversation stage is its own field: it never moves the pipeline stage
    const cs = await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'conversation_stage', value: 'interested', expected_version: 0, evidence: SELLER_EVIDENCE() })
    assert.equal(cs.status, 'succeeded')
    const th = (await sel(env.owner, `select conversation_stage, lifecycle_stage from public.inbox_thread_state where id = $1`, [t.thread_id]))[0]
    assert.deepEqual([th.conversation_stage, th.lifecycle_stage], ['interested', 'offer'])
  } finally { await env.db.drop() }
})

test('PG record sync: archival takes a sold lead out of active work (follow-ups closed), deletes nothing, and is restored from its own history', { skip }, async () => {
  const { env, creds, gateway, t } = await world()
  try {
    assert.equal((await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'disposition', value: 'interested', expected_version: 0, evidence: SELLER_EVIDENCE() })).status, 'succeeded')
    // an open follow-up on the lead
    await env.owner.query(`insert into public.followup_intents (intent_key, thread_key, property_id, kind, intent, use_case, due_at, state, writer) values ($1, $2, 'p150', 'no_reply', 'nudge', 'followup', now() + interval '2 days', 'planned', 'test')`, [`fi:${t.phone}`, t.phone])
    const opened = (await sel(env.owner, `select count(*)::int n from public.followup_intents where thread_key = $1 and state = 'planned'`, [t.phone]))[0].n
    assert.equal(opened, 1, 'an open follow-up exists before the archive')
    const arch = await apply(gateway, creds.scout, { thread_id: t.thread_id, field: 'archived', value: 'archived:sold', expected_version: 0, evidence: { source: 'research', verified: true, ref: 'county_deed_2026_1102', quote: 'Recorded deed transfer to a new owner.' }, reason: 'county record shows the property sold' })
    assert.equal(arch.status, 'succeeded', JSON.stringify(arch))
    const th = (await sel(env.owner, `select is_archived, archive_scope, archive_reason, disposition from public.inbox_thread_state where id = $1`, [t.thread_id]))[0]
    assert.deepEqual([th.is_archived, th.archive_scope, th.disposition], [true, 'lead', 'sold']); assert.match(th.archive_reason, /^sold/)
    const o = (await sel(env.owner, `select opportunity_status, archived_at from public.acquisition_opportunities where primary_thread_key = $1`, [t.phone]))[0]
    assert.equal(o.opportunity_status, 'lost'); assert.ok(o.archived_at)
    assert.equal((await sel(env.owner, `select count(*)::int n from public.followup_intents where thread_key = $1 and state = 'planned'`, [t.phone]))[0].n, 0, 'open follow-ups closed')
    assert.equal((await sel(env.owner, 'select count(*)::int n from public.inbox_thread_state where id = $1', [t.thread_id]))[0].n, 1, 'nothing deleted')
    assert.equal((await sel(env.owner, 'select count(*)::int n from public.message_events where thread_key = $1', [t.phone]))[0].n, 2, 'the conversation is kept')
    // one archive = one intent across its fields (archived, disposition, opportunity status), each versioned and published
    const fields = (await changes(env, t.thread_id)).filter((c) => c.intent_id === arch.intent_id).map((c) => c.field).sort()
    assert.deepEqual(fields, ['archived', 'disposition', 'opportunity_status'])
    await settle()
    // restored from its own history
    const back = await personApply(gateway, creds.console, { thread_id: t.thread_id, field: 'archived', value: 'active', expected_version: 1, edited_by: 'person_ryan', reason: 'the sale fell through' })
    assert.equal(back.status, 'succeeded', JSON.stringify(back))
    const th2 = (await sel(env.owner, `select is_archived, disposition from public.inbox_thread_state where id = $1`, [t.thread_id]))[0]
    assert.deepEqual([th2.is_archived, th2.disposition], [false, 'interested'])
    assert.equal((await sel(env.owner, `select opportunity_status from public.acquisition_opportunities where primary_thread_key = $1`, [t.phone]))[0].opportunity_status, 'active')
    const hist = await call(gateway, creds.sterling, 'get_record_history', { thread_id: t.thread_id })
    const rows = hist.rows || hist.result?.rows || hist.data?.rows
    assert.ok(rows.length >= 6 && rows.every((r) => r.version >= 1 && r.source && r.actor_kind), 'the full history, each change with its version and provenance')
  } finally { await env.db.drop() }
})

test('PG record sync: events carry codes only (clean payloads); the rollback refuses after use and restores the feed check when unused', { skip }, async () => {
  const { env, creds, gateway, t } = await world()
  try {
    await apply(gateway, creds.sterling, { thread_id: t.thread_id, field: 'follow_up_at', value: new Date(Date.now() + 3 * 86_400_000).toISOString(), expected_version: 0, evidence: { source: 'seller_message' } })
    const ev = await events(env, t.thread_id)
    assert.ok(ev.length >= 1)
    for (const e of ev) assert.ok(!/\+1312|message_body|Oak St/.test(JSON.stringify(e.payload)), 'never a phone, message text or an address')
    await assert.rejects(applyInTransaction(env.owner, RECORD_ROLLBACK), /record_changed events exist/)
  } finally { await env.db.drop() }
  const fresh = await recordSyncDb()
  try {
    await applyInTransaction(fresh.owner, RECORD_ROLLBACK)
    assert.equal((await sel(fresh.owner, `select to_regnamespace('lc_sync') r`))[0].r, null)
    const def = (await sel(fresh.owner, `select pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'action_gateway.lead_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%lead_transferred%'`))[0].d
    assert.ok(!/record_changed/.test(def), 'link 9\'s kind check restored')
  } finally { await fresh.db.drop() }
})
