/**
 * Seller portal — authorization, account claim, and presentation contract.
 *
 * Every fixture here is synthetic (example.test addresses, 555 numbers); no
 * production seller data is used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemorySellerPortalStore } from '@/lib/domain/seller-portal/seller-portal-store.js';
import {
  bookCall,
  documentLink,
  getPortalState,
  listCallSlots,
  listSellerMessages,
  operatorReply,
  resolveSession,
  sendSellerMessage,
  signOut,
  startSignIn,
  verifySignIn,
} from '@/lib/domain/seller-portal/seller-portal-service.js';
import { deriveSellerState, projectOffer, buildTimeline } from '@/lib/domain/seller-portal/seller-portal-contracts.js';
import { renderSellerEmail } from '@/lib/domain/seller-portal/seller-portal-notify.js';
import { handleSellerPortalRequest } from '@/app/api/internal/seller-portal/[action]/route.js';

const NOW = new Date('2026-10-05T14:00:00.000Z'); // a Monday, 10:00 in New York
const OPP_A = '11111111-1111-4111-8111-111111111111';
const OPP_B = '22222222-2222-4222-8222-222222222222';
const ENV = {
  NODE_ENV: 'test',
  SELLER_PORTAL_CODE_PEPPER: 'test-pepper',
  SELLER_PORTAL_CALL_HOURS: JSON.stringify({ timezone: 'America/New_York', days: [1, 2, 3, 4, 5], times: ['10:30', '13:00', '15:30'], lead_minutes: 60, horizon_days: 3 }),
};

function seed() {
  return createInMemorySellerPortalStore({
    opportunities: [
      { id: OPP_A, acquisition_stage: 'offer_interest', opportunity_status: 'active', primary_thread_key: '+15555550101', property_address_full: '1240 Sycamore Lane, Atlanta, GA 30310', created_at: '2026-09-20T15:00:00Z' },
      { id: OPP_B, acquisition_stage: 'offer', opportunity_status: 'active', primary_thread_key: '+15555550202', property_address_full: '88 Other Street, Tampa, FL 33602', created_at: '2026-09-21T15:00:00Z' },
    ],
    intake: [
      { id: 'sub-a', status: 'accepted', lead_id: OPP_A, seller_email: 'alex@example.test', seller_display_name: 'Alex Seller', seller_phone: '+15555550101' },
      { id: 'sub-b', status: 'accepted', lead_id: OPP_B, seller_email: 'blair@example.test', seller_display_name: 'Blair Seller', seller_phone: '+15555550202' },
    ],
    offers: [{ opportunity_id: OPP_B, offer_version: 1, direction: 'outbound', status: 'active', purchase_price: 210000, closing_date: '2026-11-01', sent_at: '2026-10-01T12:00:00Z' }],
    attachments: [{ id: 'att-b', storage_bucket: 'email-attachments', storage_path: 'b/agreement.pdf', filename: 'agreement.pdf' }],
    shares: [{ id: 'share-b', opportunity_id: OPP_B, attachment_id: 'att-b', label: 'Purchase agreement', document_kind: 'purchase_agreement', seller_status: 'needs_signature', shared_at: '2026-10-02T12:00:00Z' }],
  });
}

async function signIn(store, email) {
  const deps = { store, env: ENV, now: () => NOW, echoCode: true };
  const started = await startSignIn({ email }, deps);
  const verified = await verifySignIn({ email, code: started.dev_code }, deps);
  return verified.session_token;
}

test('an unknown email gets the same response as a known one, and no code', async () => {
  const store = seed();
  const deps = { store, env: ENV, now: () => NOW, echoCode: true };
  const unknown = await startSignIn({ email: 'nobody@example.test' }, deps);
  const known = await startSignIn({ email: 'alex@example.test' }, deps);
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.dev_code, undefined);
  assert.equal(store.state.identities.length, 1, 'no identity is created for an email with no property');
});

test('the account claims the property from intake: nothing is re-entered', async () => {
  const store = seed();
  const token = await signIn(store, 'alex@example.test');
  const state = await getPortalState({ token }, { store, env: ENV, now: () => NOW });
  assert.equal(state.property.opportunity_id, OPP_A);
  assert.equal(state.property.address, '1240 Sycamore Lane, Atlanta, GA 30310');
  assert.equal(state.seller.display_name, 'Alex Seller');
});

test('a seller can never reach another seller’s opportunity, messages, documents, or calls', async () => {
  const store = seed();
  const deps = { store, env: ENV, now: () => NOW };
  const token = await signIn(store, 'alex@example.test');
  for (const call of [
    () => getPortalState({ token, opportunityId: OPP_B }, deps),
    () => listSellerMessages({ token, opportunityId: OPP_B }, deps),
    () => sendSellerMessage({ token, opportunityId: OPP_B, body: 'hi' }, deps),
    () => documentLink({ token, opportunityId: OPP_B, documentId: 'share-b' }, deps),
  ]) {
    await assert.rejects(call, (e) => e.code === 'not_found' && e.status === 404);
  }
  // Even a granted opportunity cannot open a document shared on another one.
  await assert.rejects(documentLink({ token, opportunityId: OPP_A, documentId: 'share-b' }, deps), (e) => e.code === 'not_found');
});

test('codes expire, are single-use, and lock after five wrong attempts', async () => {
  const store = seed();
  const deps = { store, env: ENV, now: () => NOW, echoCode: true };
  const { dev_code } = await startSignIn({ email: 'alex@example.test' }, deps);
  const late = { ...deps, now: () => new Date(NOW.getTime() + 16 * 60_000) };
  await assert.rejects(verifySignIn({ email: 'alex@example.test', code: dev_code }, late), (e) => e.code === 'invalid_or_expired_code');
  const second = await startSignIn({ email: 'alex@example.test' }, deps);
  for (let i = 0; i < 5; i++) await assert.rejects(verifySignIn({ email: 'alex@example.test', code: '000000' === second.dev_code ? '111111' : '000000' }, deps));
  await assert.rejects(verifySignIn({ email: 'alex@example.test', code: second.dev_code }, deps), (e) => e.code === 'invalid_or_expired_code');
  const third = await startSignIn({ email: 'alex@example.test' }, deps);
  const ok = await verifySignIn({ email: 'alex@example.test', code: third.dev_code }, deps);
  assert.ok(ok.session_token);
  await assert.rejects(verifySignIn({ email: 'alex@example.test', code: third.dev_code }, deps), 'a code works once');
});

test('sign-out revokes the session', async () => {
  const store = seed();
  const deps = { store, env: ENV, now: () => NOW };
  const token = await signIn(store, 'alex@example.test');
  await resolveSession(token, deps);
  await signOut(token, deps);
  await assert.rejects(resolveSession(token, deps), (e) => e.code === 'unauthorized');
});

test('an estimate is never presented as an offer, and a sent offer is', async () => {
  const estimate = { seller_projection: { preliminary_range: { low: 240000, high: 265000 }, disclaimer: 'Not an offer.', binding: false }, expires_at: '2026-10-20T00:00:00Z', computed_at: '2026-10-04T00:00:00Z' };
  const offerless = projectOffer({ evaluations: [estimate], now: NOW });
  assert.equal(offerless.tier, 'estimate');
  assert.equal(offerless.binding, false);
  const unsent = projectOffer({ offers: [{ status: 'active', purchase_price: 1, offer_version: 1 }], evaluations: [], now: NOW });
  assert.equal(unsent.tier, 'none', 'an unsent draft offer is invisible to the seller');
  const sent = projectOffer({ offers: [{ status: 'active', purchase_price: 250000, offer_version: 2, sent_at: '2026-10-04T00:00:00Z' }], evaluations: [estimate], now: NOW });
  assert.equal(sent.tier, 'written_offer');
  assert.equal(sent.amount, 250000);
  assert.equal(deriveSellerState({ opportunity: { acquisition_stage: 'offer', opportunity_status: 'active' }, offers: [{ status: 'active', purchase_price: 1, sent_at: 'x' }], now: NOW }), 'offer_ready');
});

test('the timeline shows only real dates', async () => {
  const timeline = buildTimeline({ opportunity: { created_at: '2026-09-20T15:00:00Z' }, state: 'title_review', closing: { scheduled_closing_date: '2026-11-01T18:00:00Z' } });
  assert.equal(timeline.find((s) => s.key === 'title').status, 'current');
  assert.equal(timeline.find((s) => s.key === 'closing').at, null, 'an unconfirmed closing date is not shown as scheduled');
  assert.equal(timeline.find((s) => s.key === 'submitted').at, '2026-09-20T15:00:00.000Z');
});

test('calls book only into configured, open slots and reach operations', async () => {
  const store = seed();
  const deps = { store, env: ENV, now: () => NOW };
  const token = await signIn(store, 'alex@example.test');
  const { slots } = await listCallSlots({}, deps);
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => new Date(s.start_at) > new Date(NOW.getTime() + 60 * 60_000)), 'lead time respected');
  await assert.rejects(bookCall({ token, reason: 'offer', startAt: '2026-10-05T03:00:00Z' }, deps), (e) => e.code === 'slot_unavailable');
  const booked = await bookCall({ token, reason: 'offer', startAt: slots[0].start_at }, deps);
  assert.equal(booked.call.reason, 'My offer');
  assert.equal(store.state.calls[0].event_type, 'manual_call');
  assert.equal(store.state.calls[0].opportunity_id, OPP_A);
  assert.equal(store.state.inboxFlags.at(-1).threadKey, '+15555550101');
  const again = await listCallSlots({}, deps);
  assert.ok(!again.slots.some((s) => s.start_at === slots[0].start_at), 'a full slot disappears');
  const none = await listCallSlots({}, { store, env: { NODE_ENV: 'test' }, now: () => NOW });
  assert.equal(none.available, false, 'no configuration means no invented availability');
});

test('seller messages reach operations and operator replies come back', async () => {
  const store = seed();
  const deps = { store, env: ENV, now: () => NOW };
  const token = await signIn(store, 'alex@example.test');
  await sendSellerMessage({ token, body: 'When do you need the keys?', idempotencyKey: 'k1' }, deps);
  await sendSellerMessage({ token, body: 'When do you need the keys?', idempotencyKey: 'k1' }, deps);
  assert.equal(store.state.messages.length, 1, 'idempotent');
  assert.equal(store.state.history.at(-1).event_type, 'seller_portal_message_received');
  await operatorReply({ opportunityId: OPP_A, operator: 'ops-user', body: 'At closing.' }, deps);
  const listed = await listSellerMessages({ token }, deps);
  assert.deepEqual(listed.messages.map((m) => m.author), ['seller', 'operator']);
});

test('the internal route requires the shared secret in production and the portal flag', async () => {
  const request = (headers = {}) => new Request('http://local/api/internal/seller-portal/state', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  const prev = { NODE_ENV: process.env.NODE_ENV, SECRET: process.env.SELLER_PORTAL_INTERNAL_SECRET };
  process.env.SELLER_PORTAL_INTERNAL_SECRET = 'route-secret';
  try {
    const denied = await handleSellerPortalRequest(request(), 'state', { env: { SELLER_PORTAL_ENABLED: '1' }, store: seed() });
    assert.equal(denied.status, 401);
    const disabled = await handleSellerPortalRequest(request({ 'x-seller-portal-secret': 'route-secret' }), 'state', { env: {}, store: seed() });
    assert.equal(disabled.status, 503);
    const unauth = await handleSellerPortalRequest(request({ 'x-seller-portal-secret': 'route-secret' }), 'state', { env: { ...ENV, SELLER_PORTAL_ENABLED: '1' }, store: seed() });
    assert.equal(unauth.status, 401);
  } finally {
    process.env.SELLER_PORTAL_INTERNAL_SECRET = prev.SECRET;
  }
});

test('seller emails deep-link into the portal and never ask the seller to call', () => {
  for (const kind of ['call_scheduled', 'offer_ready', 'message', 'closing_scheduled']) {
    const email = renderSellerEmail({ kind, context: { start_at: NOW.toISOString(), timezone: 'America/New_York', reason: 'My offer' } }, { SELLER_PORTAL_PUBLIC_BASE_URL: 'https://example.test' });
    assert.match(email.html, /https:\/\/example\.test\/account\//);
    assert.doesNotMatch(email.text, /call us|\(\d{3}\)\s?\d{3}-\d{4}/i);
  }
});
