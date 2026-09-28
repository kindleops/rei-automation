/**
 * BUYER MATCH — who plausibly buys this property, ranked and explained by
 * observed acquisition behaviour.
 *
 * Read-only. Identity is the W8C buyer model — the same canonical, privacy-safe
 * buyer_id space Entity Graph uses (companies named, individuals opaque) — read
 * through one bounded SECURITY DEFINER RPC (buyer_match_evidence):
 *
 *   near     buyers with recorded purchases inside the radius/window
 *   county   buyers active in the subject's county in the last 24 months
 *
 * Every tier, exclusion and evidence line below is a rule over measured facts
 * (counts, dates, observed price percentiles, deed types). There is no
 * composite "match %": the tiers are the explanation, and the rules are shown
 * to the operator (TIER_RULES).
 *
 * Not a disposition engine: nothing here writes state. Buyer-side states
 * (contacted / offered / selected / committed / agreement / EMD) are read from
 * their own tables and never inferred from a match.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { loadSubjectProperty, normalizePropertyFeatures } from '@/lib/acquisition/acquisitionDecisionEngine.js'
import { displayableCompanyName } from '../entity-graph/buyer-name-privacy.js'
import { LENDER_LABEL, lenderClass } from './buyer-identity-rules.js'

const DAY = 86_400_000
const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null }
const arr = (v) => (Array.isArray(v) ? v : [])
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const money = (n) => {
  if (!Number.isFinite(n)) return null
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export { displayableCompanyName, lenderClass }

export const RADIUS_OPTIONS = [1, 2, 3, 5, 10, 25]
export const MONTH_OPTIONS = [12, 24, 36, 60]

/* ── vocabularies ─────────────────────────────────────────────────────── */

/** Subject family (transaction-corpus vocabulary) from the engine's features. */
export function subjectFamily(features = {}) {
  const f = clean(features.asset_family).toLowerCase()
  const units = num(features.units) ?? 1
  if (f === 'multifamily') return units >= 5 ? 'apartment' : 'multifamily'
  if (f === 'land') return 'land'
  if (f === 'commercial') return 'commercial'
  return 'single_family'
}

export const FAMILY_LABEL = {
  single_family: 'Single family', multifamily: 'Small multifamily', apartment: 'Apartments 5+', land: 'Land', commercial: 'Commercial',
  sfr: 'Single family', small_multifamily_2_4: 'Multifamily 2–4', multifamily_unspecified: 'Multifamily', apartments_5plus: 'Apartments 5+',
  commercial_other: 'Commercial', self_storage: 'Self storage', retail_strip: 'Retail strip', industrial: 'Industrial',
}

/** W8C buyer family → the subject families it can evidence. */
const W8C_SERVES = {
  sfr: ['single_family'],
  small_multifamily_2_4: ['multifamily'],
  multifamily_unspecified: ['multifamily', 'apartment'],
  apartments_5plus: ['apartment'],
  land: ['land'],
  commercial_other: ['commercial'], self_storage: ['commercial'], retail_strip: ['commercial'], industrial: ['commercial'],
}

/** 'dominant' | 'present' | 'absent' | 'unknown' — does this buyer buy the subject's asset family? */
export function familyFit(buyer = {}, family) {
  const fams = arr(buyer.families).map(clean).filter(Boolean)
  const dom = clean(buyer.dominant_family)
  if (!fams.length && !dom) return 'unknown'
  if (dom && arr(W8C_SERVES[dom]).includes(family)) return 'dominant'
  if (fams.some((f) => arr(W8C_SERVES[f]).includes(family))) return 'present'
  return 'absent'
}


/** How the buyer's identity was established — never flattened into one confidence number. */
export function identityTier(method) {
  const m = clean(method)
  if (m === 'exact_registry_company_identity' || m === 'seller_transaction_registry_exact') return { tier: 'registry', label: 'Registry resolved' }
  if (m === 'seller_transaction_company_corroboration' || m === 'officer_operator_corroboration') return { tier: 'corroborated', label: 'Corroborated' }
  if (m) return { tier: 'engine', label: 'Buyer engine resolved' }
  return { tier: 'observed', label: 'Observed name' }
}

const ARCHETYPE_LABEL = {
  institutional_high_volume_buyer: 'High-volume buyer', active_flipper: 'Active flipper', general_acquirer: 'General acquirer',
  geographically_concentrated_buyer: 'Concentrated local buyer', long_term_rental_holder: 'Long-term holder', multifamily_operator: 'Multifamily operator',
  small_multifamily_operator: 'Small multifamily operator', commercial_operator: 'Commercial operator', diversified_buyer: 'Diversified buyer',
  inactive_stale_buyer: 'Inactive buyer', insufficient_evidence: null,
}
const HOLD_FLIP_LABEL = { flip_like: 'Resells (flip-like)', hold_like: 'Holds (rental-like)', mixed: 'Holds and resells', no_disposition_evidence: null }

/* ── subject-vs-buyer fit ─────────────────────────────────────────────── */

/**
 * The price a disposition buyer would pay sits between the acquisition offer
 * and the as-is value; a buyer's observed purchase band (p25–p75) either
 * overlaps that window or it doesn't.
 */
export function dispositionWindow({ value, offer } = {}) {
  const v = pos(value)
  if (!v) return null
  const o = pos(offer)
  return { low: o && o < v ? o : Math.round(v * 0.85), high: v, basis: o && o < v ? 'offer_to_value' : 'value_band' }
}

export function priceFit(buyer = {}, window) {
  const p25 = pos(buyer.price_p25)
  const p75 = pos(buyer.price_p75)
  if (!window || !p25 || !p75) return { verdict: 'unknown' }
  if (window.high >= p25 && window.low <= p75) return { verdict: 'inside', low: p25, high: p75 }
  const gap = window.low > p75 ? (window.low - p75) / window.low : (p25 - window.high) / p25
  return { verdict: gap <= 0.25 ? 'near' : 'outside', low: p25, high: p75, direction: window.low > p75 ? 'above' : 'below' }
}

export function recencyFit(daysSince) {
  const d = num(daysSince)
  if (d === null) return 'unknown'
  if (d <= 90) return 'active'
  if (d <= 365) return 'recent'
  if (d <= 730) return 'slowing'
  return 'stale'
}

export function sizeFit(buyer = {}, subject = {}) {
  const s = pos(subject.sqft)
  const lo = pos(buyer.sqft_p25)
  const hi = pos(buyer.sqft_p75)
  if (!s || !lo || !hi) return { verdict: 'unknown' }
  if (s >= lo * 0.85 && s <= hi * 1.15) return { verdict: 'inside', low: lo, high: hi }
  return { verdict: 'outside', low: lo, high: hi }
}

/* ── tiering ──────────────────────────────────────────────────────────── */

export const TIER_RULES = {
  strong: '2+ same-type purchases inside the radius, a purchase in the last 12 months, and an observed price band that meets the disposition window.',
  moderate: 'At least one same-type purchase inside the radius in the last 24 months — or repeat same-type buying in the county in the last 12 months.',
  exploratory: 'Active in the county or nearby, with weaker same-type, recency or price evidence.',
}

export const EXCLUSION_LABELS = {
  lender_or_agency: 'Lender, servicer or agency — takes title at foreclosure, not a disposition buyer',
  type_mismatch: 'Buys a different asset type',
  stale: 'No purchase in over 24 months',
  price_outside: 'Observed price band far from this deal',
}

/**
 * Classify one evidence row. Returns null for one-time individual buyers
 * (a single observed purchase by a person is an owner-occupant signal, not
 * investor behaviour) — they are counted by the caller, never listed.
 */
export function classifyBuyer(b = {}, ctx = {}) {
  const near = obj(b.near)
  const kind = clean(b.kind)
  const acquisitions = num(b.acquisitions) ?? 0
  if (kind === 'person' && acquisitions <= 1) return null

  const fam = familyFit(b, ctx.family)
  const price = priceFit(b, ctx.window)
  const recency = recencyFit(b.days_since_last)
  const size = sizeFit(b, ctx.subject)
  const sameNear = num(near.same_family) ?? 0
  const countyN = num(b.county_purchases) ?? 0
  const lender = kind === 'company' ? lenderClass(b.name) : null
  const fcDeeds = num(b.foreclosure_deeds) ?? 0
  const linked = num(b.linked_transactions) ?? 0

  const exclusions = []
  if (lender) {
    exclusions.push({ code: 'lender_or_agency', label: `${LENDER_LABEL[lender]} — ${linked ? `${fcDeeds} of ${linked} acquisitions were foreclosure deeds` : 'takes title at foreclosure'}` })
  }
  if (fam === 'absent' && sameNear === 0) {
    exclusions.push({ code: 'type_mismatch', label: `Buys ${FAMILY_LABEL[clean(b.dominant_family)] || 'other assets'} — no ${FAMILY_LABEL[ctx.family] || 'same-type'} purchases observed` })
  }
  if (recency === 'stale') {
    exclusions.push({ code: 'stale', label: `Inactive — last purchase ${clean(b.last_acquisition) || 'unknown'}` })
  }
  if (price.verdict === 'outside' && acquisitions >= 3) {
    exclusions.push({ code: 'price_outside', label: `Typically pays ${money(price.low)}–${money(price.high)} — ${price.direction === 'above' ? 'below' : 'above'} this deal’s ${money(ctx.window.low)}–${money(ctx.window.high)} window` })
  }

  let tier = 'exploratory'
  const priceOk = price.verdict === 'inside' || price.verdict === 'near'
  if (sameNear >= 2 && (recency === 'active' || recency === 'recent') && priceOk) tier = 'strong'
  else if ((sameNear >= 1 && recency !== 'stale') || ((fam === 'dominant' || fam === 'present') && countyN >= 2 && (recency === 'active' || recency === 'recent'))) tier = 'moderate'
  if (exclusions.length) tier = 'excluded'

  return { tier, exclusions, fit: { family: fam, price, recency, size }, lender, sameNear, countyN }
}

/** Measured "why this buyer" lines — facts with their windows, no prose. */
export function evidenceLines(b = {}, c = {}, ctx = {}) {
  const near = obj(b.near)
  const lines = []
  const famLabel = (FAMILY_LABEL[ctx.family] || 'same-type').toLowerCase()
  if (num(near.same_family)) lines.push({ k: 'near', text: `${plural(near.same_family, `${famLabel} purchase`)} within ${ctx.radius} mi`, sub: `last ${ctx.months} months` })
  else if (num(near.n)) lines.push({ k: 'near', text: `${plural(near.n, 'purchase')} within ${ctx.radius} mi`, sub: 'other asset types' })
  if (num(near.same_zip)) lines.push({ k: 'zip', text: `${plural(near.same_zip, 'purchase')} in ZIP ${ctx.zip}` })
  if (num(near.nearest_miles) !== null) lines.push({ k: 'nearest', text: `Nearest purchase ${Number(near.nearest_miles).toFixed(1)} mi away` })
  if (num(b.county_purchases)) lines.push({ k: 'county', text: `${plural(b.county_purchases, 'purchase')} in ${ctx.countyLabel || 'this county'}` })
  if (num(b.days_since_last) !== null) lines.push({ k: 'recency', text: `Last purchase ${b.days_since_last} days ago`, sub: num(b.t90) ? `${b.t90} in the last 90 days` : num(b.t365) ? `${b.t365} in the last 12 months` : null })
  if (c.fit?.price?.verdict === 'inside') {
    const single = (num(b.acquisitions) ?? 0) < 3 || c.fit.price.low === c.fit.price.high
    lines.push(single
      ? { k: 'price', text: `Paid ${money(num(b.price_p50) ?? c.fit.price.low)}`, sub: `${plural(num(b.acquisitions) ?? 1, 'observed purchase')} · inside this deal’s window` }
      : { k: 'price', text: `Pays ${money(c.fit.price.low)}–${money(c.fit.price.high)}`, sub: 'meets this deal’s window' })
  }
  const nearCash = num(near.cash_share)
  if (nearCash !== null && num(near.n) >= 3) lines.push({ k: 'cash', text: `${Math.round(nearCash * 100)}% cash nearby` })
  else if (num(b.cash_share) !== null && num(b.acquisitions) >= 3) lines.push({ k: 'cash', text: `${Math.round(num(b.cash_share) * 100)}% cash overall` })
  if (c.fit?.size?.verdict === 'inside') lines.push({ k: 'size', text: `Buys ${Math.round(c.fit.size.low).toLocaleString('en-US')}–${Math.round(c.fit.size.high).toLocaleString('en-US')} sf`, sub: 'subject inside range' })
  const fc = num(b.foreclosure_deeds) ?? 0
  const linked = num(b.linked_transactions) ?? 0
  if (!c.lender && linked >= 2 && fc / linked >= 0.5) lines.push({ k: 'auction', text: `Buys at foreclosure auction`, sub: `${fc} of ${linked} purchases` })
  return lines
}

export function contactability(b = {}, contacts = {}) {
  if (contacts.suppressed?.has?.(b.buyer_id)) return { state: 'suppressed', label: 'Outreach suppressed' }
  if (contacts.verified?.has?.(b.buyer_id)) return { state: 'available', label: 'Contact available' }
  if (clean(b.kind) === 'company') return { state: 'company_identity_only', label: b.registry ? 'Registered company — no verified contact' : 'Company identity only' }
  return { state: 'none', label: 'No verified contact' }
}

const TIER_ORDER = { strong: 0, moderate: 1, exploratory: 2, excluded: 3 }
export function rankBuyers(rows) {
  return [...rows].sort((a, b) =>
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
    || (b.nearby?.sameFamily ?? 0) - (a.nearby?.sameFamily ?? 0)
    || (b.activity?.t365 ?? 0) - (a.activity?.t365 ?? 0)
    || (a.nearby?.nearestMiles ?? 99) - (b.nearby?.nearestMiles ?? 99)
    || (b.activity?.acquisitions ?? 0) - (a.activity?.acquisitions ?? 0))
}

/* ── shaping ──────────────────────────────────────────────────────────── */

function shapeBuyer(b, c, ctx, contacts) {
  const near = obj(b.near)
  const kind = clean(b.kind) === 'company' ? 'company' : 'person'
  const id = identityTier(b.identity_method)
  return {
    id: clean(b.buyer_id),
    kind,
    name: kind === 'company' ? displayableCompanyName(b.name) : null,
    nameWithheld: kind === 'company' && !displayableCompanyName(b.name) && !!clean(b.name),
    tier: c.tier,
    exclusions: c.exclusions,
    evidence: evidenceLines(b, c, ctx),
    fit: {
      type: c.fit.family,
      price: c.fit.price,
      recency: c.fit.recency,
      size: c.fit.size,
      market: c.sameNear >= 3 ? 'strong' : c.sameNear >= 1 ? 'present' : c.countyN >= 1 ? 'county' : 'none',
    },
    identity: { ...id, method: clean(b.identity_method) || null, registry: !!b.registry, jurisdiction: clean(b.jurisdiction) || null, aliases: num(b.aliases) ?? 0, confidence: num(b.identity_confidence) },
    activity: {
      acquisitions: num(b.acquisitions) ?? 0,
      dispositions: num(b.dispositions) ?? 0,
      first: clean(b.first_acquisition) || null,
      last: clean(b.last_acquisition) || null,
      daysSince: num(b.days_since_last),
      t90: num(b.t90) ?? 0,
      t180: num(b.t180) ?? 0,
      t365: num(b.t365) ?? 0,
      status: clean(b.activity_status) || null,
    },
    nearby: b.near ? {
      purchases: num(near.n) ?? 0,
      sameFamily: num(near.same_family) ?? 0,
      within1mi: num(near.n_1mi) ?? 0,
      sameZip: num(near.same_zip) ?? 0,
      nearestMiles: num(near.nearest_miles),
      last: clean(near.last_date) || null,
      medianPrice: num(near.median_price),
      cashShare: num(near.cash_share),
    } : null,
    countyPurchases: num(b.county_purchases) ?? 0,
    buyBox: {
      families: arr(b.families).map((f) => FAMILY_LABEL[f] || f),
      dominant: FAMILY_LABEL[clean(b.dominant_family)] || null,
      priceLow: pos(b.price_p25), priceMid: pos(b.price_p50), priceHigh: pos(b.price_p75),
      sqftLow: pos(b.sqft_p25), sqftHigh: pos(b.sqft_p75), beds: num(b.beds_p50), units: num(b.units_p50),
      cashShare: num(b.cash_share),
      markets: arr(b.counties).map((k) => clean(k).replace('|', ' · ')),
      primaryMarket: clean(b.primary_market).replace('|', ' · ') || null,
      topState: clean(b.top_state) || null,
      declared: !!b.has_buybox,
    },
    behavior: {
      archetype: ARCHETYPE_LABEL[clean(b.archetype)] ?? null,
      holdFlip: HOLD_FLIP_LABEL[clean(b.hold_flip)] ?? null,
      foreclosureDeeds: num(b.foreclosure_deeds) ?? 0,
      linkedTransactions: num(b.linked_transactions) ?? 0,
    },
    portfolio: { observed: num(b.portfolio) ?? 0, owned: num(b.owned) ?? 0, sold: num(b.sold) ?? 0, crossover: !!b.crossover },
    recent: arr(b.recent).map((r) => ({
      txnId: num(r.txn_id), propertyId: clean(r.property_id) || null, lat: num(r.lat), lng: num(r.lng), address: clean(r.address) || null, city: clean(r.city) || null,
      date: clean(r.date) || null, price: pos(r.price), family: FAMILY_LABEL[clean(r.family)] || clean(r.family) || null,
      sameFamily: clean(r.family) === ctx.family, beds: num(r.beds), sqft: pos(r.sqft), yearBuilt: pos(r.year_built),
      cash: r.cash === true ? true : r.cash === false ? false : null, miles: num(r.miles),
    })),
    contact: contactability(b, contacts),
  }
}

/* ── disposition state (read, never inferred) ─────────────────────────── */

async function readDispositionState(client, pid) {
  const safe = async (q) => { try { const r = await q; return r.error ? null : arr(r.data) } catch { return null } }
  const [targets, offers, agreements, closings, run] = await Promise.all([
    safe(client.from('buyer_outreach_targets').select('status, replied_at, reply_is_opt_out').eq('property_id', pid).limit(500)),
    safe(client.from('buyer_offers').select('status, selected_at, commitment_status, emd_status, emd_received_at').eq('property_id', pid).limit(200)),
    safe(client.from('buyer_agreements').select('status, executed_at').eq('property_id', pid).limit(100)),
    safe(client.from('closing_cases').select('buyer_id, disposition_status').eq('property_id', pid).limit(20)),
    safe(client.from('buyer_match_runs').select('buyer_match_run_id').eq('property_id', pid).order('created_at', { ascending: false }).limit(1)),
  ])
  const runId = arr(run)[0]?.buyer_match_run_id || null
  const cands = runId ? await safe(client.from('buyer_match_candidates').select('buyer_response_status, selected').eq('buyer_match_run_id', runId).limit(500)) : []
  const t = arr(targets)
  const o = arr(offers)
  const contactedStatuses = new Set(['queued', 'sending', 'sent', 'delivered', 'replied', 'failed_delivery'])
  return {
    readable: targets !== null && offers !== null,
    contacted: t.filter((x) => contactedStatuses.has(clean(x.status)) || x.replied_at).length,
    replied: t.filter((x) => x.replied_at && !x.reply_is_opt_out).length,
    markedInterested: arr(cands).filter((x) => clean(x.buyer_response_status) === 'interested').length,
    offers: o.filter((x) => !['withdrawn', 'rejected', 'superseded'].includes(clean(x.status))).length,
    selectedBuyer: o.some((x) => x.selected_at) || arr(closings).some((x) => clean(x.buyer_id)),
    committed: o.filter((x) => clean(x.commitment_status) === 'committed').length,
    agreementExecuted: arr(agreements).filter((x) => x.executed_at).length,
    emdReceived: o.filter((x) => x.emd_received_at || clean(x.emd_status) === 'received').length,
  }
}

/* ── workspace ────────────────────────────────────────────────────────── */

export async function getBuyerMatchWorkspace({ propertyId, radius = 5, months = 36 } = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const now = new Date(deps.now ?? Date.now())
  const pid = clean(propertyId)
  if (!pid) return null
  const radiusMiles = Math.min(25, Math.max(1, num(radius) ?? 5))
  const monthsBack = Math.min(60, Math.max(12, Math.round(num(months) ?? 36)))

  const raw = await loadSubjectProperty(pid, { supabase: client })
  if (!raw) return null
  const features = normalizePropertyFeatures(raw, { source: 'properties', now })
  const family = subjectFamily(features)
  const state = clean(raw.property_address_state).toUpperCase() || null
  const countyName = clean(raw.property_address_county_name) || null
  const countyKey = state && countyName ? `${state}|${countyName}` : null
  const zip = clean(raw.property_address_zip).slice(0, 5) || null
  const lat = num(features.latitude ?? raw.latitude)
  const lng = num(features.longitude ?? raw.longitude)

  const [scoreRes, oppRes, evidenceRes, disposition] = await Promise.all([
    client.from('property_acquisition_scores').select('valuation_mid, recommended_cash_offer, computed_at').eq('property_id', pid).order('computed_at', { ascending: false }).limit(1),
    client.from('acquisition_opportunities').select('id, acquisition_stage, asking_price, current_offer, recommended_offer').eq('primary_property_id', pid).order('updated_at', { ascending: false }).limit(1),
    lat !== null && lng !== null
      ? client.rpc('buyer_match_evidence', { p_lat: lat, p_lng: lng, p_family: family, p_county_key: countyKey, p_zip: zip, p_radius_miles: radiusMiles, p_months: monthsBack, p_limit: 120 })
      : Promise.resolve({ data: null, error: null }),
    readDispositionState(client, pid),
  ])
  if (evidenceRes.error) throw evidenceRes.error

  const score = arr(scoreRes.data)[0] || null
  const opp = arr(oppRes.data)[0] || null
  const value = pos(score?.valuation_mid) ?? pos(raw.estimated_value)
  const offer = pos(score?.recommended_cash_offer) ?? pos(opp?.recommended_offer)
  const window = dispositionWindow({ value, offer })

  const subject = {
    propertyId: pid,
    address: clean(raw.property_address_full) || null,
    city: clean(raw.property_address_city) || null,
    state,
    zip,
    county: countyName,
    market: clean(raw.market) || null,
    lat, lng,
    family,
    familyLabel: FAMILY_LABEL[family],
    propertyType: clean(raw.property_type) || null,
    units: pos(raw.units_count),
    beds: num(raw.total_bedrooms),
    baths: num(raw.total_baths),
    sqft: pos(raw.building_square_feet),
    yearBuilt: pos(raw.year_built),
    value,
    valueBasis: pos(score?.valuation_mid) ? 'deal_intelligence' : pos(raw.estimated_value) ? 'avm' : null,
    offer,
    ask: pos(opp?.asking_price),
    stage: clean(opp?.acquisition_stage) || null,
    opportunityId: clean(opp?.id) || null,
    window,
  }

  const ev = obj(evidenceRes.data)
  const ctx = { family, window, subject, radius: radiusMiles, months: monthsBack, zip, countyLabel: countyName ? `${countyName} County` : null }
  const contacts = { verified: new Set(), suppressed: new Set() } // buyer_contacts_v2 is keyed to the legacy universe and holds no W8C contacts
  let oneTimeIndividuals = 0
  const shaped = []
  for (const b of arr(ev.buyers)) {
    const c = classifyBuyer(b, ctx)
    if (!c) { oneTimeIndividuals += 1; continue }
    shaped.push(shapeBuyer(b, c, ctx, contacts))
  }
  const ranked = rankBuyers(shaped)
  const matched = ranked.filter((b) => b.tier !== 'excluded')
  const excluded = ranked.filter((b) => b.tier === 'excluded')
  const count = (t) => matched.filter((b) => b.tier === t).length
  const exclusionCounts = {}
  for (const b of excluded) for (const e of b.exclusions) exclusionCounts[e.code] = (exclusionCounts[e.code] ?? 0) + 1

  const fitBand = matched.filter((b) => b.tier !== 'exploratory' && b.buyBox.priceLow && b.buyBox.priceHigh)
  const bandLow = median(fitBand.map((b) => b.buyBox.priceLow))
  const bandHigh = median(fitBand.map((b) => b.buyBox.priceHigh))

  return {
    generatedAt: now.toISOString(),
    query: { radiusMiles, months: monthsBack, radiusOptions: RADIUS_OPTIONS, monthOptions: MONTH_OPTIONS },
    subject,
    counts: {
      matched: matched.length,
      strong: count('strong'),
      moderate: count('moderate'),
      exploratory: count('exploratory'),
      excluded: excluded.length,
      oneTimeIndividuals,
      exclusions: exclusionCounts,
    },
    market: {
      transactionsInRadius: num(ev.transactions_in_radius) ?? 0,
      sameTypeTransactionsInRadius: num(ev.same_family_transactions_in_radius) ?? 0,
      buyersInRadius: num(ev.buyers_in_radius) ?? 0,
      countyBuyersActive24m: num(ev.county_buyers_active_24m),
      nearbySimilarBuyers: matched.filter((b) => (b.nearby?.sameFamily ?? 0) >= 1 && (b.nearby?.nearestMiles ?? 99) <= 2).length,
      activeLast90: matched.filter((b) => (b.activity.t90 ?? 0) > 0).length,
      matchedPriceBand: bandLow && bandHigh ? { low: bandLow, high: bandHigh, buyers: fitBand.length } : null,
    },
    tierRules: TIER_RULES,
    disposition,
    contactability: {
      verified: matched.filter((b) => b.contact.state === 'available').length,
      outreachAvailable: false,
      note: 'No buyer in this universe has a verified contact on record — buyer outreach needs contact enrichment first.',
    },
    buyers: matched.slice(0, 60),
    excluded: excluded.slice(0, 24),
    lineage: {
      identity: 'W8C canonical buyer entities (shared with Entity Graph)',
      evidence: 'Recorded transactions resolved to buyers (comp_private)',
      window: `${radiusMiles} mi · last ${monthsBack} months, plus ${countyName ? `${countyName} County` : 'county'} activity in the last 24 months`,
    },
  }
}
