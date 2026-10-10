// READ-ONLY research agent — post-deploy demo, run AS THE OWNER from the browser.
//
// 1. Open https://ops.leadcommand.ai and sign in as the owner (the only allowlisted account).
// 2. Open DevTools (⌥⌘I on macOS) → Console.
// 3. If Chrome asks, type `allow pasting` and press Enter.
// 4. Paste this whole file and press Enter. Leave the tab open until it prints "DEMO DONE" (≈ 1–3 min).
//
// It calls ONLY these read-only agent routes through the normal Worker path:
//   GET  /api/cockpit/agent/live/ask              (status: models, caps, spend)
//   POST /api/cockpit/agent/live/ask              (one question → a read-only run)
//   GET  /api/cockpit/agent/live/ask/<run_id>     (poll the run)
// Your session token is read from this browser's own storage and sent only to this origin; it is never printed.
// Nothing here can send, change a campaign, make an offer or write a record — the server has no such tool.
(async () => {
  const CAMPAIGN = 'b8134925-833a-4598-975f-4d77aacd5b2b' // HOT LEADS
  const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k))
  if (!key) return console.error('Not signed in: no Supabase session in this browser.')
  const token = JSON.parse(localStorage.getItem(key) || '{}').access_token
  if (!token) return console.error('Session has no access token: sign in again.')
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const base = '/api/cockpit/agent/live/ask'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const st0 = await fetch(base, { headers: H })
  if (st0.status !== 200) return console.error(`Agent status HTTP ${st0.status}`, await st0.text().catch(() => ''))
  const s0 = await st0.json()
  console.log('MODELS', { default: s0.models.default?.id, escalation: s0.models.escalation?.id, listed_by_api: s0.models.listed_ids })
  console.log('CAPS', s0.caps, 'SPEND BEFORE', s0.spend)
  const flows = [
    { name: '(a) strongest HOT LEADS — evidence', question: 'Investigate the 5 strongest HOT LEADS properties (rank by the Decision Engine aos_score) and explain the evidence for each: scores, distress signals, equity, ownership shape, recorded documents, probate and preforeclosure status, and contact readiness (masked). Cite the tool and source for every claim.' },
    { name: '(b) tax / ownership / probate inconsistencies', question: 'For the 10 strongest HOT LEADS properties, identify tax-delinquency, ownership and probate inconsistencies between sources (campaign target graph, recorded parcel, probate_status, preforeclosure_status_v2, Entity Graph facts). Do not change anything. List each inconsistency with the sources that disagree.' },
  ]
  const results = []
  for (const f of flows) {
    const t0 = performance.now()
    let res = await fetch(base, { method: 'POST', headers: H, body: JSON.stringify({ question: f.question, context: { campaign_id: CAMPAIGN }, wait_ms: 25000 }) })
    let b = await res.json()
    if (!b.ok) { console.error(f.name, 'refused', res.status, b.error, b.message); results.push({ flow: f.name, state: 'refused', error: b.error }); continue }
    while (b.state === 'running') { await sleep(3000); b = await (await fetch(`${base}/${b.run_id}`, { headers: H })).json() }
    const wall = Math.round(performance.now() - t0)
    console.log(`\n===== ${f.name} — ${b.state} (${b.outcome}) =====\n`)
    console.log(b.answer?.answer_md || '(no answer)')
    console.table((b.calls || []).map((c) => ({ model: c.model, route: c.route, cost_usd: c.cost_usd, latency_ms: c.latency_ms, input: c.input_tokens, output: c.output_tokens, cache_read: c.cache_read_input_tokens, cache_write: c.cache_creation_input_tokens, stop: c.stop })))
    results.push({ flow: f.name, run_id: b.run_id, state: b.state, outcome: b.outcome, server_latency_ms: b.latency_ms, wall_ms: wall, cost_usd: b.cost_usd, model_calls: b.counters?.model_calls, escalated_calls: b.counters?.escalated_calls, tool_calls: b.counters?.tool_calls })
  }
  const s1 = await (await fetch(base, { headers: H })).json()
  console.log('\n===== (c) latency and cost per workflow =====')
  console.table(results)
  console.log('SPEND AFTER', s1.spend, 'runs today', s1.runs_today, '/', s1.daily_run_cap)
  console.log('DEMO DONE')
})()
