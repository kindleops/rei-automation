/**
 * READ-ONLY prod probe (EG 8.6): for each campaign id given, the Entity Graph
 * campaign scope must be EXACTLY the campaign's target set —
 *   distinct property_id of campaign_targets ∪ send_queue (this campaign)
 * — and the Overview over that scope must report the same total. Prints
 * counts + timings only (never a name, phone or address).
 *
 *   DATABASE_URL=… node --import ./apps/api/tests/register-aliases.mjs scripts/entity-graph/campaign-scope-parity-probe.mjs <uuid> [<uuid>…]
 * Keyed reads only (idx_campaign_targets_campaign_id, idx_send_queue_campaign_id,
 * properties / master_owners / prospects primary keys); 8 s per statement.
 */
const root = new URL('../../apps/api/src/lib/', import.meta.url).pathname
const { queryWithTimeout } = await import(`${root}postgres/client.js`)
const { buildEntityGraphOverview, __overviewTest } = await import(`${root}domain/entity-graph/entity-graph-overview-service.js`)
const { __campaignScopeTest } = await import(`${root}domain/entity-graph/entity-graph-campaign-scope.js`)

// SERIAL: every statement waits for the previous one (the probe never runs two reads at once)
let chain = Promise.resolve()
const serial = (sql, params, ms) => { const p = chain.then(() => queryWithTimeout(sql, params, Math.min(ms ?? 8000, 8000))); chain = p.catch(() => {}); return p }
const ids = process.argv.slice(2)
const out = []
for (const id of ids) {
  __campaignScopeTest.reset(); __overviewTest.reset()
  const t0 = Date.now()
  const { rows: [truth] } = await serial(
    `select count(*)::int as target_rows,
            (select count(distinct p) from (select property_id as p from public.campaign_targets where campaign_id = $1::uuid
               union select primary_property_id from public.campaign_targets where campaign_id = $1::uuid
               union select property_id from public.send_queue where campaign_id = $1::uuid) u where p is not null)::int as distinct_properties,
            (select count(distinct p) from (select property_id as p from public.campaign_targets where campaign_id = $1::uuid and property_id not like 'canaryprop%') u where p is not null)::int as target_properties
       from public.campaign_targets where campaign_id = $1::uuid`, [id], 8000)
  const truthMs = Date.now() - t0
  const ff = JSON.stringify([{ field_key: 'campaign.membership', operator: 'is_any_of', value: [id] }])
  const row = { campaign: id.slice(0, 8), target_rows: truth.target_rows, distinct_properties: truth.distinct_properties, truth_ms: truthMs }
  for (const [tab, sections] of [['properties', 'pinned,headline'], ['properties', 'property'], ['properties', 'value'], ['master_owners', 'pinned,headline'], ['people', 'pinned,headline']]) {
    const t1 = Date.now()
    try {
      const ov = await buildEntityGraphOverview({ tab, field_filters: ff, sections }, { query: serial, skipSnapshot: true, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) })
      row[`${tab}:${sections}`] = { total: ov.total, ms: Date.now() - t1, statements: ov.timings.statements.map((s) => `${s.label}=${s.ms}ms`).join(' '), unavailable: ov.unavailable.map((u) => u.reason.slice(0, 80)) }
    } catch (error) {
      row[`${tab}:${sections}`] = { error: String(error?.code || error?.message).slice(0, 160), ms: Date.now() - t1 }
    }
  }
  out.push(row)
}
console.log(JSON.stringify(out, null, 1))
process.exit(0)
