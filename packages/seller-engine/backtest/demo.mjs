#!/usr/bin/env node
// Phase 3 demonstration run on the vendor_schema_drift_qa_corpus (dev/testing
// use per P2-4). Produces harness-validation numbers ONLY — explicitly NOT
// final lift/calibration/superiority claims (Corpus V1 is not frozen).
// Known validity caveat: single-vintage snapshot — current-state fields
// (equity, flags) reflect 2026 state even for the historical as-of; applies
// equally to every scorer compared.
import { readAll, writeReport } from '../lib/store.mjs';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1 } from '../scores/deterministicV1.mjs';
import { scoreV12Baseline, v12AgreementReport } from '../scores/v12Baseline.mjs';
import { buildVerifiedSaleLabels, coverageReport } from '../labels/builders.mjs';
import { compareScorers } from '../backtest/harness.mjs';
import { toMs } from '../lib/timeSafety.mjs';

const AS_OF = process.env.AS_OF ?? '2025-07-15T00:00:00Z';
const OBSERVED_THROUGH = '2026-06-29T00:00:00Z';   // scrape date of the corpus
const HORIZONS = [30, 90, 180, 365];

const idx = (rows, key = 'property_id') => {
  const m = new Map();
  for (const r of rows) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])).push(r);
  return m;
};

const props = readAll('properties');
const vals = idx(readAll('property_valuation_tax_snapshots'));
const loans = idx(readAll('property_loans'));
const checks = idx(readAll('loan_checksums'));
const liens = idx(readAll('property_liens'));
const fcs = idx(readAll('property_foreclosure_events'));
const txns = idx(readAll('property_transactions'));
const links = idx(readAll('property_person_links'));
const phones = idx(readAll('contact_phones'));

// batch scalar liveness for F-111 (OD-13): share of links with scalar True
const allLinks = readAll('property_person_links');
const liveRate = allLinks.length
  ? allLinks.filter((l) => l.likely_owner_scalar === true).length / allLinks.length : null;

const asOfMs = toMs(AS_OF);
const dateOk = (d) => d === null || d === undefined || d === '' || toMs(d) === null || toMs(d) <= asOfMs;

const rows = [];
const scoredForAgreement = [];
let ix19Candidates = 0;
for (const p of props) {
  const pid = p.id;
  const bundle = {
    property: p,
    valuation: (vals.get(pid) ?? [])[0] ?? {},
    loans: (loans.get(pid) ?? []).filter((l) => dateOk(l.recording_date)),
    checksums: (checks.get(pid) ?? [])[0] ?? null,
    liens: (liens.get(pid) ?? []).filter((l) => dateOk(l.filing_date ?? l.recording_date)),
    foreclosure: (fcs.get(pid) ?? []).filter((f) => dateOk(f.recording_date ?? f.default_date)),
    transactions: (txns.get(pid) ?? []).filter((t) => dateOk(t.sale_date)),
    links: links.get(pid) ?? [],
    phones: phones.get(pid) ?? [],
    emails: [],
    batchScalarLiveness: liveRate,
  };
  let feats;
  try { feats = computeFeatures(bundle, AS_OF); } catch (e) { continue; } // leakage-guarded rows skipped defensively
  const v1 = scoreDeterministicV1(feats.features);
  const v12 = scoreV12Baseline(bundle);
  const flags = String(p.raw_keep?.property_flags ?? '');
  const naiveFlagCount = (flags.match(/"code"/g) ?? []).length;
  const orderScore = (bundle.links.find((l) => Number.isFinite(l.profile?.order_score)) ?? {}).profile?.order_score;
  if (Number.isFinite(orderScore)) {
    scoredForAgreement.push({ reconstruction_priority: v12.priority, v12_artifact_order_score: orderScore });
  }
  if (v1.ix19_dry_run?.would_escalate) ix19Candidates += 1;
  rows.push({
    property_id: pid, as_of: AS_OF,
    scores: {
      deterministic_v1: v1.execution_priority ?? 0,
      v12_baseline: v12.priority,
      naive_flag_count: naiveFlagCount,
      single_family_tax_delinquent: bundle.valuation.tax_delinquent === true ? 1 : 0,
    },
    labels: {},
  });
}

// labels from full (unfiltered) transaction history — outcome side may see post-as-of
const transfersByProperty = new Map();
for (const p of props) transfersByProperty.set(p.id, (txns.get(p.id) ?? []));
const labels = buildVerifiedSaleLabels({
  propertyIds: props.map((p) => p.id), transfersByProperty, asOf: AS_OF, observedThrough: OBSERVED_THROUGH,
});
const byProp = new Map();
for (const l of labels.filter((l2) => l2.state !== 'excluded')) {
  (byProp.get(l.property_id) ?? byProp.set(l.property_id, {}).get(l.property_id))[l.label_key] = l.state;
}
for (const r of rows) r.labels = byProp.get(r.property_id) ?? {};

const comparison = compareScorers({
  rows, scorers: ['deterministic_v1', 'v12_baseline', 'naive_flag_count', 'single_family_tax_delinquent'],
  horizons: HORIZONS,
});
const agreement = v12AgreementReport(scoredForAgreement);
const coverage = coverageReport(labels);

// IX-19 simulated budget caps (P2-7): candidates vs simulated budget fractions
const budgets = [0.25, 0.5, 1.0, 2.0].map((pct) => ({
  budget_pct: pct,
  budget_slots: Math.floor(rows.length * pct / 100),
  candidates: ix19Candidates,
  recommended_cap: Math.min(ix19Candidates, Math.floor(rows.length * pct / 100)),
}));

const report = {
  disclaimer: 'DEMONSTRATION on vendor_schema_drift_qa_corpus. NOT final lift/calibration/superiority claims (P2-4: Corpus V1 not frozen). Single-vintage caveat: current-state fields reflect scrape-time state for the historical as-of; applies to all scorers equally.',
  as_of: AS_OF, observed_through: OBSERVED_THROUGH,
  properties_scored: rows.length,
  scalar_liveness: liveRate,
  label_coverage: coverage,
  scorer_comparison: comparison,
  v12_reconstruction_agreement: agreement,
  ix19_simulated_budgets: budgets,
};
const path = writeReport('backtest_demo', report);
console.log('report ->', path);
console.log('properties scored:', rows.length, '| scalar liveness:', liveRate?.toFixed(3));
console.log('label coverage:', JSON.stringify(coverage.by_state));
for (const h of HORIZONS) {
  const k = `sale_${h}d`;
  const c = comparison[k];
  const fmt = (s) => { const l = c.scorers[s].lift['0.05']; return l.state === 'ok' ? `lift@5%=${l.lift} (top ${l.top_rate} vs base ${l.base_rate})` : `UNAVAILABLE(${l.reason})`; };
  console.log(`${k}: eligible=${c.eligible} censored=${c.censored_excluded} | V1 ${fmt('deterministic_v1')} | V12 ${fmt('v12_baseline')} | flags ${fmt('naive_flag_count')}`);
}
console.log('v12 agreement (spearman vs order_score):', JSON.stringify(agreement));
console.log('ix19 dry-run candidates:', ix19Candidates, 'budgets:', JSON.stringify(budgets.map((b) => [b.budget_pct, b.recommended_cap])));
