/**
 * ENTITY GRAPH — BUYER ENTITY PROFILE.
 *
 * One read (`eg_buyer_profile`, service-role, SECURITY DEFINER over the W8C
 * buyer-intelligence tables) shaped for the inspector. Buyers are observational
 * intelligence: nothing here writes, ranks for outreach, or triggers a send.
 *
 * Evidence language the UI renders verbatim:
 *   registry  matched through the company registry number        → Resolved
 *   link      resolved by the buyer-intelligence engine (method,  → Resolved
 *             confidence carried)
 *   name      exact normalized-name match, unambiguous alias      → Observed by name
 */
import { displayableCompanyName } from './buyer-name-privacy.js'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value))

/** W8C geography/asset lists are [[key, count, share], …]. */
function tuples(list, split = false) {
  if (!Array.isArray(list)) return []
  return list.map((entry) => {
    const [rawKey, count, share] = Array.isArray(entry) ? entry : [entry?.key, entry?.count, entry?.share]
    const key = String(rawKey ?? '')
    const [state, place] = split && key.includes('|') ? key.split('|') : [null, key]
    return { key, label: split && state ? `${place}, ${state}` : key, count: num(count) ?? 0, share: num(share) }
  })
}

const METHOD_LABEL = {
  exact_registry_company_identity: 'Registry identity match',
  seller_transaction_registry_exact: 'Registry match on the deed',
  seller_transaction_company_corroboration: 'Corroborated by company records',
  transaction_linked_company_evidence: 'Company evidence on the transaction',
  transaction_linked_contact_evidence: 'Contact evidence on the transaction',
  property_linked_contact_tokenset: 'Name + property contact match',
  officer_operator_corroboration: 'Officer / operator corroboration',
}

export function evidenceTier({ basis, confidence } = {}) {
  if (basis === 'registry') return 'resolved'
  if (basis === 'link') return Number(confidence) >= 0.95 ? 'resolved' : 'inferred'
  if (basis === 'individual_key') return 'resolved'
  if (basis === 'name') return 'observed'
  return 'inferred'
}

export function shapeBuyerProfile(raw) {
  if (!raw || !raw.index) return null
  const index = raw.index
  const behavior = raw.behavior || {}
  const geo = behavior.geography_profile || {}
  const assets = behavior.asset_profile || {}
  const price = behavior.price_profile || {}
  const holdFlip = behavior.hold_flip_profile || {}
  const person = index.entity_type === 'person'
  const shownName = person ? null : displayableCompanyName(index.display_name)
  const withheld = person || (!shownName && !!index.display_name)

  return {
    id: index.buyer_id,
    kind: person ? 'person' : 'company',
    name: shownName || (withheld ? (person ? 'Individual buyer' : 'Registered entity') : 'Unnamed company'),
    nameWithheld: withheld,
    identity: {
      grade: raw.identity?.entity_grade ?? index.entity_grade ?? null,
      confidence: num(raw.identity?.confidence ?? index.confidence),
      method: raw.identity?.strongest_method ?? null,
      jurisdiction: raw.identity?.jurisdiction ?? index.jurisdiction_code ?? null,
      companyNumber: raw.identity?.company_number ?? null,
      aliasCount: raw.identity?.alias_count ?? index.alias_count ?? null,
      modelAsOf: raw.identity?.materialized_at ?? null,
    },
    registry: raw.registry || null,
    aliases: (withheld ? [] : raw.aliases || []).map((alias) => ({
      name: alias.alias,
      forms: alias.forms || [],
      canonical: Boolean(alias.canonical),
      provisional: Boolean(alias.provisional),
      grade: alias.grade ?? null,
    })),
    roles: {
      purchases: num(index.acquisition_count) ?? 0,
      dispositions: num(index.disposition_count) ?? 0,
      sold: num(index.sold_count) ?? 0,
      owned: num(index.owned_count) ?? 0,
      ownedRegistry: num(index.owned_registry) ?? 0,
      portfolio: num(index.portfolio_count) ?? 0,
      portfolioValue: num(index.portfolio_value),
      linkedSales: num(index.linked_sales) ?? 0,
      crossover: Boolean(index.is_crossover),
    },
    activity: {
      status: index.activity_status ?? null,
      score: num(index.activity_score),
      first: index.first_acquisition ?? null,
      last: index.last_acquisition ?? null,
      daysSinceLast: num(index.days_since_last),
      trailing90: num(index.trailing_90d),
      trailing180: num(index.trailing_180d),
      trailing365: num(index.trailing_365d),
      perYear: num(index.acquisitions_per_year),
      components: behavior.activity_components || null,
      byYear: (raw.purchases_by_year || []).map((row) => ({ year: row.year, count: row.count, volume: num(row.volume) })),
    },
    behavior: {
      archetype: index.archetype ?? null,
      archetypeReasons: behavior.archetype_reasons || [],
      holdFlip: index.hold_flip ?? null,
      medianHoldDays: num(holdFlip.median_hold_days),
      evidenceCount: num(behavior.evidence_count),
      confidence: num(behavior.confidence),
    },
    geography: {
      usable: geo.usable !== false,
      states: tuples(geo.states),
      counties: tuples(geo.counties, true),
      cities: tuples(geo.cities, true),
      zips: tuples(geo.zips),
      primaryMarkets: (geo.primary_markets || []).map((key) => String(key).split('|').reverse().join(', ')),
      concentration: num(geo.concentration_index),
    },
    assets: {
      families: tuples(assets.families),
      dominant: assets.dominant_family ?? null,
    },
    price: {
      p10: num(price.lifetime?.p10),
      p25: num(price.lifetime?.p25),
      p50: num(price.lifetime?.p50),
      p75: num(price.lifetime?.p75),
      p90: num(price.lifetime?.p90),
      recentMedian: num(price.recent_365d?.median),
      recentCount: num(price.recent_365d?.count),
      cashShare: num(price.cash_share),
      armsLengthShare: num(price.arms_length_share),
    },
    buybox: raw.buybox ? {
      counties: raw.buybox.preferred_counties || [],
      states: raw.buybox.acceptable_states || [],
      families: raw.buybox.preferred_asset_families || [],
      priceLow: num(raw.buybox.price_robust_low ?? raw.buybox.price_low),
      priceHigh: num(raw.buybox.price_robust_high ?? raw.buybox.price_high),
      sqftLow: num(raw.buybox.building_sqft_p25),
      sqftHigh: num(raw.buybox.building_sqft_p75),
      unitsLow: num(raw.buybox.units_p25),
      unitsHigh: num(raw.buybox.units_p75),
      evidenceDepth: num(raw.buybox.evidence_depth),
      confidence: num(raw.buybox.confidence),
    } : null,
    network: (raw.relationships || []).map((rel) => ({
      other: rel.other ? {
        id: rel.other.buyer_id,
        name: (rel.other.entity_type === 'person' ? null : displayableCompanyName(rel.other.name)) || (rel.other.entity_type === 'person' ? 'Individual' : 'Company'),
        kind: rel.other.entity_type,
        purchases: rel.other.acquisition_count ?? null,
      } : null,
      direction: rel.direction,
      role: rel.role || null,
      confidence: num(rel.confidence),
      basis: rel.basis || null,
    })).filter((rel) => rel.other),
    purchases: (raw.purchases || []).map((tx) => ({
      id: tx.canonical_transaction_id,
      date: tx.date ?? null,
      price: num(tx.price),
      docType: tx.doc_type ?? null,
      seller: tx.seller ?? null,
      cash: tx.cash ?? null,
      armsLength: tx.arms_length ?? null,
      lender: tx.lender ?? null,
      loanAmount: num(tx.loan_amount),
      propertyId: tx.property_id ?? null,
      inUniverse: Boolean(tx.in_universe),
      address: tx.address ?? null,
      city: tx.city ?? null,
      state: tx.state ?? null,
      lat: num(tx.lat),
      lng: num(tx.lng),
      propertyType: tx.property_type ?? null,
      evidence: { basis: 'link', method: METHOD_LABEL[tx.method] || tx.method || null, confidence: num(tx.confidence), tier: evidenceTier({ basis: 'link', confidence: tx.confidence }) },
    })),
    dispositions: (raw.dispositions || []).map((tx) => ({
      id: tx.canonical_transaction_id,
      date: tx.date ?? null,
      price: num(tx.price),
      docType: tx.doc_type ?? null,
      buyer: tx.buyer ?? null,
      propertyId: tx.property_id ?? null,
      address: tx.address ?? null,
      evidence: { basis: 'name', tier: 'observed' },
    })),
    owned: (raw.owned || []).map((row) => ({
      propertyId: row.property_id,
      address: row.address ?? null,
      value: num(row.value),
      equityPercent: num(row.equity_percent),
      propertyType: row.property_type ?? null,
      market: row.market ?? null,
      lat: num(row.lat),
      lng: num(row.lng),
      evidence: { basis: row.basis, tier: evidenceTier({ basis: row.basis }) },
    })),
    portfolio: (raw.portfolio || []).map((row) => ({
      propertyId: row.property_id,
      address: row.address ?? null,
      value: num(row.value),
      equity: num(row.equity),
      propertyType: row.property_type ?? null,
      lat: num(row.lat),
      lng: num(row.lng),
      attribution: row.attribution ?? null,
    })),
  }
}

export async function getBuyerProfile(buyerId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data, error } = await supabase.rpc('eg_buyer_profile', { p_buyer_id: buyerId, p_limit: 60 })
  if (error) throw error
  return shapeBuyerProfile(data)
}

export default getBuyerProfile
