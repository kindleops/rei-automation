import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ingestExternalSellerIntake,
  normalizeExternalSellerIntake,
} from '@/lib/domain/acquisition/external-seller-intake-service.js';
import { handleExternalSellerIntakeRequest } from '@/app/api/internal/acquisition/intake/route.js';

const NOW = new Date('2026-08-31T15:00:00.000Z');

function input(overrides = {}) {
  return {
    schema_version: 'pco-intake/v1',
    idempotency_key: 'pco-test-key-0001',
    source_application: 'prominent_cash_offer',
    source_channel: 'web_seller_intake',
    source: {
      canonical_path: '/sell-your-house/',
      landing_path: '/sell-your-house/',
      referrer: 'https://example.test/',
      utm_source: 'test',
      utm_campaign: 'synthetic',
    },
    seller: {
      name: 'Synthetic Seller',
      phone: '(512) 555-0123',
      email: 'synthetic@example.test',
    },
    property: {
      address: '123 Main St, Austin, TX 78701',
      context: {
        property_type: 'Single-family home',
        condition: 'Needs updates',
        situation: 'Exploring my options',
        timeline: 'Within the next few months',
        note: 'Synthetic test fixture only',
      },
    },
    consent: {
      contact_requested: true,
      captured_at: NOW.toISOString(),
      policy_version: 'pco-intake/v1',
    },
    client: { submitted_at: NOW.toISOString(), user_agent_class: 'test' },
    ...overrides,
  };
}

function request(body, headers = {}) {
  return {
    headers: new Headers({ 'content-length': String(JSON.stringify(body).length), ...headers }),
    json: async () => body,
  };
}

test('normalizes PCO seller, property, attribution, and consent without writing', () => {
  const normalized = normalizeExternalSellerIntake(input(), { now: NOW });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.intake.seller_phone, '+15125550123');
  assert.equal(normalized.intake.seller_email, 'synthetic@example.test');
  assert.equal(normalized.intake.seller_first_name, 'Synthetic');
  assert.equal(normalized.intake.seller_last_name, 'Seller');
  assert.equal(normalized.intake.attribution.utm_campaign, 'synthetic');
  assert.equal(normalized.intake.consent.contact_requested, true);
  assert.match(normalized.intake.payload_hash, /^[a-f0-9]{64}$/);
});

test('canonical service performs exactly one authenticated RPC handoff and preserves resolved property identity', async () => {
  const calls = [];
  const result = await ingestExternalSellerIntake(input(), {
    now: NOW,
    resolveProperty: async () => ({ status: 'RESOLVED', property_id: 'property-test-1', reason: 'unique_structured_match' }),
    supabase: {
      rpc: async (name, params) => {
        calls.push({ name, params });
        return { data: { ok: true, submission_id: 'submission-test-1', lead_id: 'lead-test-1', matched_existing: false }, error: null };
      },
    },
  });
  assert.deepEqual(result, { ok: true, submission_id: 'submission-test-1', lead_id: 'lead-test-1', matched_existing: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ingest_external_seller_intake');
  assert.equal(calls[0].params.p_property_id, 'property-test-1');
  assert.equal(calls[0].params.p_seller_phone, '+15125550123');
  assert.equal(calls[0].params.p_attribution.utm_source, 'test');
  assert.equal(calls[0].params.p_consent.contact_requested, true);
});

test('same-key concurrent handoffs return the durable RPC result and do not add a browser-side writer', async () => {
  let calls = 0;
  const durable = { ok: true, submission_id: 'submission-race-1', lead_id: 'lead-race-1', matched_existing: false };
  const supabase = {
    rpc: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { data: durable, error: null };
    },
  };
  const [first, second] = await Promise.all([
    ingestExternalSellerIntake(input(), { now: NOW, resolveProperty: async () => ({ status: 'NOT_FOUND' }), supabase }),
    ingestExternalSellerIntake(input(), { now: NOW, resolveProperty: async () => ({ status: 'NOT_FOUND' }), supabase }),
  ]);
  assert.deepEqual(first, durable);
  assert.deepEqual(second, durable);
  assert.equal(calls, 2, 'the application may retry, but the database RPC owns same-key serialization');
});

test('public intake route rejects unauthorized requests and returns only safe identifiers on success', async () => {
  const body = input();
  const unauthorized = await handleExternalSellerIntakeRequest(request(body, { 'x-prominent-intake-secret': 'wrong' }), {
    expectedSecret: 'test-secret',
    logger: { warn() {}, error() {}, info() {} },
  });
  assert.equal(unauthorized.status, 401);

  const accepted = await handleExternalSellerIntakeRequest(request(body, { 'x-prominent-intake-secret': 'test-secret' }), {
    expectedSecret: 'test-secret',
    generateCorrelationId: () => 'request-1',
    ingestExternalSellerIntake: async () => ({ ok: true, submission_id: 'submission-1', lead_id: 'lead-1', matched_existing: false }),
    logger: { warn() {}, error() {}, info() {} },
  });
  assert.equal(accepted.status, 200);
  const payload = await accepted.json();
  assert.deepEqual(payload, {
    ok: true,
    submission_id: 'submission-1',
    lead_id: 'lead-1',
    matched_existing: false,
    idempotent_replay: false,
    thread_created: false,
    communication_queued: false,
    message_sent: false,
  });
  assert.equal('seller_phone' in payload, false);
  assert.equal('seller_email' in payload, false);
});

test('public intake route rejects malformed/invalid/oversized payloads before persistence', async () => {
  const deps = {
    expectedSecret: 'test-secret',
    logger: { warn() {}, error() {}, info() {} },
    ingestExternalSellerIntake: async () => {
      throw new Error('must not write');
    },
  };
  const headers = { 'x-prominent-intake-secret': 'test-secret' };

  const invalid = await handleExternalSellerIntakeRequest(request({ ...input(), consent: {} }, headers), deps);
  assert.equal(invalid.status, 422);

  const malformed = await handleExternalSellerIntakeRequest({
    headers: new Headers(headers),
    json: async () => { throw new SyntaxError('bad json'); },
  }, deps);
  assert.equal(malformed.status, 400);

  const oversized = await handleExternalSellerIntakeRequest({
    headers: new Headers(headers),
    json: async () => ({ ...input(), seller: { ...input().seller, name: 'x'.repeat(40_000) } }),
  }, deps);
  assert.equal(oversized.status, 413);
});

test('public intake route maps canonical persistence failure to honest 503', async () => {
  const response = await handleExternalSellerIntakeRequest(request(input(), {
    'x-prominent-intake-secret': 'test-secret',
  }), {
    expectedSecret: 'test-secret',
    ingestExternalSellerIntake: async () => ({ ok: false, failure_code: 'external_intake_persistence_failed' }),
    logger: { warn() {}, error() {}, info() {} },
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'intake_unavailable');
});

test('migration makes idempotency atomic and contains no outbound queue or messaging write', () => {
  const migration = fs.readFileSync(new URL('../../supabase/migrations/20260831120000_external_seller_intake.sql', import.meta.url), 'utf8');
  assert.match(migration, /UNIQUE \(source_application, idempotency_key\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /automation_state, automation_status/);
  assert.match(migration, /primary_property_id = p_property_id/);
  assert.match(migration, /source_application, source_channel/);
  assert.match(migration, /contact_requested/);
  assert.doesNotMatch(migration, /INSERT INTO public\.(send_queue|message_events)/);
  assert.doesNotMatch(migration, /acquisition_contacts/);
});
