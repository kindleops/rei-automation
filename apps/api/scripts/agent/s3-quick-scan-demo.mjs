#!/usr/bin/env node
// Agent S3 local demo driver: talks to a LOCAL API (next dev with
// AGENT_LIVE_ROUTES=1 AGENT_MAX_MODE=read) over the real cockpit routes.
// Prints NO phone numbers, names or addresses — only ids, counts, classes.
//
//   node scripts/agent/s3-quick-scan-demo.mjs start <property_id…>   preflight + confirm, wait, summarize
//   node scripts/agent/s3-quick-scan-demo.mjs dump <run_id> <file>   all events (cursor-paged) + snapshot → file, print digest
//   node scripts/agent/s3-quick-scan-demo.mjs digest <run_id>        digest only
//
// Env: AGENT_DEMO_BASE (default http://localhost:3010), secret read from .env.local.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

const BASE = process.env.AGENT_DEMO_BASE || 'http://localhost:3010'
const envFile = path.resolve(process.cwd(), '.env.local')
const secret = (fs.readFileSync(envFile, 'utf8').match(/^OPS_DASHBOARD_SECRET=(.*)$/m)?.[1] || '').trim().replace(/^['"]|['"]$/g, '')
const headers = { 'content-type': 'application/json', 'x-ops-dashboard-secret': secret, 'x-ops-user-id': 'local-demo-operator' }

async function call(p, opts = {}) {
  const res = await fetch(`${BASE}/api/cockpit/agent/live${p}`, { headers, ...opts })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

async function allEvents(run_id) {
  const out = []
  let cursor = 0
  for (;;) {
    const { body } = await call(`/runs/${run_id}/events?after=${cursor}&limit=200`)
    out.push(...body.events)
    if (!body.events.length) return { events: out, done: body.done }
    cursor = body.cursor
  }
}

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

function digest(events, snap) {
  const types = {}
  for (const e of events) types[e.type] = (types[e.type] || 0) + 1
  const classes = {}
  for (const f of snap.findings || []) classes[`${f.source_class}/${f.evidence_status}`] = (classes[`${f.source_class}/${f.evidence_status}`] || 0) + 1
  const unavailable = {}
  for (const f of (snap.findings || []).filter((x) => x.value === null)) unavailable[`${f.finding_type}:${f.unavailable_reason}`] = (unavailable[`${f.finding_type}:${f.unavailable_reason}`] || 0) + 1
  const seqOk = events.every((e, i) => e.seq === i + 1)
  const uniq = new Set(events.map((e) => e.event_id)).size === events.length
  return {
    run_id: snap.run_id, state: snap.state, live: snap.live, fixture: snap.fixture, store: snap.store,
    events: events.length, last_event_id: snap.last_event_id, seq_gapless: seqOk, event_ids_unique: uniq,
    events_sha: sha(events), view_sha: sha(snap.view),
    event_types: types, findings: (snap.findings || []).length, findings_by_class: classes, unavailable_by_reason: unavailable,
    conflicts: (snap.conflicts || []).map((c) => ({ property: c.property_id, rule: c.rule, resolution: c.resolution_state, best_supported_class: c.best_supported?.source_class || null })),
    properties: Object.fromEntries(Object.entries(snap.view?.properties || {}).map(([k, v]) => [k, { state: v.state, contact_readiness: v.contact_readiness_class, counters: v.counters }])),
    accrued_usd: snap.cost?.accrued_usd, task_costs_nonzero: events.filter((e) => e.type === 'task.completed' && e.payload.cost_usd !== 0).length,
    fixture_events: events.filter((e) => e.fixture).length,
  }
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'start') {
  const st = await call('/status')
  console.log('status', st.status, { mode: st.body.mode, ai_enabled: st.body.ai_enabled, tools: st.body.tools?.length, store: st.body.store })
  const pf = await call('/quick-scan/preflight', { method: 'POST', body: JSON.stringify({ property_ids: args }) })
  console.log('preflight', pf.status, { run_id: pf.body.run_id, scope: pf.body.scope, scope_hash: pf.body.scope_hash?.slice(0, 12), estimate: pf.body.estimate, can_run: pf.body.can_run, approval: pf.body.approval?.required })
  const wrong = await call('/quick-scan/confirm', { method: 'POST', body: JSON.stringify({ job_id: pf.body.job_id, scope_hash: '0'.repeat(64) }) })
  console.log('confirm with a wrong scope hash', wrong.status, wrong.body.error)
  const t0 = Date.now()
  const c = await call('/quick-scan/confirm', { method: 'POST', body: JSON.stringify({ job_id: pf.body.job_id, scope_hash: pf.body.scope_hash }) })
  console.log('confirm', c.status, c.body.state)
  if (process.env.AGENT_DEMO_NO_WAIT) { console.log('RUN_ID', pf.body.run_id); process.exit(0) }
  let cursor = 0
  for (;;) {
    const { body } = await call(`/runs/${pf.body.run_id}/events?after=${cursor}&timeout_ms=5000`)
    cursor = body.cursor
    if (body.done) break
  }
  const snap = (await call(`/runs/${pf.body.run_id}`)).body
  const { events } = await allEvents(pf.body.run_id)
  console.log(JSON.stringify({ wall_ms: Date.now() - t0, ...digest(events, snap) }, null, 2))
  console.log('RUN_ID', pf.body.run_id)
} else if (cmd === 'dump' || cmd === 'digest') {
  const [run_id, file] = args
  const snap = (await call(`/runs/${run_id}`)).body
  const { events } = await allEvents(run_id)
  if (cmd === 'dump' && file) fs.writeFileSync(file, JSON.stringify({ events, snapshot: snap }))
  console.log(JSON.stringify(digest(events, snap), null, 2))
} else {
  console.error('usage: start <ids…> | dump <run_id> <file> | digest <run_id>')
  process.exit(2)
}
