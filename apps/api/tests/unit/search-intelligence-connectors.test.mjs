import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretStore, isSecretRef, looksLikeSecretMaterial } from '@/lib/domain/search-intelligence/secret-store.js';
import { connectionStatus, createSearchConsoleConnector, PROVIDERS, READ_ONLY_SCOPE } from '@/lib/domain/search-intelligence/connectors.js';

const none = createSecretStore({});

test('secret references are names, never material', () => {
  assert.equal(isSecretRef('SI_GSC_PROMINENT'), true);
  assert.equal(isSecretRef('-----BEGIN PRIVATE KEY-----'), false);
  assert.equal(looksLikeSecretMaterial('{"type": "service_account", "private_key": "x"}'), true);
  assert.equal(looksLikeSecretMaterial('SI_GSC_PROMINENT'), false);
});

test('describe() reports presence only and never the value', () => {
  const store = createSecretStore({ SI_GSC_X: 'super-secret-value' });
  const d = store.describe('SI_GSC_X');
  assert.deepEqual(d, { ref: 'SI_GSC_X', configured: true, reason: null });
  assert.equal(JSON.stringify(d).includes('super-secret-value'), false);
  assert.throws(() => none.resolve('SI_GSC_X'), { code: 'not_configured' });
  assert.throws(() => none.resolve('not a ref'), { code: 'invalid_reference' });
});

test('every V1 connection is NOT_CONFIGURED (no credentials exist)', () => {
  for (const provider of PROVIDERS) {
    const s = connectionStatus({ property_id: 'prominent', provider }, { secrets: none });
    assert.equal(s.state, 'NOT_CONFIGURED', provider);
  }
});

test('states advance on evidence: reference → secret → property', () => {
  const row = { property_id: 'p', provider: 'SEARCH_CONSOLE', secret_ref: 'SI_GSC_P' };
  assert.equal(connectionStatus(row, { secrets: none }).state, 'AWAITING_ACCESS');
  const store = createSecretStore({ SI_GSC_P: 'x' });
  assert.equal(connectionStatus(row, { secrets: store }).reason, 'provider_property_missing');
  assert.equal(connectionStatus({ ...row, provider_property: 'sc-domain:p.test' }, { secrets: store }).state, 'VERIFYING');
});

test('key material pasted into a connection row is refused', () => {
  const s = connectionStatus({ property_id: 'p', provider: 'GA4', secret_ref: '-----BEGIN PRIVATE KEY-----abc' }, { secrets: none });
  assert.equal(s.state, 'ERROR');
  assert.equal(s.reason, 'secret_material_in_row');
});

test('connectors are read-only and refuse to run unconfigured', async () => {
  assert.match(READ_ONLY_SCOPE.SEARCH_CONSOLE, /readonly$/);
  assert.match(READ_ONLY_SCOPE.GA4, /readonly$/);
  const c = createSearchConsoleConnector({ secrets: none });
  assert.equal(c.status.state, 'NOT_CONFIGURED');
  assert.equal(Object.keys(c).some((k) => /write|insert|update|delete|submit/i.test(k)), false);
  await assert.rejects(c.searchAnalytics({}), { code: 'no_secret_reference' });
});
