#!/usr/bin/env node
// V12 fidelity evaluator. Consumes a read-only sample of the legacy sync's own
// output rows (master_owners: scores + synced aggregate inputs) and measures
// how exactly the port reproduces them. Usage:
//   node scores/v12Fidelity.mjs var/reports/v12_master_owners_sample.json
// The sample fetch itself is a separate, approval-gated read-only step (see
// SELLER_V12_FIDELITY_REPORT.md); this module never touches the network.
import { readFileSync } from 'node:fs';
import { writeReport } from '../lib/store.mjs';
import {
  calcFinancialPressure_, calcUrgency_, priorityScore_, priorityTierFromScore_,
  followUpCadence_, asNumber_,
} from './v12Baseline.mjs';

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const spearman = (xs, ys) => {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const rk = new Array(arr.length);
    idx.forEach(([, i], r) => { rk[i] = r; });
    return rk;
  };
  const a = rank(xs); const b = rank(ys); const n = xs.length;
  if (n < 3) return null;
  const d2 = a.reduce((s, ai, i) => s + (ai - b[i]) ** 2, 0);
  return Math.round((1 - (6 * d2) / (n * (n * n - 1))) * 10000) / 10000;
};

function metrics(pairs) {
  const errs = pairs.map(([recomputed, historical]) => Math.abs(recomputed - historical));
  return {
    n: pairs.length,
    exact_match_rate: Math.round((pairs.filter(([r, h]) => r === h).length / Math.max(pairs.length, 1)) * 10000) / 10000,
    mean_absolute_error: Math.round((errs.reduce((s, e) => s + e, 0) / Math.max(errs.length, 1)) * 1000) / 1000,
    p50_abs_error: pct(errs, 0.50), p90_abs_error: pct(errs, 0.90),
    p99_abs_error: pct(errs, 0.99), max_abs_error: errs.length ? Math.max(...errs) : null,
    rank_correlation_spearman: spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])),
  };
}

export function evaluateFidelity(rows) {
  const usable = rows.filter((r) => Number.isFinite(asNumber_(r.priority_score)));
  const prioPairs = []; const tierPairs = []; const cadPairs = [];
  const fpPairs = []; const urgLowPairs = []; const urgHighPairs = [];
  const mismatches = [];
  for (const r of usable) {
    const fp = asNumber_(r.financial_pressure_score);
    const urg = asNumber_(r.urgency_score);
    const contact = asNumber_(r.contactability_score);
    // ---- exact recompute: priority/tier/cadence from synced sub-scores + synced portfolio
    const prio = priorityScore_({
      financial_pressure_score: fp, urgency_score: urg, contactability_score: contact,
      portfolio_total_equity: asNumber_(r.portfolio_total_equity),
      portfolio_total_value: asNumber_(r.portfolio_total_value),
    });
    prioPairs.push([prio, asNumber_(r.priority_score)]);
    const tier = priorityTierFromScore_(prio);
    tierPairs.push([tier, r.priority_tier]);
    cadPairs.push([followUpCadence_(tier), r.follow_up_cadence]);
    if (prio !== asNumber_(r.priority_score) && mismatches.length < 25) {
      mismatches.push({ master_key: r.master_key, kind: 'priority', recomputed: prio, historical: asNumber_(r.priority_score), inputs: { fp, urg, contact, eq: r.portfolio_total_equity, val: r.portfolio_total_value } });
    }
    // ---- partial recompute: FP (best_* slot fields were NOT synced -> '' )
    const owner = {
      tax_delinquent_count: asNumber_(r.tax_delinquent_count),
      oldest_tax_delinquent_year: asNumber_(r.oldest_tax_delinquent_year),
      portfolio_total_value: asNumber_(r.portfolio_total_value),
      portfolio_total_loan_balance: asNumber_(r.portfolio_total_loan_balance),
      best_buying_power: '', best_income: '', best_net_asset: '',
      seller_tags_text: r.seller_tags_text ?? '',
      last_sale_doc_type: r.last_sale_doc_type ?? '',
      max_ownership_years: asNumber_(r.max_ownership_years),
    };
    fpPairs.push([calcFinancialPressure_(owner), fp]);
    // ---- bounded recompute: URG (distress_marker_count not synced -> bound 0..cap)
    const urgBase = {
      ...owner,
      is_absentee: /absentee/i.test(String(r.owner_location_text ?? '')),
      active_lien_count: asNumber_(r.active_lien_count),
      property_count: asNumber_(r.property_count),
    };
    urgLowPairs.push([calcUrgency_({ ...urgBase, distress_marker_count: 0 }), urg]);
    urgHighPairs.push([calcUrgency_({ ...urgBase, distress_marker_count: 6 }), urg]); // cap term (30)
  }
  const tierExact = tierPairs.filter(([a, b]) => a === b).length / Math.max(tierPairs.length, 1);
  const cadExact = cadPairs.filter(([a, b]) => a === b).length / Math.max(cadPairs.length, 1);
  const urgWithinBound = urgLowPairs.map(([lo], i) => {
    const [hi] = urgHighPairs[i];
    const h = urgLowPairs[i][1];
    return h >= Math.min(lo, hi) - 0 && h <= Math.max(lo, hi) + 0;
  }).filter(Boolean).length / Math.max(urgLowPairs.length, 1);

  return {
    rows_with_historical_scores: usable.length,
    exact_recompute: {
      priority: metrics(prioPairs),
      tier_exact_match_rate: Math.round(tierExact * 10000) / 10000,
      cadence_exact_match_rate: Math.round(cadExact * 10000) / 10000,
    },
    partial_recompute: {
      financial_pressure_missing_best_fields: metrics(fpPairs),
      urgency_within_marker_bounds_rate: Math.round(urgWithinBound * 10000) / 10000,
      note: 'best_buying_power/best_income/best_net_asset and distress_marker_count were not synced to master_owners; FP differences are bounded at +50 (20+15+15) and URG marker term at +30 by construction — see fidelity report for the reproducibility taxonomy',
    },
    mismatch_examples: mismatches,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) { console.error('usage: v12Fidelity.mjs <master_owners_sample.json>'); process.exit(1); }
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  const report = evaluateFidelity(rows);
  const out = writeReport('v12_fidelity', report);
  console.log(JSON.stringify(report.exact_recompute, null, 2));
  console.log('full report ->', out);
}
