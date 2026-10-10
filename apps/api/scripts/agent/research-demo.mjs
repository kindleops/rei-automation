#!/usr/bin/env node
// READ-ONLY research agent — post-deploy demo from a terminal, AS THE OWNER'S SESSION.
//
//   AGENT_DEMO_TOKEN_FILE=/path/to/owner-access-token  node apps/api/scripts/agent/research-demo.mjs [https://ops.leadcommand.ai]
//
// The token file holds the owner's CURRENT Supabase access token (copy it in the browser:
// DevTools console → JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>/^sb-.+-auth-token$/.test(k)))).access_token).
// It expires in ≤ 1 h. The token is read from the file and never printed. Only GET/POST to
// /api/cockpit/agent/live/ask*. Prints the answers, then a latency + cost table.
import fs from 'node:fs'

const base = (process.argv[2] || 'https://ops.leadcommand.ai').replace(/\/+$/, '')
const file = process.env.AGENT_DEMO_TOKEN_FILE
if (!file) { console.error('set AGENT_DEMO_TOKEN_FILE'); process.exit(2) }
const token = fs.readFileSync(file, 'utf8').trim()
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const CAMPAIGN = 'b8134925-833a-4598-975f-4d77aacd5b2b'
const url = `${base}/api/cockpit/agent/live/ask`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const flows = [
  { name: '(a) strongest HOT LEADS — evidence', question: 'Investigate the 5 strongest HOT LEADS properties (rank by the Decision Engine aos_score) and explain the evidence for each: scores, distress signals, equity, ownership shape, recorded documents, probate and preforeclosure status, and contact readiness (masked). Cite the tool and source for every claim.' },
  { name: '(b) tax / ownership / probate inconsistencies', question: 'For the 10 strongest HOT LEADS properties, identify tax-delinquency, ownership and probate inconsistencies between sources (campaign target graph, recorded parcel, probate_status, preforeclosure_status_v2, Entity Graph facts). Do not change anything. List each inconsistency with the sources that disagree.' },
]

const st = await fetch(url, { headers: H })
if (st.status !== 200) { console.error(`status HTTP ${st.status}`); process.exit(1) }
const s0 = await st.json()
console.log('models', { default: s0.models.default?.id, escalation: s0.models.escalation?.id, listed_by_api: s0.models.listed_ids })
console.log('caps', s0.caps, 'spend before', s0.spend)
const rows = []
for (const f of flows) {
  const t0 = Date.now()
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify({ question: f.question, context: { campaign_id: CAMPAIGN }, wait_ms: 25000 }) })
  let b = await r.json()
  if (!b.ok) { console.error(f.name, 'refused', r.status, b.error); rows.push({ flow: f.name, state: 'refused', error: b.error }); continue }
  while (b.state === 'running') { await sleep(3000); b = await (await fetch(`${url}/${b.run_id}`, { headers: H })).json() }
  console.log(`\n===== ${f.name} — ${b.state} (${b.outcome}) =====\n${b.answer?.answer_md || '(no answer)'}\n`)
  for (const c of b.calls || []) console.log(`  call ${c.model} [${c.route}] $${c.cost_usd} ${c.latency_ms} ms in=${c.input_tokens} out=${c.output_tokens} cache_read=${c.cache_read_input_tokens} cache_write=${c.cache_creation_input_tokens} stop=${c.stop}`)
  rows.push({ flow: f.name, run_id: b.run_id, state: b.state, outcome: b.outcome, server_latency_ms: b.latency_ms, wall_ms: Date.now() - t0, cost_usd: b.cost_usd, model_calls: b.counters?.model_calls, escalated_calls: b.counters?.escalated_calls, tool_calls: b.counters?.tool_calls })
}
const s1 = await (await fetch(url, { headers: H })).json()
console.log('\n===== (c) latency and cost per workflow =====')
console.table(rows)
console.log('spend after', s1.spend, 'runs today', s1.runs_today)
