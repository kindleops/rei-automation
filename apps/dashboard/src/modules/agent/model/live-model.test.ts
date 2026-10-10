import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, Finding } from '../contracts/contracts'
import { bucketSummary, groupActivity, type Bucket } from './activity-groups'
import { composeOwnerBrief, OWNER_BRIEF_ORDER } from './brief-model'
import { conflictsFor } from './conflict-model'
import { evidenceClassOf, limitationsOf, toSourceRef } from './evidence-class'
import { findingsByPanel, isTerminal, progressOf, reduceResearch } from './research-model'

/**
 * S3 LIVE SHAPES — a synthetic log in the exact shape the S3 backend emits
 * (c0a16cf5: research.check tasks on LeadCommand sources, server-assigned
 * source_class, internal_record / derived statuses, object conflict members
 * with best_supported / reason / follow_up, brief.section property_id,
 * run.* lifecycle, an interrupted read re-run as attempt 2). Test data only.
 */
const RUN = 'run_test_live'
const P = 'test-prop-1'
let id = 0
const ev = (type: AgentEvent['type'], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent => {
  id += 1
  return { event_id: id, run_id: RUN, seq: id, type, at: new Date(Date.UTC(2026, 9, 9, 4, 20, id)).toISOString(), attempt: 1, visibility: 'operator', property_id: null, task_id: null, tool_call_id: null, payload, ...extra }
}
const finding = (f: Partial<Finding> & Pick<Finding, 'finding_id' | 'finding_type' | 'evidence_status'>): Finding => ({
  property_id: P, key: f.finding_type, value: f.display_value ?? null, display_value: null, confidence: 0.6, confidence_band: 'medium', is_inference: false, is_discovery: false, is_negative_claim: false,
  freshness_state: 'fresh', observed_at: null, retrieved_at: '2026-10-09T04:20:43Z', fresh_until: null, source_id: 'lc.property_record', citation: null, supersedes_id: null, contradicted_by: null, conflict_group_id: null, live: true, ...f,
})

function log(): AgentEvent[] {
  id = 0
  const t1 = { property_id: P, task_id: 'rtask_a' }
  const t2 = { property_id: P, task_id: 'rtask_b' }
  return [
    ev('run.created', { kind: 'research', title: 'Quick Scan · 1 property', budget_cap_usd: 0, depth: 'quick' }),
    ev('job.created', { depth: 'quick', property_count: 1, estimate: { low_usd: 0, high_usd: 0, basis: 'structural_zero' }, cap: { per_property_usd: 0, batch_usd: 0 } }),
    ev('job.confirmed', { depth: 'quick', property_count: 1, cap: { per_property_usd: 0, batch_usd: 0 }, scope_sentence: null }),
    ev('run.state', { from: 'created', to: 'running', reason: 'quick_scan_confirmed', accrued_usd: 0 }),
    ev('job.phase', { phase: 'planning' }),
    ev('plan.task_added', { task_id: 'rtask_a', operation: 'research.check', source_id: 'lc.property_record', finding_type: 'property_facts', billable: false, label: 'Checking LeadCommand property facts (LeadCommand property record)' }, t1),
    ev('plan.task_added', { task_id: 'rtask_b', operation: 'research.check', source_id: 'lc.recorded_documents', finding_type: 'mortgage', billable: false, label: 'Checking LeadCommand mortgage (Recorded documents (vendor-transcribed))' }, t2),
    ev('job.property_state', { state: 'running', phase: 'researching' }, { property_id: P }),
    ev('job.phase', { phase: 'researching' }),
    ev('task.started', { operation: 'research.check', source_id: 'lc.property_record', finding_type: 'property_facts', label: 'Checking LeadCommand property facts (LeadCommand property record)' }, t1),
    ev('source.retrieved', { source_id: 'lc.property_record', host: 'leadcommand', retrieved_at: '2026-10-09T04:20:43Z', purpose: 'property facts' }, t1),
    ev('finding.upserted', { finding: finding({ finding_id: 'f_core', finding_type: 'property_facts', evidence_status: 'vendor_reported', source_class: 'third_party_vendor', display_value: 'Single family · 3 bd', limitations: ['Vendor snapshot attributes; not verified against the assessor.'] }) }, t1),
    ev('finding.upserted', { finding: finding({ finding_id: 'f_free', finding_type: 'equity', evidence_status: 'vendor_reported', source_class: 'third_party_vendor', display_value: 'Free And Clear (vendor flag)' }) }, t1),
    ev('task.completed', { duration_ms: 812, cost_usd: 0, observation_count: 1 }, t1),
    ev('task.started', { operation: 'research.check', source_id: 'lc.recorded_documents', finding_type: 'mortgage', label: 'Checking LeadCommand mortgage (Recorded documents (vendor-transcribed))' }, t2),
    ev('task.unavailable', { reason: 'interrupted_by_restart', retry_at: '2026-10-09T04:24:37Z' }, t2),
    ev('task.started', { operation: 'research.check', source_id: 'lc.recorded_documents', finding_type: 'mortgage', label: 'Checking LeadCommand mortgage (Recorded documents (vendor-transcribed))' }, { ...t2, attempt: 2 }),
    ev('finding.upserted', { finding: finding({ finding_id: 'f_mtg', finding_type: 'mortgage', evidence_status: 'recorded', source_class: 'official_public_record', source_id: 'lc.recorded_documents', display_value: 'Mortgage recorded 1994-05-17', confidence: 0.95, confidence_band: 'high' }) }, { ...t2, attempt: 2 }),
    ev('finding.upserted', { finding: finding({ finding_id: 'f_lien', finding_type: 'lien', evidence_status: 'unavailable', source_class: 'unavailable_blocked', source_id: 'lc.recorded_documents', confidence: 0, confidence_band: 'low', freshness_state: 'never', unavailable_reason: 'no_rows_in_feed' }) }, { ...t2, attempt: 2 }),
    ev('finding.upserted', { finding: finding({ finding_id: 'f_sms', finding_type: 'sms_eligibility', evidence_status: 'internal_record', source_class: 'internal_record', source_id: 'lc.campaign_target_graph', display_value: 'Not SMS-eligible (no ranked phone)' }) }, { ...t2, attempt: 2 }),
    ev('finding.upserted', { finding: finding({ finding_id: 'f_eq', finding_type: 'equity', evidence_status: 'derived', source_class: 'derived_inferred', source_id: 'lc.derived_rules', display_value: 'Equity 100% (rule free_and_clear)' }) }, { ...t2, attempt: 2 }),
    ev('task.completed', { duration_ms: 1400, cost_usd: 0, observation_count: 3 }, { ...t2, attempt: 2 }),
    ev('job.phase', { phase: 'cross_checking' }),
    ev('finding.conflict', {
      conflict_group_id: 'cfl_open', finding_type: 'mortgage', rule: 'free_clear_flag_vs_recorded_mortgage', resolution_state: 'open', best_supported: null,
      members: [
        { finding_id: 'f_free', claim: 'Vendor flags the property "Free And Clear"', source_id: 'lc.property_record', source_name: 'LeadCommand property record', source_class: 'third_party_vendor', evidence_status: 'vendor_reported', as_of: '2026-05-30' },
        { finding_id: 'f_mtg', claim: 'A mortgage recorded 1994-05-17 sits in an open slot', source_id: 'lc.recorded_documents', source_name: 'Recorded documents (vendor-transcribed)', source_class: 'official_public_record', evidence_status: 'recorded', as_of: '1994-05-17' },
      ],
      reason: 'The recorded mortgage predates the vendor snapshot; a later release the feed lacks would make the vendor right.',
      remaining_uncertainty: 'Whether the recorded mortgage was released or satisfied.',
      follow_up: 'Search the county recorder for a release/satisfaction of the mortgage recorded 1994-05-17.',
    }, { property_id: P }),
    ev('finding.conflict', {
      conflict_group_id: 'cfl_won', finding_type: 'lien', rule: 'recorded_lien_vs_vendor_flag', resolution_state: 'resolved_by_rule',
      members: [{ finding_id: 'f_core', claim: 'Vendor shows no lien flag', source_class: 'third_party_vendor', evidence_status: 'vendor_reported', as_of: '2026-05-30' }, { finding_id: 'f_mtg', claim: 'A lien was recorded after the vendor snapshot', source_class: 'official_public_record', evidence_status: 'recorded', as_of: '2026-07-01' }],
      best_supported: { finding_id: 'f_mtg', claim: 'A lien was recorded after the vendor snapshot', source_class: 'official_public_record', evidence_status: 'recorded', as_of: '2026-07-01' },
      reason: 'Recorded instrument is higher authority and fresher than the vendor flag.', remaining_uncertainty: 'Release status of the lien.', follow_up: 'Check for a release of the recorded lien.',
    }, { property_id: P }),
    ev('job.phase', { phase: 'synthesizing' }),
    ev('brief.section', { property_id: P, section_key: 'property_ownership', label: 'Property & ownership', claims: [{ text: 'Single family · 3 bd', finding_ids: ['f_core'], evidence_status: 'vendor_reported', source_class: 'third_party_vendor', confidence: 0.6, freshness_state: 'fresh', source_name: 'LeadCommand property record', is_inference: false }] }),
    ev('brief.section', { property_id: P, section_key: 'next_investigation', label: 'Recommended next investigation', claims: [{ text: 'Not SMS-eligible (no ranked phone)', finding_ids: ['f_sms'], evidence_status: 'internal_record', source_class: 'internal_record', confidence: 0.9, freshness_state: 'fresh', source_name: 'Campaign target graph', is_inference: false }] }),
    ev('brief.completed', { opportunity_class: 'unknown', contact_readiness_class: 'ineligible', sections_missing: ['physical_condition', 'listing_history'] }, { property_id: P }),
    ev('job.property_state', { state: 'completed', phase: 'complete', display_address: '100 Test St (test data)' }, { property_id: P }),
    ev('decision', { summary: 'Quick Scan read 1 property: 4 findings with a value, 1 unavailable, 1 unresolved and 1 resolved conflict. $0.', criterion: 'quick_scan_summary', basis_finding_ids: [], basis_refs: ['cfl_open'] }),
    ev('job.completed', { state: 'completed', summary: 'Quick Scan read 1 property. $0.', accrued_usd: 0 }),
    ev('run.completed', { state: 'completed', summary: 'Quick Scan read 1 property. $0.', accrued_usd: 0 }),
  ]
}

const SOURCES = Object.fromEntries([
  toSourceRef({ source_id: 'lc.property_record', name: 'LeadCommand property record', authority_class: 'commercial', source_class: 'third_party_vendor', limitations: ['Vendor snapshot attributes; not verified against the assessor.'] }),
  toSourceRef({ source_id: 'lc.recorded_documents', name: 'Recorded documents (vendor-transcribed)', authority_class: 'commercial', source_class: 'official_public_record' }),
].map((s) => [s.source_id, s]))

describe('S3 live event shapes', () => {
  const v = reduceResearch(RUN, log())

  it('reaches a terminal state from job.* / run.* and never flags a gap', () => {
    expect(v.state).toBe('completed')
    expect(isTerminal(v)).toBe(true)
    expect(v.gap).toBe(false)
    expect(v.fixture).toBe(false)
    expect(v.cap_usd).toBe(0)
    expect(v.depth).toBe('quick')
  })

  it('records the retry: attempt 2 with the prior failure reason, one row, one retry', () => {
    const t = v.tasks[v.taskIndex.rtask_b]
    expect(v.tasks.filter((x) => x.task_id === 'rtask_b')).toHaveLength(1)
    expect(t.attempt).toBe(2)
    expect(t.prior_failure).toBe('interrupted_by_restart')
    expect(t.state).toBe('succeeded')
    expect(v.retries).toBe(1)
    expect(progressOf(v)).toMatchObject({ planned: 2, done: 2, succeeded: 2 })
  })

  it('uses the server source class — never re-derives it', () => {
    expect(evidenceClassOf(v.findings.f_mtg, SOURCES['lc.recorded_documents'])).toBe('official')
    expect(evidenceClassOf(v.findings.f_core, SOURCES['lc.property_record'])).toBe('vendor')
    expect(evidenceClassOf(v.findings.f_sms, null)).toBe('internal')
    expect(evidenceClassOf(v.findings.f_eq, null)).toBe('derived')
    expect(evidenceClassOf(v.findings.f_lien, SOURCES['lc.recorded_documents'])).toBe('unavailable')
  })

  it('puts the server limitations first and names an unavailable reason', () => {
    const l = limitationsOf(v.findings.f_core, SOURCES['lc.property_record'])
    expect(l[0]).toBe('Vendor snapshot attributes; not verified against the assessor.')
    expect(limitationsOf(v.findings.f_lien, null).some((x) => x.includes('no rows in feed'))).toBe(true)
  })

  it('maps Quick Scan finding types to inspector panels', () => {
    const panels = findingsByPanel(v, P)
    expect(panels.ownership?.map((f) => f.finding_id)).toContain('f_core')
    expect(panels.contact?.map((f) => f.finding_id)).toContain('f_sms')
    expect(panels.other).toBeUndefined()
  })

  it('conflicts: unresolved keeps no conclusion and shows the server reason + follow-up; decisive shows best supported', () => {
    const cs = conflictsFor(v, SOURCES, P)
    const open = cs.find((c) => c.id === 'cfl_open')!
    expect(open.status).toBe('unresolved')
    expect(open.conclusion).toBeNull()
    expect(open.unresolved_reason).toMatch(/predates the vendor snapshot/)
    expect(open.uncertainty).toContain('Whether the recorded mortgage was released or satisfied.')
    expect(open.follow_up[0]).toMatch(/release\/satisfaction/)
    expect(open.claims.map((c) => c.role)).toEqual(['competing', 'competing'])
    expect(open.claims[0].cls).toBe('official') // strongest first
    const won = cs.find((c) => c.id === 'cfl_won')!
    expect(won.status).toBe('resolved')
    expect(won.conclusion?.finding_id).toBe('f_mtg')
    expect(won.conclusion?.reason).toMatch(/higher authority/)
    expect(won.claims[0].role).toBe('preferred')
    expect(cs[0].status).toBe('unresolved') // unresolved sort first
  })

  it('brief: the owner order, recommendation from the run only, Quick Scan has no economics', () => {
    expect(OWNER_BRIEF_ORDER.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(OWNER_BRIEF_ORDER.map((s) => s.key)).toEqual(['recommendation', 'findings', 'confidence', 'economics', 'evidence', 'conflicts', 'next'])
    const b = composeOwnerBrief(v, v.properties[P], SOURCES, true)
    expect(b.status).toBe('final')
    expect(b.recommendation.opportunity).toBe('unknown')
    expect(b.recommendation.readiness).toBe('ineligible')
    expect(b.economics.applicable).toBe(false)
    expect(b.economics.note).toMatch(/Quick Scan does not compute/)
    expect(b.findings.find((f) => f.key === 'property_ownership')?.arrived).toBe(true)
    expect(b.next).toHaveLength(1)
    expect(b.conflicts).toHaveLength(2)
    expect(b.unavailable).toHaveLength(0) // the interrupted read re-ran and succeeded
    expect(b.byClass).toMatchObject({ official: 1, vendor: 2, internal: 1, derived: 1, unavailable: 1 })
    expect(b.confidence.gaps.some((g) => g.startsWith('Not covered'))).toBe(true)
    expect(v.properties[P].display_address).toBe('100 Test St (test data)')
  })

  it('groups routine reads by tool family and never folds exceptions', () => {
    const groups = groupActivity(v, SOURCES, { propertyId: P, filter: 'all' })
    const buckets = groups.flatMap((g) => g.entries.filter((e): e is Bucket => e.kind === 'bucket'))
    const rec = buckets.find((b) => b.family === 'Recorded documents (vendor-transcribed)')!
    // rtask_b was retried and its findings sit in a conflict → surfaced, not folded
    expect(rec.exceptions.map((x) => x.task.task_id)).toEqual(['rtask_b'])
    expect(['conflict', 'retried']).toContain(rec.exceptions[0].why)
    const core = buckets.find((b) => b.family === 'LeadCommand property record')!
    expect(core.exceptions.map((x) => x.why)).toEqual(['conflict']) // f_free / f_core are conflict members
    expect(bucketSummary(rec)).toMatch(/1 read completed/)
    expect(bucketSummary(rec)).toMatch(/1 finding unavailable/)
    // every task appears exactly once across buckets
    const all = buckets.flatMap((b) => b.tasks.map((t) => t.task_id)).sort()
    expect(all).toEqual(['rtask_a', 'rtask_b'])
  })

  it('applies an event exactly once (idempotent replay = same view)', () => {
    const events = log()
    const twice = reduceResearch(RUN, events)
    expect(JSON.stringify(twice.findings)).toBe(JSON.stringify(v.findings))
  })
})

/**
 * Local-only: replay the backend agent's RECORDED live Quick Scan (5 real
 * properties, read-only, $0) through the client reducer. Skipped when the
 * artifact is not on this machine; it is never committed (real records).
 */
const ARTIFACT = '/tmp/agent-s3-demo/run1-before.json'
describe.skipIf(!fs.existsSync(ARTIFACT))('recorded live Quick Scan (local artifact)', () => {
  it('reduces 401 recorded events without a gap, to the same terminal state as the server', () => {
    const j = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')) as { events: AgentEvent[]; snapshot: { state: string; findings: unknown[]; conflicts: unknown[] } }
    expect(j.events.some((e) => e.fixture)).toBe(false)
    const v = reduceResearch(j.events[0].run_id, j.events)
    expect(v.gap).toBe(false)
    expect(v.state).toBe(j.snapshot.state)
    expect(Object.keys(v.findings)).toHaveLength(j.snapshot.findings.length)
    expect(Object.keys(v.conflicts)).toHaveLength(j.snapshot.conflicts.length)
    expect(findingsByPanel(v, null).other).toBeUndefined()
    for (const c of conflictsFor(v, {}, null)) expect(c.status === 'resolved' ? Boolean(c.conclusion) : c.conclusion === null).toBe(true)
    // grouping: each task exactly once; anything blocked / failed / unavailable / in conflict is never folded
    const buckets = groupActivity(v, {}, { propertyId: null, filter: 'all' }).flatMap((g) => g.entries.filter((e): e is Bucket => e.kind === 'bucket'))
    expect(buckets.reduce((n, b) => n + b.tasks.length, 0)).toBe(v.tasks.length)
    for (const b of buckets) for (const t of b.routine) expect(['succeeded', 'skipped_fresh', 'planned', 'queued']).toContain(t.state)
    expect(buckets.some((b) => b.routine.length > 1)).toBe(true) // routine reads really do fold
  })
})
