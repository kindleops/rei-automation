/**
 * FIXTURE · single-property Deep Research (DR §11 demo #1 + #3). SIMULATED.
 * Synthetic subject; Cuyahoga-shaped fixture sources. Shows: phases, the
 * shimmer status line, a reused fresh finding, parallel tasks, a gold
 * discovery (county-confirmed tax delinquency), an unavailable source (no
 * licensed listing provider — not evidence of absence), a vendor assumption
 * downgraded by the recorder, a labelled model inference, and a streamed brief.
 */
import { BRIEF_SECTIONS, renderOperationLabel, type BriefClaim } from '../contracts/contracts'
import { ScenarioWriter, fxFinding, retrievalSteps, type FixtureScenario, type SyntheticProperty } from './fixture-kit'
import { SRC } from './sources'

export const LARKSPUR: SyntheticProperty = {
  property_id: 'fx-prop-1418',
  address: '1418 Larkspur Ct',
  city: 'Cleveland, OH 44105',
  jurisdiction: 'Cuyahoga County',
  asset: 'Single family',
  beds_baths: '3 bd · 1 ba',
  sqft: 1236,
  year_built: 1924,
  owner_display: 'L. Marlow',
}

const P = LARKSPUR
const pid = 'fx-prop-1418' // = LARKSPUR.property_id, literal so the module stays tree-shakeable (a top-level property read is kept by the bundler)
const claim = (text: string, finding_ids: string[], evidence_status: BriefClaim['evidence_status'], confidence: number, source_name: string | null, is_inference = false, freshness_state: BriefClaim['freshness_state'] = 'fresh'): BriefClaim =>
  ({ text, finding_ids, evidence_status, confidence, freshness_state, source_name, is_inference })

export function singleDeepScenario(): FixtureScenario {
  const w = new ScenarioWriter()
  const ids = { property_id: pid }

  w.emit(0, 'job.created', { depth: 'deep', property_count: 1, estimate: { low_usd: 0.012, high_usd: 0.041, basis: 'worst_case', worst_case_usd: 0.75 }, cap: 0.75 })
  w.emit(0, 'job.property_state', { state: 'queued', display_address: `${P.address} (synthetic)`, counters: {} }, ids)
  // ── scope gate (explicit authorization) ──
  w.emit(150, 'job.confirmed', { depth: 'deep', property_count: 1, estimate: { low_usd: 0.012, high_usd: 0.041, basis: 'worst_case', worst_case_usd: 0.75 }, cap: 0.75, scope_sentence: 'Research 1 property · Deep · hard cap $0.75' })
  w.emit(300, 'job.phase', { phase: 'planning' })
  w.emit(320, 'job.property_state', { state: 'running', phase: 'planning' }, ids)

  // what LeadCommand already holds (internal reads, $0)
  w.emit(520, 'finding.upserted', { finding: fxFinding({ finding_id: 'fx-f-mort', property_id: pid, finding_type: 'mortgage', evidence_status: 'recorded', value: { original: 58400, year: 2011 }, display_value: '1st mortgage · 2011 · $58,400 original', source_id: SRC.lcRecorded.source_id, observed_at: '2026-10-07', retrieved_at: '2026-10-07', fresh_until: '2026-11-06', citation: 'seller.property_mortgage · position 1' }) }, ids)
  w.emit(560, 'plan.skipped_fresh', { finding_type: 'mortgage', cited_finding_id: 'fx-f-mort', canonical_ref: 'seller.property_mortgage', fresh_until: '2026-11-06', label: renderOperationLabel('research.reuse_fresh', { finding_label: 'mortgage', source_name: SRC.lcRecorded.name }) }, ids)
  w.emit(600, 'decision', { summary: 'Reusing recorded mortgage data refreshed 2026-10-07 — no new mortgage lookup planned.', basis_finding_ids: ['fx-f-mort'], criterion: 'fresh_in_supabase' }, ids)
  w.emit(680, 'finding.upserted', { finding: fxFinding({ finding_id: 'fx-f-occ', property_id: pid, finding_type: 'ownership', key: 'occupancy', evidence_status: 'vendor_reported', value: 'owner_occupied', display_value: 'Owner-occupied (vendor flag)', source_id: SRC.vendor.source_id, observed_at: '2026-06-30', freshness_state: 'aging', citation: 'vendor snapshot · owner_occupied=Y' }) }, ids)
  w.emit(700, 'finding.upserted', { finding: fxFinding({ finding_id: 'fx-f-vtax', property_id: pid, finding_type: 'tax_delinquency', key: 'vendor_tax_flag', evidence_status: 'vendor_reported', value: true, display_value: 'Tax delinquent (vendor flag)', source_id: SRC.vendor.source_id, observed_at: '2026-06-30', freshness_state: 'aging', citation: 'vendor snapshot · tax_delinquent=Y' }) }, ids)
  w.emit(760, 'decision', { summary: 'Vendor flags say tax-delinquent and owner-occupied. Neither is county-confirmed, so both are checked at the source.', basis_finding_ids: ['fx-f-vtax', 'fx-f-occ'], criterion: 'vendor_needs_confirmation' }, ids)

  const t1 = { id: 'fx-t-parcel', property: P, operation: 'research.match_parcel' as const, source: SRC.cuyFiscal, finding_type: 'parcel' as const, planned_at: 820 }
  const t2 = { id: 'fx-t-tax', property: P, operation: 'research.check' as const, source: SRC.cuyTreasurer, finding_type: 'tax_delinquency' as const, planned_at: 860, depends_on: ['fx-t-parcel'] }
  const t3 = { id: 'fx-t-code', property: P, operation: 'research.check' as const, source: SRC.cleCode, finding_type: 'code_violation' as const, planned_at: 900, depends_on: ['fx-t-parcel'] }
  const t4 = { id: 'fx-t-fcl', property: P, operation: 'research.check' as const, source: SRC.cuyClerk, finding_type: 'foreclosure' as const, planned_at: 940, depends_on: ['fx-t-parcel'] }
  const t5 = { id: 'fx-t-own', property: P, operation: 'research.check' as const, source: SRC.cuyRecorder, finding_type: 'ownership' as const, planned_at: 980, depends_on: ['fx-t-parcel'] }
  const t6 = { id: 'fx-t-list', property: P, operation: 'research.check' as const, source: SRC.listing, finding_type: 'listing_status' as const, planned_at: 1020, billable: true }
  const t7 = { id: 'fx-t-comps', property: P, operation: 'research.check' as const, source: SRC.lcComps, finding_type: 'comparable_sales' as const, planned_at: 1060 }
  const t8 = { id: 'fx-t-buyers', property: P, operation: 'research.check' as const, source: SRC.lcBuyers, finding_type: 'investor_demand' as const, planned_at: 1100 }

  w.emit(1300, 'job.phase', { phase: 'researching' })
  w.emit(1300, 'job.property_state', { state: 'running', phase: 'researching' }, ids)

  w.task({ ...t1, start: 1450, steps: [
    ...retrievalSteps(SRC.cuyFiscal, 'parcel match', '2026-10-08', 18_412, [240, 560, 980]),
    ['observation.extracted', 1120, { observation_ids: ['fx-o-1'], finding_type: 'parcel', display_value: 'Parcel 128-07-044 · exact situs match', citation: 'parcel_roll.parcel_id' }],
    ['finding.upserted', 1240, { finding: fxFinding({ finding_id: 'fx-f-parcel', property_id: pid, finding_type: 'parcel', evidence_status: 'county_confirmed', value: '128-07-044', display_value: 'Parcel 128-07-044 · exact situs match', source_id: SRC.cuyFiscal.source_id, observed_at: '2026-10-08', retrieved_at: '2026-10-08', fresh_until: '2027-01-06', citation: 'parcel_roll.parcel_id = 128-07-044' }) }],
  ], end: ['task.completed', 1320, { duration_ms: 1320, cost_usd: 0, observation_count: 2 }] })

  w.task({ ...t2, start: 2900, steps: [
    ...retrievalSteps(SRC.cuyTreasurer, 'tax status', '2026-10-08', 2_406_118, [280, 700, 1480]),
    ['observation.extracted', 1640, { observation_ids: ['fx-o-2'], finding_type: 'tax_delinquency', display_value: 'Delinquent $1,804.22 · 2 half-years', citation: 'delinquent_list row 41,207 · balance_due' }],
    ['finding.upserted', 1780, { finding: fxFinding({ finding_id: 'fx-f-tax', property_id: pid, finding_type: 'tax_delinquency', evidence_status: 'county_confirmed', value: { balance: 1804.22, half_years: 2 }, display_value: 'Delinquent $1,804.22 · 2 half-years', is_discovery: true, source_id: SRC.cuyTreasurer.source_id, observed_at: '2026-10-01', retrieved_at: '2026-10-08', fresh_until: '2026-11-01', citation: 'delinquent_list 2026-10-01 · parcel 128-07-044 · balance_due 1804.22' }) }],
    ['usage.settled', 1840, { reserve_id: 'fx-res-tax', op_type: 'research.fetch', route: 'research.fetch', provider: 'fixture', model: null, tokens: 0, actual_usd: 0, accrued_usd: 0, remaining_usd: 0.75 }],
  ], end: ['task.completed', 1900, { duration_ms: 1900, cost_usd: 0, observation_count: 1 }] })
  w.emit(4860, 'decision', { summary: 'County list confirms the delinquency ($1,804.22). The vendor flag agrees — now backed by an official source.', basis_finding_ids: ['fx-f-tax', 'fx-f-vtax'], criterion: 'county_confirmed' }, ids)

  w.task({ ...t3, start: 2980, steps: [
    ...retrievalSteps(SRC.cleCode, 'code violations', '2026-10-08', 41_220, [300, 820, 1500]),
    ['observation.extracted', 1700, { observation_ids: ['fx-o-3'], finding_type: 'code_violation', display_value: 'Open case · exterior maintenance · opened 2026-08-14', citation: 'code_cases.case_status = OPEN' }],
    ['finding.upserted', 1880, { finding: fxFinding({ finding_id: 'fx-f-code', property_id: pid, finding_type: 'code_violation', evidence_status: 'county_confirmed', value: { open: 1, type: 'exterior maintenance' }, display_value: 'Open exterior-maintenance case (Aug 2026)', source_id: SRC.cleCode.source_id, observed_at: '2026-08-14', retrieved_at: '2026-10-08', fresh_until: '2026-10-22', citation: 'case CE-26-0814 · status OPEN' }) }],
  ], end: ['task.completed', 2000, { duration_ms: 2000, cost_usd: 0, observation_count: 1 }] })

  w.task({ ...t4, start: 4900, steps: [
    ...retrievalSteps(SRC.cuyClerk, 'foreclosure filings', '2026-10-08', 9_880, [260, 720, 1240]),
    ['observation.extracted', 1380, { observation_ids: ['fx-o-4'], finding_type: 'foreclosure', display_value: 'No foreclosure case for parcel 128-07-044', citation: 'docket search · parcel 128-07-044 · 0 cases' }],
    ['finding.upserted', 1480, { finding: fxFinding({ finding_id: 'fx-f-fcl', property_id: pid, finding_type: 'foreclosure', evidence_status: 'county_confirmed', value: { cases: 0 }, display_value: 'No foreclosure case filed', is_negative_claim: true, source_id: SRC.cuyClerk.source_id, observed_at: '2026-10-08', retrieved_at: '2026-10-08', fresh_until: '2026-10-22', citation: 'docket covers Cuyahoga Common Pleas · 0 cases' }) }],
  ], end: ['task.completed', 1560, { duration_ms: 1560, cost_usd: 0, observation_count: 1 }] })

  w.task({ ...t5, start: 5000, steps: [
    ...retrievalSteps(SRC.cuyRecorder, 'ownership', '2026-10-08', 12_604, [320, 900, 1600]),
    ['observation.extracted', 1760, { observation_ids: ['fx-o-5'], finding_type: 'ownership', display_value: 'Deed 2009 · owner mailing address Tucson, AZ', citation: 'deed 200906110412 · grantee mailing address' }],
    ['finding.upserted', 1900, { finding: fxFinding({ finding_id: 'fx-f-own', property_id: pid, finding_type: 'ownership', evidence_status: 'recorded', value: { since: 2009, mailing_state: 'AZ' }, display_value: 'Owned since 2009 · mailing address out of state', source_id: SRC.cuyRecorder.source_id, observed_at: '2009-06-11', retrieved_at: '2026-10-08', fresh_until: '2027-01-06', citation: 'deed 200906110412' }) }],
  ], end: ['task.completed', 2000, { duration_ms: 2000, cost_usd: 0, observation_count: 1 }] })
  // the vendor assumption is downgraded (contradicted) by the recorder
  w.emit(7050, 'finding.conflict', { conflict_group_id: 'fx-cg-occ', finding_type: 'ownership', members: ['fx-f-occ', 'fx-f-own'], rule: 'recorded_beats_vendor', resolution_state: 'resolved_by_rule' }, ids)
  w.emit(7100, 'finding.upserted', { finding: fxFinding({ finding_id: 'fx-f-occ', property_id: pid, finding_type: 'ownership', key: 'occupancy', evidence_status: 'vendor_reported', value: 'owner_occupied', display_value: 'Owner-occupied (vendor flag)', source_id: SRC.vendor.source_id, observed_at: '2026-06-30', freshness_state: 'aging', contradicted_by: 'fx-f-own', conflict_group_id: 'fx-cg-occ', confidence: 0.2, citation: 'vendor snapshot · owner_occupied=Y' }) }, ids)
  w.emit(7160, 'decision', { summary: 'The recorder shows an out-of-state mailing address since 2009, so the vendor "owner-occupied" flag is contradicted. Treating the owner as absentee.', basis_finding_ids: ['fx-f-own', 'fx-f-occ'], criterion: 'recorded_beats_vendor' }, ids)

  w.task({ ...t6, start: 6600, steps: [
    ['finding.upserted', 300, { finding: fxFinding({ finding_id: 'fx-f-list', property_id: pid, finding_type: 'listing_status', evidence_status: 'unavailable', value: null, display_value: null, freshness_state: 'never', source_id: SRC.listing.source_id }) }],
  ], end: ['task.unavailable', 340, { reason: 'no_supported_source_for_jurisdiction', retry_at: null }] })

  w.task({ ...t7, start: 7300, steps: [
    ['source.searched', 220, { source_id: SRC.lcComps.source_id, host: SRC.lcComps.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-comps', purpose: 'comparable sales' }],
    ['source.retrieved', 780, { source_id: SRC.lcComps.source_id, host: SRC.lcComps.host, http_class: '2xx', bytes: 6_204, retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-comps', purpose: 'comparable sales' }],
    ['observation.extracted', 960, { observation_ids: ['fx-o-6'], finding_type: 'comparable_sales', display_value: '6 investor-cluster sales · ≤ 0.4 mi · $58k–$71k', citation: 'v_recent_sold_comps · 12 mo · LLC buyers' }],
    ['finding.upserted', 1080, { finding: fxFinding({ finding_id: 'fx-f-comps', property_id: pid, finding_type: 'comparable_sales', evidence_status: 'recorded', value: { n: 6, median: 64500 }, display_value: '6 investor sales ≤ 0.4 mi · median $64,500', source_id: SRC.lcComps.source_id, observed_at: '2026-10-07', retrieved_at: '2026-10-08', fresh_until: '2026-10-22', citation: 'investor cluster lane · 12 months' }) }],
  ], end: ['task.completed', 1160, { duration_ms: 1160, cost_usd: 0, observation_count: 6 }] })

  w.task({ ...t8, start: 8600, steps: [
    ['source.searched', 200, { source_id: SRC.lcBuyers.source_id, host: SRC.lcBuyers.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-buyers', purpose: 'investor demand' }],
    ['source.retrieved', 640, { source_id: SRC.lcBuyers.source_id, host: SRC.lcBuyers.host, http_class: '2xx', bytes: 3_310, retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-buyers', purpose: 'investor demand' }],
    ['observation.extracted', 800, { observation_ids: ['fx-o-7'], finding_type: 'investor_demand', display_value: '11 cash buyers bought in 44105 · last 12 months', citation: 'buyer index · zip 44105' }],
    ['finding.upserted', 900, { finding: fxFinding({ finding_id: 'fx-f-buyers', property_id: pid, finding_type: 'investor_demand', evidence_status: 'recorded', value: { buyers: 11 }, display_value: '11 cash buyers in 44105 (12 mo)', source_id: SRC.lcBuyers.source_id, observed_at: '2026-10-07', retrieved_at: '2026-10-08', fresh_until: '2026-10-22', citation: 'recorded purchases · 12 months' }) }],
  ], end: ['task.completed', 980, { duration_ms: 980, cost_usd: 0, observation_count: 11 }] })

  // ── analyzing: one model extraction over the code-case notes (unstructured) ──
  w.emit(9800, 'job.phase', { phase: 'analyzing' })
  w.emit(9800, 'job.property_state', { state: 'running', phase: 'analyzing' }, ids)
  w.task({ id: 'fx-t-extract', property: P, operation: 'research.extract', source: SRC.cleCode, finding_type: 'physical_condition', planned_at: 9700, start: 9900, billable: true, steps: [
    ['usage.reserved', 60, { reserve_id: 'fx-res-x1', op_type: 'research.extract', route: 'research.extract', provider: 'fixture', model: 'fixture-haiku', worst_case_usd: 0.02, remaining_usd: 0.75 }],
    ['observation.extracted', 1500, { observation_ids: ['fx-o-8'], finding_type: 'physical_condition', display_value: 'Case notes cite roof covering, gutters, porch steps', citation: 'case CE-26-0814 · inspector notes ¶2' }],
    ['finding.upserted', 1640, { finding: fxFinding({ finding_id: 'fx-f-cond', property_id: pid, finding_type: 'physical_condition', evidence_status: 'model_inference', value: ['roof', 'gutters', 'porch steps'], display_value: 'Exterior wear: roof, gutters, porch steps', confidence: 0.5, source_id: SRC.cleCode.source_id, observed_at: '2026-08-14', retrieved_at: '2026-10-08', citation: 'inferred from case CE-26-0814 notes' }) }],
    ['usage.settled', 1700, { reserve_id: 'fx-res-x1', op_type: 'research.extract', route: 'research.extract', provider: 'fixture', model: 'fixture-haiku', tokens: 1840, actual_usd: 0.004, accrued_usd: 0.004, remaining_usd: 0.746 }],
  ], end: ['task.completed', 1760, { duration_ms: 1760, cost_usd: 0.004, observation_count: 1 }] })

  // ── cross-checking ──
  w.emit(11800, 'job.phase', { phase: 'cross_checking' })
  w.emit(11800, 'job.property_state', { state: 'running', phase: 'cross_checking' }, ids)
  w.task({ id: 'fx-t-xc', property: P, operation: 'research.cross_check', source: SRC.cuyTreasurer, other_source: SRC.vendor, finding_type: 'tax_delinquency', planned_at: 11700, start: 11900, steps: [
    ['finding.conflict', 700, { conflict_group_id: 'fx-cg-tax', finding_type: 'tax_delinquency', members: ['fx-f-tax', 'fx-f-vtax'], rule: 'agreement', resolution_state: 'resolved_by_rule' }],
  ], end: ['task.completed', 900, { duration_ms: 900, cost_usd: 0, observation_count: 0 }] })

  // ── synthesizing: the brief streams section by section ──
  w.emit(13000, 'job.phase', { phase: 'synthesizing' })
  w.emit(13000, 'job.property_state', { state: 'running', phase: 'synthesizing' }, ids)
  w.emit(13050, 'usage.reserved', { reserve_id: 'fx-res-syn', op_type: 'research.synthesize', route: 'research.synthesize', provider: 'fixture', model: 'fixture-sonnet', worst_case_usd: 0.09, remaining_usd: 0.746 }, ids)
  const sections: Record<string, BriefClaim[]> = {
    property_ownership: [
      claim('Parcel 128-07-044 — exact situs match on the county parcel roll', ['fx-f-parcel'], 'county_confirmed', 0.94, SRC.cuyFiscal.name),
      claim('Owned since 2009; the owner’s mailing address is out of state (Tucson, AZ)', ['fx-f-own'], 'recorded', 0.88, SRC.cuyRecorder.name),
      claim('Vendor “owner-occupied” flag — contradicted by the recorder', ['fx-f-occ'], 'vendor_reported', 0.2, SRC.vendor.name, false, 'aging'),
    ],
    physical_condition: [
      claim('Open exterior-maintenance code case since 2026-08-14', ['fx-f-code'], 'county_confirmed', 0.92, SRC.cleCode.name),
      claim('Exterior wear on roof, gutters and porch steps', ['fx-f-cond'], 'model_inference', 0.5, SRC.cleCode.name, true),
    ],
    taxes_liens: [
      claim('Tax delinquent $1,804.22 (two half-years) on the county delinquent list', ['fx-f-tax'], 'county_confirmed', 0.95, SRC.cuyTreasurer.name),
      claim('One recorded first mortgage (2011, $58,400 original)', ['fx-f-mort'], 'recorded', 0.88, SRC.lcRecorded.name),
    ],
    foreclosure_legal: [claim('No foreclosure case filed for the parcel (docket covers Cuyahoga Common Pleas)', ['fx-f-fcl'], 'county_confirmed', 0.9, SRC.cuyClerk.name)],
    listing_history: [claim('Listing status unavailable — no licensed listing provider for this jurisdiction. Not evidence that it is unlisted.', ['fx-f-list'], 'unavailable', 0, SRC.listing.name, false, 'never')],
    comparable_sales: [claim('6 investor-cluster sales within 0.4 mi in 12 months · median $64,500', ['fx-f-comps'], 'recorded', 0.86, SRC.lcComps.name)],
    investor_demand: [claim('11 cash buyers purchased in 44105 in the last 12 months', ['fx-f-buyers'], 'recorded', 0.84, SRC.lcBuyers.name)],
    risks_unresolved: [
      claim('Listing status could not be checked', ['fx-f-list'], 'unavailable', 0, SRC.listing.name, false, 'never'),
      claim('Condition is inferred from code-case notes, not inspected', ['fx-f-cond'], 'model_inference', 0.5, SRC.cleCode.name, true),
    ],
    next_investigation: [
      claim('Street View or drive-by check of roof and porch', [], 'unverified', 0.3, null),
      claim('Re-confirm the delinquent balance with the Treasurer before any offer', ['fx-f-tax'], 'unverified', 0.3, null),
    ],
  }
  let t = 13200
  for (const s of BRIEF_SECTIONS) {
    if (s.key === 'acquisition_economics') continue
    const claims = sections[s.key] ?? []
    const id = `fx-t-syn-${s.key}`
    w.task({ id, property: P, operation: 'research.synthesize_section', source: SRC.model, finding_type: null, section_label: s.label, planned_at: 12950, start: t, steps: [
      ['brief.section', 420, { section_key: s.key, label: s.label, claims, claim_count: claims.length, finding_refs: [...new Set(claims.flatMap((c) => c.finding_ids))] }],
    ], end: ['task.completed', 460, { duration_ms: 460, cost_usd: 0, observation_count: 0 }] })
    t += 520
  }
  w.emit(t + 40, 'usage.settled', { reserve_id: 'fx-res-syn', op_type: 'research.synthesize', route: 'research.synthesize', provider: 'fixture', model: 'fixture-sonnet', tokens: 6120, actual_usd: 0.027, accrued_usd: 0.031, remaining_usd: 0.719 }, ids)
  w.emit(t + 120, 'brief.completed', { opportunity_class: 'strong', contact_readiness_class: 'unknown', sections_missing: [] }, ids)
  w.emit(t + 140, 'job.property_state', { state: 'completed', phase: 'complete', opportunity_class: 'strong', contact_readiness_class: 'unknown' }, ids)
  w.emit(t + 200, 'job.phase', { phase: 'complete' })
  w.emit(t + 240, 'job.completed', { state: 'completed', summary: 'Deep Research complete · 1 discovery · 1 source unavailable · 1 vendor assumption contradicted', accrued_usd: 0.031 })

  return {
    id: 'single-deep', kind: 'research', depth: 'deep',
    title: `${P.address} (synthetic)`, subtitle: `${P.city} · Deep Research`,
    properties: [P],
    sources: [SRC.lcRecorded, SRC.vendor, SRC.cuyFiscal, SRC.cuyTreasurer, SRC.cleCode, SRC.cuyClerk, SRC.cuyRecorder, SRC.listing, SRC.lcComps, SRC.lcBuyers, SRC.model],
    log: w.sorted(),
    confirm_gate: 100,
  }
}
