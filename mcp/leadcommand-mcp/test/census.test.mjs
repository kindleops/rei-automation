// The 1.2 corpus census + lead screen over FIXTURE data, and the restartable screening job: scopes are opt-in,
// counts are exact, keyset pages cover every lead once, nothing identifying leaves the server, the job resumes
// after an interruption without screening a lead twice, and a seller who stopped us is never a candidate.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect, call, fixtureEnv } from './helpers.mjs'
import { DEFAULT_SCOPES, OPT_IN_SCOPES } from '../src/authz/scopes.mjs'
import { FIXTURE_PHONES, FIXTURE_SECRET_NAMES } from '../fixtures/dataset.mjs'
import { runScreen, screenLead, FACTORS, CANDIDATE_MIN_SCORE } from '../scripts/corpus-screen.mjs'

const result = (r) => r.structuredContent.result
const digits = (s) => s.replace(/[^0-9]/g, '')
const TOOLS = ['leadcommand_get_corpus_census', 'leadcommand_search_lead_screen']

test('scopes: the census reads sit behind the opt-in pipeline scope; a host without it is refused and audited', async () => {
  assert.ok(OPT_IN_SCOPES.includes('leadcommand.pipeline.read') && !DEFAULT_SCOPES.includes('leadcommand.pipeline.read'))
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: DEFAULT_SCOPES.join(' ') }) })
  try {
    for (const name of TOOLS) {
      const r = await call(c.client, name, {})
      assert.equal(r.isError, true, name)
      assert.equal(r.structuredContent.error.class, 'forbidden', name)
    }
    assert.ok(c.audit.filter((a) => TOOLS.includes(a.tool)).every((a) => a.outcome === 'refused'))
  } finally { await c.close() }
})

test('census: exact populations, coverage over the lead corpus, evidence, duplicates, contact, health — and absent columns named', async () => {
  const c = await connect()
  try {
    const r = result(await call(c.client, 'leadcommand_get_corpus_census', {}))
    assert.equal(r.lead_key, 'eg_property_facts.property_id')
    assert.equal(r.sources.eg_property_facts, 31)
    assert.equal(r.sources.properties, 31)
    assert.deepEqual(r.sources.campaign_target_graph, { rows: 3, properties: 2, phones: 3, sms_eligible_rows: 1 })
    assert.deepEqual(r.sources.campaign_targets, { rows: 10, properties: 3 })
    assert.equal(r.sources.inbox_thread_state.threads, 4)
    assert.equal(r.sources.message_events.inbound, 7)
    assert.equal(r.sources.message_events.inbound_unknown_sender, 1)
    assert.equal(r.sources.acquisition_opportunities, null, 'a source the database lacks is null, never 0')
    assert.deepEqual(r.sources.property_acquisition_scores, { rows: 2, fresh_30d: 1 })
    assert.deepEqual(r.sources.sms_suppression_list, { rows: 2, active: 1 })
    const cv = r.coverage
    assert.equal(cv.leads, 31); assert.equal(cv.with_property_row, 31); assert.equal(cv.with_phone_on_graph, 2); assert.equal(cv.with_sms_eligible_phone, 1)
    assert.equal(cv.in_campaign_targets, 3); assert.equal(cv.with_thread, 4); assert.equal(cv.with_inbound, 4)
    assert.equal(cv.with_decision_engine, 2); assert.equal(cv.with_fresh_decision_engine, 1); assert.equal(cv.conversation_stage_set, 16); assert.equal(cv.deal_linked, 1)
    assert.equal(cv.last_contact_set, 31); assert.equal(cv.contacted_90d, 31)
    assert.equal(r.evidence.distress_signals, 21); assert.equal(r.evidence.distress_signals_2plus, 11); assert.equal(r.evidence.equity_30pct_plus, 31)
    assert.equal(r.evidence.tax_delinquent, 0, 'absent column: 0 by absence')
    assert.ok(r.columns_absent.includes('tax_delinquent') && r.columns_absent.includes('owner_property_count'))
    assert.ok(r.columns_present.includes('distress_signal_count') && r.columns_present.includes('last_contact_at'))
    assert.deepEqual(r.duplicates, { phones_on_several_properties: 0, properties_sharing_address: { groups: 0, properties: 0 }, owners_with_several_properties: { owners: 0, properties: 0 }, properties_with_several_threads: 0, facts_without_property_row: 0, properties_without_facts_row: 0 })
    assert.equal(r.contact.threads_opted_out, 1); assert.equal(r.contact.threads_suppressed, 1); assert.equal(r.contact.threads_unanswered_inbound, 3); assert.equal(r.contact.threads_unanswered_over_7d, 0)
    assert.deepEqual(r.decision_engine, { leads_in_conversation: 4, without_decision_engine: 2, decision_engine_older_than_30d: 1 })
    assert.equal(r.pipeline_health.pipeline_without_conversation_stage, 0)
    assert.match(r.notes.join(' '), /exact server-side count/)
    const m = result(await call(c.client, 'leadcommand_get_corpus_census', { market: 'Fixture Metro, TX' }))
    assert.equal(m.coverage.leads, 31)
    assert.equal((await call(c.client, 'leadcommand_get_corpus_census', { market: 'x'.repeat(61) })).isError, true)
    assert.doesNotMatch(JSON.stringify(r), /\+1555|Fixture Way|Ownerperson/)
  } finally { await c.close() }
})

test('lead screen: keyset pages cover every lead exactly once in order; rows carry labels, flags, counts and engine presence; nothing identifying', async () => {
  const c = await connect()
  try {
    const ids = []
    let cursor = null, pages = 0, first = null
    do {
      const r = await call(c.client, 'leadcommand_search_lead_screen', { limit: 10, ...(cursor ? { cursor } : {}) })
      assert.notEqual(r.isError, true, JSON.stringify(r.structuredContent?.error))
      const page = r.structuredContent.page
      first ||= result(r)
      ids.push(...result(r).rows.map((x) => x.property_id))
      cursor = page.next_cursor
      pages += 1
      assert.equal(page.has_more, Boolean(cursor))
    } while (cursor && pages < 10)
    assert.equal(pages, 4)
    assert.equal(ids.length, 31)
    assert.deepEqual(ids, [...ids].sort())
    assert.equal(new Set(ids).size, 31)
    const fx1001 = first.rows.find((x) => x.property_id === 'FX1001'), fx1003 = first.rows.find((x) => x.property_id === 'FX1003')
    assert.equal(fx1001.threads.unanswered, true); assert.equal(fx1001.decision_engine.present, true); assert.equal(fx1001.decision_engine.tier, 'A')
    assert.deepEqual(fx1001.contact, { phones_on_graph: 2, sms_eligible_phones: 1, candidate_phones: null, sms_status: 'eligible' })
    assert.equal(fx1001.outreach.campaign_targets, 2); assert.equal(fx1001.pipeline.deal_linked, true); assert.equal(fx1001.distress.signal_count, 3)
    assert.equal(fx1003.threads.opted_out, true); assert.equal(fx1003.threads.suppressed, true); assert.equal(fx1003.threads.contactability, 'opted_out')
    assert.equal(first.labels_are.includes('not evidence of seller intent'), true)
    const all = JSON.stringify(first)
    for (const p of FIXTURE_PHONES) assert.equal(digits(all).includes(digits(p).slice(1)), false)
    for (const nm of FIXTURE_SECRET_NAMES) assert.equal(all.includes(nm), false)
    assert.doesNotMatch(all, /Fixture Way|thread_key|canonical_e164/)
    assert.equal((await call(c.client, 'leadcommand_search_lead_screen', { limit: 501 })).isError, true)
    assert.equal((await call(c.client, 'leadcommand_search_lead_screen', { state: 'TEX' })).isError, true)
    const st = result(await call(c.client, 'leadcommand_search_lead_screen', { state: 'tx', market: 'Fixture Metro, TX', limit: 500 }))
    assert.equal(st.rows.length, 31)
    // the plain keyset key resumes a batch across processes (a signed cursor is bound to the server that minted it)
    const after = result(await call(c.client, 'leadcommand_search_lead_screen', { after_property_id: 'FX2025', limit: 10 }))
    assert.deepEqual(after.rows.map((x) => x.property_id), ['FX2026', 'FX2027', 'FX9001'])
    assert.equal((await call(c.client, 'leadcommand_search_lead_screen', { after_property_id: 'FX2025', cursor: 'x'.repeat(20) })).isError, true)
  } finally { await c.close() }
})

test('screen rule: every point is a cited factor; a seller who stopped us is excluded before scoring; no channel counts against', () => {
  const base = { property_id: 'X', threads: { n: 0 }, contact: { phones_on_graph: 0, sms_eligible_phones: 0, candidate_phones: 0 }, distress: {}, equity: {}, owner: {}, decision_engine: {}, conversation: {}, pipeline: {}, last_contact: {} }
  const nothing = screenLead(base)
  assert.equal(nothing.candidate, false)
  assert.deepEqual(nothing.factors.map((f) => f.factor), ['no_channel'])
  const hot = screenLead({ ...base, threads: { n: 1, unanswered: true, last_inbound_at: '2026-10-13T00:00:00Z', last_outbound_at: '2026-10-12T00:00:00Z' }, contact: { phones_on_graph: 1, sms_eligible_phones: 1 }, distress: { signal_count: 3, tax_delinquent: true }, equity: { known_pct: 66 }, decision_engine: { present: true, tier: 'A', computed_at: '2026-10-10T00:00:00Z' } }, Date.parse('2026-10-14T00:00:00Z'))
  assert.equal(hot.candidate, true)
  assert.equal(hot.score, FACTORS.unanswered_seller_message + FACTORS.decision_engine_tier_a + FACTORS.distress_2plus + FACTORS.tax_delinquent + FACTORS.equity_30pct_plus + FACTORS.sms_eligible_phone)
  assert.ok(hot.score >= CANDIDATE_MIN_SCORE)
  assert.ok(hot.factors.every((f) => typeof f.evidence === 'string' && f.evidence.length > 5))
  assert.ok(hot.categories.includes('unanswered_inbound'))
  const stopped = screenLead({ ...hot, threads: { ...hot.threads, opted_out: true } })
  assert.deepEqual([stopped.candidate, stopped.excluded, stopped.score], [false, 'opted_out', 0])
  assert.equal(screenLead({ ...base, threads: { n: 1, wrong_number: true } }).excluded, 'wrong_number')
  assert.equal(screenLead({ ...base, contact: { ...base.contact, sms_status: 'opted_out' } }).excluded, 'sms_status_opted_out')
  const stalled = screenLead({ ...base, pipeline: { deal_linked: true }, last_contact: { at: '2026-01-01T00:00:00Z' }, contact: { phones_on_graph: 1, sms_eligible_phones: 0 } }, Date.parse('2026-10-14T00:00:00Z'))
  assert.ok(stalled.categories.includes('stalled_opportunity') && stalled.categories.includes('no_sms_channel_other_possible'))
  const review = screenLead({ ...base, conversation: { status: 'needs_review' }, last_contact: { at: '2026-09-01T00:00:00Z' } }, Date.parse('2026-10-14T00:00:00Z'))
  assert.ok(review.categories.includes('needs_review_unresolved'))
})

test('the screening job: durable state, an interrupted run resumes without screening a lead twice, the shortlist never holds a stopped seller, outputs are private and cite tool calls', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-screen-'))
  const logs = []
  const first = await runScreen({ outDir, fixture: true, page: 10, maxPages: 1, log: (m) => logs.push(m) })
  assert.equal(first.finished, false); assert.equal(first.pages, 1); assert.equal(first.leads, 10); assert.equal(first.last_property_id, 'FX2007')
  assert.ok(fs.existsSync(path.join(outDir, 'census.json')) && fs.existsSync(path.join(outDir, 'leads.jsonl')) && fs.existsSync(path.join(outDir, 'audit.jsonl')))
  assert.equal(fs.existsSync(path.join(outDir, 'report.md')), false)
  // simulate a crash after the rows were flushed but before the cursor advanced: the state file still points at the page just read
  const st = JSON.parse(fs.readFileSync(path.join(outDir, 'state.json'), 'utf8'))
  fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify({ ...st, last_property_id: null, pages: 0, leads: 0, candidates: 0, excluded: 0 }))
  const second = await runScreen({ outDir, fixture: true, page: 10, log: (m) => logs.push(m) })
  assert.equal(second.finished, true); assert.equal(second.runs, 2)
  const lines = fs.readFileSync(path.join(outDir, 'leads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 31, 'every lead once, although the first page was read twice')
  assert.equal(new Set(lines.map((l) => l.property_id)).size, 31)
  assert.ok(lines.every((l) => /^lcmcp_|^[a-z0-9-]{8,}$/i.test(String(l.correlation_id))))
  const shortlist = JSON.parse(fs.readFileSync(path.join(outDir, 'shortlist.json'), 'utf8'))
  assert.equal(shortlist[0].property_id, 'FX1001', JSON.stringify(shortlist.slice(0, 3)))
  assert.ok(!shortlist.some((s) => s.property_id === 'FX1003'), 'the opted-out seller is never shortlisted')
  const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
  assert.equal(summary.totals.leads, 31); assert.equal(summary.excluded.opted_out, 1)
  assert.ok(summary.categories.unanswered_inbound >= 2)
  const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8')
  for (const h of ['## Corpus (exact counts)', '## Screen', '## Shortlist', '## Rule']) assert.ok(md.includes(h), h)
  assert.match(md, /no message was sent, queued or approved/)
  const all = md + fs.readFileSync(path.join(outDir, 'leads.jsonl'), 'utf8') + fs.readFileSync(path.join(outDir, 'census.json'), 'utf8')
  for (const p of FIXTURE_PHONES) assert.equal(digits(all).includes(digits(p).slice(1)), false)
  for (const nm of FIXTURE_SECRET_NAMES) assert.equal(all.includes(nm), false)
  const audit = fs.readFileSync(path.join(outDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(audit.some((a) => a.tool === 'leadcommand_get_corpus_census') && audit.filter((a) => a.tool === 'leadcommand_search_lead_screen').length >= 4)
  assert.equal((fs.statSync(path.join(outDir, 'leads.jsonl')).mode & 0o077), 0, 'private files')
  // a different rule / filter set refuses to continue in the same directory
  await assert.rejects(runScreen({ outDir, fixture: true, market: 'Elsewhere, TX' }), /belongs to another run/)
})

test('a database without the 1.2 functions: the census tools answer SOURCE_NOT_APPLIED and every 1.0 tool still works', async () => {
  const c = await connect({ faults: { failRpcs: ['lc_mcp_corpus_census', 'lc_mcp_lead_screen'], rpcErrorCode: 'PGRST202' } })
  try {
    for (const name of TOOLS) {
      const r = await call(c.client, name, {})
      assert.equal(r.isError, true)
      assert.equal(r.structuredContent.error.code, 'SOURCE_NOT_APPLIED', name)
    }
    assert.notEqual((await call(c.client, 'leadcommand_get_lead', { property_id: 'FX1001' })).isError, true)
  } finally { await c.close() }
})
