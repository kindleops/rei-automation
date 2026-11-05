#!/usr/bin/env node
// 8.5.20-b LIVE READ-ONLY PROOF — property research + MAO / opening plan on recent real
// sellers who stated an asking price, and a ZIP-model build over one market.
//
// READ-ONLY: the caller supplies `query(sql, params)` that runs inside BEGIN READ ONLY with a
// bounded statement_timeout (the CLI below does exactly that from PROOF_RO_DATABASE_URL).
// Nothing is written to any database; results go to a local JSON file.
// ANONYMIZED: properties are P1..Pn, no address / zip / owner / phone is emitted, and every
// amount is rounded to the nearest $5,000.
//
//   PROOF_RO_DATABASE_URL=… node --import ./tests/register-aliases.mjs scripts/proof/property-research-live-proof.mjs [--n 5] [--market dallas-tx] [--out file]
import fs from 'node:fs'
import { createResearchSqlSource } from '../../src/lib/domain/property-research/research-source.js'
import { loadResearchInputs, runInternalResearch } from '../../src/lib/domain/property-research/research-pipeline.js'
import { createZipModelBuilder, createZipSqlSource, createZipMemoryStore } from '../../src/lib/domain/zip-intelligence/zip-builder.js'
import { lookupZipEconomics } from '../../src/lib/domain/zip-intelligence/zip-model.js'

const r5 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) / 5000) * 5000)

/** Recent sellers with a stated ask: the n most recent + the most recent offer-ready one. */
export async function pickSellers(query, { n = 5 } = {}) {
  const recent = await query(`select o.primary_property_id as property_id, o.updated_at from public.acquisition_opportunities o
                               where o.asking_price > 10000 and o.primary_property_id is not null order by o.updated_at desc limit 40`, [])
  const ids = [...new Set(recent.map((r) => String(r.property_id)))]
  const ready = await query(`select o.primary_property_id as property_id from public.acquisition_opportunities o
                               join lateral (select decision_tier, computed_at from public.property_acquisition_scores s where s.property_id = o.primary_property_id order by computed_at desc limit 1) s on true
                              where o.asking_price > 10000 and s.decision_tier in ('AUTO_HARD_OFFER', 'AUTO_RANGE_OFFER') order by o.updated_at desc limit 1`, [])
  const pick = ids.slice(0, Math.max(1, n - 1))
  for (const r of ready) if (!pick.includes(String(r.property_id))) pick.push(String(r.property_id))
  return pick.slice(0, n)
}

export function summarize(label, r) {
  if (!r.found) return { property: label, found: false }
  const p = r.offer_plan || {}
  const c = r.comps_area
  return {
    property: label,
    lane: r.lane,
    ask: r5(r.ask?.amount),
    ask_origin: r.ask?.origin || null,
    engine: { tier: p.engine?.decision_tier || null, computed_at: p.engine?.computed_at ? p.engine.computed_at.slice(0, 10) : null, offer_ready: p.engine?.offer_ready ?? false, reason: p.engine?.offer_ready_reason || null, spendable: p.engine?.spendable ?? false },
    as_is_value: r5(p.values?.as_is_value?.value),
    mao: r5(p.mao?.amount),
    target: r5(p.target?.amount),
    opening: p.available ? { recommended: r5(p.opening.recommended), range: p.opening.range.map(r5), discount_from_target: p.opening.discount_from_target, factors: p.opening.factors.map((f) => f.factor), floor_conflict: p.opening.fair_offer_floor_conflict } : null,
    counter_room: p.available ? r5(p.counter_room.usd) : null,
    plan: { available: Boolean(p.available), reason: p.reason || null, recommendation: p.recommendation || null, lane_check: p.lane_check ? p.lane_check.conformance : null, notes: p.notes || [] },
    economics: { class: r.economics.class, judgment: r.economics.judgment?.path || null, friction: r.economics.execution_friction?.level || null, legit_questions: r.economics.execution_friction?.legitimate_questions?.length || 0, uncertainty: r.economics.uncertainty?.level || null, missing: (r.economics.uncertainty?.missing || []).slice(0, 6) },
    evidence: {
      dossier_contract_ok: r.dossier.contract.ok,
      dossier_coverage: r.dossier.coverage.share,
      coverage_by_section: Object.fromEntries(Object.entries(r.dossier.coverage.by_section).map(([k, v]) => [k, v.share])),
      gaps: r.dossier.gaps,
      stale: r.dossier.stale,
      sold_comps_12m_1_5mi: c.evidence_counts.sold,
      recorded_sales_12m_1_5mi: c.evidence_counts.market_sales,
      listings: c.evidence_counts.listings,
      comps_uncertainty: c.uncertainty.level,
      comps_uncertainty_reasons: c.uncertainty.reasons,
      investor_share: c.sections.market_activity.investor_share.value,
      liquidity: c.sections.market_activity.liquidity.value,
      flood_sfha_share: c.sections.neighborhood.flood_sfha_share.value,
      zip_aggregates: { median_price: r5(c.sections.neighborhood.zip_median_price.value), as_of: c.sections.neighborhood.zip_median_price.as_of ? c.sections.neighborhood.zip_median_price.as_of.slice(0, 10) : null },
    },
  }
}

export async function runPropertyResearchProof({ query, n = 5, now = Date.now() }) {
  const source = createResearchSqlSource({ query })
  const ids = await pickSellers(query, { n })
  const out = []
  for (let i = 0; i < ids.length; i += 1) {
    const inputs = await loadResearchInputs(source, ids[i], { now })
    out.push(summarize(`P${i + 1}`, runInternalResearch(inputs, { now })))
  }
  return out
}

export async function runZipModelProof({ query, market = 'dallas-tx', now = Date.now() }) {
  const store = createZipMemoryStore()
  const builder = createZipModelBuilder({ source: createZipSqlSource({ query }), store, env: { ZIP_INTEL_BUILDER_ENABLED: '1' }, now: () => now })
  const run = await builder.run({ markets: [market] })
  const cells = [...store.cells.values()]
  const all = cells.filter((c) => c.condition_band === 'all' && c.value_band === 'all')
  const count = (xs, k) => xs.reduce((m, c) => ({ ...m, [c[k]]: (m[c[k]] || 0) + 1 }), {})
  const sfr = all.filter((c) => c.property_type === 'sfr').sort((a, b) => b.sample_size - a.sample_size)
  const pick = [sfr[0], sfr[Math.floor(sfr.length / 2)], sfr[sfr.length - 1]].filter(Boolean)
  return {
    market,
    build: run.markets[0],
    cells: cells.length,
    zips: new Set(cells.map((c) => c.zip5)).size,
    all_band_cells_by_type: count(all, 'property_type'),
    prior_levels_all_band: count(all, 'prior_level'),
    mao_precision_all_band: count(all, 'mao_precision'),
    condition_bands: count(cells, 'condition_band'),
    examples_sfr: pick.map((c) => ({ zip5: c.zip5, sample: c.sample_size, investor_n: c.investor_n, retail_n: c.retail_n, unclassified_n: c.unclassified_n, discount: c.investor_discount_vs_retail, band: [c.discount_p25, c.discount_p75], prior: c.prior_label, own_weight: c.own_weight, confidence: c.confidence, precision: c.mao_precision, exit: c.typical_exit })),
    lookup_example: sfr[0] ? lookupZipEconomics(cells, { zip5: sfr[0].zip5, property_type: 'sfr' }) : null,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pg = (await import('pg')).default
  const url = process.env.PROOF_RO_DATABASE_URL
  if (!url) { console.error('PROOF_RO_DATABASE_URL required'); process.exit(2) }
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await c.connect()
  try {
    await c.query('BEGIN READ ONLY')
    await c.query('SET LOCAL statement_timeout = 120000')
    const query = async (sql, params = []) => (await c.query(sql, params)).rows
    const now = Date.now()
    const sellers = await runPropertyResearchProof({ query, n: Number(arg('--n', 5)), now })
    const zip = await runZipModelProof({ query, market: arg('--market', 'dallas-tx'), now })
    await c.query('ROLLBACK')
    fs.writeFileSync(arg('--out', 'property-research-proof.json'), JSON.stringify({ generated_at: new Date(now).toISOString(), sellers, zip }, null, 2))
    console.log('written')
  } finally { await c.end() }
}
