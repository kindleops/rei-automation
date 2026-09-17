import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOSING_CASE_COLUMNS,
  CLOSING_STAGE_BAND,
  TERMINAL_CONTRACT_STATUSES,
  isActiveClosingCase,
  numOrNull,
  closingProvenance,
  UUID_RE,
} from '@/app/api/cockpit/closing-desk/_shared.js';

/**
 * CLOSING-DESK-MOBILE-LOCK-1 §49 — server invariants.
 *
 * These are pure-function assertions over the closing-desk authority helpers.
 * Nothing here touches a live closing case (§43): the destructive scenarios are
 * proved against synthetic rows, and production is only ever read.
 */

test('§31: terminal contract statuses are never counted as active', () => {
  for (const status of TERMINAL_CONTRACT_STATUSES) {
    assert.equal(isActiveClosingCase({ contract_status: status }), false, status);
  }
  // Case-insensitive and whitespace-tolerant: a stored ' Cancelled ' must not
  // slip through as live work on a string-equality technicality.
  assert.equal(isActiveClosingCase({ contract_status: ' Cancelled ' }), false);
  assert.equal(isActiveClosingCase({ contract_status: 'DECLINED' }), false);
});

test('§31: a voided case is inactive even when its status looks healthy', () => {
  // Production's only closing case is exactly this shape: universal_stage is
  // still `formal_contract` because its CHECK permits only post-contract
  // values, so the void lives in provenance and in contract_status.
  assert.equal(
    isActiveClosingCase({ contract_status: 'fully_executed', provenance: { voided: true } }),
    false,
  );
});

test('an in-flight case stays active', () => {
  for (const status of ['draft', 'sent_for_signature', 'viewed', 'seller_signed', 'buyer_signed', 'fully_executed']) {
    assert.equal(isActiveClosingCase({ contract_status: status }), true, status);
  }
  // An unset status is NOT terminal — absence of evidence of cancellation is
  // not evidence of cancellation.
  assert.equal(isActiveClosingCase({}), true);
  assert.equal(isActiveClosingCase({ contract_status: null }), true);
});

test('§37: numOrNull never turns an absent value into a confident zero', () => {
  // Every one of these is 0 or 1 under Number(), and Number.isFinite(0) is
  // true — the exact path by which "no revenue recorded" became "$0 revenue".
  for (const absent of [null, undefined, '', '   ', [], {}, true, false, 'n/a', NaN, Infinity]) {
    assert.equal(numOrNull(absent), null, JSON.stringify(absent) ?? String(absent));
  }
});

test('§37: numOrNull reads real numbers, including PostgREST numeric strings', () => {
  assert.equal(numOrNull(0), 0); // a genuine zero survives — zero IS data
  assert.equal(numOrNull(12500.5), 12500.5);
  assert.equal(numOrNull('12500.50'), 12500.5);
  assert.equal(numOrNull('-250'), -250);
});

test('the selected columns cover the deep state the surface claims to show', () => {
  const cols = CLOSING_CASE_COLUMNS.split(',');
  // One phantom column fails an entire PostgREST select, so this list is
  // verified against information_schema, not written from memory.
  for (const required of [
    'closing_case_id', 'opportunity_id', 'universal_stage', 'contract_status',
    'title_status', 'escrow_status', 'funding_status', 'revenue_status',
    'emd_due_date', 'scheduled_closing_date', 'revenue_confirmed_date',
    'expected_gross_revenue', 'confirmed_gross_revenue', 'readiness', 'provenance',
  ]) {
    assert.ok(cols.includes(required), `missing column: ${required}`);
  }
  assert.equal(new Set(cols).size, cols.length, 'duplicate column in select list');
});

test('the stage band is the full Stages 6-10 set the surface advertises', () => {
  // The route used to filter to `formal_contract` alone while the header said
  // "Stages 6-10", so four of five stages were unreachable.
  assert.deepEqual(CLOSING_STAGE_BAND, [
    'formal_contract', 'under_contract', 'disposition', 'prepared_to_close', 'closed',
  ]);
});

test('provenance names closing_cases, not the dead Podio mirror', () => {
  const p = closingProvenance();
  assert.equal(p.source, 'closing_cases');
  assert.deepEqual(p.degraded, []);
  assert.deepEqual(closingProvenance(['title absent']).degraded, ['title absent']);
});

test('UUID_RE keeps a text closing_case_id out of the uuid column', () => {
  // opportunity_id is uuid; pushing `closing:<uuid>` at it raises 22P02 and
  // fails the WHOLE query, which would read as "case not found".
  assert.equal(UUID_RE.test('2b3c261d-f3dd-494a-a60c-3437cbdf39b8'), true);
  assert.equal(UUID_RE.test('closing:2b3c261d-f3dd-494a-a60c-3437cbdf39b8'), false);
  // Filter-injection shapes must never look like a uuid.
  assert.equal(UUID_RE.test('x,opportunity_id.not.is.null'), false);
});
