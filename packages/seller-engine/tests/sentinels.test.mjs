import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, parseBool, parseCategorical, priceQualifierClass, blanketLoanGuard, RULES } from '../lib/sentinels.mjs';

test('T-01 sentinel contamination: -999.99 equity -> unknown, never numeric', () => {
  const r = parseNumber('-999.99', RULES.equity_percent);
  assert.equal(r.value, null);
  assert.equal(r.state, 'unknown');
  assert.match(r.note, /sentinel/);
});

test('T-01: loan term 999 and 0 -> unknown', () => {
  assert.equal(parseNumber('999', RULES.loan_term_months).value, null);
  assert.equal(parseNumber('0', RULES.loan_term_months).value, null);
  assert.equal(parseNumber('360', RULES.loan_term_months).value, 360);
});

test('T-02 impossible values: 88% interest rate rejected; negative balance rejected', () => {
  assert.equal(parseNumber('88', RULES.interest_rate).value, null);
  assert.match(parseNumber('88', RULES.interest_rate).note, /impossible/);
  assert.equal(parseNumber('-140256', RULES.loan_balance).value, null);
  assert.equal(parseNumber('6.5', RULES.interest_rate).value, 6.5);
});

test('T-09 missing vs zero: household 0 means unknown; blank is unknown, not false', () => {
  assert.equal(parseNumber('0', RULES.household_count).value, null);
  assert.equal(parseNumber('0', RULES.household_count).note, 'zero_means_unknown');
  assert.equal(parseBool('').state, 'unknown');
  assert.equal(parseBool('').value, null);
});

test('five states: Restricted -> unavailable; Unknown -> unknown; value -> known', () => {
  assert.equal(parseCategorical('Restricted').state, 'unavailable');
  assert.equal(parseCategorical('Unknown').state, 'unknown');
  assert.equal(parseCategorical('Average').state, 'known');
});

test('T-06 price qualifier router: distress/exempt/unusable classes', () => {
  assert.equal(priceQualifierClass('Full amount stated on Document.'), 'valuation');
  assert.equal(priceQualifierClass('Non-arms length transaction.'), 'distress_context');
  assert.equal(priceQualifierClass('Sold for Taxes.'), 'distress_context');
  assert.equal(priceQualifierClass('Transfer Tax on document indicated as EXEMPT.'), 'evidence_only');
  assert.equal(priceQualifierClass('Unable to compute'), 'unusable');
  assert.equal(priceQualifierClass('Full amount from assessment file, when available.'), 'valuation_caution');
});

test('T-05 blanket loan guard: $200M vs $350k value trips; normal LTV does not', () => {
  assert.equal(blanketLoanGuard(200_000_000, 350_000), true);
  assert.equal(blanketLoanGuard(280_000, 350_000), false);
  assert.equal(blanketLoanGuard(null, 350_000), false);
});
