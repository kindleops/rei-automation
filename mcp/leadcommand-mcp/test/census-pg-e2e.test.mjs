// END TO END for the 1.2 census reads over a REAL PostgREST + disposable PostgreSQL with the 1.0 reader, the 1.1
// conversation intelligence and PROPOSED_20261026150000_lc_mcp_corpus_census.sql applied, seeded with the synthetic
// corpus of migrations/test/lc_mcp_corpus_census_emulation.sql. Never production. Opt-in:
//   LC_PG_BIN=<dir with initdb, pg_ctl, postgres> LC_POSTGREST_BIN=<postgrest> [LC_PSQL=<psql>] npm test
// Proves the SQL ↔ adapter contract (the fixture mirror cannot drift unnoticed): the real projections pass the
// tools' output schemas through the real gateway AS lc_mcp_reader; the boot self-check judges the six applied
// functions; the counts are the seeded corpus's; keyset paging through real cursors covers every lead once; the
// screening job runs to completion on the real stack and resumes; the role still cannot read message_events.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLocalStack } from './support/local-stack.mjs'
import { liveEnv, tmpDir } from './support/live-env.mjs'
import { buildApp } from '../src/app.mjs'
import { runScreen } from '../scripts/corpus-screen.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const PG_BIN = process.env.LC_PG_BIN
const PGRST_BIN = process.env.LC_POSTGREST_BIN
const skip = !(PG_BIN && PGRST_BIN) && 'set LC_PG_BIN and LC_POSTGREST_BIN to run the real-PostgREST end-to-end'
const exp = (days) => Math.floor(Date.now() / 1000) + days * 86_400

test('real PostgREST: the 1.2 census reads and the screening job end to end on the applied migration', { skip, timeout: 240_000 }, async (t) => {
  const stack = await startLocalStack({
    pgBin: PG_BIN, postgrestBin: PGRST_BIN,
    extraSql: [
      path.join(REPO, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_conversation_intel_emulation.sql'), path.join(REPO, 'supabase/migrations/PROPOSED_20261026120000_lc_mcp_conversation_intel.sql'),
      path.join(REPO, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_corpus_census_emulation.sql'), path.join(REPO, 'supabase/migrations/PROPOSED_20261026150000_lc_mcp_corpus_census.sql'),
    ],
  })
  const reader = stack.mint({ role: 'lc_mcp_reader', iss: 'supabase', iat: exp(0), exp: exp(7) })
  const anon = stack.mint({ role: 'anon', iss: 'supabase', iat: exp(0), exp: exp(365) })
  const audit = []
  const env = liveEnv({ dir: tmpDir(), reader, apiKey: anon, over: { LEADCOMMAND_MCP_SUPABASE_URL: stack.url, LEADCOMMAND_MCP_SCOPES: 'leadcommand.pipeline.read leadcommand.leads.read' } })
  const app = await buildApp({ env, scrub: false, auditSink: (r) => audit.push(r) })
  const call = async (name, args) => {
    const r = await app.gateway.call(name, args)
    assert.ok(r.ok, `${name}: ${JSON.stringify(r.structured?.error)}`)
    assert.equal(r.structured.data_mode, 'live')
    return r.structured
  }
  try {
    await t.test('the boot self-check passes WITH the six optional functions applied (judged, none absent)', () => {
      const check = audit.find((a) => a.event === 'credential_self_check')
      assert.equal(check.outcome, 'ok', JSON.stringify(check.findings))
    })

    await t.test('census: the seeded corpus, exactly, through the real gateway and output schema', async () => {
      const r = (await call('leadcommand_get_corpus_census', {})).result
      assert.equal(r.sources.eg_property_facts, 6); assert.equal(r.sources.properties, 5)
      assert.deepEqual(r.sources.campaign_target_graph, { rows: 5, properties: 4, phones: 4, sms_eligible_rows: 4 })
      assert.equal(r.sources.message_events.rows, 11); assert.equal(r.sources.message_events.inbound_unknown_sender, 1)
      assert.deepEqual(r.sources.acquisition_opportunities, { rows: 2, open: 1, stale_open_60d: 0 })
      assert.equal(r.coverage.leads, 6); assert.equal(r.coverage.with_sms_eligible_phone, 4); assert.equal(r.coverage.with_thread, 5); assert.equal(r.coverage.with_decision_engine, 1)
      assert.equal(r.evidence.probate, 1); assert.equal(r.evidence.preforeclosure, 1); assert.equal(r.evidence.signals_never_contacted, 2)
      assert.deepEqual(r.duplicates.properties_sharing_address, { groups: 1, properties: 2 }); assert.deepEqual(r.duplicates.owners_with_several_properties, { owners: 1, properties: 2 })
      assert.equal(r.duplicates.phones_on_several_properties, 1); assert.equal(r.duplicates.facts_without_property_row, 2)
      assert.equal(r.contact.threads_unanswered_inbound, 3); assert.equal(r.contact.threads_unanswered_over_7d, 1)
      assert.equal(r.pipeline_health.needs_review_unresolved_14d, 1); assert.equal(r.pipeline_health.contactable_phone_never_contacted, 1)
      assert.deepEqual(r.decision_engine, { leads_in_conversation: 4, without_decision_engine: 3, decision_engine_older_than_30d: 0 })
      assert.ok(r.columns_present.includes('tax_delinquent'))
      const m = (await call('leadcommand_get_corpus_census', { market: 'Fixture Metro, TX' })).result
      assert.equal(m.coverage.leads, 5)
      assert.doesNotMatch(JSON.stringify(r), /\+1555|Fixture St|Fixture Owner|Fixture Person/)
    })

    await t.test('lead screen: real keyset cursors cover P1..P6 once; rows as seeded; bounds refused through the real function', async () => {
      const ids = []
      let cursor = null, pages = 0, rows = []
      do {
        const r = await call('leadcommand_search_lead_screen', { limit: 4, ...(cursor ? { cursor } : {}) })
        ids.push(...r.result.rows.map((x) => x.property_id)); rows.push(...r.result.rows)
        cursor = r.page.next_cursor; pages += 1
      } while (cursor && pages < 5)
      assert.deepEqual(ids, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']); assert.equal(pages, 2)
      const p1 = rows.find((x) => x.property_id === 'P1'), p2 = rows.find((x) => x.property_id === 'P2'), p5 = rows.find((x) => x.property_id === 'P5')
      assert.equal(p1.threads.unanswered, true); assert.equal(p1.decision_engine.present, true); assert.equal(p1.distress.tax_delinquent, true); assert.equal(p1.pipeline.deal_linked, true); assert.equal(p1.outreach.campaign_targets, 1)
      assert.equal(p2.threads.opted_out, true); assert.equal(p2.contact.phones_on_graph, 2)
      assert.equal(p5.last_contact.at, null); assert.equal(p5.distress.preforeclosure, true); assert.equal(p5.contact.sms_eligible_phones, 1)
      const bad = await app.gateway.call('leadcommand_search_lead_screen', { limit: 4, state: 'tx', market: 'x'.repeat(61) })
      assert.equal(bad.ok, false)
      assert.doesNotMatch(JSON.stringify(rows), /\+1555|Fixture St|thread_key/)
    })

    await t.test('the screening job runs on the real stack, resumes, and shortlists P1 and P5 but never P2', async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-screen-pg-'))
      const first = await runScreen({ outDir, env, page: 2, maxPages: 1 })
      assert.equal(first.finished, false); assert.equal(first.leads, 2)
      const done = await runScreen({ outDir, env, page: 2 })
      assert.equal(done.finished, true); assert.equal(done.leads, 6); assert.equal(done.excluded, 1)
      const shortlist = JSON.parse(fs.readFileSync(path.join(outDir, 'shortlist.json'), 'utf8')).map((s) => s.property_id)
      assert.ok(shortlist.includes('P1') && shortlist.includes('P5') && !shortlist.includes('P2'), JSON.stringify(shortlist))
      assert.equal(new Set(fs.readFileSync(path.join(outDir, 'leads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).property_id)).size, 6)
    })

    await t.test('the role still cannot read message_events directly (42501)', async () => {
      const r = await fetch(`${stack.url}/rest/v1/message_events?select=count`, { headers: { apikey: anon, authorization: `Bearer ${reader}` } })
      assert.ok([401, 403].includes(r.status), String(r.status))
    })
  } finally {
    await app.close()
    await stack.stop()
  }
})
