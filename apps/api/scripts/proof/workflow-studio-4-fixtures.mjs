/**
 * Record REAL observatory responses for the Workflow Studio 4.0 desktop capture.
 *
 * Runs the exact service functions the routes call, against production, SELECT
 * only (the observatory read models never write), and stores each response
 * under the URL the dashboard requests. The capture replays them verbatim, so a
 * screenshot run puts zero load on the database. Simulation is the server's own
 * PURE validateAndSimulate (capability.simulate only — zero writes).
 *
 *   cd apps/api && node --import ./scripts/proof/register-aliases-live.mjs scripts/proof/workflow-studio-4-fixtures.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const OUT = path.resolve(process.env.WS4_FIXTURES || '../dashboard/artifacts/workflow-studio-4/fixtures.json')
const { supabase } = await import('@/lib/supabase/client.js')
const svc = await import('@/lib/domain/workflow-studio/observatory/service.js')
const { getAnalytics } = await import('@/lib/domain/workflow-studio/observatory/analytics.js')
const { getSystemMap } = await import('@/lib/domain/workflow-studio/observatory/system-map.js')
const { getExceptions } = await import('@/lib/domain/workflow-studio/observatory/exceptions.js')
const { getStudioCatalog, validateAndSimulate } = await import('@/lib/domain/workflow-studio/orchestrator/studio-service.js')
const { getStudioWorkflow } = await import('@/lib/domain/workflow-studio/studio-home-service.js')

const deps = { supabase, noCache: true }
const B = '/api/cockpit/workflow-studio'
const O = `${B}/observatory`
const out = {}
const put = async (url, fn) => {
  const t = Date.now()
  try { out[url] = await fn() } catch (e) { out[url] = { ok: false, error: e.message } }
  console.log(`${String(Date.now() - t).padStart(6)}ms ${url}`)
  return out[url]
}

const now = new Date()
const local0 = new Date(now); local0.setHours(0, 0, 0, 0)
await put(`${O}/registry`, () => svc.getRegistry({ dayStart: local0.toISOString() }, deps))
await put(`${O}/exceptions`, () => getExceptions(deps))
await put(`${O}/system?window=24h`, () => getSystemMap({ window: '24h' }, deps))
await put(`${O}/system?window=7d`, () => getSystemMap({ window: '7d' }, deps))
await put(`${O}/activity?hours=24&limit=300`, () => svc.getActivity({ hours: 24, limit: 300 }, deps))
await put(`${O}/activity?hours=168&human=1&limit=300`, () => svc.getActivity({ hours: 168, human: true, limit: 300 }, deps))
await put(`${O}/live`, () => svc.getLive({}, deps))
const liveSeller = await put(`${O}/live?key=seller_inbound`, () => svc.getLive({ key: 'seller_inbound' }, deps))
// a second, wider read (real traversals of the last 6 hours) — the capture serves it as the next poll to exercise the pulse layer
await put(`${O}/live?since=REPLAY&key=seller_inbound`, () => svc.getLive({ key: 'seller_inbound', since: new Date(Date.now() - 6 * 3600e3 + 60e3).toISOString() }, deps))
void liveSeller

const KEYS = ['seller_inbound', 'queue_dispatch', 'campaign_execution', 'seller_review_escalation', 'offer_negotiation', 'dnc_opt_out', 'operator_notifications', 'event_bridge', 'decision_engine', 'closing_execution', 'email_dispatch', 'lead_state_reconcile']
for (const key of KEYS) for (const period of ['24h', '7d']) await put(`${O}/workflows/${key}?period=${period}`, () => svc.getWorkflow(key, { period }, deps))
await put(`${O}/workflows/seller_inbound?period=30d`, () => svc.getWorkflow('seller_inbound', { period: '30d' }, deps))
for (const key of ['seller_inbound', 'queue_dispatch', 'campaign_execution', 'seller_review_escalation']) {
  await put(`${O}/workflows/${key}/runs?period=7d&limit=80`, () => svc.listRuns(key, { period: '7d', limit: 80 }, deps))
  await put(`${O}/workflows/${key}/runs?period=24h&limit=6`, () => svc.listRuns(key, { period: '24h', limit: 6 }, deps))
  await put(`${O}/analytics?key=${key}&period=7d`, () => getAnalytics({ key, period: '7d' }, deps))
}
await put(`${O}/analytics?key=seller_inbound&period=30d`, () => getAnalytics({ key: 'seller_inbound', period: '30d' }, deps))
await put(`${O}/workflows/event_bridge/runs?period=24h&limit=200`, () => svc.listRuns('event_bridge', { period: '24h', limit: 200 }, deps))

// run details: what the exceptions open, and real successful / held / failed seller runs
const exc = out[`${O}/exceptions`]?.items || []
const sellerRuns = out[`${O}/workflows/seller_inbound/runs?period=7d&limit=80`]?.runs || []
const ids = new Map()
for (const it of exc) if (it.open) ids.set(`${it.open.workflow_key}|${it.open.run_id}`, it.open)
const pick = (status, extra = () => true) => sellerRuns.find((r) => r.status === status && extra(r))
for (const r of [pick('completed', (x) => /delivered/i.test(x.result || '')), pick('completed'), pick('held'), pick('failed'), pick('needs_you'), pick('waiting'), pick('cancelled')].filter(Boolean)) ids.set(`seller_inbound|${r.run_id}`, { workflow_key: 'seller_inbound', run_id: r.run_id })
for (const key of ['seller_review_escalation', 'campaign_execution', 'queue_dispatch']) {
  const runs = out[`${O}/workflows/${key}/runs?period=7d&limit=80`]?.runs || []
  for (const r of [runs[0], runs.find((x) => x.status === 'failed'), runs.find((x) => x.status === 'completed')].filter(Boolean)) ids.set(`${key}|${r.run_id}`, { workflow_key: key, run_id: r.run_id })
}
for (const { workflow_key, run_id } of ids.values()) await put(`${O}/workflows/${workflow_key}/runs/${encodeURIComponent(run_id)}`, () => svc.getRun(workflow_key, run_id, deps))
// branch cohorts the inspectors ask for (edge inspector, analytics) on the seller workflow
const sellerA = out[`${O}/analytics?key=seller_inbound&period=7d`]
for (const b of (sellerA?.branches || []).slice(0, 3)) for (const e of b.exits.filter((x) => x.count).slice(0, 3)) await put(`${O}/workflows/seller_inbound/runs?period=7d&edge=${encodeURIComponent(e.edge)}&limit=6`, () => svc.listRuns('seller_inbound', { period: '7d', edge: e.edge, limit: 6 }, deps))

// studio authoring: catalog, the studio workflow, and a PURE simulation of its live graph
const catalog = await put(`${B}/catalog`, async () => getStudioCatalog())
const studio = await put(`${B}/studio/seller_review_escalation`, () => getStudioWorkflow('seller_review_escalation', deps))
if (studio?.workflow?.graph) out[`POST ${B}/simulate`] = validateAndSimulate({ graph: studio.workflow.graph, previous: studio.workflow.graph, scenario: { pick: 'first' } })
// the "New workflow" preview: each blueprint at its default parameters (PURE — no database at all)
for (const bp of getStudioCatalog().blueprints || []) {
  const params = Object.fromEntries(Object.entries(bp.params || {}).map(([k, v]) => [k, Number(v.default ?? v.min ?? 0)]))
  out[`POST ${B}/simulate#blueprint:${bp.key}`] = validateAndSimulate({ blueprint: bp.key, params, scenario: { pick: 'first' } })
}
void catalog

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ recorded_at: new Date().toISOString(), responses: out }, null, 1))
console.log(`wrote ${Object.keys(out).length} responses → ${OUT}`)
