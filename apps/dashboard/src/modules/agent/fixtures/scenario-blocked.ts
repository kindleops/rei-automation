/**
 * FIXTURE · blocked county source + conflicting evidence (DR §11 demo #4).
 * SIMULATED. Synthetic subject; Duval-shaped fixture sources.
 *
 *   · the tax collector refuses automated access (HTTP 403) → a calm blocked
 *     card naming legitimate alternatives; no retry loop, no bypass, and the
 *     blocked finding carries NO value (not evidence of absence);
 *   · the property-appraiser roll shows 2025 taxes paid → an open conflict with
 *     the vendor's "tax delinquent" flag, resolved by rule during cross-check,
 *     and the vendor assumption is visibly downgraded;
 *   · code compliance times out → unavailable, retry scheduled;
 *   · two parcels match the situs → Needs input (operator picks one).
 */
import { BRIEF_SECTIONS, type BriefClaim } from '../contracts/contracts'
import { ScenarioWriter, fxFinding, registerAnswers, retrievalSteps, type DraftEvent, type FixtureScenario, type SyntheticProperty } from './fixture-kit'
import { SRC } from './sources'

export const PALMETTO: SyntheticProperty = {
  property_id: 'fx-prop-2207',
  address: '2207 Palmetto Row',
  city: 'Jacksonville, FL 32209',
  jurisdiction: 'Duval County',
  asset: 'Single family',
  beds_baths: '3 bd · 2 ba',
  sqft: 1410,
  year_built: 1956,
  owner_display: 'R. Okonkwo',
}
const P = PALMETTO
const pid = 'fx-prop-2207' // = PALMETTO.property_id, literal so the module stays tree-shakeable
const claim = (text: string, finding_ids: string[], evidence_status: BriefClaim['evidence_status'], confidence: number, source_name: string | null, is_inference = false, freshness_state: BriefClaim['freshness_state'] = 'fresh'): BriefClaim =>
  ({ text, finding_ids, evidence_status, confidence, freshness_state, source_name, is_inference })

const PARCEL_TASK = 'fx-t-d-parcel'
const ALTERNATIVES = ['Duval Property Appraiser · tax roll', 'Duval Clerk · tax-deed index', 'Open in Browser (manual lookup)']

if (import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_FIXTURES === '1') registerAnswers('blocked-conflict', {
  [PARCEL_TASK]: (option: string): DraftEvent[] => {
    const ids = { property_id: pid, task_id: PARCEL_TASK }
    const base = { source_id: SRC.duvalOr.source_id, host: SRC.duvalOr.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-or-2', purpose: 'ownership' }
    return [
      { t: 80, type: 'decision', payload: { summary: `Operator chose parcel ${option.split(' · ')[0]}. Re-running the ownership match on that parcel only.`, basis_finding_ids: [], criterion: 'operator_input' }, ...ids },
      { t: 160, type: 'task.started', attempt: 2, payload: { operation: 'research.match_parcel', label: 'Matching parcel in Duval Official Records', source_id: SRC.duvalOr.source_id, adapter_id: SRC.duvalOr.adapter_id, finding_type: 'ownership' }, ...ids },
      { t: 520, type: 'source.opened', attempt: 2, payload: base, ...ids },
      { t: 980, type: 'source.retrieved', attempt: 2, payload: { ...base, bytes: 8_840 }, ...ids },
      { t: 1120, type: 'observation.extracted', attempt: 2, payload: { observation_ids: ['fx-o-d9'], finding_type: 'ownership', display_value: 'Warranty deed 2016 · homestead exemption on file', citation: 'OR book 17602 page 1189' }, ...ids },
      { t: 1240, type: 'finding.upserted', attempt: 2, payload: { finding: fxFinding({ finding_id: 'fx-f-d-own', property_id: pid, finding_type: 'ownership', evidence_status: 'recorded', value: { since: 2016, homestead: true }, display_value: 'Deeded 2016 · homestead exemption (owner-occupied)', source_id: SRC.duvalOr.source_id, observed_at: '2016-04-02', retrieved_at: '2026-10-08', fresh_until: '2027-01-06', citation: 'OR 17602/1189' }) }, ...ids },
      { t: 1320, type: 'task.completed', attempt: 2, payload: { duration_ms: 1160, cost_usd: 0, observation_count: 1 }, ...ids },
    ]
  },
})

export function blockedConflictScenario(): FixtureScenario {
  const w = new ScenarioWriter()
  const ids = { property_id: pid }
  const unans = { when: { unanswered: PARCEL_TASK } }
  const ans = { when: { answered: PARCEL_TASK } }

  w.emit(0, 'job.created', { depth: 'deep', property_count: 1, estimate: { low_usd: 0.01, high_usd: 0.035, basis: 'worst_case', worst_case_usd: 0.75 }, cap: 0.75 })
  w.emit(0, 'job.property_state', { state: 'queued', display_address: `${P.address} (synthetic)`, counters: {} }, ids)
  w.emit(150, 'job.confirmed', { depth: 'deep', property_count: 1, estimate: { low_usd: 0.01, high_usd: 0.035, basis: 'worst_case', worst_case_usd: 0.75 }, cap: 0.75, scope_sentence: 'Research 1 property · Deep · hard cap $0.75' })
  w.emit(300, 'job.phase', { phase: 'planning' })
  w.emit(320, 'job.property_state', { state: 'running', phase: 'planning' }, ids)
  w.emit(480, 'finding.upserted', { finding: fxFinding({ finding_id: 'fx-f-d-vtax', property_id: pid, finding_type: 'tax_delinquency', key: 'vendor_tax_flag', evidence_status: 'vendor_reported', value: true, display_value: 'Tax delinquent (vendor flag)', source_id: SRC.vendor.source_id, observed_at: '2026-05-31', freshness_state: 'aging', citation: 'vendor snapshot · tax_delinquent=Y' }) }, ids)
  w.emit(560, 'decision', { summary: 'The vendor marks this property tax-delinquent. Checking the county before relying on it.', basis_finding_ids: ['fx-f-d-vtax'], criterion: 'vendor_needs_confirmation' }, ids)

  w.emit(1200, 'job.phase', { phase: 'researching' })
  w.emit(1200, 'job.property_state', { state: 'running', phase: 'researching' }, ids)

  // 1 · tax collector → blocked (403), terminal, never retried automatically
  w.task({ id: 'fx-t-d-tax', property: P, operation: 'research.check', source: SRC.duvalTax, finding_type: 'tax_status', planned_at: 700, start: 1300, steps: [
    ['source.searched', 260, { source_id: SRC.duvalTax.source_id, host: SRC.duvalTax.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-dtax', purpose: 'tax status' }],
    ['source.blocked', 720, { source_id: SRC.duvalTax.source_id, host: SRC.duvalTax.host, reason: 'http_403', message: 'Duval Tax Collector refused automated access (HTTP 403).', alternatives: ALTERNATIVES, retry_at: null }],
    ['finding.upserted', 800, { finding: fxFinding({ finding_id: 'fx-f-d-tax-blocked', property_id: pid, finding_type: 'tax_status', evidence_status: 'blocked', value: null, display_value: null, freshness_state: 'never', source_id: SRC.duvalTax.source_id }) }],
  ], end: ['task.blocked', 780, { reason: 'http_403', duration_ms: 780, alternatives: ALTERNATIVES }] })
  w.emit(2160, 'decision', { summary: 'The tax collector blocks automated access. Continuing with the appraiser’s tax roll and the clerk’s tax-deed index — no retry, no workaround.', basis_finding_ids: ['fx-f-d-tax-blocked'], criterion: 'blocked_source_alternatives' }, ids)

  // 2 · property appraiser roll → paid (contradicts the vendor)
  w.task({ id: 'fx-t-d-pa', property: P, operation: 'research.check', source: SRC.duvalPa, finding_type: 'tax_status', planned_at: 2200, start: 2400, steps: [
    ...retrievalSteps(SRC.duvalPa, 'tax status', '2026-10-08', 22_310, [280, 760, 1300]),
    ['observation.extracted', 1460, { observation_ids: ['fx-o-d2'], finding_type: 'tax_status', display_value: '2025 taxes paid 2026-03-28 · $2,116.40', citation: 'tax_roll 2025 · paid_date' }],
    ['finding.upserted', 1580, { finding: fxFinding({ finding_id: 'fx-f-d-paid', property_id: pid, finding_type: 'tax_status', evidence_status: 'county_confirmed', value: { year: 2025, paid: '2026-03-28', amount: 2116.4 }, display_value: 'Paid · 2025 taxes (2026-03-28)', source_id: SRC.duvalPa.source_id, observed_at: '2026-03-28', retrieved_at: '2026-10-08', fresh_until: '2026-11-01', citation: 'tax roll 2025 · paid 2026-03-28' }) }],
  ], end: ['task.completed', 1660, { duration_ms: 1660, cost_usd: 0, observation_count: 1 }] })
  w.emit(4120, 'finding.conflict', { conflict_group_id: 'fx-cg-d-tax', finding_type: 'tax_delinquency', members: ['fx-f-d-vtax', 'fx-f-d-paid'], rule: 'county_beats_vendor', resolution_state: 'open' }, ids)
  w.emit(4180, 'decision', { summary: 'Conflict: vendor says delinquent, the county roll says 2025 taxes were paid. Holding both until the cross-check.', basis_finding_ids: ['fx-f-d-vtax', 'fx-f-d-paid'], criterion: 'conflict_open' }, ids)

  // 3 · clerk tax-deed index → covering negative (source supports_negative)
  w.task({ id: 'fx-t-d-deed', property: P, operation: 'research.check', source: SRC.duvalClerk, finding_type: 'tax_delinquency', planned_at: 2240, start: 2500, steps: [
    ...retrievalSteps(SRC.duvalClerk, 'tax-deed applications', '2026-10-08', 7_120, [300, 820, 1420]),
    ['observation.extracted', 1560, { observation_ids: ['fx-o-d3'], finding_type: 'tax_delinquency', display_value: 'No tax-deed application for the parcel', citation: 'tax-deed index · 0 applications' }],
    ['finding.upserted', 1680, { finding: fxFinding({ finding_id: 'fx-f-d-deed', property_id: pid, finding_type: 'tax_delinquency', key: 'tax_deed', evidence_status: 'county_confirmed', value: { applications: 0 }, display_value: 'No tax-deed application on file', is_negative_claim: true, source_id: SRC.duvalClerk.source_id, observed_at: '2026-10-08', retrieved_at: '2026-10-08', fresh_until: '2026-10-22', citation: 'tax-deed index · covering query' }) }],
  ], end: ['task.completed', 1760, { duration_ms: 1760, cost_usd: 0, observation_count: 1 }] })

  // 4 · official records → two parcels match → needs input
  w.task({ id: PARCEL_TASK, property: P, operation: 'research.match_parcel', source: SRC.duvalOr, finding_type: 'ownership', planned_at: 2280, start: 4400, steps: [
    ['source.searched', 300, { source_id: SRC.duvalOr.source_id, host: SRC.duvalOr.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-or', purpose: 'ownership' }],
    ['source.opened', 700, { source_id: SRC.duvalOr.source_id, host: SRC.duvalOr.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-or', purpose: 'ownership' }],
  ], end: ['task.needs_input', 900, { question: 'Two parcels match 2207 Palmetto Row. Which one is the subject?', options: ['043512-0000 · main house · 1,410 sqft', '043512-0010 · rear unit · 520 sqft'] }] })

  // 5 · code compliance → timeout → unavailable, retry later
  w.task({ id: 'fx-t-d-code', property: P, operation: 'research.check', source: SRC.jaxCode, finding_type: 'code_violation', planned_at: 2320, start: 4500, steps: [
    ['source.searched', 260, { source_id: SRC.jaxCode.source_id, host: SRC.jaxCode.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-jax', purpose: 'code violations' }],
    ['source.failed', 3600, { source_id: SRC.jaxCode.source_id, host: SRC.jaxCode.host, reason: 'timeout', retry_at: '2026-10-08T22:00:00Z' }],
    ['finding.upserted', 3680, { finding: fxFinding({ finding_id: 'fx-f-d-code', property_id: pid, finding_type: 'code_violation', evidence_status: 'unavailable', value: null, display_value: null, freshness_state: 'never', source_id: SRC.jaxCode.source_id }) }],
  ], end: ['task.unavailable', 3640, { reason: 'timeout', retry_at: '2026-10-08T22:00:00Z' }] })

  // 6 · comps (internal)
  w.task({ id: 'fx-t-d-comps', property: P, operation: 'research.check', source: SRC.lcComps, finding_type: 'comparable_sales', planned_at: 2360, start: 5900, steps: [
    ['source.searched', 200, { source_id: SRC.lcComps.source_id, host: SRC.lcComps.host, http_class: '2xx', retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-dcomps', purpose: 'comparable sales' }],
    ['source.retrieved', 700, { source_id: SRC.lcComps.source_id, host: SRC.lcComps.host, http_class: '2xx', bytes: 4_880, retrieved_at: '2026-10-08', fetch_id: 'fx-fetch-dcomps', purpose: 'comparable sales' }],
    ['finding.upserted', 900, { finding: fxFinding({ finding_id: 'fx-f-d-comps', property_id: pid, finding_type: 'comparable_sales', evidence_status: 'recorded', value: { n: 4, median: 118000 }, display_value: '4 investor sales ≤ 0.6 mi · median $118,000', source_id: SRC.lcComps.source_id, observed_at: '2026-10-07', retrieved_at: '2026-10-08', fresh_until: '2026-10-22', citation: 'investor cluster lane · 12 months' }) }],
  ], end: ['task.completed', 980, { duration_ms: 980, cost_usd: 0, observation_count: 4 }] })

  // analyzing → cross-checking: the conflict resolves by rule; the vendor flag is downgraded
  w.emit(8400, 'job.phase', { phase: 'analyzing' })
  w.emit(8400, 'job.property_state', { state: 'running', phase: 'analyzing' }, ids)
  w.emit(8900, 'job.phase', { phase: 'cross_checking' })
  w.emit(8900, 'job.property_state', { state: 'running', phase: 'cross_checking' }, ids)
  w.task({ id: 'fx-t-d-xc', property: P, operation: 'research.cross_check', source: SRC.duvalPa, other_source: SRC.vendor, finding_type: 'tax_delinquency', planned_at: 8850, start: 9000, steps: [
    ['finding.conflict', 900, { conflict_group_id: 'fx-cg-d-tax', finding_type: 'tax_delinquency', members: ['fx-f-d-vtax', 'fx-f-d-paid'], rule: 'county_beats_vendor', resolution_state: 'resolved_by_rule' }],
    ['finding.upserted', 960, { finding: fxFinding({ finding_id: 'fx-f-d-vtax', property_id: pid, finding_type: 'tax_delinquency', key: 'vendor_tax_flag', evidence_status: 'vendor_reported', value: true, display_value: 'Tax delinquent (vendor flag)', source_id: SRC.vendor.source_id, observed_at: '2026-05-31', freshness_state: 'stale', contradicted_by: 'fx-f-d-paid', conflict_group_id: 'fx-cg-d-tax', confidence: 0.15, citation: 'vendor snapshot · tax_delinquent=Y' }) }],
  ], end: ['task.completed', 1000, { duration_ms: 1000, cost_usd: 0, observation_count: 0 }] })
  w.emit(10060, 'decision', { summary: 'County roll shows 2025 taxes paid and no tax-deed application. The vendor delinquency flag is contradicted and no longer used.', basis_finding_ids: ['fx-f-d-paid', 'fx-f-d-deed', 'fx-f-d-vtax'], criterion: 'county_beats_vendor' }, ids)

  // synthesizing
  w.emit(10600, 'job.phase', { phase: 'synthesizing' })
  w.emit(10600, 'job.property_state', { state: 'running', phase: 'synthesizing' }, ids)
  w.emit(10650, 'usage.reserved', { reserve_id: 'fx-res-dsyn', op_type: 'research.synthesize', route: 'research.synthesize', provider: 'fixture', model: 'fixture-sonnet', worst_case_usd: 0.09, remaining_usd: 0.75 }, ids)
  const ownership: Record<'a' | 'u', BriefClaim[]> = {
    u: [claim('Ownership not confirmed — two parcels match the situs; awaiting your choice', [], 'unverified', 0.3, SRC.duvalOr.name)],
    a: [claim('Deeded 2016; homestead exemption on file (owner-occupied)', ['fx-f-d-own'], 'recorded', 0.88, SRC.duvalOr.name)],
  }
  const sections: Record<string, BriefClaim[]> = {
    physical_condition: [claim('Code-compliance status unavailable (source timed out; retry scheduled 22:00 UTC). Not evidence of no violations.', ['fx-f-d-code'], 'unavailable', 0, SRC.jaxCode.name, false, 'never')],
    taxes_liens: [
      claim('2025 taxes paid on 2026-03-28 ($2,116.40)', ['fx-f-d-paid'], 'county_confirmed', 0.93, SRC.duvalPa.name),
      claim('No tax-deed application on file', ['fx-f-d-deed'], 'county_confirmed', 0.9, SRC.duvalClerk.name),
      claim('Vendor “tax delinquent” flag — contradicted by the county roll', ['fx-f-d-vtax'], 'vendor_reported', 0.15, SRC.vendor.name, false, 'stale'),
      claim('Tax Collector record not read — automated access blocked (HTTP 403)', ['fx-f-d-tax-blocked'], 'blocked', 0, SRC.duvalTax.name, false, 'never'),
    ],
    foreclosure_legal: [claim('Not checked at this depth for Duval (no registered docket adapter)', [], 'unavailable', 0, null, false, 'never')],
    listing_history: [claim('Not checked — no licensed listing provider configured', [], 'unavailable', 0, null, false, 'never')],
    comparable_sales: [claim('4 investor-cluster sales within 0.6 mi · median $118,000', ['fx-f-d-comps'], 'recorded', 0.84, SRC.lcComps.name)],
    investor_demand: [claim('Not requested in this pass', [], 'unavailable', 0, null, false, 'never')],
    next_investigation: [
      claim('Look up the Tax Collector record manually in the Browser', ['fx-f-d-tax-blocked'], 'unverified', 0.3, null),
      claim('Re-run code compliance after the scheduled retry', ['fx-f-d-code'], 'unverified', 0.3, null),
    ],
  }
  const risksU: BriefClaim[] = [
    claim('Parcel ambiguity — two parcels match; ownership unconfirmed until you choose', [], 'unverified', 0.3, SRC.duvalOr.name),
    claim('Tax Collector blocked: delinquency for 2026 cannot be ruled out from that source', ['fx-f-d-tax-blocked'], 'blocked', 0, SRC.duvalTax.name, false, 'never'),
    claim('Code compliance unavailable (timeout)', ['fx-f-d-code'], 'unavailable', 0, SRC.jaxCode.name, false, 'never'),
  ]
  const risksA: BriefClaim[] = risksU.slice(1)
  let t = 10800
  for (const s of BRIEF_SECTIONS) {
    if (s.key === 'acquisition_economics') continue
    const id = `fx-t-dsyn-${s.key}`
    const variants: Array<[BriefClaim[], { when?: DraftEvent['when'] }]> =
      s.key === 'property_ownership' ? [[ownership.u, unans], [ownership.a, ans]]
        : s.key === 'risks_unresolved' ? [[risksU, unans], [risksA, ans]]
          : [[sections[s.key] ?? [], {}]]
    w.emit(10750, 'plan.task_added', { task_id: id, operation: 'research.synthesize_section', label: `Writing brief section: ${s.label}`, adapter_id: SRC.model.adapter_id, source_id: SRC.model.source_id, finding_type: null, depends_on: [], billable: false }, { property_id: pid, task_id: id })
    w.emit(t, 'task.started', { operation: 'research.synthesize_section', label: `Writing brief section: ${s.label}`, source_id: SRC.model.source_id, adapter_id: SRC.model.adapter_id, finding_type: null }, { property_id: pid, task_id: id })
    for (const [claims, when] of variants) {
      w.log.push({ t: t + 400, type: 'brief.section', payload: { section_key: s.key, label: s.label, claims, claim_count: claims.length, finding_refs: [...new Set(claims.flatMap((c) => c.finding_ids))] }, property_id: pid, task_id: id, ...when })
    }
    w.emit(t + 440, 'task.completed', { duration_ms: 440, cost_usd: 0, observation_count: 0 }, { property_id: pid, task_id: id })
    t += 500
  }
  w.emit(t + 40, 'usage.settled', { reserve_id: 'fx-res-dsyn', op_type: 'research.synthesize', route: 'research.synthesize', provider: 'fixture', model: 'fixture-sonnet', tokens: 5480, actual_usd: 0.024, accrued_usd: 0.024, remaining_usd: 0.726 }, ids)
  w.log.push({ t: t + 120, type: 'brief.completed', payload: { opportunity_class: 'unknown', contact_readiness_class: 'unknown', sections_missing: ['foreclosure_legal', 'listing_history', 'investor_demand'] }, ...ids, ...unans })
  w.log.push({ t: t + 120, type: 'brief.completed', payload: { opportunity_class: 'weak', contact_readiness_class: 'unknown', sections_missing: ['foreclosure_legal', 'listing_history', 'investor_demand'] }, ...ids, ...ans })
  w.log.push({ t: t + 140, type: 'job.property_state', payload: { state: 'completed_partial', phase: 'complete', opportunity_class: 'unknown', contact_readiness_class: 'unknown' }, ...ids, ...unans })
  w.log.push({ t: t + 140, type: 'job.property_state', payload: { state: 'completed_partial', phase: 'complete', opportunity_class: 'weak', contact_readiness_class: 'unknown' }, ...ids, ...ans })
  w.emit(t + 200, 'job.phase', { phase: 'complete' })
  w.log.push({ t: t + 240, type: 'job.completed', payload: { state: 'completed_partial', summary: 'Partial · 1 source blocked · 1 unavailable · 1 conflict resolved · parcel awaiting your input', accrued_usd: 0.024 }, ...unans })
  w.log.push({ t: t + 240, type: 'job.completed', payload: { state: 'completed_partial', summary: 'Partial · 1 source blocked · 1 unavailable · 1 conflict resolved by rule', accrued_usd: 0.024 }, ...ans })

  return {
    id: 'blocked-conflict', kind: 'research', depth: 'deep',
    title: `${P.address} (synthetic)`, subtitle: `${P.city} · Deep Research`,
    properties: [P],
    sources: [SRC.vendor, SRC.duvalTax, SRC.duvalPa, SRC.duvalClerk, SRC.duvalOr, SRC.jaxCode, SRC.lcComps, SRC.model],
    log: w.sorted(),
    confirm_gate: 100,
  }
}
