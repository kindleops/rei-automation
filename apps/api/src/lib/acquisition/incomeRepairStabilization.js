/**
 * Acquisition Engine V3 — Item 5B: income repair & stabilization categories.
 *
 * Separates capital needs into explicit buckets and — critically — partitions
 * them into ONE-TIME (offer/valuation) vs RECURRING (income model) so no dollar
 * is double-counted across valuation, buyer exit and offer economics (mission §8).
 *
 * It re-categorizes the totals already produced by estimateRepairs (the single
 * source of the one-time rehab figure); it never invents a new aggregate.
 */

import { num, roundMoney, round } from './modelConstants.js';

/** Fractional allocation of the ONE-TIME rehab into named categories. */
const ONE_TIME_ALLOCATION = Object.freeze({
  life_safety: 0.15,
  unit_turns: 0.2,
  deferred_maintenance: 0.25,
  building_systems: 0.2,
  code_compliance: 0.08,
  common_areas: 0.07,
  parking_site: 0.05,
});

export function buildIncomeRepairStabilization(repair, contract) {
  const oneTimeTotal = num(repair?.repair_mid) ?? 0;
  const one_time = {};
  for (const [k, frac] of Object.entries(ONE_TIME_ALLOCATION)) {
    one_time[k] = roundMoney(oneTimeTotal * frac);
  }
  const oneTimeSum = Object.values(one_time).reduce((s, v) => s + v, 0);

  // Recurring / capital-reserve items — NEVER added to the one-time offer bridge.
  const stabilization_capex = num(repair?.stabilization_capex) ?? 0;
  const replacement_reserves_annual =
    num(contract?.replacement_reserves_annual?.value) ?? num(repair?.replacement_reserve_annual) ?? 0;
  const optional_value_add = roundMoney(oneTimeTotal * 0.3); // labeled, NOT in baseline offer

  return {
    one_time_categories: one_time,
    one_time_total: roundMoney(oneTimeSum),
    stabilization_capex: roundMoney(stabilization_capex),
    replacement_reserves_annual: roundMoney(replacement_reserves_annual),
    optional_value_add_renovation: optional_value_add,
    // Explicit anti-double-count contract: the offer bridge consumes EXACTLY
    // `offer_one_time_repairs` + `offer_stabilization`; the income model consumes
    // `replacement_reserves_annual`; optional value-add is excluded from both.
    double_count_guard: {
      offer_one_time_repairs: roundMoney(oneTimeSum),
      offer_stabilization: roundMoney(stabilization_capex),
      income_recurring_reserves: roundMoney(replacement_reserves_annual),
      excluded_from_baseline: ['optional_value_add_renovation'],
    },
    confidence: num(repair?.repair_confidence) ?? 0,
    missing_inputs: repair?.missing_repair_inputs ?? [],
  };
}
