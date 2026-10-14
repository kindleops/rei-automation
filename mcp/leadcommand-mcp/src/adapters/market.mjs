// Market intelligence for one ZIP, from the CURRENT ready Market Intelligence
// build (mi_rollup_builds → mi_geo_period_rollup, the nightly rollup of
// mv_map_market_sales) plus buyer counts (eg_buyer_index).
// REUSED: getEntityGraphZipContext (via createQuickScanServices().zipContext) and
// the Quick Scan projection projectZipContext (demographics never returned —
// census_geo_metrics is empty in prod; availability only).
import { projectZipContext } from '@/lib/agent/quick-scan/tools.js'
import { err } from '../errors.mjs'
import { prov, missing } from '../provenance.mjs'
import { num, clean, read } from './common.mjs'

export async function getMarketIntelligence(input, svc, { now }) {
  let zip = input.zip || null
  let resolved_from = null
  if (!zip) {
    const { rows } = await read(svc.db.from('properties').select('property_id,property_address_zip').eq('property_id', input.property_id).limit(1), 'properties')
    if (!rows[0]) throw err('not_found', 'no LeadCommand property record for this id', { code: 'PROPERTY_NOT_FOUND' })
    zip = String(rows[0].property_address_zip || '').slice(0, 5)
    if (!/^[0-9]{5}$/.test(zip)) throw err('data_unavailable', 'the property record has no 5-digit ZIP', { code: 'NO_ZIP' })
    resolved_from = 'property_record'
  }
  const ctx = projectZipContext(await svc.zipContext(zip), zip)
  if (!ctx.available) {
    return { zip, resolved_from, available: false, build_id: ctx.build_id ?? null, metrics: null, provenance: missing('mi_geo_period_rollup (current ready build)', ctx.build_id == null ? 'no_ready_market_build' : 'zip_not_in_build') }
  }
  const src = `mi_geo_period_rollup build ${ctx.build_id} (rollup of mv_map_market_sales) · eg_buyer_index`
  return {
    zip, resolved_from, available: true, build_id: num(ctx.build_id),
    metrics: {
      sales_90d: num(ctx.sales90d), sales_1y: num(ctx.sales1y),
      investor_share_1y_pct: num(ctx.investorShare1y), cash_share_1y_pct: num(ctx.cashShare1y),
      median_price_1y: num(ctx.medianPrice1y), median_ppsf_1y: num(ctx.medianPpsf1y), median_investor_price_1y: num(ctx.medianInvestorPrice1y),
      latest_sale: clean(ctx.latestSale),
      buyers_in_zip: num(ctx.buyers), active_buyers_in_zip: num(ctx.activeBuyers),
    },
    shares_note: 'Shares are over sales with a KNOWN buyer type / cash flag (unknown is excluded from the denominator, not counted as 0).',
    demographics_available: Boolean(ctx.demographics_available),
    provenance: prov({ kind: 'derived', source: src, as_of: ctx.latestSale, rule: 'Market Intelligence nightly rollup (asset=all, periods 90d / 1y)', window_days: 45, now }),
  }
}
