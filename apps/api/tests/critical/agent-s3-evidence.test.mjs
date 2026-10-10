// Agent S3 — source-class assignment and the conflict model.
//   * blocked / unavailable never carry a value and are never "absent"
//   * vendor ≠ official: vendor flags/estimates are third_party_vendor; only a
//     recorded instrument WITH its recording date is official_public_record
//   * conflicts are decisive only when the higher authority is also fresher;
//     otherwise unresolved with a follow-up; absence never outweighs a claim
import test from 'node:test'
import assert from 'node:assert/strict'

import { findingsFromTool, detectConflicts, makeFinding, unavailableFindingsForTool } from '../../src/lib/agent/quick-scan/evidence.js'
import { EVIDENCE_SOURCE_CLASSES, EVIDENCE_SOURCE_CLASS_META, EVIDENCE_STATUSES, EXTENDED_EVIDENCE_STATUSES, findingViolations, sourceClassViolations } from '../../src/lib/agent/contracts/evidence.js'

const ctx = { run_id: 'run_t', property_id: 'p1', retrieved_at: '2026-10-09T04:00:00.000Z', now: new Date('2026-10-09T04:00:00Z') }

function recDocs({ mortgages = [], liens = [], foreclosures = [], parcel = { tax_delinquent: false, active_lien: false, open_mortgage_count: 0, updated_at: '2026-04-22' } } = {}) {
  return { property_id: 'p1', available: true, mortgages, liens, foreclosures, parcel, totals: null }
}
const mtg = (over = {}) => ({ open: true, position: 1, recorded: '2019-05-03', amount: 180000, loan_type: 'Conventional', financing: null, private_lender: false, lender: 'Bank', est_balance: 150000, est_payment: 1100, rate: 3.2, due: null, term_months: 360, ...over })
const valuation = (flags = [], loan = 0) => ({ property_id: 'p1', vendor: { estimated_value: 250000, value_low: null, value_high: null, value_confidence: null, valuation_date: '2026-04-22', equity_percent: 100, total_loan_balance: loan, equity_flags: flags }, engine: null, equity: { known: false, percent: null, amount: null, class: 'unknown', rule: 'unknown' }, provenance: { vendor_as_of: '2026-04-22' } })

const all = (tool, output) => findingsFromTool(tool, output, ctx)

test('contract: five P4 source classes; the DR status vocabulary is unchanged; extended statuses are additive', () => {
  assert.deepEqual([...EVIDENCE_SOURCE_CLASSES], ['official_public_record', 'internal_record', 'third_party_vendor', 'derived_inferred', 'unavailable_blocked'])
  assert.deepEqual([...EVIDENCE_STATUSES], ['county_confirmed', 'recorded', 'vendor_reported', 'licensed_provider', 'model_inference', 'unverified', 'stale', 'unavailable', 'blocked'])
  assert.deepEqual(EXTENDED_EVIDENCE_STATUSES.slice(-2), ['internal_record', 'derived'])
  assert.ok(!EVIDENCE_SOURCE_CLASS_META.official_public_record.statuses.includes('vendor_reported'))
  assert.ok(!EVIDENCE_SOURCE_CLASS_META.third_party_vendor.statuses.includes('recorded'))
  assert.deepEqual(sourceClassViolations({ source_class: 'third_party_vendor', evidence_status: 'recorded', value: 1 }), ['SOURCE_CLASS_STATUS_MISMATCH'])
  assert.deepEqual(sourceClassViolations({ source_class: 'unavailable_blocked', evidence_status: 'unavailable', value: 5 }), ['NO_VALUE_STATUS_HAS_VALUE'])
  assert.deepEqual(findingViolations({ evidence_status: 'internal_record', value: 1 }), [])
  assert.deepEqual(findingViolations({ evidence_status: 'nonsense' }), ['UNKNOWN_EVIDENCE_STATUS'])
})

test('makeFinding refuses vendor data labelled official, values on unavailable, and negative claims', () => {
  const base = { ...ctx, finding_type: 'lien', key: 'k', citation: 'c' }
  assert.throws(() => makeFinding({ ...base, source_id: 'lc.vendor_parcel', source_class: 'official_public_record', evidence_status: 'vendor_reported', value: 1 }), (e) => e.code === 'FINDING_INVARIANT')
  const u = makeFinding({ ...base, source_id: 'lc.recorded_documents', source_class: 'unavailable_blocked', evidence_status: 'unavailable', value: 'none', display_value: 'None found' })
  assert.equal(u.value, null)
  assert.equal(u.display_value, null)
  assert.equal(u.is_negative_claim, false)
  assert.equal(u.confidence, 0)
  assert.equal(u.freshness_state, 'never')
})

test('no recorded documents → UNAVAILABLE (never "free and clear" / "no liens"); every finding carries provenance + limitations', () => {
  const fs = all('eg.recorded_documents', recDocs())
  const by = Object.fromEntries(fs.map((f) => [`${f.finding_type}:${f.key}`, f]))
  for (const k of ['mortgage:recorded_mortgages', 'lien:recorded_liens', 'foreclosure:recorded_foreclosures']) {
    assert.equal(by[k].evidence_status, 'unavailable', k)
    assert.equal(by[k].source_class, 'unavailable_blocked')
    assert.equal(by[k].value, null)
    assert.equal(by[k].is_negative_claim, false)
    assert.equal(by[k].unavailable_reason, 'none_in_vendor_recorded_feed')
    assert.ok(by[k].limitations.some((l) => /NOT evidence/.test(l)))
  }
  for (const f of fs) {
    assert.ok(f.provenance && f.retrieved_at && f.citation && Array.isArray(f.limitations), f.key)
    assert.ok(EVIDENCE_SOURCE_CLASSES.includes(f.source_class))
  }
})

test('vendor ≠ official: recorded rows WITH a recording date are official (vendor-transcribed); estimates and flags are vendor', () => {
  const fs = all('eg.recorded_documents', recDocs({ mortgages: [mtg()] }))
  const rec = fs.find((f) => f.key === 'recorded_mortgages')
  assert.equal(rec.source_class, 'official_public_record')
  assert.equal(rec.evidence_status, 'recorded')
  assert.ok(rec.limitations.some((l) => /vendor; not re-verified|transcribed/i.test(l)))
  const est = fs.find((f) => f.key === 'vendor_loan_estimate')
  assert.equal(est.source_class, 'third_party_vendor')
  const flags = fs.find((f) => f.key === 'vendor_parcel_flags')
  assert.equal(flags.source_class, 'third_party_vendor')
  assert.ok(['vendor_reported', 'stale'].includes(flags.evidence_status))
  // a mortgage row with no recording date is NOT treated as a recorded instrument
  const undated = all('eg.recorded_documents', recDocs({ mortgages: [mtg({ recorded: null })] })).find((f) => f.key === 'recorded_mortgages')
  assert.equal(undated.evidence_status, 'unavailable')
  assert.equal(undated.unavailable_reason, 'mortgage_rows_without_recording_date')
  // nothing in Quick Scan is ever county_confirmed
  assert.ok(!fs.some((f) => f.evidence_status === 'county_confirmed'))
})

test('stale vendor snapshots are labelled stale, recorded instruments keep their own date; internal + derived classes', () => {
  const fs = all('eg.recorded_documents', recDocs({ mortgages: [mtg()], parcel: { tax_delinquent: true, updated_at: '2025-01-01' } }))
  assert.equal(fs.find((f) => f.key === 'vendor_parcel_flags').evidence_status, 'stale')
  assert.equal(fs.find((f) => f.key === 'recorded_mortgages').observed_at, '2019-05-03')
  const sms = all('eg.sms_eligibility', { property_id: 'p1', available: true, eligible: false, reason: 'missing_phone', rows: 1, ready: 0, reviewChecked: true, generated_at: ctx.retrieved_at })[0]
  assert.deepEqual([sms.source_class, sms.evidence_status], ['internal_record', 'internal_record'])
  const v = valuation(['free and clear'])
  v.equity = { known: true, percent: 100, amount: 250000, class: 'high', rule: 'free_and_clear' }
  const eq = all('valuation.read', v).find((f) => f.key === 'equity_known_v1')
  assert.deepEqual([eq.source_class, eq.evidence_status], ['derived_inferred', 'derived'])
  assert.ok(eq.confidence <= 0.7)
  assert.equal(eq.is_inference, false)
})

test('equity unknown is unavailable — never 0% or 100%; a vendor flag alone is a vendor class finding', () => {
  const fs = all('valuation.read', valuation(['high equity']))
  const eq = fs.find((f) => f.key === 'equity_known_v1')
  assert.equal(eq.evidence_status, 'unavailable')
  assert.equal(eq.value, null)
  const flag = fs.find((f) => f.key === 'vendor_equity_flag')
  assert.equal(flag.source_class, 'third_party_vendor')
  assert.equal(flag.value.class, 'high')
})

test('failed / refused tools produce unavailable findings only', () => {
  for (const tool of ['eg.recorded_documents', 'valuation.read', 'eg.sms_eligibility', 'mi.zip_context']) {
    for (const f of unavailableFindingsForTool(tool, ctx, 'timeout')) {
      assert.deepEqual([f.evidence_status, f.source_class, f.value, f.is_negative_claim, f.unavailable_reason], ['unavailable', 'unavailable_blocked', null, false, 'timeout'])
    }
  }
})

function conflictsFor({ flags, loan = 0, mortgages = [], liens = [], parcel }) {
  const outputs = { 'eg.recorded_documents': recDocs({ mortgages, liens, ...(parcel ? { parcel } : {}) }), 'valuation.read': valuation(flags, loan) }
  const findings = [...all('eg.recorded_documents', outputs['eg.recorded_documents']), ...all('valuation.read', outputs['valuation.read'])]
  return detectConflicts({ run_id: ctx.run_id, property_id: 'p1', findings, outputs })
}

test('conflict DECISIVE: vendor "Free And Clear" vs a mortgage recorded AFTER the vendor snapshot → resolved_by_rule for the record', () => {
  const [c] = conflictsFor({ flags: ['free and clear'], mortgages: [mtg({ recorded: '2026-06-15' })] })
  assert.equal(c.rule, 'free_clear_flag_vs_recorded_mortgage')
  assert.equal(c.resolution_state, 'resolved_by_rule')
  assert.equal(c.best_supported.source_class, 'official_public_record')
  assert.ok(c.members.some((m) => m.source_class === 'third_party_vendor'))
  assert.ok(c.reason && c.remaining_uncertainty && c.follow_up)
})

test('conflict UNRESOLVED: the recorded mortgage predates the vendor snapshot (a release may exist) → open, no winner, follow-up', () => {
  const [c] = conflictsFor({ flags: ['free and clear'], mortgages: [mtg({ recorded: '2019-05-03' })] })
  assert.equal(c.resolution_state, 'open')
  assert.equal(c.best_supported, null)
  assert.match(c.follow_up, /release\/satisfaction/)
})

test('conflict UNRESOLVED: vendor shows debt but the recorded feed has no mortgage — absence never wins', () => {
  const cs = conflictsFor({ flags: ['low equity'], loan: 90000 })
  const c = cs.find((x) => x.rule === 'vendor_debt_vs_no_recorded_mortgage')
  assert.equal(c.resolution_state, 'open')
  assert.equal(c.best_supported, null)
  const absent = c.members.find((m) => m.evidence_status === 'unavailable')
  assert.ok(absent, 'the no-mortgage side is an unavailable finding, not an absence claim')
})

test('lien + tax conflicts: decisive only when the recorded instrument is fresher; agreeing evidence → no conflict', () => {
  const fresh = conflictsFor({ flags: [], liens: [{ recorded: '2026-07-01', category: 'Tax Lien', type: 'tax', title: 'Tax Lien', distress: true }] })
  assert.ok(fresh.find((c) => c.rule === 'vendor_no_lien_flag_vs_recorded_lien').resolution_state === 'resolved_by_rule')
  assert.ok(fresh.find((c) => c.rule === 'vendor_not_delinquent_vs_recorded_tax_lien').resolution_state === 'resolved_by_rule')
  const old = conflictsFor({ flags: [], liens: [{ recorded: '2018-01-01', category: 'Tax Lien', type: 'tax', title: 'Tax Lien', distress: true }] })
  assert.ok(old.every((c) => c.resolution_state === 'open'))
  assert.deepEqual(conflictsFor({ flags: [], mortgages: [] }), [])
})
