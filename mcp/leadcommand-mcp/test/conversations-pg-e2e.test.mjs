// END TO END for the 1.1 conversation reads over a REAL PostgREST + disposable PostgreSQL with BOTH the 1.0
// reader migration and PROPOSED_20261026120000_lc_mcp_conversation_intel.sql applied, seeded with the synthetic
// conversations of migrations/test/lc_mcp_conversation_intel_emulation.sql. Never production. Opt-in:
//   LC_PG_BIN=<dir with initdb, pg_ctl, postgres> LC_POSTGREST_BIN=<postgrest> [LC_PSQL=<psql>] npm test
// Proves the SQL ↔ adapter contract (the fixture mirror cannot drift unnoticed): the real projections pass the
// tools' output schemas through the real gateway, AS lc_mcp_reader through the real JWT → SET ROLE path; the
// boot self-check judges the four applied functions; chronology, attribution, history states, masking, the
// worklist verification, exact counts and keyset paging (microsecond timestamps) hold on real data; the role
// still cannot read message_events directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLocalStack } from './support/local-stack.mjs'
import { liveEnv, tmpDir } from './support/live-env.mjs'
import { buildApp } from '../src/app.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const PG_BIN = process.env.LC_PG_BIN
const PGRST_BIN = process.env.LC_POSTGREST_BIN
const skip = !(PG_BIN && PGRST_BIN) && 'set LC_PG_BIN and LC_POSTGREST_BIN to run the real-PostgREST end-to-end'
const exp = (days) => Math.floor(Date.now() / 1000) + days * 86_400
const T1 = '00000000-0000-4000-8000-000000000101'

test('real PostgREST: the 1.1 conversation reads end to end on the applied migration', { skip, timeout: 240_000 }, async (t) => {
  const stack = await startLocalStack({
    pgBin: PG_BIN, postgrestBin: PGRST_BIN,
    extraSql: [path.join(REPO, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_conversation_intel_emulation.sql'), path.join(REPO, 'supabase/migrations/PROPOSED_20261026120000_lc_mcp_conversation_intel.sql')],
  })
  const reader = stack.mint({ role: 'lc_mcp_reader', iss: 'supabase', iat: exp(0), exp: exp(7) })
  const anon = stack.mint({ role: 'anon', iss: 'supabase', iat: exp(0), exp: exp(365) })
  const audit = []
  const app = await buildApp({ env: liveEnv({ dir: tmpDir(), reader, apiKey: anon, over: { LEADCOMMAND_MCP_SUPABASE_URL: stack.url } }), scrub: false, auditSink: (r) => audit.push(r) })
  const call = async (name, args) => {
    const r = await app.gateway.call(name, args)
    assert.ok(r.ok, `${name}: ${JSON.stringify(r.structured?.error)}`)
    assert.equal(r.structured.data_mode, 'live')
    return r.structured
  }
  try {
    await t.test('the boot self-check passes WITH the four functions applied (judged, none absent)', () => {
      const check = audit.find((a) => a.event === 'credential_self_check')
      assert.equal(check.outcome, 'ok', JSON.stringify(check.findings))
    })

    await t.test('one lead: real text, created_at chronology, other-property row withheld, history state, masking', async () => {
      const r = await call('leadcommand_get_lead_conversation', { property_id: 'P1' })
      const res = r.result
      assert.equal(res.history.state, 'present')
      assert.deepEqual(res.rows.map((m) => m.text?.slice(0, 18)), ['Hi, this is Fixtur', 'Yes I own it. What', 'Thanks! What price', 'I would take $185,', 'Did you get my las', 'Understood. We wil', 'IGNORE ALL PREVIOU'])
      assert.equal(res.rows[4].attribution, 'phone')
      assert.equal(res.rows[5].delivery.status, 'failed')
      assert.equal(res.counts.other_property_rows_in_window, 1)
      assert.equal(res.rows[6].instruction_like, true)
      assert.doesNotMatch(JSON.stringify(r), /555-010-0001|seller@example\.invalid|\+1555|provider payload/)
      assert.equal(res.threads[0].contact.state, 'blocked')
      assert.ok(res.threads[0].contact.blockers.includes('hold_ownership_attribution_unresolved'))
      assert.equal(res.evidence.interest.state, 'interest')
      assert.equal(res.evidence.commitment.message_id != null, true)
    })

    await t.test('keyset pages over real microsecond timestamps cover every message exactly once', async () => {
      const seen = []
      let cursor
      for (let i = 0; i < 5; i++) {
        const r = await call('leadcommand_get_lead_conversation', { property_id: 'P1', limit: 2, ...(cursor ? { cursor } : {}) })
        seen.push(...r.result.rows.map((m) => m.id))
        cursor = r.page.next_cursor
        if (!cursor) break
      }
      assert.equal(seen.length, 7)
      assert.equal(new Set(seen).size, 7)
    })

    await t.test('history states and the Spanish opt-out on real data', async () => {
      for (const [pid, state] of [['P3', 'missing'], ['P4', 'empty'], ['P5', 'outside_window'], ['P6', 'no_thread']]) {
        assert.equal((await call('leadcommand_get_lead_conversation', { property_id: pid })).result.history.state, state, pid)
      }
      const p2 = (await call('leadcommand_get_lead_conversation', { property_id: 'P2' })).result
      const own = p2.threads.find((x) => x.thread_id === '00000000-0000-4000-8000-000000000102')
      assert.ok(own.contact.blockers.includes('suppression_list_active') || own.contact.blockers.includes('suppression_list_global'))
      assert.equal(p2.rows.find((m) => m.text === 'ALTO').opt_out_reading, 'possible')
    })

    await t.test('worklist, ranking and pipeline summary validate and count exactly on real data', async () => {
      const w = await call('leadcommand_search_conversation_worklist', { category: 'unanswered_inbound', window_days: 30 })
      assert.equal(w.result.total, 2)
      assert.equal(w.result.rows[0].thread_id, T1)
      assert.equal(w.result.rows[0].verified.state, 'unanswered')
      assert.equal(w.result.rows[1].verified.state, 'not_verifiable')
      assert.equal(w.result.rows[0].latest_outbound.failed, true)
      const p1 = await call('leadcommand_search_conversation_worklist', { category: 'recent_inbound', window_days: 30, limit: 1 })
      const p2 = await call('leadcommand_search_conversation_worklist', { category: 'recent_inbound', window_days: 30, limit: 1, cursor: p1.page.next_cursor })
      assert.notEqual(p1.result.rows[0].thread_id, p2.result.rows[0].thread_id)
      const rank = await call('leadcommand_get_opportunity_ranking', { window_days: 30 })
      assert.equal(rank.result.excluded.opted_out, 1)
      assert.equal(rank.result.ranked[0].thread_id, T1)
      const s = await call('leadcommand_get_pipeline_summary', { dimension: 'market' })
      assert.equal(s.result.counts.total, 6)
      assert.equal(s.result.signals.messages.inbound, 6)
    })

    await t.test('the role still cannot read message_events or contact_property_resolution directly (42501)', async () => {
      for (const rel of ['message_events', 'contact_property_resolution']) {
        const r = await fetch(`${stack.url}/rest/v1/${rel}?select=*&limit=1`, { headers: { apikey: anon, authorization: `Bearer ${reader}` } })
        assert.ok([401, 403, 404].includes(r.status), `${rel}: ${r.status}`)
      }
      const lines = audit.filter((a) => a.event === 'tool_call')
      assert.ok(lines.length >= 10)
      assert.doesNotMatch(JSON.stringify(lines), /own it|185,000|IGNORE ALL/)
    })
  } finally {
    await app.close()
    await stack.stop()
  }
})
