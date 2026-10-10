// FIXTURE EVENT-LOG GENERATOR — design-review scenarios for the S2 prototype.
//
// Pure ESM, deterministic (seeded PRNG, fixed base clock), no Node-only APIs.
// Every event carries `fixture: true` and a `fixture_t_ms` offset for the
// player; every source and property is fictional test data (see
// fixture-sources.js). Events use exactly the production envelope and the
// per-type payload whitelist from ../events.js, and every label is rendered
// from a registered operation template — so a UI that renders these renders
// the real stream. Nothing here is a recording of production.
//
// Scenarios (DR §11 design-review plan):
//   1 single-deep          single property live research
//   2 batch-25             25-property batch workspace
//   3 discoveries          successful sources + meaningful discoveries
//   4 blocked-conflict     blocked county source + conflicting evidence
//   5 campaign-handoff     completed research + Add to Campaign handoff
//   6 resume-reload        resume after navigation/reload (cursor + redelivery)
//   7 ultrawide            5120×1440: concurrent single + batch runs
//   8 reduced-motion       performance (≥ 2,000 events) + reduced motion

import { FINDING_TYPES, BRIEF_SECTIONS, confidenceBand } from '../evidence.js'
import { renderOperationLabel } from '../events.js'
import { RESEARCH_DEPTH_LABELS } from '../states.js'
import { reduceEvents } from '../reducer.js'
import { FIXTURE_SOURCES, fixtureSource, fixtureProperty } from './fixture-sources.js'

export const FIXTURE_BASE_AT = Date.parse('2026-10-08T15:00:00.000Z')

export const FIXTURE_SCENARIOS = Object.freeze([
  { id: 'single-deep', n: 1, title: 'Single-property live research', proves: ['status shimmer', 'phases', 'timeline', 'source explorer', 'streamed brief'] },
  { id: 'batch-25', n: 2, title: '25-property batch workspace', proves: ['batch panel', 'queue', 'live counters', 'grid status column', 'shell indicator'] },
  { id: 'discoveries', n: 3, title: 'Successful sources + meaningful discoveries', proves: ['gold discovery reveal', 'class upgrade', 'evidence into home panel'] },
  { id: 'blocked-conflict', n: 4, title: 'Blocked county source + conflicting evidence', proves: ['blocked card + alternatives', 'conflict group', 'downgraded assumption', 'not evidence of absence'] },
  { id: 'campaign-handoff', n: 5, title: 'Completed research + Add to Campaign handoff', proves: ['brief actions', 'campaign sheet intent (draft only)', 'readiness ≠ opportunity', 'approval card (identity unavailable)'] },
  { id: 'resume-reload', n: 6, title: 'Resume after reload', proves: ['snapshot + Last-Event-ID replay', 'no duplicated rows on redelivery'] },
  { id: 'ultrawide', n: 7, title: 'Ultrawide 5120×1440', proves: ['multi-column canvas', 'two concurrent runs', 'interleaved global event ids'] },
  { id: 'reduced-motion', n: 8, title: 'Performance + reduced motion', proves: ['≥ 2,000-event virtualized timeline', 'reduced motion static status', 'keyboard flow'] },
])

export const FIXTURE_SCENARIO_IDS = Object.freeze(FIXTURE_SCENARIOS.map((s) => s.id))

// ── deterministic helpers ──────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fakeHex(rand, len = 64) {
  let s = ''
  while (s.length < len) s += Math.floor(rand() * 16).toString(16)
  return s
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6
}

function createSequencer({ start_event_id = 1, seed = 1 } = {}) {
  return { next_event_id: start_event_id, t_ms: 0, seqByRun: {}, events: [], rand: mulberry32(seed) }
}

function between(rand, lo, hi) {
  return Math.round(lo + rand() * (hi - lo))
}

function makeEmitter(seqr, run_id) {
  return function emit(type, payload = {}, opts = {}) {
    seqr.t_ms += opts.dt ?? between(seqr.rand, 60, 220)
    seqr.seqByRun[run_id] = (seqr.seqByRun[run_id] || 0) + 1
    const event = {
      event_id: seqr.next_event_id++,
      run_id,
      seq: seqr.seqByRun[run_id],
      type,
      at: new Date(FIXTURE_BASE_AT + seqr.t_ms).toISOString(),
      attempt: opts.attempt || 1,
      visibility: 'operator',
      property_id: opts.property_id ?? null,
      task_id: opts.task_id ?? null,
      tool_call_id: opts.tool_call_id ?? null,
      payload,
      fixture: true,
      fixture_t_ms: seqr.t_ms,
    }
    seqr.events.push(event)
    return event
  }
}

function checkLabel(source, property, finding_type) {
  return renderOperationLabel('research.check', {
    jurisdiction: source.jurisdiction || property.jurisdiction,
    finding_label: FINDING_TYPES[finding_type].label.toLowerCase(),
    source_name: source.name,
  })
}

function makeFinding(spec) {
  const noValue = spec.evidence_status === 'blocked' || spec.evidence_status === 'unavailable'
  const confidence = noValue ? 0 : spec.confidence ?? 0.9
  return {
    finding_id: spec.finding_id,
    property_id: spec.property_id,
    finding_type: spec.finding_type,
    key: spec.key || spec.finding_type,
    value: noValue ? null : spec.value ?? null,
    display_value: spec.display_value ?? null,
    evidence_status: spec.evidence_status,
    confidence,
    confidence_band: confidenceBand(confidence),
    is_inference: spec.evidence_status === 'model_inference',
    is_discovery: Boolean(spec.is_discovery),
    is_negative_claim: Boolean(spec.is_negative_claim),
    freshness_state: noValue ? 'never' : spec.freshness_state || 'fresh',
    observed_at: noValue ? null : spec.observed_at || '2026-10-05',
    retrieved_at: spec.retrieved_at || '2026-10-08T15:00:00.000Z',
    fresh_until: noValue ? null : spec.fresh_until || '2026-11-07',
    source_id: spec.source_id,
    citation: noValue ? null : spec.citation || null,
    supersedes_id: spec.supersedes_id || null,
    contradicts_id: spec.contradicts_id || null,
    conflict_group_id: spec.conflict_group_id || null,
    test_data: true,
  }
}

/**
 * Build the step closures for one research task. Returns
 * { added: () => void, steps: Array<() => void> }.
 * outcome: { kind: 'retrieved'|'blocked'|'unavailable'|'needs_input', finding?, extraction? }
 */
function researchTask(emit, ctx, { property, source_id, finding_type, task_id, outcome }) {
  const source = fixtureSource(source_id)
  const label = checkLabel(source, property, finding_type)
  const pid = property.property_id
  const base = { property_id: pid, task_id }
  const added = () =>
    emit('plan.task_added', {
      task_id,
      operation: 'research.check',
      label,
      adapter_id: source.adapter_id,
      source_id,
      finding_type,
      depends_on: [],
      billable: source.billable,
    }, { ...base, dt: 40 })

  const steps = []
  steps.push(() => emit('task.started', { operation: 'research.check', label, source_id, adapter_id: source.adapter_id, finding_type }, { ...base, dt: 90 }))
  const purpose = FINDING_TYPES[finding_type].label.toLowerCase()
  if (outcome.kind === 'blocked') {
    steps.push(() => emit('source.searched', { source_id, host: source.host, http_class: '4xx', retrieved_at: null, fetch_id: null, purpose }, { ...base, dt: between(ctx.rand, 600, 1400) }))
    steps.push(() =>
      emit('source.blocked', {
        source_id,
        host: source.host,
        reason: outcome.reason || 'http_403',
        message: outcome.message,
        alternatives: outcome.alternatives || [],
        retry_at: null,
      }, { ...base, dt: 80 }))
    steps.push(() => emit('finding.upserted', { finding: makeFinding({ finding_id: `${task_id}-f`, property_id: pid, finding_type, evidence_status: 'blocked', source_id }) }, { ...base, dt: 40 }))
    steps.push(() => emit('task.blocked', { reason: outcome.reason || 'http_403', duration_ms: 1500, alternatives: outcome.alternatives || [] }, { ...base, dt: 40 }))
    return { added, steps }
  }
  if (outcome.kind === 'unavailable') {
    steps.push(() => emit('finding.upserted', { finding: makeFinding({ finding_id: `${task_id}-f`, property_id: pid, finding_type, evidence_status: 'unavailable', source_id }) }, { ...base, dt: 200 }))
    steps.push(() => emit('task.unavailable', { reason: outcome.reason || 'no_supported_source_for_jurisdiction', retry_at: null }, { ...base, dt: 40 }))
    return { added, steps }
  }
  if (outcome.kind === 'needs_input') {
    steps.push(() => emit('source.searched', { source_id, host: source.host, http_class: '2xx', retrieved_at: '2026-10-08T15:01:00.000Z', fetch_id: `${task_id}-fetch`, purpose }, { ...base, dt: 700 }))
    steps.push(() => emit('task.needs_input', { question: outcome.question, options: outcome.options || [] }, { ...base, dt: 60 }))
    return { added, steps }
  }
  // retrieved
  const fetch_id = `${task_id}-fetch`
  steps.push(() => emit('source.searched', { source_id, host: source.host, http_class: '2xx', retrieved_at: null, fetch_id, purpose }, { ...base, dt: between(ctx.rand, 250, 900) }))
  steps.push(() => emit('source.retrieved', { source_id, host: source.host, http_class: '2xx', bytes: between(ctx.rand, 2_000, 60_000), retrieved_at: '2026-10-08T15:01:00.000Z', fetch_id, purpose }, { ...base, dt: between(ctx.rand, 200, 700) }))
  let costUsd = 0
  if (outcome.extraction) {
    const reserve_id = `${task_id}-rsv`
    const worst = outcome.extraction.worst_case_usd
    const actual = outcome.extraction.actual_usd
    steps.push(() => emit('usage.reserved', { reserve_id, op_type: 'model', route: 'research.extract_structured', provider: 'anthropic', model: 'claude-haiku-4-5', worst_case_usd: worst, remaining_usd: round6(ctx.cap - ctx.accrued - worst) }, { ...base, dt: 30 }))
    steps.push(() => {
      ctx.accrued = round6(ctx.accrued + actual)
      emit('usage.settled', { reserve_id, op_type: 'model', route: 'research.extract_structured', provider: 'anthropic', model: 'claude-haiku-4-5', tokens: outcome.extraction.tokens, actual_usd: actual, accrued_usd: ctx.accrued, remaining_usd: round6(ctx.cap - ctx.accrued) }, { ...base, dt: between(ctx.rand, 900, 1800) })
    })
    costUsd = actual
  }
  const f = outcome.finding
  steps.push(() => emit('observation.extracted', { observation_ids: [`${task_id}-obs1`], finding_type, display_value: f.display_value, citation: f.citation || null }, { ...base, dt: 70 }))
  steps.push(() => emit('finding.upserted', { finding: makeFinding({ finding_id: `${task_id}-f`, property_id: pid, finding_type, source_id, ...f }) }, { ...base, dt: 50 }))
  steps.push(() => emit('task.completed', { duration_ms: between(ctx.rand, 400, 2400), cost_usd: costUsd, observation_count: 1 }, { ...base, dt: 40 }))
  return { added, steps }
}

function emitBriefSections(emit, property, depth, claimsByKey, dtBase = 260) {
  for (const section of BRIEF_SECTIONS) {
    if (section.diligence_only && depth !== 'diligence') continue
    const claims = claimsByKey[section.key] || [{ text: 'No findings gathered for this section in this pass.', finding_id: null, evidence_status: 'unverified', is_inference: false }]
    emit('brief.section', { section_key: section.key, label: section.label, claims, claim_count: claims.length, finding_refs: claims.map((c) => c.finding_id).filter(Boolean) }, { property_id: property.property_id, dt: dtBase })
  }
}

// ── single-property research ───────────────────────────────────────────────

function singlePropertyRun(seqr, { run_id, property, variant }) {
  const emit = makeEmitter(seqr, run_id)
  const ctx = { rand: seqr.rand, accrued: 0, cap: 0.75 }
  const pid = property.property_id
  const discoveries = variant === 'discoveries'

  emit('run.created', { kind: 'research', title: `Deep Research · ${property.display_address}`, objective_summary: 'Investigate distress, taxes and ownership for 1 property', budget_cap_usd: 0.75, parent_run_id: null, depth: 'deep' }, { dt: 0 })
  emit('job.created', { depth: 'deep', property_count: 1, estimate: { low_usd: 0, high_usd: 0.75, basis: 'worst_case', label: 'No measured history yet: worst case $0.75 = 1 × $0.75 cap' }, cap: { per_property_usd: 0.75, batch_usd: 0.75 } })
  emit('job.confirmed', { depth: 'deep', property_count: 1, estimate: { low_usd: 0, high_usd: 0.75, basis: 'worst_case', label: 'No measured history yet: worst case $0.75' }, cap: { per_property_usd: 0.75, batch_usd: 0.75 }, scope_sentence: `Research 1 property · ${RESEARCH_DEPTH_LABELS.deep} · hard cap $0.75` }, { dt: 900 })
  emit('run.state', { from: 'created', to: 'running', reason: 'confirmed' })
  emit('job.phase', { phase: 'planning' })
  emit('job.property_state', { state: 'running', phase: 'planning', opportunity_class: 'standard', contact_readiness_class: 'unknown', display_address: property.display_address, counters: { planned: 0, done: 0 } }, { property_id: pid })

  const tasks = [
    researchTask(emit, ctx, { property, source_id: 'fx-src-lc-records', finding_type: 'ownership', task_id: `${run_id}-t1`, outcome: { kind: 'retrieved', finding: { evidence_status: 'vendor_reported', display_value: 'Individual owner · held 14 yrs', value: { owner_type: 'individual', years_held: 14 }, confidence: 0.6, citation: 'owner_type, last_sale_date' } } }),
    researchTask(emit, ctx, { property, source_id: 'fx-src-cuyahoga-tax', finding_type: 'tax_delinquency', task_id: `${run_id}-t2`, outcome: { kind: 'retrieved', finding: { evidence_status: 'county_confirmed', display_value: 'Tax delinquent $1,804 · county', value: { delinquent: true, amount_usd: 1804 }, confidence: 0.97, citation: 'DELQ_AMT', is_discovery: true } } }),
    researchTask(emit, ctx, { property, source_id: 'fx-src-cleveland-code', finding_type: 'code_violation', task_id: `${run_id}-t3`, outcome: { kind: 'retrieved', finding: { evidence_status: 'county_confirmed', display_value: '2 open code cases', value: { open_cases: 2 }, confidence: 0.92, citation: 'CASE_STATUS' } } }),
    researchTask(emit, ctx, { property, source_id: 'fx-src-code-pdf-extract', finding_type: 'condemnation', task_id: `${run_id}-t4`, outcome: { kind: 'retrieved', extraction: { worst_case_usd: 0.012, actual_usd: 0.0031, tokens: { input: 2140, output: 180, cache_read: 1600 } }, finding: discoveries ? { evidence_status: 'county_confirmed', display_value: 'Condemnation notice 2026-09-12', value: { condemned: true, notice_date: '2026-09-12' }, confidence: 0.9, citation: 'notice p.1 §2', is_discovery: true } : { evidence_status: 'county_confirmed', display_value: 'Code case mentions inspection; no order in this document', value: { order_in_document: false }, confidence: 0.5, citation: 'case summary' } } }),
    researchTask(emit, ctx, { property, source_id: 'fx-src-cuyahoga-recorder', finding_type: 'lien', task_id: `${run_id}-t5`, outcome: { kind: 'retrieved', finding: { evidence_status: 'recorded', display_value: discoveries ? 'Mechanic’s lien $6,200 (2026-06)' : '1 satisfied mortgage (recorded)', value: discoveries ? { liens: [{ type: 'mechanics', amount_usd: 6200 }] } : { liens: [{ type: 'mortgage', satisfied: true }] }, confidence: 0.88, citation: 'instrument index', is_discovery: discoveries } } }),
    researchTask(emit, ctx, { property, source_id: 'fx-src-lc-records', finding_type: 'listing_status', task_id: `${run_id}-t6`, outcome: { kind: 'unavailable', reason: 'no_supported_source_for_jurisdiction' } }),
  ]
  for (const t of tasks) t.added()
  emit('plan.skipped_fresh', { finding_type: 'mortgage', cited_finding_id: null, canonical_ref: 'seller.property_mortgage', fresh_until: '2026-11-06', label: renderOperationLabel('research.reuse_fresh', { finding_label: 'mortgage', source_name: fixtureSource('fx-src-lc-records').name }) }, { property_id: pid })
  emit('decision', { summary: 'Skipping mortgage lookup: recorded mortgage data refreshed 2026-10-07.', basis_finding_ids: [], basis_refs: ['seller.property_mortgage'], criterion: 'freshness_reuse' }, { property_id: pid })
  emit('job.phase', { phase: 'researching' }, { dt: 300 })
  for (const t of tasks) for (const s of t.steps) s()

  emit('job.phase', { phase: 'cross_checking' }, { dt: 300 })
  emit('decision', { summary: 'County tax roll and vendor flag agree: delinquent. Using the county figure.', basis_finding_ids: [`${run_id}-t2-f`], basis_refs: [], criterion: 'authority_order' }, { property_id: pid })
  if (discoveries) {
    emit('job.property_state', { state: 'running', phase: 'cross_checking', opportunity_class: 'priority', contact_readiness_class: 'unknown', display_address: property.display_address, counters: { planned: 6, done: 6 } }, { property_id: pid })
    emit('decision', { summary: 'Upgraded to Priority: county-confirmed tax delinquency plus a condemnation notice.', basis_finding_ids: [`${run_id}-t2-f`, `${run_id}-t4-f`], basis_refs: [], criterion: 'opportunity_rule' }, { property_id: pid })
  }
  emit('job.phase', { phase: 'synthesizing' }, { dt: 300 })
  const synthWorst = 0.04
  emit('usage.reserved', { reserve_id: `${run_id}-syn-rsv`, op_type: 'model', route: 'research.synthesize_brief', provider: 'anthropic', model: 'claude-haiku-4-5', worst_case_usd: synthWorst, remaining_usd: round6(ctx.cap - ctx.accrued - synthWorst) })
  const t = (id) => `${run_id}-${id}-f`
  emitBriefSections(emit, property, 'deep', {
    property_ownership: [{ text: 'Individual owner, held about 14 years.', finding_id: t('t1'), evidence_status: 'vendor_reported', is_inference: false }],
    physical_condition: [
      { text: '2 open code cases.', finding_id: t('t3'), evidence_status: 'county_confirmed', is_inference: false },
      ...(discoveries ? [{ text: 'Condemnation notice issued 2026-09-12.', finding_id: t('t4'), evidence_status: 'county_confirmed', is_inference: false }] : []),
    ],
    taxes_liens: [
      { text: 'Tax delinquent $1,804 per the county roll.', finding_id: t('t2'), evidence_status: 'county_confirmed', is_inference: false },
      { text: discoveries ? 'Mechanic’s lien $6,200 recorded 2026-06.' : 'One satisfied mortgage recorded; no open liens seen in the index searched (not exhaustive).', finding_id: t('t5'), evidence_status: 'recorded', is_inference: false },
    ],
    listing_history: [{ text: 'Listing status unavailable: no supported source for this jurisdiction. Not evidence of absence.', finding_id: t('t6'), evidence_status: 'unavailable', is_inference: false }],
    risks_unresolved: [{ text: 'Likely deferred maintenance given open code cases (inference).', finding_id: t('t3'), evidence_status: 'model_inference', is_inference: true }],
    next_investigation: [{ text: 'Check listing status manually in the Browser app.', finding_id: null, evidence_status: 'unverified', is_inference: false }],
  })
  ctx.accrued = round6(ctx.accrued + 0.0068)
  emit('usage.settled', { reserve_id: `${run_id}-syn-rsv`, op_type: 'model', route: 'research.synthesize_brief', provider: 'anthropic', model: 'claude-haiku-4-5', tokens: { input: 5200, output: 640, cache_read: 3900 }, actual_usd: 0.0068, accrued_usd: ctx.accrued, remaining_usd: round6(ctx.cap - ctx.accrued) })
  emit('brief.completed', { opportunity_class: discoveries ? 'priority' : 'strong', contact_readiness_class: 'unknown', sections_missing: ['listing_history'] }, { property_id: pid })
  emit('job.property_state', { state: 'completed_partial', phase: 'complete', opportunity_class: discoveries ? 'priority' : 'strong', contact_readiness_class: 'unknown', display_address: property.display_address, counters: { planned: 6, done: 6 } }, { property_id: pid })
  emit('job.completed', { state: 'completed_partial', summary: '6 of 6 source operations · 0 blocked · 1 unavailable', counters: { planned: 6, done: 6, blocked: 0 }, accrued_usd: ctx.accrued })
  emit('run.state', { from: 'running', to: 'completed_partial', reason: 'job_completed', accrued_usd: ctx.accrued })
  return { run_id, accrued_usd: ctx.accrued }
}

// ── blocked + conflict (Duval) ─────────────────────────────────────────────

function blockedConflictRun(seqr, { run_id }) {
  const emit = makeEmitter(seqr, run_id)
  const property = fixtureProperty(7, 'jacksonville')
  const pid = property.property_id
  const ctx = { rand: seqr.rand, accrued: 0, cap: 0.75 }
  emit('run.created', { kind: 'research', title: `Deep Research · ${property.display_address}`, objective_summary: 'Verify tax status and ownership for 1 property', budget_cap_usd: 0.75, parent_run_id: null, depth: 'deep' }, { dt: 0 })
  emit('job.confirmed', { depth: 'deep', property_count: 1, estimate: { low_usd: 0, high_usd: 0.75, basis: 'worst_case', label: 'No measured history yet: worst case $0.75' }, cap: { per_property_usd: 0.75, batch_usd: 0.75 }, scope_sentence: 'Research 1 property · Deep Research · hard cap $0.75' })
  emit('run.state', { from: 'created', to: 'running', reason: 'confirmed' })
  emit('job.phase', { phase: 'planning' })
  emit('job.property_state', { state: 'running', phase: 'planning', opportunity_class: 'strong', contact_readiness_class: 'unknown', display_address: property.display_address, counters: {} }, { property_id: pid })
  const vendor = researchTask(emit, ctx, { property, source_id: 'fx-src-vendor-flags', finding_type: 'tax_delinquency', task_id: `${run_id}-t1`, outcome: { kind: 'retrieved', finding: { evidence_status: 'vendor_reported', display_value: 'Tax delinquent (vendor flag)', value: { delinquent: true }, confidence: 0.55, citation: 'tax_delinquent flag', freshness_state: 'aging', observed_at: '2026-04-30' } } })
  const blocked = researchTask(emit, ctx, { property, source_id: 'fx-src-duval-tax-collector', finding_type: 'tax_status', task_id: `${run_id}-t2`, outcome: { kind: 'blocked', reason: 'http_403', message: 'Fixture Duval tax collector blocks automated access (403, 2026-10-07). Not evidence of absence.', alternatives: ['Fixture Duval clerk tax-deed index [test data]', 'Open in Browser (manual) [test data]'] } })
  const appraiser = researchTask(emit, ctx, { property, source_id: 'fx-src-duval-appraiser', finding_type: 'tax_status', task_id: `${run_id}-t3`, outcome: { kind: 'retrieved', finding: { evidence_status: 'county_confirmed', display_value: '2025 taxes paid · current', value: { status: 'current', tax_year: 2025 }, confidence: 0.93, citation: 'TAX_STATUS', conflict_group_id: `${run_id}-cg1`, contradicts_id: `${run_id}-t1-f` } } })
  const clerk = researchTask(emit, ctx, { property, source_id: 'fx-src-duval-clerk', finding_type: 'tax_delinquency', task_id: `${run_id}-t4`, outcome: { kind: 'retrieved', finding: { evidence_status: 'county_confirmed', display_value: 'No tax-deed application on file', value: { tax_deed_application: false }, confidence: 0.9, citation: 'index search: parcel', is_negative_claim: true } } })
  for (const t of [vendor, blocked, appraiser, clerk]) t.added()
  emit('job.phase', { phase: 'researching' })
  for (const s of vendor.steps) s()
  for (const s of blocked.steps) s()
  emit('decision', { summary: 'Tax collector blocked automated access; continuing with the appraiser roll and the clerk tax-deed index.', basis_finding_ids: [`${run_id}-t2-f`], basis_refs: [], criterion: 'blocked_alternative' }, { property_id: pid })
  for (const s of appraiser.steps) s()
  for (const s of clerk.steps) s()
  emit('job.phase', { phase: 'cross_checking' })
  emit('finding.conflict', {
    conflict_group_id: `${run_id}-cg1`,
    finding_type: 'tax_status',
    members: [
      { finding_id: `${run_id}-t1-f`, source_id: 'fx-src-vendor-flags', evidence_status: 'vendor_reported', display_value: 'Tax delinquent (vendor flag)' },
      { finding_id: `${run_id}-t3-f`, source_id: 'fx-src-duval-appraiser', evidence_status: 'county_confirmed', display_value: '2025 taxes paid · current' },
    ],
    rule: 'official_fresh_outranks_vendor_aging',
    resolution_state: 'open',
  }, { property_id: pid })
  emit('decision', { summary: 'Tax status conflicts with the vendor flag; the county roll is official and fresher.', basis_finding_ids: [`${run_id}-t1-f`, `${run_id}-t3-f`], basis_refs: [], criterion: 'conflict_detected' }, { property_id: pid })
  emit('finding.upserted', { finding: makeFinding({ finding_id: `${run_id}-t1-f2`, property_id: pid, finding_type: 'tax_delinquency', source_id: 'fx-src-vendor-flags', evidence_status: 'stale', display_value: 'Tax delinquent (vendor flag) — contradicted by county roll 2026-10-08', value: { delinquent: true }, confidence: 0.2, supersedes_id: `${run_id}-t1-f`, contradicts_id: null, conflict_group_id: `${run_id}-cg1`, freshness_state: 'stale' }) }, { property_id: pid })
  emit('finding.conflict', { conflict_group_id: `${run_id}-cg1`, finding_type: 'tax_status', members: [{ finding_id: `${run_id}-t1-f2` }, { finding_id: `${run_id}-t3-f` }], rule: 'official_fresh_outranks_vendor_aging', resolution_state: 'resolved_by_rule' }, { property_id: pid })
  emit('job.property_state', { state: 'running', phase: 'cross_checking', opportunity_class: 'standard', contact_readiness_class: 'unknown', display_address: property.display_address, counters: {} }, { property_id: pid })
  emit('job.phase', { phase: 'synthesizing' })
  emitBriefSections(emit, property, 'deep', {
    taxes_liens: [
      { text: '2025 taxes paid; current per the county appraiser roll.', finding_id: `${run_id}-t3-f`, evidence_status: 'county_confirmed', is_inference: false },
      { text: 'Vendor delinquency flag contradicted by the county roll.', finding_id: `${run_id}-t1-f2`, evidence_status: 'stale', is_inference: false },
      { text: 'No tax-deed application on file (clerk index covers this jurisdiction).', finding_id: `${run_id}-t4-f`, evidence_status: 'county_confirmed', is_inference: false },
    ],
    risks_unresolved: [{ text: 'Tax collector blocked automated access. Not evidence of absence; verify manually if needed.', finding_id: `${run_id}-t2-f`, evidence_status: 'blocked', is_inference: false }],
  })
  emit('brief.completed', { opportunity_class: 'standard', contact_readiness_class: 'unknown', sections_missing: [] }, { property_id: pid })
  emit('job.property_state', { state: 'completed', phase: 'complete', opportunity_class: 'standard', contact_readiness_class: 'unknown', display_address: property.display_address, counters: {} }, { property_id: pid })
  emit('job.completed', { state: 'completed', summary: '4 source operations · 1 blocked · 1 conflict resolved by rule', counters: { planned: 4, done: 4, blocked: 1 }, accrued_usd: 0 })
  emit('run.state', { from: 'running', to: 'completed', reason: 'job_completed', accrued_usd: 0 })
  return { run_id, property }
}

// ── batch ──────────────────────────────────────────────────────────────────

function batchRun(seqr, { run_id, count, tasksPerProperty = 3, title, depth = 'deep' }) {
  const emit = makeEmitter(seqr, run_id)
  const capPer = depth === 'quick' ? 0 : 0.75
  const batchCap = Math.min(25, round6(capPer * count))
  const ctx = { rand: seqr.rand, accrued: 0, cap: batchCap }
  const props = Array.from({ length: count }, (_, i) => fixtureProperty(i + 1, 'cleveland'))
  emit('run.created', { kind: 'research', title: title || `${RESEARCH_DEPTH_LABELS[depth]} · ${count} properties`, objective_summary: `Investigate ${count} properties`, budget_cap_usd: batchCap, parent_run_id: null, depth }, { dt: 0 })
  emit('job.confirmed', {
    depth,
    property_count: count,
    estimate: { low_usd: 0, high_usd: batchCap, basis: 'worst_case', label: `No measured history yet: worst case $${batchCap.toFixed(2)} = ${count} × $${capPer.toFixed(2)} cap` },
    cap: { per_property_usd: capPer, batch_usd: batchCap },
    scope_sentence: `Research ${count} properties · ${RESEARCH_DEPTH_LABELS[depth]} · hard cap $${capPer.toFixed(2)} each · batch cap $${batchCap.toFixed(2)} (≤ $25)`,
  })
  emit('run.state', { from: 'created', to: 'running', reason: 'confirmed' })
  emit('job.phase', { phase: 'planning' })

  const plan = props.map((property, i) => {
    const pid = property.property_id
    const tasks = []
    const specs = [
      { source_id: 'fx-src-lc-records', finding_type: 'ownership', outcome: { kind: 'retrieved', finding: { evidence_status: 'vendor_reported', display_value: i % 3 === 0 ? 'LLC owner' : 'Individual owner', value: { owner_type: i % 3 === 0 ? 'llc' : 'individual' }, confidence: 0.6 } } },
      { source_id: 'fx-src-cuyahoga-tax', finding_type: 'tax_delinquency', outcome: i % 7 === 3 ? { kind: 'blocked', reason: 'http_403', message: 'Fixture tax roll refused automated access (403). Not evidence of absence.', alternatives: ['Open in Browser (manual) [test data]'] } : { kind: 'retrieved', finding: i % 4 === 1 ? { evidence_status: 'county_confirmed', display_value: `Tax delinquent $${(900 + i * 37).toLocaleString('en-US')} · county`, value: { delinquent: true, amount_usd: 900 + i * 37 }, confidence: 0.96, is_discovery: true } : { evidence_status: 'county_confirmed', display_value: 'Taxes current', value: { delinquent: false }, confidence: 0.95 } } },
      { source_id: 'fx-src-cleveland-code', finding_type: 'code_violation', outcome: i % 9 === 5 ? { kind: 'needs_input', question: 'Two parcels match this situs address. Which parcel?', options: ['Parcel A [test data]', 'Parcel B [test data]'] } : { kind: 'retrieved', finding: { evidence_status: 'county_confirmed', display_value: `${i % 5} open code cases`, value: { open_cases: i % 5 }, confidence: 0.9, is_discovery: i % 5 === 4 } } },
      { source_id: 'fx-src-cuyahoga-recorder', finding_type: 'lien', outcome: { kind: 'retrieved', finding: i % 6 === 2 ? { evidence_status: 'recorded', display_value: '1 open lien', value: { open_liens: 1 }, confidence: 0.85 } : { evidence_status: 'unverified', display_value: 'None found in index searched (index not exhaustive)', value: { open_liens_found: 0 }, confidence: 0.3 } } },
      { source_id: 'fx-src-cuyahoga-recorder', finding_type: 'foreclosure', outcome: { kind: 'retrieved', finding: i % 11 === 6 ? { evidence_status: 'recorded', display_value: 'Lis pendens 2026-08', value: { lis_pendens: true }, confidence: 0.82, is_discovery: true } : { evidence_status: 'unverified', display_value: 'None found in index searched (index not exhaustive)', value: { lis_pendens_found: false }, confidence: 0.3 } } },
      { source_id: 'fx-src-lc-records', finding_type: 'comparable_sales', outcome: { kind: 'retrieved', finding: { evidence_status: 'vendor_reported', display_value: `${3 + (i % 4)} investor comps within 0.5 mi`, value: { comps: 3 + (i % 4) }, confidence: 0.7 } } },
      { source_id: 'fx-src-lc-records', finding_type: 'listing_status', outcome: { kind: 'unavailable' } },
    ].slice(0, tasksPerProperty)
    specs.forEach((spec, j) => {
      tasks.push(researchTask(emit, ctx, { property, ...spec, task_id: `${run_id}-p${i + 1}-t${j + 1}` }))
    })
    return { property, pid, tasks, index: i }
  })
  for (const p of plan) {
    emit('job.property_state', { state: 'queued', phase: 'planning', opportunity_class: 'unknown', contact_readiness_class: 'unknown', display_address: p.property.display_address, counters: { planned: p.tasks.length, done: 0 } }, { property_id: p.pid, dt: 15 })
  }
  for (const p of plan) for (const t of p.tasks) t.added()
  emit('job.phase', { phase: 'researching' })

  // concurrency 2: interleave pairs of properties
  for (let k = 0; k < plan.length; k += 2) {
    const pair = plan.slice(k, k + 2)
    const streams = pair.map((p) => {
      const steps = [() => emit('job.property_state', { state: 'running', phase: 'researching', opportunity_class: 'unknown', contact_readiness_class: 'unknown', display_address: p.property.display_address, counters: { planned: p.tasks.length, done: 0 } }, { property_id: p.pid })]
      for (const t of p.tasks) steps.push(...t.steps)
      const discovery = p.index % 4 === 1 || p.index % 11 === 6
      const blockedOne = p.index % 7 === 3
      const cls = discovery ? 'priority' : p.index % 3 === 0 ? 'strong' : 'standard'
      steps.push(() => emit('brief.completed', { opportunity_class: cls, contact_readiness_class: p.index % 5 === 2 ? 'held' : 'ready', sections_missing: blockedOne ? ['taxes_liens'] : [] }, { property_id: p.pid }))
      steps.push(() => emit('job.property_state', { state: blockedOne ? 'completed_partial' : 'completed', phase: 'complete', opportunity_class: cls, contact_readiness_class: p.index % 5 === 2 ? 'held' : 'ready', display_address: p.property.display_address, counters: { planned: p.tasks.length, done: p.tasks.length } }, { property_id: p.pid }))
      return steps
    })
    const max = Math.max(...streams.map((s) => s.length))
    for (let i = 0; i < max; i += 1) for (const s of streams) if (s[i]) s[i]()
  }
  emit('job.phase', { phase: 'synthesizing' })
  emit('decision', { summary: `Batch complete: ${plan.filter((p) => p.index % 4 === 1 || p.index % 11 === 6).length} priority discoveries; blocked sources are listed per property.`, basis_finding_ids: [], basis_refs: [], criterion: 'batch_summary' })
  emit('job.completed', { state: 'completed_partial', summary: `${count} properties · ${plan.filter((p) => p.index % 7 === 3).length} with a blocked source`, counters: { properties: count }, accrued_usd: ctx.accrued })
  emit('run.state', { from: 'running', to: 'completed_partial', reason: 'job_completed', accrued_usd: ctx.accrued })
  return { run_id, props }
}

// ── campaign handoff (research run → agent task run) ───────────────────────

function campaignHandoff(seqr) {
  const researchRun = 'fx-run-handoff-research'
  const r = batchRun(seqr, { run_id: researchRun, count: 3, tasksPerProperty: 3, title: 'Deep Research · 3 properties' })
  const run_id = 'fx-run-handoff-task'
  const emit = makeEmitter(seqr, run_id)
  const ids = r.props.map((p) => p.property_id)
  const turn_id = 'fx-turn-1'
  emit('run.created', { kind: 'task', title: 'Add researched properties to a campaign draft', objective_summary: 'Prepare a campaign draft from 3 researched properties', budget_cap_usd: 0.5, parent_run_id: researchRun, depth: null }, { dt: 1200 })
  emit('message.operator', { turn_id, text: 'Add these three to a campaign draft.', client_msg_id: 'fx-client-1' })
  emit('context.attached', { app: 'entity-graph', object_refs: ids.map((id) => ({ kind: 'property', id })), filter_summary: 'Research: completed · 3 selected', selection_count: 3 })
  emit('run.state', { from: 'created', to: 'running', reason: 'operator_message' })
  const tool_call_id = 'fx-tc-1'
  emit('tool.proposed', { tool: 'composer.audience_preview', tool_version: 1, tier: 'T0', target_refs: ids.map((id) => ({ kind: 'property', id })), intent_basis: 'turn' }, { tool_call_id })
  emit('tool.started', { tool: 'composer.audience_preview', tool_version: 1, tier: 'T0', operation: 'tool.invoke', label: renderOperationLabel('tool.invoke', { tool_label: 'Previewing campaign audience eligibility' }), target_refs: ids.map((id) => ({ kind: 'property', id })) }, { tool_call_id })
  emit('tool.completed', { tool: 'composer.audience_preview', rows: 3, duration_ms: 840, cost_usd: 0, result_summary: { ready: 2, held: 1, ineligible: 0, held_reasons: [{ reason: 'no_sms_reachable_phone', count: 1 }] }, incomplete: false }, { tool_call_id, dt: 840 })
  emit('decision', { summary: 'Readiness is separate from opportunity: 2 of 3 are ready to contact, 1 is held (no SMS-reachable phone).', basis_finding_ids: [], basis_refs: ids.map((id) => `property:${id}`), criterion: 'readiness_vs_opportunity' })
  emit('artifact.created', { artifact_id: 'fx-art-aud-1', kind: 'audience_proposal', version: 1, title: 'Campaign draft audience · 3 researched properties', status: 'draft' })
  emit('ui.intent', { intent: 'open_campaign_sheet', destination: 'entity-graph.campaign-sheet', object_refs: ids.map((id) => ({ kind: 'property', id })), params: { mode: 'draft' }, label: 'Open Add to Campaign with 3 properties (draft only)', draft_only: true })
  const approval_id = 'fx-apr-1'
  const hash = fakeHex(seqr.rand)
  emit('tool.proposed', { tool: 'campaigns.build_targets', tool_version: 1, tier: 'T3', target_refs: [{ kind: 'campaign_draft', id: 'fx-campaign-draft-1' }], intent_basis: 'turn' }, { tool_call_id: 'fx-tc-2' })
  emit('approval.requested', {
    approval: {
      approval_id,
      run_id,
      tool_call_id: 'fx-tc-2',
      tool: 'campaigns.build_targets',
      tool_version: 1,
      tier: 'T3',
      payload_hash: hash,
      payload_hash_prefix: hash.slice(0, 12),
      effects: [{ summary: 'Materializes 2 ready recipients into campaign draft [test data]. No messages are sent.', kind: 'materialize', reversible: false, undo_note: 'Built targets can be cleared, not un-built.' }],
      precondition_summary: ['Campaign is still a draft', 'Outbound paused by owner: nothing will send'],
      target_scope_summary: '1 campaign draft · 2 recipients',
      required_role: 'lead',
      fresh_auth_required: false,
      owner_only: false,
      requested_at: new Date(FIXTURE_BASE_AT + seqr.t_ms).toISOString(),
      expires_at: new Date(FIXTURE_BASE_AT + seqr.t_ms + 10 * 60 * 1000).toISOString(),
      state: 'requested',
      provenance: { basis: 'turn', label: 'Proposed from: your message 15:0x' },
      batch_id: null,
      identity_available: false,
    },
  }, { tool_call_id: 'fx-tc-2' })
  emit('run.state', { from: 'running', to: 'awaiting_approval', reason: 'approval_requested' })
  return { research_run_id: researchRun, run_id }
}

// ── public API ─────────────────────────────────────────────────────────────

function finalize(meta, seqr, extra = {}) {
  return {
    scenario_id: meta.id,
    scenario_number: meta.n,
    title: meta.title,
    proves: meta.proves,
    fixture: true,
    test_data: true,
    notice: 'FIXTURE — fictional test data for design review. Not production events.',
    base_at: new Date(FIXTURE_BASE_AT).toISOString(),
    duration_ms: seqr.t_ms,
    runs: Object.keys(seqr.seqByRun),
    sources: FIXTURE_SOURCES,
    presentation: extra.presentation || {},
    events: seqr.events,
    ...(extra.resume ? { resume: extra.resume } : {}),
  }
}

/**
 * Generate one design-review scenario.
 * @param {string} id one of FIXTURE_SCENARIO_IDS
 * @returns {{ scenario_id: string, fixture: true, test_data: true, runs: string[], events: import('../events.js').AgentEvent[], sources: Array, presentation: Object, resume?: Object }}
 */
export function generateFixtureScenario(id) {
  const meta = FIXTURE_SCENARIOS.find((s) => s.id === id)
  if (!meta) throw new Error(`UNKNOWN_FIXTURE_SCENARIO:${id}`)
  const seqr = createSequencer({ seed: meta.n * 7919 })
  switch (id) {
    case 'single-deep':
      singlePropertyRun(seqr, { run_id: 'fx-run-single', property: fixtureProperty(1, 'cleveland'), variant: 'single' })
      return finalize(meta, seqr)
    case 'discoveries':
      singlePropertyRun(seqr, { run_id: 'fx-run-discoveries', property: fixtureProperty(2, 'cleveland'), variant: 'discoveries' })
      return finalize(meta, seqr)
    case 'batch-25':
      batchRun(seqr, { run_id: 'fx-run-batch25', count: 25, tasksPerProperty: 3 })
      return finalize(meta, seqr)
    case 'blocked-conflict':
      blockedConflictRun(seqr, { run_id: 'fx-run-duval' })
      return finalize(meta, seqr)
    case 'campaign-handoff':
      campaignHandoff(seqr)
      return finalize(meta, seqr)
    case 'resume-reload': {
      batchRun(seqr, { run_id: 'fx-run-resume', count: 25, tasksPerProperty: 3 })
      const mid = seqr.events[Math.floor(seqr.events.length / 2)]
      const before = seqr.events.filter((e) => e.event_id <= mid.event_id)
      const snapshotView = reduceEvents(before)['fx-run-resume']
      return finalize(meta, seqr, {
        resume: {
          reload_after_event_id: mid.event_id,
          snapshot: { run_id: 'fx-run-resume', state: snapshotView.state, phase: snapshotView.phase, last_event_id: snapshotView.last_event_id, last_seq: snapshotView.last_seq, counters: snapshotView.counters, fixture: true },
          // the transport redelivers a few events at/before the cursor after reconnect; the client must drop them
          redelivered_event_ids: before.slice(-5).map((e) => e.event_id),
        },
      })
    }
    case 'ultrawide': {
      // two concurrent runs on one global sequence; event ids interleave
      const a = createSequencer({ seed: 101 })
      singlePropertyRun(a, { run_id: 'fx-run-uw-single', property: fixtureProperty(30, 'cleveland'), variant: 'discoveries' })
      const b = createSequencer({ seed: 202 })
      batchRun(b, { run_id: 'fx-run-uw-batch', count: 25, tasksPerProperty: 3 })
      const merged = [...a.events, ...b.events].sort((x, y) => x.fixture_t_ms - y.fixture_t_ms || (x.run_id < y.run_id ? -1 : 1))
      merged.forEach((e, i) => { e.event_id = i + 1 })
      seqr.events = merged
      seqr.seqByRun = { 'fx-run-uw-single': a.seqByRun['fx-run-uw-single'], 'fx-run-uw-batch': b.seqByRun['fx-run-uw-batch'] }
      seqr.t_ms = Math.max(a.t_ms, b.t_ms)
      return finalize(meta, seqr, { presentation: { viewport: { width: 5120, height: 1440 }, layout: 'multi-column' } })
    }
    case 'reduced-motion':
      batchRun(seqr, { run_id: 'fx-run-perf', count: 50, tasksPerProperty: 7, title: 'Deep Research · 50 properties (max batch)' })
      return finalize(meta, seqr, { presentation: { reduced_motion: true, data_lc_motion: 'reduce' } })
    default:
      throw new Error(`UNKNOWN_FIXTURE_SCENARIO:${id}`)
  }
}

/** All scenarios, generated. */
export function generateAllFixtureScenarios() {
  return FIXTURE_SCENARIO_IDS.map((id) => generateFixtureScenario(id))
}

/** Lightweight listing for an index route. */
export function listFixtureScenarios() {
  return FIXTURE_SCENARIOS.map((s) => ({ id: s.id, number: s.n, title: s.title, proves: s.proves, fixture: true }))
}
