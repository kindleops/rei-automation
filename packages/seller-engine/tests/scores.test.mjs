import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1, loadV1Config } from '../scores/deterministicV1.mjs';
import { scoreV12Baseline, v12AgreementReport } from '../scores/v12Baseline.mjs';

const AS_OF = '2026-07-01T00:00:00Z';
const mk = (over = {}) => ({
  property: { id: 'p1', year_built: 1950, condition_raw: 'Poor', condition_state: 'known', raw_keep: { property_flags: '[{"code":"tax_delinquent"},{"code":"high_equity"}]', estimated_equity: '150000' } },
  valuation: { estimated_value: 200000, equity_percent: 70, tax_delinquent: true, tax_delinquent_year: 2022, estimated_equity: 150000 },
  loans: [], checksums: { num_of_mortgages: 0 },
  liens: [
    { id: 'a', base_type: 'lien', lifecycle_class: 'creation', filing_date: '2023-01-05', amount_due: 12000 },
    { id: 'b', base_type: 'lien', lifecycle_class: 'release', filing_date: '2024-02-01' },
  ],
  foreclosure: [], transactions: [{ id: 't1', event_role: 'current', sale_date: '2008-06-15', sale_price: 60000, price_qualifier_class: 'valuation' }],
  links: [{ id: 'k1', link_tier: 'high', matching_flags: ['Likely Owner'], likely_owner_scalar: true, renter_flag: false, profile: { ready_to_call: true } }],
  phones: [{ phone_e164: '+15555550100', line_type: 'wireless', rank: 1, do_not_call: false, never_call: false }],
  emails: [], batchScalarLiveness: 0.2,
  ...over,
});

test('deterministic V1: versioned by config hash, weight_class provisional', () => {
  const { versionId } = loadV1Config();
  assert.match(versionId, /^seller_engine_deterministic_v1@1\.5\.0-provisional\+cfg\.[0-9a-f]{12}$/);
  const { features } = computeFeatures(mk(), AS_OF);
  const s = scoreDeterministicV1(features);
  assert.equal(s.weight_class, 'provisional_domain_weight');
});

test('V1 explanations include positive, negative and gate directions', () => {
  const { features } = computeFeatures(mk(), AS_OF);
  const s = scoreDeterministicV1(features);
  const dirs = new Set(s.explanations.map((e) => e.direction));
  assert.ok(dirs.has('positive'));
  assert.ok(dirs.has('gate'));
  assert.ok(dirs.has('blocked') || dirs.has('negative'));
});

test('V1.3: renter+owner-token collision is person-suppressed and routed to manual review, not a zeroed property block', () => {
  const { features } = computeFeatures(mk({
    links: [{ id: 'k2', person_id: 'k2', link_tier: 'high', matching_flags: ['Likely Owner'], renter_flag: true }],
  }), AS_OF);
  const s = scoreDeterministicV1(features);
  // the same person carrying renter + owner evidence is a conflict: review, do
  // not auto-message and do not discard the property
  assert.equal(s.route, 'manual_review_renter_owner_conflict');
  const ep = s.families.execution_priority;
  assert.ok(ep.person_contact_suppressed.some((x) => x.suppressed), 'the renter contact is suppressed');
  assert.ok(ep.score > 0, 'the property is not zeroed — it is a review candidate');
});

test('V1.4: a renter with NO owner name in the graph is NOT a property block — it is a no-reachable-owner resolution task', () => {
  const { features } = computeFeatures(mk({
    property: { id: 'p1', raw_keep: {} },   // owner-of-record name not captured
    links: [{ id: 'k3', person_id: 'k3', link_tier: 'none', matching_flags: [], renter_flag: true, is_matching_property_as_owner: false }],
  }), AS_OF);
  const s = scoreDeterministicV1(features);
  // blocked_not_owner is DEPRECATED — the property resolves to owner resolution
  assert.notEqual(s.route, 'blocked_not_owner');
  assert.equal(s.route, 'owner_resolution_required');
  assert.equal(s.families.execution_priority.owner_resolution_status, 'no_reachable_owner_contact');
  // the renter contact is still person-suppressed
  assert.ok(s.families.execution_priority.person_contact_suppressed.some((x) => x.suppressed));
});

test('release netting differentiates V1 from V12 on the SAME evidence (archetype A6)', () => {
  const b = mk();
  b.property.raw_keep.active_lien = 'Yes';   // legacy vendor scalar counts regardless of release
  const { features } = computeFeatures(b, AS_OF);
  const v1 = scoreDeterministicV1(features);
  const v12 = scoreV12Baseline(b);
  // V1: lien released -> legal pressure 0; exact V12: active_lien scalar feeds urgency (+12) with no netting concept
  assert.equal(v1.families.legal_title_pressure.score, 0);
  const urg = v12.components.find((c) => c.component === 'urgency_x0.30');
  assert.ok(urg.contribution >= 12, 'legacy urgency counts the unnetted lien scalar');
});

test('V12 exact port is versioned, sha-pinned and labeled exact_legacy_port', () => {
  const v12 = scoreV12Baseline(mk());
  assert.match(v12.engine_version_id, /^seller_engine_v12_baseline@12\.1\.0-exact-port/);
  assert.equal(v12.weight_class, 'exact_legacy_port');
  assert.match(v12.source_sha256, /^89adfaeb/);
  assert.ok(['TIER_1', 'TIER_2', 'TIER_3'].includes(v12.tier));
});

test('v12 agreement report computes spearman on artifact pairs', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    reconstruction_priority: i, v12_artifact_order_score: i * 2 + (i % 3),
  }));
  const rep = v12AgreementReport(rows);
  assert.equal(rep.pairs, 30);
  assert.ok(rep.spearman > 0.9);
});

test('ix19 escalation: dry-run only, disabled, fires only on distress+equity+unreachable', () => {
  const unreachable = mk({ phones: [], foreclosure: [{ id: 'f1', stage: 'nod', recording_date: '2026-05-01' }] });
  const { features } = computeFeatures(unreachable, AS_OF);
  const s = scoreDeterministicV1(features);
  assert.equal(s.ix19_dry_run.enabled, false);
  assert.equal(s.ix19_dry_run.mode, 'dry_run_only');
  assert.equal(s.ix19_dry_run.would_escalate, true);
  const reachable = scoreDeterministicV1(computeFeatures(mk(), AS_OF).features);
  assert.equal(reachable.ix19_dry_run.would_escalate, false);
});
