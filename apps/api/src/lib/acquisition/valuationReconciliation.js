/**
 * Acquisition Engine V3 — multi-model reconciliation (mission Item 4 §7).
 *
 * Produces a reconciled market value AND a separate conservative/base/optimistic
 * investor exit, preferring qualified market evidence. Disagreement between
 * high-confidence models is preserved and lowers confidence — never averaged away.
 * Subject-anchor-only inputs are labeled SUBJECT_ANCHOR_SCENARIO, not market value.
 */

import {
  VALUATION_UNIVERSES as U,
  VALUE_CLASSIFICATION as VC,
  INVESTOR_DISCOUNT_FROM_RETAIL,
  MODEL_DISAGREEMENT_CONF_CAP,
  ASSET_FAMILIES,
  clamp,
  round,
  roundMoney,
} from './modelConstants.js';

const avail = (u) => Boolean(u && u.available && u.mid > 0);

function blend(entries, key) {
  const pts = entries.filter((e) => e.u[key] != null && e.weight > 0);
  const total = pts.reduce((s, e) => s + e.weight, 0);
  if (!total) return null;
  return pts.reduce((s, e) => s + e.u[key] * e.weight, 0) / total;
}

function disagreementScore(mids) {
  const xs = mids.filter((m) => m > 0);
  if (xs.length < 2) return 0;
  const mn = Math.min(...xs);
  const mx = Math.max(...xs);
  const avg = xs.reduce((s, v) => s + v, 0) / xs.length;
  return clamp(((mx - mn) / avg) * 100, 0, 100);
}

export function reconcileValuation(universes = {}, family = ASSET_FAMILIES.UNKNOWN) {
  const retail = universes[U.RETAIL_MLS_VALUE];
  const investor = universes[U.LOCAL_INVESTOR_VALUE];
  const institutional = universes[U.INSTITUTIONAL_VALUE];
  const publicRec = universes[U.PUBLIC_RECORD_ARM_LENGTH_VALUE];
  const income = universes[U.INCOME_VALUE];
  const anchor = universes[U.SUBJECT_ANCHOR_SCENARIO];
  const reasoning = [];

  // ---- Market value (retail-leaning blend of qualified market universes) ----
  const marketEntries = [
    { name: U.RETAIL_MLS_VALUE, u: retail, prior: 1.1 },
    { name: U.LOCAL_INVESTOR_VALUE, u: investor, prior: 1.0 },
    { name: U.INSTITUTIONAL_VALUE, u: institutional, prior: 1.0 },
    { name: U.PUBLIC_RECORD_ARM_LENGTH_VALUE, u: publicRec, prior: 0.9 },
  ]
    .filter((e) => avail(e.u) && e.u.value_classification === VC.QUALIFIED)
    .map((e) => ({ ...e, weight: (e.u.confidence / 100) * e.prior }));

  let market = { low: null, mid: null, high: null, classification: null, confidence: 0 };
  if (marketEntries.length) {
    market = {
      low: roundMoney(blend(marketEntries, 'low')),
      mid: roundMoney(blend(marketEntries, 'mid')),
      high: roundMoney(blend(marketEntries, 'high')),
      classification: VC.QUALIFIED,
      confidence: Math.round(
        marketEntries.reduce((s, e) => s + e.u.confidence * e.weight, 0) /
          marketEntries.reduce((s, e) => s + e.weight, 0),
      ),
    };
    reasoning.push(`market_value from ${marketEntries.map((e) => e.name).join(', ')}`);
  } else if (avail(income) && income.value_classification === VC.QUALIFIED) {
    market = { low: income.low, mid: income.mid, high: income.high, classification: VC.QUALIFIED, confidence: income.confidence };
    reasoning.push('market_value from INCOME_VALUE (no sales universes qualified)');
  } else if (avail(anchor)) {
    market = { low: anchor.low, mid: anchor.mid, high: anchor.high, classification: VC.SUBJECT_ANCHOR_SCENARIO, confidence: anchor.confidence };
    reasoning.push('market_value UNAVAILABLE from transactions — SUBJECT_ANCHOR_SCENARIO only');
  } else {
    reasoning.push('no_valuation_basis');
  }

  // ---- Investor exit (wholesale-relevant universes; investor preferred) ----
  const wholesaleEntries = [
    { name: U.LOCAL_INVESTOR_VALUE, u: investor, prior: 1.2 },
    { name: U.INSTITUTIONAL_VALUE, u: institutional, prior: 1.0 },
    { name: U.PUBLIC_RECORD_ARM_LENGTH_VALUE, u: publicRec, prior: 0.9 },
  ]
    .filter((e) => avail(e.u) && e.u.value_classification === VC.QUALIFIED)
    .map((e) => ({ ...e, weight: (e.u.confidence / 100) * e.prior }));

  let investorExit = {
    conservative: null, base: null, optimistic: null, classification: null, confidence: 0,
  };
  if (wholesaleEntries.length) {
    investorExit = {
      conservative: roundMoney(blend(wholesaleEntries, 'p25') ?? blend(wholesaleEntries, 'low')),
      base: roundMoney(blend(wholesaleEntries, 'mid')),
      optimistic: roundMoney(blend(wholesaleEntries, 'high')),
      classification: VC.QUALIFIED,
      confidence: Math.round(
        wholesaleEntries.reduce((s, e) => s + e.u.confidence * e.weight, 0) /
          wholesaleEntries.reduce((s, e) => s + e.weight, 0),
      ),
    };
    reasoning.push(`investor_exit from ${wholesaleEntries.map((e) => e.name).join(', ')}`);
  } else if (avail(retail)) {
    const disc = INVESTOR_DISCOUNT_FROM_RETAIL[family] ?? INVESTOR_DISCOUNT_FROM_RETAIL.UNKNOWN;
    const base = retail.mid * disc;
    investorExit = {
      conservative: roundMoney(base * 0.95),
      base: roundMoney(base),
      optimistic: roundMoney(base * 1.05),
      classification: VC.PROVISIONAL_SCENARIO,
      confidence: Math.round(retail.confidence * 0.7),
      derived_from: `retail_x_investor_discount_${disc}`,
    };
    reasoning.push('investor_exit DERIVED from retail (no qualified investor evidence) — PROVISIONAL');
  } else if (avail(anchor)) {
    const disc = INVESTOR_DISCOUNT_FROM_RETAIL[family] ?? INVESTOR_DISCOUNT_FROM_RETAIL.UNKNOWN;
    const base = anchor.mid * disc;
    investorExit = {
      conservative: roundMoney(base * 0.9),
      base: roundMoney(base),
      optimistic: roundMoney(base),
      classification: VC.SUBJECT_ANCHOR_SCENARIO,
      confidence: 20,
      derived_from: `subject_anchor_x_investor_discount_${disc}`,
    };
    reasoning.push('investor_exit from SUBJECT_ANCHOR_SCENARIO only — not transaction-supported');
  }

  // ---- Disagreement + dominant/secondary ----
  const allQualified = [retail, investor, institutional, publicRec, income].filter(
    (u) => avail(u) && u.value_classification === VC.QUALIFIED,
  );
  const disagreement = disagreementScore(allQualified.map((u) => u.mid));
  const ranked = [...marketEntries].sort((a, b) => b.weight - a.weight);
  const dominant = ranked[0]?.name ?? market.classification;
  const secondary = ranked[1]?.name ?? null;

  let marketConfidence = market.confidence;
  const caps = {};
  if (disagreement > MODEL_DISAGREEMENT_CONF_CAP) {
    marketConfidence = Math.min(marketConfidence, 60);
    caps.disagreement_cap = 60;
    reasoning.push(`model_disagreement=${round(disagreement, 1)} > ${MODEL_DISAGREEMENT_CONF_CAP} — confidence capped, conflict preserved`);
  }

  return {
    reconciled_market_value_low: market.low,
    reconciled_market_value_mid: market.mid,
    reconciled_market_value_high: market.high,
    market_value_classification: market.classification,
    market_confidence: marketConfidence,

    conservative_investor_exit: investorExit.conservative,
    base_investor_exit: investorExit.base,
    optimistic_investor_exit: investorExit.optimistic,
    investor_exit_classification: investorExit.classification,
    investor_exit_confidence: investorExit.confidence,
    investor_exit_derived_from: investorExit.derived_from ?? null,

    dominant_model: dominant,
    secondary_model: secondary,
    model_weights: Object.fromEntries(marketEntries.map((e) => [e.name, round(e.weight, 3)])),
    model_disagreement_score: Math.round(disagreement),
    confidence_caps: caps,
    reasoning,
  };
}
