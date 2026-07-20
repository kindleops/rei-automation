import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLienDocType } from '../importers/mappers.mjs';
import { netLienEpisodes } from '../features/engine.mjs';

test('compositional doc-type parse: JDGLENREL is a judgment-lien RELEASE', () => {
  const p = parseLienDocType('JDGLENREL');
  assert.equal(p.lifecycle, 'release');
});

test('base types classify: LENCNT creation, LIS litigation, UCCCON continuation, AFD probate', () => {
  assert.equal(parseLienDocType('LENCNT').lifecycle, 'creation');
  assert.equal(parseLienDocType('LIS').lifecycle, 'litigation');
  assert.equal(parseLienDocType('UCCCON').lifecycle, 'continuation');
  assert.equal(parseLienDocType('AFD').lifecycle, 'probate_life_event');
  assert.equal(parseLienDocType('RED').lifecycle, 'foreclosure_related');
  assert.equal(parseLienDocType('ORD').lifecycle, 'ambiguous');
});

test('T-04 release netting: creation then release => closed, zero active pressure', () => {
  const liens = [
    { id: 'a', base_type: 'lien', lifecycle_class: 'creation', filing_date: '2023-01-05', amount_due: 12000 },
    { id: 'b', base_type: 'lien', lifecycle_class: 'release', filing_date: '2024-02-01' },
  ];
  const eps = netLienEpisodes(liens);
  assert.equal(eps.filter((e) => e.state === 'open').length, 0);
  assert.equal(eps.filter((e) => e.state === 'closed').length, 1);
});

test('T-04 unmatched release routes to review, never nets silently', () => {
  const eps = netLienEpisodes([{ id: 'x', base_type: 'judgment', lifecycle_class: 'release', filing_date: '2024-01-01' }]);
  assert.equal(eps[0].state, 'review_unmatched_release');
});

test('T-03 no duplicate episodes: assignment and continuation extend, not reopen', () => {
  const liens = [
    { id: 'a', base_type: 'ucc', lifecycle_class: 'creation', filing_date: '2020-01-01' },
    { id: 'b', base_type: 'ucc', lifecycle_class: 'continuation', filing_date: '2022-01-01' },
    { id: 'c', base_type: 'ucc', lifecycle_class: 'assignment', filing_date: '2023-01-01' },
  ];
  const eps = netLienEpisodes(liens).filter((e) => e.state === 'open');
  assert.equal(eps.length, 1);
  assert.equal(eps[0].docs.length, 3);
});
