import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeApn,
  normalizeSitus,
  ownerKey,
  matchProperty,
  parseSourceDate,
  mapRow,
  readArcgisLayer,
  parcelInClauses,
  buildCandidate,
  verifyOwnership,
  TIER,
  SOURCE_TYPE,
} from '../../src/lib/acquisition/county-records/index.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const CTX = { retrievedAt: '2026-10-08T04:50:00Z', sourceLastEdit: '2026-10-05', now: NOW };

test('APN normalization per county format', () => {
  assert.equal(normalizeApn('39035', '00104015'), '001-04-015');
  assert.equal(normalizeApn('39035', '001-04-015'), '001-04-015');
  assert.equal(normalizeApn('39035', '0010401'), null);
  assert.equal(normalizeApn('39049', '010137397'), '010-137397');
  assert.equal(normalizeApn('39049', '010-137397-00'), '010-137397');
  assert.equal(normalizeApn('39049', '31843202029000'), null);
  assert.equal(normalizeApn('26163', ' 22125216. '), '22125216.');
  assert.equal(normalizeApn('26163', '02003617.001'), '02003617.001');
  assert.equal(normalizeApn('12086', '01-0103-040-1110'), '0101030401110');
  assert.equal(normalizeApn('39035', ''), null);
});

test('situs normalization drops units and standardizes suffix/direction', () => {
  assert.equal(normalizeSitus('3808 Central Street Apt 2, Kansas City', '64111-1234'), '3808 CENTRAL ST|64111');
  assert.equal(normalizeSitus('1656 West 36th St.', null), '1656 W 36TH ST');
  assert.equal(normalizeSitus('PO BOX 12', null), null);
});

test('owner key ignores entity suffixes and order', () => {
  assert.equal(ownerKey('SMITH JOHN & MARY'), ownerKey('John Smith and Mary'));
  assert.equal(ownerKey('ACME HOLDINGS LLC'), 'ACME HOLDINGS');
});

test('matchProperty: APN exact, address only for review, ambiguity refused', () => {
  const index = {
    byApn: new Map([['39035|001-04-015', ['p1']], ['39035|001-04-016', ['p2', 'p3']]]),
    bySitus: new Map([['100 MAIN ST|44102', ['p9']]]),
  };
  assert.deepEqual(matchProperty({ fips: '39035', apnRaw: '00104015' }, index), { propertyId: 'p1', method: 'apn', confidence: 'exact' });
  assert.equal(matchProperty({ fips: '39035', apnRaw: '001-04-016' }, index).reason, 'apn_ambiguous');
  assert.deepEqual(matchProperty({ fips: '39035', apnRaw: 'x', situsRaw: '100 Main Street', zipRaw: '44102' }, index), { propertyId: 'p9', method: 'situs', confidence: 'review' });
  assert.equal(matchProperty({ fips: '39035', apnRaw: '999-99-999' }, index).reason, 'apn_not_in_universe');
});

test('parseSourceDate rejects impossible years (Detroit blight defect)', () => {
  assert.equal(parseSourceDate('8535-09-25', NOW), null);
  assert.equal(parseSourceDate(1791259200000, NOW), '2026-10-06');
  assert.equal(parseSourceDate(null, NOW), null);
});

const clePaid = {
  parcelpinDashed: '001-04-015', parcel_owner: 'SMITH JOHN', par_addr_all: '100 MAIN ST',
  isTaxDelinquent: 0, taxDelinquencyAmount: 0, cert_sold_flag: 0, foreclosure_flag: 0, payment_plan_flag: 0,
  numBuildingCodeViolationsLast6Mo: 0, isCountyLandBank: 0, isCityLandBank: 0, isCityOwned: 0,
  last_transfer_date: Date.parse('2004-05-01'), activeRentalRegistrationFlag: 0, taxbill_update_date: Date.parse('2026-10-05'),
};

test('Cleveland mapper emits roll + tax rows; foreclosure and violations when flagged', () => {
  const quiet = mapRow('cle_property_insights', clePaid, CTX);
  assert.deepEqual(quiet.map((o) => `${o.source_type}:${o.status}`), ['parcel_roll:of_record', 'tax_delinquency:current']);
  const hot = mapRow('cle_property_insights', { ...clePaid, isTaxDelinquent: 1, taxDelinquencyAmount: 4200, foreclosure_flag: 1, numBuildingCodeViolationsLast6Mo: 2, lastBuildingCodeViolationDate: Date.parse('2026-08-01') }, CTX);
  const kinds = hot.map((o) => `${o.source_type}:${o.status}`);
  assert.ok(kinds.includes('tax_delinquency:delinquent'));
  assert.ok(kinds.includes('tax_sale:tax_foreclosure_filed'));
  assert.ok(kinds.includes('code_enforcement:violation_last_6mo'));
  for (const o of hot) {
    assert.equal(o.source_id, 'cle_property_insights');
    assert.equal(o.retrieved_at, CTX.retrievedAt);
    assert.equal(o.apn_norm, '001-04-015');
    assert.ok(o.source_url.startsWith('https://'));
  }
});

test('Columbus mapper ignores noise/zoning cases and splits vacant structure', () => {
  const noise = mapRow('cbus_code_cases', { B1_PARCEL_NBR: '010000059', B1_PER_TYPE: 'Community Noise', B1_APPL_STATUS: 'Closed' }, CTX);
  assert.equal(noise.length, 0);
  const vac = mapRow('cbus_code_cases', { B1_PARCEL_NBR: '010137397', B1_ALT_ID: 'VS-1', B1_PER_TYPE: 'Vacant Structure Inspection', B1_APPL_STATUS: 'Court', B1_FILE_DD: Date.parse('2026-04-02') }, CTX);
  assert.equal(vac[0].source_type, SOURCE_TYPE.VACANT_REGISTRY);
  assert.equal(vac[0].apn_norm, '010-137397');
  assert.equal(vac[0].status, 'court');
});

test('readArcgisLayer pages through injected fetch and stops on short page', async () => {
  const calls = [];
  const pages = [
    { features: [{ attributes: { a: 1 } }, { attributes: { a: 2 } }], exceededTransferLimit: true },
    { features: [{ attributes: { a: 3 } }] },
  ];
  const rows = await readArcgisLayer(
    { url: 'https://example.test/FeatureServer/0', where: "x IN ('1')", outFields: ['a'], pageSize: 2, delayMs: 5 },
    { fetchJson: async (url, body) => { calls.push(body.resultOffset); return pages.shift(); }, sleep: async () => {} },
  );
  assert.deepEqual(rows.map((r) => r.a), [1, 2, 3]);
  assert.deepEqual(calls, ['0', '2']);
  assert.equal(parcelInClauses('p', ['a', 'b', 'a', null, "c'"], 2).length, 2);
});

const baseProperty = {
  property_id: 'p1', fips: '39035', apn: '001-04-015', owner_name: 'SMITH JOHN', tax_delinquent: true,
  vendor_snapshot_date: '2026-07-18', age: 77, marital_status: 'M',
};

test('candidate: tax foreclosure + open condemnation, owner verified → S6_A, no sensitive fields', () => {
  const obs = [
    ...mapRow('cle_property_insights', { ...clePaid, isTaxDelinquent: 1, taxDelinquencyAmount: 4200, foreclosure_flag: 1 }, CTX),
    ...mapRow('cle_active_condemnations', { Parcel_Number: '001-04-015', Active_Condemnation: 'Y', Condemnation_Date: Date.parse('2026-05-01') }, CTX),
  ];
  const c = buildCandidate({ property: baseProperty, match: { method: 'apn', confidence: 'exact' }, observations: obs, contact: { ever_contacted: false }, now: NOW });
  assert.equal(c.tier, TIER.A);
  assert.equal(c.contact_state, 'never_contacted');
  assert.equal(c.property.age, undefined);
  assert.equal(c.property.marital_status, undefined);
  assert.deepEqual(c.evidence_groups.map((g) => g.group).sort(), ['code', 'tax']);
  assert.ok(c.inferences.every((s) => s.includes('(inference)')));
});

test('candidate: county says taxes paid → contradiction recorded, no distress', () => {
  const obs = mapRow('cle_property_insights', clePaid, CTX);
  const c = buildCandidate({ property: baseProperty, match: { method: 'apn', confidence: 'exact' }, observations: obs, now: NOW });
  assert.equal(c.tier, TIER.NONE);
  assert.equal(c.evidence_groups[0].contradictions.length, 1);
});

test('recent transfer after vendor snapshot excludes (recent buyer ≠ distressed seller)', () => {
  const obs = mapRow('cle_property_insights', { ...clePaid, isTaxDelinquent: 1, taxDelinquencyAmount: 9000, last_transfer_date: Date.parse('2026-07-22') }, CTX);
  const c = buildCandidate({ property: baseProperty, match: { method: 'apn', confidence: 'exact' }, observations: obs, now: NOW });
  assert.equal(c.tier, TIER.EXCLUDED);
  assert.ok(c.exclusions.includes('recent_transfer_new_owner_not_distressed_seller'));
  const v = verifyOwnership(baseProperty, null, [{ event_date: '2026-08-30' }], NOW);
  assert.ok(v.exclusions.includes('recent_transfer_new_owner_not_distressed_seller'));
});

test('owner mismatch or address-only match → review; opt-out → excluded; stale → not evidence', () => {
  const obs = mapRow('cle_property_insights', { ...clePaid, parcel_owner: 'JONES ROBERT', isTaxDelinquent: 1, taxDelinquencyAmount: 9000, foreclosure_flag: 1 }, CTX);
  const mismatch = buildCandidate({ property: baseProperty, match: { method: 'apn', confidence: 'exact' }, observations: obs, now: NOW });
  assert.equal(mismatch.tier, TIER.REVIEW);
  assert.equal(mismatch.ownership.status, 'owner_of_record_differs');
  const optOut = buildCandidate({ property: baseProperty, match: { method: 'apn', confidence: 'exact' }, observations: obs, contact: { opted_out: true }, now: NOW });
  assert.equal(optOut.tier, TIER.EXCLUDED);
  const staleCtx = { ...CTX, retrievedAt: '2026-08-01T00:00:00Z' };
  const staleObs = mapRow('cle_property_insights', { ...clePaid, isTaxDelinquent: 1, taxDelinquencyAmount: 9000 }, staleCtx);
  const stale = buildCandidate({ property: baseProperty, match: { method: 'apn', confidence: 'exact' }, observations: staleObs, now: NOW });
  assert.equal(stale.tier, TIER.NONE);
  assert.equal(stale.stale_observations, staleObs.length);
});

test('Detroit: land-bank owned excludes; old/impossible-date tickets are not evidence', () => {
  const det = { ...baseProperty, property_id: 'd1', fips: '26163', apn: '22125216.', owner_name: 'DOE JANE' };
  const lb = mapRow('det_dlba_buildings', { parcel_id: '22125216.', dlba_case_number: 'B1' }, CTX);
  const c1 = buildCandidate({ property: det, match: { method: 'apn', confidence: 'exact' }, observations: lb, now: NOW });
  assert.equal(c1.tier, TIER.EXCLUDED);
  const t = mapRow('det_blight_tickets', { parcel_id: '22125216.', ticket_issued_date: '8535-09-25', amt_balance_due: 900 }, CTX);
  assert.deepEqual(t[0].data_defects, ['impossible_issue_date']);
  const c2 = buildCandidate({ property: det, match: { method: 'apn', confidence: 'exact' }, observations: t, now: NOW });
  assert.equal(c2.tier, TIER.NONE);
});
