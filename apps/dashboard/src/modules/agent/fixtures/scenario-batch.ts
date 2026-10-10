/**
 * FIXTURE · 25-property batch (DR §11 demo #2). SIMULATED. Deterministic
 * generator over SYNTHETIC addresses in the three pilot jurisdictions
 * (St. Louis City → Hennepin → Cuyahoga). Concurrency 2 (owner cap). Shows the
 * batch counters, the property under investigation, blocked / failed source
 * operations, gold high-priority discoveries, a property skipped as already
 * fresh, accrued cost vs remaining budget, and per-property brief sections.
 */
import { renderOperationLabel, type BriefClaim, type OpportunityClass } from '../contracts/contracts'
import { ScenarioWriter, fxFinding, type FixtureScenario, type SyntheticProperty } from './fixture-kit'
import { SRC } from './sources'

const STREETS = ['Wren Hollow Ln', 'Cobalt Ave', 'Fennimore St', 'Larch Bend Rd', 'Quillon Ct', 'Hearthstone Dr', 'Ostrander Ave', 'Pell Mell Way', 'Gannet St', 'Brisbane Ter', 'Calloway Pl', 'Juniper Fold Rd', 'Ashcombe Ave']
// a function, not a top-level array: top-level reads of SRC.* would keep the fixture sources in production bundles
const JURIS = () => [
  { name: 'St. Louis City', city: 'St. Louis, MO 6311', parcel: SRC.stlAssessor, tax: SRC.stlCollector, code: SRC.stlCsb },
  { name: 'Hennepin County', city: 'Minneapolis, MN 5541', parcel: SRC.henParcel, tax: SRC.henParcel, code: SRC.mplsCode },
  { name: 'Cuyahoga County', city: 'Cleveland, OH 4410', parcel: SRC.cuyFiscal, tax: SRC.cuyTreasurer, code: SRC.cleCode },
] as const

export const BATCH_SIZE = 25
const DISCOVERY = new Set([2, 8, 13, 19])
const BLOCKED = new Set([3, 9, 18])      // St. Louis collector CAPTCHA (St. Louis City rows: index % 3 === 0)
const FAILED = new Set([5, 14, 22])      // code source timeout
const FRESH = new Set([11])              // researched 3 days ago → skipped

export function batchProperties(): SyntheticProperty[] {
  const out: SyntheticProperty[] = []
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const j = JURIS()[i % 3]
    out.push({
      property_id: `fx-prop-b${String(i + 1).padStart(2, '0')}`,
      address: `${210 + ((i * 137) % 7700)} ${STREETS[i % STREETS.length]}`,
      city: `${j.city}${(i * 3) % 10}`,
      jurisdiction: j.name,
      asset: i % 5 === 4 ? 'Duplex' : 'Single family',
      beds_baths: i % 5 === 4 ? '2 × 2 bd · 1 ba' : `${2 + (i % 3)} bd · ${1 + (i % 2)} ba`,
      sqft: 880 + ((i * 97) % 1100),
      year_built: 1905 + ((i * 11) % 80),
      owner_display: `Owner ${String.fromCharCode(65 + (i % 26))}.`,
    })
  }
  return out
}

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`

export function batchScenario(): FixtureScenario {
  const w = new ScenarioWriter()
  const props = batchProperties()
  const estimate = { low_usd: 0.3, high_usd: 0.95, basis: 'worst_case', worst_case_usd: 18.75 }
  w.emit(0, 'job.created', { depth: 'deep', property_count: BATCH_SIZE, estimate, cap: 18.75 })
  for (const p of props) w.emit(0, 'job.property_state', { state: 'queued', display_address: `${p.address} (synthetic)`, counters: {} }, { property_id: p.property_id })
  w.emit(150, 'job.confirmed', { depth: 'deep', property_count: BATCH_SIZE, estimate, cap: 18.75, scope_sentence: 'Research 25 properties · Deep · hard cap $0.75 each · batch cap $18.75 (≤ $25)' })
  w.emit(300, 'job.phase', { phase: 'planning' })
  w.emit(500, 'decision', { summary: '1 property was researched 3 days ago and is still fresh — skipped at $0. 24 properties planned, 2 at a time.', basis_finding_ids: [], criterion: 'fresh_in_supabase' })
  w.emit(900, 'job.phase', { phase: 'researching' })

  const lanes = [1000, 1000]
  let accrued = 0
  props.forEach((p, i) => {
    const j = JURIS()[i % 3]
    const ids = { property_id: p.property_id }
    if (FRESH.has(i)) {
      w.emit(520, 'plan.skipped_fresh', { finding_type: 'tax_status', cited_finding_id: `fx-f-b${i}-prior`, canonical_ref: 'research.finding', fresh_until: '2026-10-19', label: renderOperationLabel('research.reuse_fresh', { finding_label: 'research brief', source_name: 'previous Deep pass (2026-10-05)' }) }, ids)
      w.emit(540, 'job.property_state', { state: 'skipped_fresh', phase: 'complete', opportunity_class: 'standard', contact_readiness_class: 'unknown' }, ids)
      return
    }
    const lane = lanes[0] <= lanes[1] ? 0 : 1
    let t = lanes[lane]
    w.emit(t, 'job.property_state', { state: 'running', phase: 'researching' }, ids)
    const tid = (k: string) => `fx-t-b${i}-${k}`
    // parcel
    w.task({ id: tid('parcel'), property: p, operation: 'research.match_parcel', source: j.parcel, finding_type: 'parcel', planned_at: 600 + i * 8, start: t + 60, steps: [
      ['source.searched', 160, { source_id: j.parcel.source_id, host: j.parcel.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-p`, purpose: 'parcel match' }],
      ['source.retrieved', 560, { source_id: j.parcel.source_id, host: j.parcel.host, http_class: '2xx', bytes: 9_000 + i * 31, retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-p`, purpose: 'parcel match' }],
      ['finding.upserted', 640, { finding: fxFinding({ finding_id: `fx-f-b${i}-parcel`, property_id: p.property_id, finding_type: 'parcel', evidence_status: 'county_confirmed', value: `P-${1000 + i}`, display_value: `Parcel P-${1000 + i} · exact match`, source_id: j.parcel.source_id, retrieved_at: '2026-10-08' }) }],
    ], end: ['task.completed', 700, { duration_ms: 700, cost_usd: 0, observation_count: 1 }] })
    t += 820
    // tax
    const discovery = DISCOVERY.has(i)
    const blocked = BLOCKED.has(i)
    const delinquent = discovery || i % 4 === 1
    const bal = 900 + ((i * 311) % 4200) + 0.18
    if (blocked) {
      w.task({ id: tid('tax'), property: p, operation: 'research.check', source: SRC.stlCollector, finding_type: 'tax_status', planned_at: 600 + i * 8 + 1, start: t, steps: [
        ['source.searched', 180, { source_id: SRC.stlCollector.source_id, host: SRC.stlCollector.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-t`, purpose: 'tax status' }],
        ['source.blocked', 520, { source_id: SRC.stlCollector.source_id, host: SRC.stlCollector.host, reason: 'captcha_detected', message: 'St. Louis Collector of Revenue presents a CAPTCHA to automated requests.', alternatives: ['St. Louis City Assessor · parcels', 'Open in Browser (manual lookup)'], retry_at: null }],
        ['finding.upserted', 560, { finding: fxFinding({ finding_id: `fx-f-b${i}-tax`, property_id: p.property_id, finding_type: 'tax_status', evidence_status: 'blocked', value: null, display_value: null, freshness_state: 'never', source_id: SRC.stlCollector.source_id }) }],
      ], end: ['task.blocked', 580, { reason: 'captcha_detected', duration_ms: 580, alternatives: ['St. Louis City Assessor · parcels', 'Open in Browser (manual lookup)'] }] })
    } else {
      w.task({ id: tid('tax'), property: p, operation: 'research.check', source: j.tax, finding_type: 'tax_delinquency', planned_at: 600 + i * 8 + 1, start: t, steps: [
        ['source.searched', 200, { source_id: j.tax.source_id, host: j.tax.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-t`, purpose: 'tax status' }],
        ['source.retrieved', 820, { source_id: j.tax.source_id, host: j.tax.host, http_class: '2xx', bytes: 40_000 + i * 77, retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-t`, purpose: 'tax status' }],
        ['finding.upserted', 900, { finding: fxFinding({ finding_id: `fx-f-b${i}-tax`, property_id: p.property_id, finding_type: 'tax_delinquency', evidence_status: 'county_confirmed', value: delinquent ? { balance: bal } : { balance: 0 }, display_value: delinquent ? `Delinquent ${money(bal)}` : 'Current', is_discovery: discovery, source_id: j.tax.source_id, retrieved_at: '2026-10-08' }) }],
      ], end: ['task.completed', 960, { duration_ms: 960, cost_usd: 0, observation_count: 1 }] })
    }
    // code (parallel with tax inside the lane)
    const failed = FAILED.has(i)
    if (failed) {
      w.task({ id: tid('code'), property: p, operation: 'research.check', source: j.code, finding_type: 'code_violation', planned_at: 600 + i * 8 + 2, start: t + 120, steps: [
        ['source.searched', 200, { source_id: j.code.source_id, host: j.code.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-c`, purpose: 'code violations' }],
        ['source.failed', 1500, { source_id: j.code.source_id, host: j.code.host, reason: 'timeout', retry_at: '2026-10-08T22:00:00Z' }],
      ], end: ['task.failed', 1520, { error_code: 'timeout', duration_ms: 1520, retry_at: '2026-10-08T22:00:00Z' }] })
    } else {
      w.task({ id: tid('code'), property: p, operation: 'research.check', source: j.code, finding_type: discovery ? 'condemnation' : 'code_violation', planned_at: 600 + i * 8 + 2, start: t + 120, steps: [
        ['source.searched', 220, { source_id: j.code.source_id, host: j.code.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-c`, purpose: 'code violations' }],
        ['source.retrieved', 900, { source_id: j.code.source_id, host: j.code.host, http_class: '2xx', bytes: 12_000 + i * 51, retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-c`, purpose: 'code violations' }],
        ['finding.upserted', 980, { finding: fxFinding({ finding_id: `fx-f-b${i}-code`, property_id: p.property_id, finding_type: discovery ? 'condemnation' : 'code_violation', evidence_status: 'county_confirmed', value: discovery ? { condemned: true } : { open: i % 3 === 2 ? 1 : 0 }, display_value: discovery ? 'Condemnation order (2026)' : i % 3 === 2 ? '1 open code case' : 'No open code case', is_discovery: discovery, is_negative_claim: !discovery && i % 3 !== 2, source_id: j.code.source_id, retrieved_at: '2026-10-08' }) }],
      ], end: ['task.completed', 1040, { duration_ms: 1040, cost_usd: 0, observation_count: 1 }] })
    }
    t += 1300
    // comps (internal) + one extraction for some
    w.task({ id: tid('comps'), property: p, operation: 'research.check', source: SRC.lcComps, finding_type: 'comparable_sales', planned_at: 600 + i * 8 + 3, start: t, steps: [
      ['source.retrieved', 420, { source_id: SRC.lcComps.source_id, host: SRC.lcComps.host, http_class: '2xx', bytes: 3_000 + i * 17, retrieved_at: '2026-10-08', fetch_id: `fx-fetch-b${i}-m`, purpose: 'comparable sales' }],
      ['finding.upserted', 500, { finding: fxFinding({ finding_id: `fx-f-b${i}-comps`, property_id: p.property_id, finding_type: 'comparable_sales', evidence_status: 'recorded', value: { n: 3 + (i % 5) }, display_value: `${3 + (i % 5)} investor sales nearby`, source_id: SRC.lcComps.source_id, retrieved_at: '2026-10-08' }) }],
    ], end: ['task.completed', 540, { duration_ms: 540, cost_usd: 0, observation_count: 3 + (i % 5) }] })
    t += 600
    // synthesis (billable, fixture-priced)
    const usd = Math.round((0.009 + (i % 4) * 0.003) * 1000) / 1000
    accrued = Math.round((accrued + usd) * 1000) / 1000
    w.task({ id: tid('syn'), property: p, operation: 'research.synthesize_section', source: SRC.model, finding_type: null, section_label: 'Taxes & liens', planned_at: 600 + i * 8 + 4, start: t, billable: true, steps: [
      ['usage.reserved', 40, { reserve_id: `fx-res-b${i}`, op_type: 'research.synthesize', route: 'research.synthesize', provider: 'fixture', model: 'fixture-haiku', worst_case_usd: 0.05, remaining_usd: Math.round((18.75 - accrued + usd) * 1000) / 1000 }],
      ['brief.section', 520, { section_key: 'taxes_liens', label: 'Taxes & liens', claims: [blocked
        ? { text: 'Tax status not read — the collector blocks automated access. Not evidence of current taxes.', finding_ids: [`fx-f-b${i}-tax`], evidence_status: 'blocked', confidence: 0, freshness_state: 'never', source_name: SRC.stlCollector.name, is_inference: false }
        : { text: delinquent ? `Tax delinquent ${money(bal)}` : 'Taxes current', finding_ids: [`fx-f-b${i}-tax`], evidence_status: 'county_confirmed', confidence: 0.93, freshness_state: 'fresh', source_name: j.tax.name, is_inference: false }] as BriefClaim[], claim_count: 1, finding_refs: [`fx-f-b${i}-tax`] }],
      ['usage.settled', 600, { reserve_id: `fx-res-b${i}`, op_type: 'research.synthesize', route: 'research.synthesize', provider: 'fixture', model: 'fixture-haiku', tokens: 1200 + i * 9, actual_usd: usd, accrued_usd: accrued, remaining_usd: Math.round((18.75 - accrued) * 1000) / 1000 }],
    ], end: ['task.completed', 640, { duration_ms: 640, cost_usd: usd, observation_count: 0 }] })
    t += 700
    const opp: OpportunityClass = blocked ? 'unknown' : discovery ? 'priority' : delinquent ? 'strong' : i % 3 === 0 ? 'weak' : 'standard'
    if (discovery) w.emit(t - 40, 'decision', { summary: `High-priority: ${p.address} (synthetic) is county-confirmed tax-delinquent with a condemnation order.`, basis_finding_ids: [`fx-f-b${i}-tax`, `fx-f-b${i}-code`], criterion: 'discovery' }, ids)
    w.emit(t, 'brief.completed', { opportunity_class: opp, contact_readiness_class: 'unknown', sections_missing: failed ? ['physical_condition'] : [] }, ids)
    w.emit(t + 20, 'job.property_state', { state: blocked || failed ? 'completed_partial' : 'completed', phase: 'complete', opportunity_class: opp, contact_readiness_class: 'unknown' }, ids)
    lanes[lane] = t + 80
  })
  const end = Math.max(...lanes) + 200
  w.emit(end, 'job.phase', { phase: 'synthesizing' })
  w.emit(end + 400, 'job.phase', { phase: 'complete' })
  w.emit(end + 460, 'job.completed', { state: 'completed_partial', summary: `24 researched · 1 fresh · ${DISCOVERY.size} high-priority · ${BLOCKED.size} blocked · ${FAILED.size} failed sources`, accrued_usd: accrued })

  return {
    id: 'batch-25', kind: 'research', depth: 'deep',
    title: 'Pilot cohort · 25 properties (synthetic)', subtitle: 'St. Louis City · Hennepin · Cuyahoga · Deep Research',
    properties: props,
    sources: [SRC.stlAssessor, SRC.stlCollector, SRC.stlCsb, SRC.henParcel, SRC.mplsCode, SRC.cuyFiscal, SRC.cuyTreasurer, SRC.cleCode, SRC.lcComps, SRC.model],
    log: w.sorted(),
    confirm_gate: 100,
  }
}
