/**
 * Record REAL observatory GET responses for the desktop capture harness.
 *
 * The local Next dev API is too slow under load to answer every capture, so
 * this runs the exact same service functions against production (SELECT only)
 * and stores each response under the URL the dashboard requests. The capture
 * script replays them verbatim; nothing is synthesized.
 *
 *   cd apps/api && node --import ./scripts/proof/register-aliases-live.mjs scripts/proof/workflow-observatory-fixtures.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const OUT = path.resolve('../dashboard/artifacts/workflow-studio-3/fixtures.json')
const { supabase } = await import('@/lib/supabase/client.js')
const svc = await import('@/lib/domain/workflow-studio/observatory/service.js')
const { getAnalytics } = await import('@/lib/domain/workflow-studio/observatory/analytics.js')
const { getStudioCatalog } = await import('@/lib/domain/workflow-studio/orchestrator/studio-service.js')
const { getStudioWorkflow } = await import('@/lib/domain/workflow-studio/studio-home-service.js')
const deps = { supabase }
const B = '/api/cockpit/workflow-studio'
const O = `${B}/observatory`
const out = {}
const put = async (url, fn) => { const t = Date.now(); try { out[url] = await fn() } catch (e) { out[url] = { ok: false, error: e.message } } console.log(`${String(Date.now() - t).padStart(6)}ms ${url}`) }

await put(`${O}/registry`, () => svc.getRegistry({}, deps))
await put(`${O}/needs-you`, () => svc.getNeedsYou(deps))
await put(`${O}/activity?hours=24&limit=40`, () => svc.getActivity({ hours: 24, limit: 40 }, deps))
await put(`${O}/activity?hours=24&limit=200`, () => svc.getActivity({ hours: 24, limit: 200 }, deps))
await put(`${O}/live`, () => svc.getLive({}, deps))
for (const key of ['seller_inbound', 'queue_dispatch', 'campaign_execution', 'closing_execution', 'email_dispatch', 'seller_review_escalation', 'dnc_opt_out', 'offer_negotiation']) {
  for (const period of ['24h', '7d']) await put(`${O}/workflows/${key}?period=${period}`, () => svc.getWorkflow(key, { period }, deps))
}
await put(`${O}/workflows/seller_inbound/runs?period=7d&limit=80`, () => svc.listRuns('seller_inbound', { period: '7d', limit: 80 }, deps))
await put(`${O}/workflows/queue_dispatch/runs?period=7d&limit=80`, () => svc.listRuns('queue_dispatch', { period: '7d', limit: 80 }, deps))
await put(`${O}/analytics?key=seller_inbound&period=7d`, () => getAnalytics({ key: 'seller_inbound', period: '7d' }, deps))
await put(`${O}/analytics?key=queue_dispatch&period=7d`, () => getAnalytics({ key: 'queue_dispatch', period: '7d' }, deps))
// run details: the needs-you items + a few of each seller status
const needs = out[`${O}/needs-you`]?.items || []
const runs = out[`${O}/workflows/seller_inbound/runs?period=7d&limit=80`]?.runs || []
const ids = new Set([...needs.filter((n) => n.workflow_key === 'seller_inbound' && !String(n.run_id).startsWith('queue:')).slice(0, 4).map((n) => n.run_id), ...['completed', 'held', 'failed', 'needs_you', 'waiting'].map((s) => runs.find((r) => r.status === s)?.run_id).filter(Boolean)])
for (const id of ids) await put(`${O}/workflows/seller_inbound/runs/${id}`, () => svc.getRun('seller_inbound', id, deps))
await put(`${B}/catalog`, async () => getStudioCatalog())
await put(`${B}/studio/seller_review_escalation`, () => getStudioWorkflow('seller_review_escalation', deps))
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ recorded_at: new Date().toISOString(), responses: out }, null, 1))
console.log(`wrote ${Object.keys(out).length} responses → ${OUT}`)
