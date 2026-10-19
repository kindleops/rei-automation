// Properties: search (eg_property_facts keyset) and one-property detail.
//
// REUSED, not re-implemented:
//   * getEntityGraphDossier (via createQuickScanServices().dossier) — the same
//     load GET /api/cockpit/entity-graph/property/:id performs;
//   * the Quick Scan projections projectPropertyCore / projectOwnership /
//     projectRecordedDocuments / projectSalesHistory (no names, no mailing,
//     private lenders withheld, buyer KIND only);
//   * the research tool eg.distress_signals (graph flags, parcel, probate,
//     preforeclosure, EG facts + the deterministic cross-source inconsistency
//     rules findInconsistencies);
//   * the research tool eg.property_lookup (address fragment → ≤ 5 candidates,
//     trigram-indexed) and safeFlags (protected-class flag filter).
import { projectPropertyCore, projectOwnership, projectRecordedDocuments, projectSalesHistory } from '@/lib/agent/quick-scan/tools.js'
import { RESEARCH_TOOL_SPECS, safeFlags } from '@/lib/agent/research/research-tools.js'
import { err } from '../errors.mjs'
import { prov, missing } from '../provenance.mjs'
import { num, clean, untrusted, dayOrNull, isoOrNull } from './common.mjs'
import { keysetPage, PROPERTY_ANCHORS } from './facts-search.mjs'

const spec = (name) => RESEARCH_TOOL_SPECS.find((s) => s.name === name)
export const FACTS_WINDOW_DAYS = 7

export const PROPERTY_SEARCH_COLUMNS = 'property_id,property_address_full,property_address_city,property_address_state,zip_code,market,property_type,asset_type,units_count,total_bedrooms,total_baths,building_square_feet,year_built,estimated_value,equity_known_pct,equity_class,equity_rule,distress_signal_count,signal_labels,last_sale_on,refreshed_at'

const PROPERTY_RANGES = [
  ['units_min', 'units_count', 'gte'], ['units_max', 'units_count', 'lte'],
  ['year_built_min', 'year_built', 'gte'], ['year_built_max', 'year_built', 'lte'],
  ['value_min', 'estimated_value', 'gte'], ['value_max', 'estimated_value', 'lte'],
  ['bedrooms_min', 'total_bedrooms', 'gte'],
  ['distress_signals_min', 'distress_signal_count', 'gte'],
]

const labels = (v) => (Array.isArray(v) ? safeFlags(v.join(';')) : safeFlags(v)).map((x) => untrusted(x, 60)).filter(Boolean)

export function projectPropertyRow(r, now = new Date()) {
  return {
    property_id: String(r.property_id),
    address: untrusted(r.property_address_full, 160),
    city: clean(r.property_address_city), state: clean(r.property_address_state), zip: clean(r.zip_code), market: clean(r.market),
    property_type: untrusted(r.property_type, 60), asset_type: clean(r.asset_type),
    units: num(r.units_count), bedrooms: num(r.total_bedrooms), baths: num(r.total_baths), building_sqft: num(r.building_square_feet), year_built: num(r.year_built),
    vendor_estimated_value: num(r.estimated_value),
    equity: { known_pct: num(r.equity_known_pct), class: clean(r.equity_class), rule: clean(r.equity_rule) },
    distress_signal_count: num(r.distress_signal_count),
    signal_labels: labels(r.signal_labels),
    last_sale_on: dayOrNull(r.last_sale_on),
    provenance: prov({ kind: 'fact', source: 'eg_property_facts (Entity Graph read model)', as_of: r.refreshed_at, window_days: FACTS_WINDOW_DAYS, now }),
  }
}

export async function searchProperties(input, svc, { after, now }) {
  if (input.address) {
    // address fragment → the research tool's bounded trigram lookup (≤ 25 read, ≤ 5 returned); no pagination
    const out = await spec('eg.property_lookup').execute({ address: input.address, ...(input.city ? { city: input.city } : {}), ...(input.state ? { state: input.state } : {}), ...(input.zip ? { zip: input.zip } : {}) }, { services: svc }).catch((e) => {
      if (e?.code === 'ADDRESS_NOT_SELECTIVE') throw err('invalid_input', 'an address needs a house number and a street name (≥ 3 characters)', { code: 'ADDRESS_NOT_SELECTIVE' })
      throw e
    })
    return {
      rows: out.candidates.map((c) => ({ property_id: c.property_id, address: untrusted(c.address, 160), city: c.city, state: c.state, zip: c.zip, market: c.market, property_type: untrusted(c.property_type, 60), units: c.units, match: c.match, provenance: prov({ kind: 'fact', source: 'properties (LeadCommand property record)', as_of: null }) })),
      ambiguous: out.ambiguous,
      has_more: Boolean(out.more_may_exist),
      last: null,
      mode: 'address_lookup',
    }
  }
  const page = await keysetPage(svc.db, { columns: PROPERTY_SEARCH_COLUMNS, filters: input, anchors: PROPERTY_ANCHORS, ranges: PROPERTY_RANGES, inFilters: [['asset_types', 'asset_type']], after, limit: input.limit, signal: svc.signal })
  return { rows: page.rows.map((r) => projectPropertyRow(r, now)), has_more: page.has_more, last: page.last, mode: 'keyset' }
}

const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : null)

export async function getProperty(input, svc, { now }) {
  const dossier = await svc.dossier(input.property_id)
  if (!dossier) throw err('not_found', 'no LeadCommand property record for this id', { code: 'PROPERTY_NOT_FOUND' })
  const core = projectPropertyCore(dossier)
  const own = projectOwnership(dossier)
  const recorded = projectRecordedDocuments(dossier)
  const sales = projectSalesHistory(dossier)
  const distress = await spec('eg.distress_signals').execute({ property_id: input.property_id }, { services: svc })
  const vendorAsOf = core.provenance.vendor_as_of
  return {
    property_id: core.property_id,
    address: untrusted(core.display_address, 160),
    market: clean(core.market),
    facts: Object.fromEntries(Object.entries(core.facts).map(([k, v]) => [k, typeof v === 'string' ? untrusted(v, 80) : v])),
    has_coordinates: core.has_coordinates,
    facts_provenance: prov({ kind: 'fact', source: `properties (vendor record${core.provenance.source_system ? `, ${clean(core.provenance.source_system)}` : ''})`, as_of: vendorAsOf || core.provenance.source_updated_at, now }),
    ownership: {
      owner_kind: own.owner_kind, owner_linked: own.owner_linked, is_corporate_owner: own.is_corporate_owner, out_of_state_owner: own.out_of_state_owner,
      ownership_years: own.ownership_years, owner_portfolio_count: own.owner_portfolio_count, linked_people_count: own.linked_people_count,
      provenance: prov({ kind: 'derived', source: 'properties + master_owners (classifyHolder: owner KIND only, never names)', rule: 'entity-network-service#classifyHolder', as_of: vendorAsOf, now }),
    },
    recorded_documents: recorded.available
      ? {
          mortgages: cap(recorded.mortgages, 10).map((m) => ({ ...m, lender: untrusted(m.lender, 80) })),
          liens: cap(recorded.liens, 10).map((l) => ({ ...l, title: untrusted(l.title, 80), description: untrusted(l.description, 160), type: untrusted(l.type, 60), category: untrusted(l.category, 60) })),
          foreclosures: cap(recorded.foreclosures, 5).map((f) => ({ ...f, lender: untrusted(f.lender, 80), case_number: untrusted(f.case_number, 40) })),
          totals: recorded.totals || null,
          provenance: prov({ kind: 'fact', source: 'recorded documents (seller.* via entity_graph_property_records)', as_of: recorded.parcel?.updated_at || null, now }),
        }
      : { available: false, provenance: missing('recorded documents', recorded.reason || 'records_unavailable') },
    sales_history: sales.available
      ? {
          sales: cap(sales.sales, 10).map((s) => ({ ...s, doc_type: untrusted(s.doc_type, 60), price_note: untrusted(s.price_note, 120) })),
          owner_buyer: sales.owner_buyer,
          buyer_rule: 'Buyer KIND / activity only (never names). A recorded deed buyer is not asserted to be the current owner.',
          provenance: prov({ kind: 'fact', source: 'recorded documents (sales / transfers)', as_of: null }),
        }
      : { available: false, provenance: missing('recorded documents', sales.reason || 'records_unavailable') },
    distress: {
      graph: distress.graph,
      parcel: distress.parcel,
      probate: distress.probate,
      preforeclosure: distress.preforeclosure,
      inconsistencies: distress.inconsistencies,
      provenance: prov({ kind: 'fact', source: 'campaign_target_graph · probate_status · preforeclosure_status_v2 · eg_property_facts · recorded parcel', as_of: isoOrNull(distress.probate?.audited_at) || isoOrNull(distress.preforeclosure?.verified_at), rule: 'research-tools#findInconsistencies (cross-source checks)', now }),
    },
  }
}
