/**
 * Acquisition Engine V3 — Item 5C §10: execution-state basis hardening.
 *
 * Makes strategy-specific authorization explicit so a global SHADOW_MODE_READY
 * never implies that every displayed strategy is authorized. Derived purely from
 * the (class-first) strategy ranking — it reports, it does not re-gate.
 *
 * Guarantees:
 *   - authorized monetary fields are strategy-specific (cash authorized ⇏ others)
 *   - a PROVISIONAL cash strategy can NOT become authorized because another
 *     strategy (e.g. subject-to) is underwritten
 *   - a qualified subject-to can be the basis for a global executable state while
 *     cash remains scenario-only
 *   - consumers can read exactly which strategy justified the execution state
 */

import {
  STRATEGIES as S,
  STRATEGY_QUALIFICATION as Q,
  EXECUTABLE_EXECUTION_STATES,
} from './modelConstants.js';

const UNDERWRITTEN = new Set([Q.EXECUTABLE, Q.UNDERWRITTEN_SHADOW]);

function find(ranked, strategy) {
  return (ranked ?? []).find((c) => c.strategy === strategy) ?? null;
}

/**
 * @param {object} args
 * @param {object[]} args.ranked        strategy ranking entries
 * @param {string}   args.executionState global execution state
 * @param {string}   [args.primaryStrategy]
 */
export function buildExecutionStateBasis({ ranked = [], executionState, primaryStrategy = null }) {
  const globalExecutable = EXECUTABLE_EXECUTION_STATES.includes(executionState);

  const cash = find(ranked, S.CASH);
  const novation = find(ranked, S.NOVATION);
  const subjectTo = find(ranked, S.SUBJECT_TO);
  const sellerFinance = find(ranked, S.SELLER_FINANCE);

  // Cash is authorized ONLY when cash itself is underwritten/executable AND its
  // own authorized_offer flag is set — never because another strategy passed.
  const cashAuthorized = Boolean(cash && UNDERWRITTEN.has(cash.qualification_status) && cash.authorized_offer);
  const novationUnderwritten = Boolean(novation && UNDERWRITTEN.has(novation.qualification_status));
  const subjectToUnderwritten = Boolean(subjectTo && UNDERWRITTEN.has(subjectTo.qualification_status));
  const sellerFinanceUnderwritten = Boolean(sellerFinance && UNDERWRITTEN.has(sellerFinance.qualification_status));

  const underwrittenStrategies = (ranked ?? [])
    .filter((c) => UNDERWRITTEN.has(c.qualification_status))
    .map((c) => c.strategy);
  const provisionalStrategies = (ranked ?? [])
    .filter((c) => c.qualification_status === Q.PROVISIONAL_SCENARIO)
    .map((c) => c.strategy);

  // The basis strategy is the one that JUSTIFIES the executable state: prefer the
  // primary if it is underwritten, else the highest-ranked underwritten strategy.
  let basisStrategy = null;
  if (globalExecutable && underwrittenStrategies.length) {
    if (primaryStrategy && underwrittenStrategies.includes(primaryStrategy)) basisStrategy = primaryStrategy;
    else basisStrategy = underwrittenStrategies[0];
  }

  // Authorized monetary fields are strategy-specific: only CASH carries an
  // authorized offer today, and only when cash itself is authorized.
  const authorizedStrategy = cashAuthorized ? S.CASH : null;
  const authorizedOfferType = cashAuthorized ? 'CASH_OFFER' : null;

  return {
    execution_state: executionState,
    execution_state_basis_strategy: basisStrategy,
    underwritten_strategies: underwrittenStrategies,
    provisional_strategies: provisionalStrategies,
    authorized_strategy: authorizedStrategy,
    authorized_offer_type: authorizedOfferType,
    cash_authorized: cashAuthorized,
    novation_authorized: false, // novation is a listing strategy — never auto-authorized
    novation_underwritten: novationUnderwritten,
    subject_to_underwritten: subjectToUnderwritten,
    seller_finance_underwritten: sellerFinanceUnderwritten,
    // Explicit invariant for consumers: a non-cash basis does NOT authorize cash.
    cash_scenario_only: !cashAuthorized,
    note:
      globalExecutable && basisStrategy && basisStrategy !== S.CASH && !cashAuthorized
        ? `Global ${executionState} is justified by ${basisStrategy}; cash remains scenario-only.`
        : null,
  };
}
