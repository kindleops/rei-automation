/**
 * Seller portal — authorization, account claim, sign-in hardening, calls
 * through the shared scheduling core, documents, lifecycle notifications.
 *
 * Every fixture here is synthetic (example.test addresses, 555 numbers, one
 * explicitly fake internal team member); no production seller data is used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemorySellerPortalStore } from '@/lib/domain/seller-portal/seller-portal-store.js';
import {
  SIGN_IN_LIMITS,
  bookCall,
  cancelCall,
  documentLink,
  getPortalState,
  listCallSlots,
  listSellerMessages,
  listShareableDocuments,
  operatorReply,
  rescheduleCall,
  resolveSession,
  revokeDocument,
  sendSellerMessage,
  shareDocument,
  signOut,
  signOutEverywhere,
  startSignIn,
  verifySignIn,
} from '@/lib/domain/seller-portal/seller-portal-service.js';
import { deriveSellerState, projectOffer, buildTimeline } from '@/lib/domain/seller-portal/seller-portal-contracts.js';
import { renderSellerEmail } from '@/lib/domain/seller-portal/seller-portal-notify.js';
import { emitSellerLifecycle } from '@/lib/domain/seller-portal/seller-portal-lifecycle.js';
import { createProminentSchedulingAdapter, PROMINENT_BRAND } from '@/lib/domain/seller-portal/prominent-scheduling-adapter.js';
import { createInMemorySchedulingStore } from '@/lib/domain/scheduling/scheduling-store.js';
import { createSchedulingService } from '@/lib/domain/scheduling/scheduling-service.js';
import { bindOfferToQueueRow } from '@/lib/domain/seller-flow/seller-offer-authority.js';
import { handleSellerPortalRequest } from '@/app/api/internal/seller-portal/[action]/route.js';

const NOW = new Date('2026-10-05T14:00:00.000Z'); // a Monday, 10:00 in New York
const OPP_A = '11111111-1111-4111-8111-111111111111';
const OPP_B = '22222222-2222-4222-8222-222222222222';
const ADVISOR = 'aaaaaaaa-0000-4000-8000-000000000001'; // the single fake internal user
const ENV = { NODE_ENV: 'test', SELLER_PORTAL_CODE_PEPPER: 'test-pepper' };
const WEEKDAYS_9_TO_5 = { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] };

function prominentTypes() {
  return [
    { id: 't-prop', brand_key: PROMINENT_BRAND, type_key: 'property_conversation', name: 'Property conversation', duration_minutes: 30, slot_interval_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 10, min_notice_minutes: 120, horizon_days: 3, routing: { strategy: 'round_robin', pool: 'seller_advisors' }, reminder_offsets_minutes: [1440, 60], environment: 'production', active: true },
    { id: 't-offer', brand_key: PROMINENT_BRAND, type_key: 'offer_review', name: 'Offer review', duration_minutes: 30, slot_interval_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 10, min_notice_minutes: 120, horizon_days: 3, routing: { strategy: 'specific_owner', owner: 'opportunity_owner', owner_unavailable: 'route_to_pool', pool: 'seller_advisors' }, reminder_offsets_minutes: [1440, 60], environment: 'production', active: true },
    { id: 't-title', brand_key: PROMINENT_BRAND, type_key: 'title_closing_question', name: 'Title / closing question', duration_minutes: 30, slot_interval_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 10, min_notice_minutes: 120, horizon_days: 3, routing: { strategy: 'specific_owner', owner: 'transaction_owner', owner_unavailable: 'route_to_pool', pool: 'transaction_team', fallback_pool: 'seller_advisors' }, reminder_offsets_minutes: [1440, 60], environment: 'production', active: true },
  ];
}

function world({ withAdvisor = true } = {}) {
  const store = createInMemorySellerPortalStore({
    opportunities: [
      { id: OPP_A, acquisition_stage: 'offer_interest', opportunity_status: 'active', primary_thread_key: '+15555550101', property_address_full: '1240 Sycamore Lane, Atlanta, GA 30310', created_at: '2026-09-20T15:00:00Z' },
      { id: OPP_B, acquisition_stage: 'offer', opportunity_status: 'active', primary_thread_key: '+15555550202', property_address_full: '88 Other Street, Tampa, FL 33602', created_at: '2026-09-21T15:00:00Z' },
    ],
    intake: [
      { id: 'sub-a', status: 'accepted', lead_id: OPP_A, seller_email: 'alex@example.test', seller_display_name: 'Alex Seller', seller_phone: '+15555550101' },
      { id: 'sub-b', status: 'accepted', lead_id: OPP_B, seller_email: 'blair@example.test', seller_display_name: 'Blair Seller', seller_phone: '+15555550202' },
    ],
    offers: [{ opportunity_id: OPP_B, offer_version: 1, direction: 'outbound', status: 'active', purchase_price: 210000, closing_date: '2026-11-01', sent_at: '2026-10-01T12:00:00Z' }],
    closings: [{ opportunity_id: OPP_B, closing_case_id: 'case-b' }],
    threads: [{ id: 'thr-title', closing_case_id: 'case-b', category: 'title' }, { id: 'thr-buyer', closing_case_id: 'case-b', category: 'buyer' }],
    attachments: [
      { id: 'att-b', storage_bucket: 'email-attachments', storage_path: 'b/agreement.pdf', filename: 'agreement.pdf', routed_entity_type: 'closing_case', routed_entity_id: 'case-b', fetch_status: 'stored' },
      { id: 'att-title', storage_bucket: 'email-attachments', storage_path: 'b/commitment.pdf', filename: 'commitment.pdf', thread_id: 'thr-title', fetch_status: 'stored' },
      { id: 'att-buyer', storage_bucket: 'email-attachments', storage_path: 'b/assignment.pdf', filename: 'assignment.pdf', thread_id: 'thr-buyer', fetch_status: 'stored' },
    ],
    shares: [{ id: 'share-b', opportunity_id: OPP_B, attachment_id: 'att-b', label: 'Purchase agreement', document_kind: 'purchase_agreement', seller_status: 'needs_signature', shared_at: '2026-10-02T12:00:00Z' }],
  });
  const sent = [];
  const notify = async (m) => { sent.push(m); return { sent: true }; };
  const schedStore = createInMemorySchedulingStore({
    eventTypes: prominentTypes(),
    resources: withAdvisor ? [{ id: ADVISOR, display_name: 'Test Advisor (fixture)', timezone: 'America/New_York', weekly_hours: WEEKDAYS_9_TO_5, active: true, operator_keys: ['test-advisor'] }] : [],
    pools: [{ id: 'p-adv', brand_key: PROMINENT_BRAND, pool_key: 'seller_advisors' }, { id: 'p-tx', brand_key: PROMINENT_BRAND, pool_key: 'transaction_team' }],
    poolMembers: withAdvisor ? [{ pool_id: 'p-adv', resource_id: ADVISOR, active: true }] : [],
  });
  const reminders = [];
  const scheduling = createSchedulingService({
    store: schedStore,
    env: ENV,
    now: () => NOW,
    google: { config: { configured: false } },
    adapters: new Map([[PROMINENT_BRAND, createProminentSchedulingAdapter({ env: ENV, sellerPortalStore: store, notify })]]),
    enqueueEmail: async (row) => { reminders.push(row); return { ok: true }; },
  });
  const deps = { store, env: ENV, now: () => NOW, scheduling, notify, sellerLifecycle: (e) => emitSellerLifecycle(e, { store, notify, force: true }) };
  return { store, deps, sent, schedStore, reminders };
}

async function signIn(w, email) {
  const started = await startSignIn({ email }, { ...w.deps, echoCode: true });
  const verified = await verifySignIn({ email, code: started.dev_code }, w.deps);
  return verified.session_token;
}

// ---------------------------------------------------------------------------
// Sign-in and sessions
// ---------------------------------------------------------------------------

test('an unknown email gets the same response as a known one, and no code', async () => {
  const w = world();
  const deps = { ...w.deps, echoCode: true };
  const unknown = await startSignIn({ email: 'nobody@example.test' }, deps);
  const known = await startSignIn({ email: 'alex@example.test' }, deps);
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.dev_code, undefined);
  assert.equal(w.store.state.identities.length, 1, 'no identity is created for an email with no property');
});

test('known and unknown addresses take the same minimum time', async () => {
  const w = world();
  const deps = { ...w.deps, env: { ...ENV, SELLER_PORTAL_SIGNIN_MIN_MS: '120' } };
  for (const email of ['nobody@example.test', 'alex@example.test']) {
    const t = Date.now();
    await startSignIn({ email }, deps);
    assert.ok(Date.now() - t >= 115, `${email} answered early`);
  }
});

test('codes expire, lock after five wrong attempts, and work once', async () => {
  const w = world();
  const deps = { ...w.deps, echoCode: true };
  const { dev_code } = await startSignIn({ email: 'alex@example.test' }, deps);
  const late = { ...deps, now: () => new Date(NOW.getTime() + 16 * 60_000) };
  await assert.rejects(verifySignIn({ email: 'alex@example.test', code: dev_code }, late), (e) => e.code === 'invalid_or_expired_code');
  const second = await startSignIn({ email: 'alex@example.test' }, deps);
  for (let i = 0; i < 5; i++) await assert.rejects(verifySignIn({ email: 'alex@example.test', code: second.dev_code === '000000' ? '111111' : '000000' }, deps));
  await assert.rejects(verifySignIn({ email: 'alex@example.test', code: second.dev_code }, deps), (e) => e.code === 'invalid_or_expired_code');
  const third = await startSignIn({ email: 'alex@example.test' }, deps);
  assert.ok((await verifySignIn({ email: 'alex@example.test', code: third.dev_code }, deps)).session_token);
  await assert.rejects(verifySignIn({ email: 'alex@example.test', code: third.dev_code }, deps), 'a code works once');
});

test('a code submitted twice at the same moment yields exactly one session', async () => {
  const w = world();
  const { dev_code } = await startSignIn({ email: 'alex@example.test' }, { ...w.deps, echoCode: true });
  const results = await Promise.allSettled([1, 2, 3].map(() => verifySignIn({ email: 'alex@example.test', code: dev_code }, w.deps)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(w.store.state.sessions.length, 1);
});

test('sign-in is throttled per address and per network without revealing anything', async () => {
  const w = world();
  const deps = { ...w.deps, echoCode: true };
  for (let i = 0; i < SIGN_IN_LIMITS.startsPerAddress; i++) assert.ok((await startSignIn({ email: 'alex@example.test', ip: `10.0.0.${i}` }, deps)).dev_code);
  const blocked = await startSignIn({ email: 'alex@example.test', ip: '10.0.0.99' }, deps);
  assert.equal(blocked.status, 'code_sent_if_eligible');
  assert.equal(blocked.dev_code, undefined, 'over the address limit: same response, no code');
  // Per network: many addresses from one IP.
  const w2 = world();
  for (let i = 0; i < SIGN_IN_LIMITS.startsPerIp; i++) await startSignIn({ email: `probe${i}@example.test`, ip: '203.0.113.7' }, { ...w2.deps, echoCode: true });
  assert.equal((await startSignIn({ email: 'alex@example.test', ip: '203.0.113.7' }, { ...w2.deps, echoCode: true })).dev_code, undefined);
  assert.ok(w2.store.state.audits.some((a) => a.event === 'sign_in_throttled'));
  assert.ok(w2.store.state.throttle.every((t) => !t.key_hash.includes('203.0.113.7')), 'IPs are stored only as keyed hashes');
  // Verify attempts per network.
  const w3 = world();
  for (let i = 0; i < SIGN_IN_LIMITS.verifiesPerIp; i++) await assert.rejects(verifySignIn({ email: 'alex@example.test', code: '123456', ip: '198.51.100.1' }, w3.deps));
  await assert.rejects(verifySignIn({ email: 'alex@example.test', code: '123456', ip: '198.51.100.1' }, w3.deps), (e) => e.code === 'too_many_attempts' && e.status === 429);
});

test('sessions: rotation per sign-in, a cap on concurrent sessions, idle expiry, sign-out everywhere', async () => {
  const w = world();
  const tokens = [];
  for (let i = 0; i < SIGN_IN_LIMITS.maxActiveSessions + 1; i++) {
    const at = { ...w, deps: { ...w.deps, now: () => new Date(NOW.getTime() + i * 4 * 60_000) } }; // within the per-address limit
    tokens.push(await signIn(at, 'alex@example.test'));
  }
  assert.equal(new Set(tokens).size, tokens.length, 'every sign-in issues a new token');
  await assert.rejects(resolveSession(tokens[0], w.deps), (e) => e.code === 'unauthorized', 'the oldest session is retired past the cap');
  await resolveSession(tokens.at(-1), w.deps);
  const idle = { ...w.deps, now: () => new Date(NOW.getTime() + (SIGN_IN_LIMITS.idleTimeoutDays + 1) * 86400e3) };
  await assert.rejects(resolveSession(tokens.at(-2), idle), (e) => e.code === 'unauthorized', 'idle sessions expire');
  await signOutEverywhere(tokens.at(-1), w.deps);
  for (const t of tokens) await assert.rejects(resolveSession(t, w.deps));
  assert.ok(w.store.state.audits.some((a) => a.event === 'signed_out_everywhere'));
});

test('sign-out revokes the session', async () => {
  const w = world();
  const token = await signIn(w, 'alex@example.test');
  await resolveSession(token, w.deps);
  await signOut(token, w.deps);
  await assert.rejects(resolveSession(token, w.deps), (e) => e.code === 'unauthorized');
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('the account claims the property from intake: nothing is re-entered', async () => {
  const w = world();
  const token = await signIn(w, 'alex@example.test');
  const state = await getPortalState({ token }, w.deps);
  assert.equal(state.property.opportunity_id, OPP_A);
  assert.equal(state.property.address, '1240 Sycamore Lane, Atlanta, GA 30310');
  assert.equal(state.seller.display_name, 'Alex Seller');
});

test('a seller can never reach another seller’s opportunity, messages, documents, or calls', async () => {
  const w = world();
  const tokenA = await signIn(w, 'alex@example.test');
  for (const call of [
    () => getPortalState({ token: tokenA, opportunityId: OPP_B }, w.deps),
    () => listSellerMessages({ token: tokenA, opportunityId: OPP_B }, w.deps),
    () => sendSellerMessage({ token: tokenA, opportunityId: OPP_B, body: 'hi' }, w.deps),
    () => documentLink({ token: tokenA, opportunityId: OPP_B, documentId: 'share-b' }, w.deps),
    () => listCallSlots({ token: tokenA, opportunityId: OPP_B, reason: 'offer' }, w.deps),
  ]) {
    await assert.rejects(call, (e) => e.code === 'not_found' && e.status === 404);
  }
  // Even a granted opportunity cannot open a document shared on another one (IDOR).
  await assert.rejects(documentLink({ token: tokenA, opportunityId: OPP_A, documentId: 'share-b' }, w.deps), (e) => e.code === 'not_found');
  // Blair's call cannot be moved or cancelled by Alex.
  const tokenB = await signIn(w, 'blair@example.test');
  const { slots } = await listCallSlots({ token: tokenB, reason: 'property' }, w.deps);
  const { call } = await bookCall({ token: tokenB, reason: 'property', startAt: slots[0].start_at }, w.deps);
  await assert.rejects(cancelCall({ token: tokenA, appointmentId: call.id }, w.deps), (e) => e.code === 'not_found');
  await assert.rejects(rescheduleCall({ token: tokenA, appointmentId: call.id, startAt: slots[3].start_at }, w.deps), (e) => e.code === 'not_found');
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

test('documents: signed download links, buyer-side files never shareable, revocation is immediate', async () => {
  const w = world();
  const tokenB = await signIn(w, 'blair@example.test');
  const link = await documentLink({ token: tokenB, documentId: 'share-b' }, w.deps);
  assert.match(link.url, /expires=300/);
  assert.match(link.url, /download=agreement\.pdf/, 'served as an attachment');
  const { attachments } = await listShareableDocuments({ opportunityId: OPP_B }, w.deps);
  assert.deepEqual(attachments.map((a) => a.id).sort(), ['att-b', 'att-title']);
  await assert.rejects(shareDocument({ opportunityId: OPP_B, attachmentId: 'att-buyer', label: 'x', operator: 'ops' }, w.deps), (e) => e.code === 'attachment_not_shareable');
  await assert.rejects(shareDocument({ opportunityId: OPP_A, attachmentId: 'att-title', label: 'x', operator: 'ops' }, w.deps), (e) => e.code === 'attachment_not_shareable', 'another deal’s file cannot be shared here');
  const shared = await shareDocument({ opportunityId: OPP_B, attachmentId: 'att-title', label: 'Title commitment', kind: 'title', operator: 'ops' }, w.deps);
  assert.ok((await getPortalState({ token: tokenB }, w.deps)).documents.some((d) => d.id === shared.share.id));
  assert.ok(w.sent.some((m) => m.kind === 'document_ready' && m.to === 'blair@example.test'));
  await revokeDocument({ opportunityId: OPP_B, shareId: shared.share.id, operator: 'ops' }, w.deps);
  await assert.rejects(documentLink({ token: tokenB, documentId: shared.share.id }, w.deps), (e) => e.code === 'not_found');
  assert.ok(!(await getPortalState({ token: tokenB }, w.deps)).documents.some((d) => d.id === shared.share.id));
});

// ---------------------------------------------------------------------------
// Calls (shared scheduling core)
// ---------------------------------------------------------------------------

test('calls: real availability only, known details never re-asked, reschedule and cancel from the account', async () => {
  const w = world();
  const token = await signIn(w, 'alex@example.test');
  const first = await listCallSlots({ token, reason: 'offer', timezone: 'America/Chicago' }, w.deps);
  assert.ok(first.available);
  assert.ok(first.slots.every((s) => Date.parse(s.start_at) >= NOW.getTime() + 120 * 60_000), 'minimum notice');
  assert.deepEqual(Object.keys(first.slots[0]).sort(), ['end_at', 'start_at', 'zone'], 'times only — no people, no calendars');
  assert.equal(first.slots[0].zone, 'CDT');
  await assert.rejects(bookCall({ token, reason: 'offer', startAt: '2026-10-05T03:00:00Z' }, w.deps), (e) => e.code === 'slot_unavailable' && Array.isArray(e.slots));
  const booked = await bookCall({ token, reason: 'offer', startAt: first.slots[0].start_at, timezone: 'America/Chicago' }, w.deps);
  assert.equal(booked.call.reason, 'My offer');
  const appt = w.schedStore.state.appointments[0];
  assert.deepEqual(appt.related_refs, [`opportunity:${OPP_A}`]);
  assert.equal(appt.customer.email, 'alex@example.test', 'identity from the session');
  assert.equal(appt.resource_id, ADVISOR);
  assert.equal(w.store.state.history.at(-1).event_type, 'seller_call_scheduled');
  assert.equal(w.store.state.inboxFlags.at(-1).threadKey, '+15555550101');
  assert.ok(w.sent.some((m) => m.kind === 'call_scheduled'));
  assert.equal(w.reminders.length, 1, 'only reminders still in the future are queued (the 24h one is already past)');
  const state = await getPortalState({ token }, w.deps);
  assert.equal(state.calls[0].id, booked.call.id);
  assert.ok(!(await listCallSlots({ token, reason: 'offer' }, w.deps)).slots.some((s) => s.start_at === first.slots[0].start_at), 'a booked time disappears');

  const moved = await rescheduleCall({ token, appointmentId: booked.call.id, startAt: first.slots[4].start_at }, w.deps);
  assert.equal(moved.call.start_at, first.slots[4].start_at);
  assert.ok((await listCallSlots({ token, reason: 'offer' }, w.deps)).slots.some((s) => s.start_at === first.slots[0].start_at), 'the old time returns');
  assert.ok(w.sent.some((m) => m.kind === 'call_rescheduled'));
  await cancelCall({ token, appointmentId: moved.call.id }, w.deps);
  assert.equal((await getPortalState({ token }, w.deps)).calls.length, 0);
  assert.ok((await listCallSlots({ token, reason: 'offer' }, w.deps)).slots.some((s) => s.start_at === first.slots[4].start_at), 'cancelled time is released');
  assert.ok(w.sent.some((m) => m.kind === 'call_cancelled'));
});

test('public booking: minimum contact data, linked to an opportunity only on a deterministic match', async () => {
  const w = world();
  const { slots } = await listCallSlots({ reason: 'property' }, w.deps);
  await assert.rejects(bookCall({ reason: 'property', startAt: slots[0].start_at, contact: { name: 'No Phone' } }, w.deps), (e) => e.code === 'invalid_contact');
  const linked = await bookCall({ reason: 'property', startAt: slots[0].start_at, contact: { name: 'Blair', phone: '555-555-0202', email: 'blair@example.test' } }, w.deps);
  assert.equal(linked.linked, true);
  const unlinked = await bookCall({ reason: 'property', startAt: slots[2].start_at, contact: { name: 'New Person', phone: '555-555-0303', email: 'new@example.test' } }, w.deps);
  assert.equal(unlinked.linked, false, 'no match → no guessed linkage');
});

test('no configured people means no invented availability', async () => {
  const w = world({ withAdvisor: false });
  const none = await listCallSlots({ reason: 'property' }, w.deps);
  assert.equal(none.available, false);
  assert.equal(none.slots.length, 0);
});

// ---------------------------------------------------------------------------
// Messages and lifecycle notifications
// ---------------------------------------------------------------------------

test('seller messages reach operations; a Prominent reply emails the seller once', async () => {
  const w = world();
  const token = await signIn(w, 'alex@example.test');
  await sendSellerMessage({ token, body: 'When do you need the keys?', idempotencyKey: 'k1' }, w.deps);
  await sendSellerMessage({ token, body: 'When do you need the keys?', idempotencyKey: 'k1' }, w.deps);
  assert.equal(w.store.state.messages.length, 1, 'idempotent');
  assert.equal(w.store.state.history.at(-1).event_type, 'seller_portal_message_received');
  const conversations = await w.store.listSellerConversations({ unreadOnly: true });
  assert.equal(conversations[0].unread, 1);
  await operatorReply({ opportunityId: OPP_A, operator: 'ops-user', body: 'At closing.' }, w.deps);
  const listed = await listSellerMessages({ token }, w.deps);
  assert.deepEqual(listed.messages.map((m) => m.author), ['seller', 'operator']);
  assert.equal(w.sent.filter((m) => m.kind === 'message').length, 1);
});

test('lifecycle notifications: only sellers with an account, once per event, never throwing', async () => {
  const w = world();
  const deps = { store: w.store, notify: async (m) => { w.sent.push(m); return { sent: true }; }, force: true };
  assert.equal((await emitSellerLifecycle({ kind: 'offer_ready', opportunityId: OPP_B, dedupeKey: 'offer_ready:o1' }, deps)).skipped, 'no_portal_account');
  await signIn(w, 'blair@example.test');
  assert.equal((await emitSellerLifecycle({ kind: 'offer_ready', opportunityId: OPP_B, dedupeKey: 'offer_ready:o1' }, deps)).sent, 1);
  assert.equal((await emitSellerLifecycle({ kind: 'offer_ready', opportunityId: OPP_B, dedupeKey: 'offer_ready:o1' }, deps)).sent, 0, 'a repeated canonical write does not email twice');
  assert.equal((await emitSellerLifecycle({ kind: 'offer_ready', opportunityId: OPP_B, dedupeKey: 'x' }, { ...deps, force: false, env: {} })).skipped, 'portal_disabled');
  const broken = await emitSellerLifecycle({ kind: 'closed', opportunityId: OPP_B, dedupeKey: 'closed:c' }, { ...deps, store: { listIdentitiesForOpportunity: async () => { throw new Error('db down'); } } });
  assert.equal(broken.ok, false, 'reports, does not throw');
});

test('offer ready fires from the canonical sent_at stamp', async () => {
  const events = [];
  const supabase = { from: () => ({ update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { opportunity_id: OPP_B, offer_version: 2 }, error: null }) }) }) }) }) };
  const r = await bindOfferToQueueRow({ offer_id: 'offer-9', send_queue_row_id: 'q1', supabase, sellerLifecycle: async (e) => events.push(e) });
  assert.equal(r.ok, true);
  assert.deepEqual(events, [{ kind: 'offer_ready', opportunityId: OPP_B, dedupeKey: 'offer_ready:offer-9' }]);
});

// ---------------------------------------------------------------------------
// Presentation contract
// ---------------------------------------------------------------------------

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

test('the internal route requires the shared secret in production and the portal flag', async () => {
  const request = (headers = {}) => new Request('http://local/api/internal/seller-portal/state', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  const prev = { SECRET: process.env.SELLER_PORTAL_INTERNAL_SECRET };
  process.env.SELLER_PORTAL_INTERNAL_SECRET = 'route-secret';
  try {
    const w = world();
    const denied = await handleSellerPortalRequest(request(), 'state', { env: { SELLER_PORTAL_ENABLED: '1' }, store: w.store, scheduling: w.deps.scheduling });
    assert.equal(denied.status, 401);
    const disabled = await handleSellerPortalRequest(request({ 'x-seller-portal-secret': 'route-secret' }), 'state', { env: {}, store: w.store, scheduling: w.deps.scheduling });
    assert.equal(disabled.status, 503);
    const unauth = await handleSellerPortalRequest(request({ 'x-seller-portal-secret': 'route-secret' }), 'state', { env: { ...ENV, SELLER_PORTAL_ENABLED: '1' }, store: w.store, scheduling: w.deps.scheduling });
    assert.equal(unauth.status, 401);
  } finally {
    process.env.SELLER_PORTAL_INTERNAL_SECRET = prev.SECRET;
  }
});

test('seller emails deep-link into the account and never ask the seller to call', () => {
  const paths = { call_scheduled: '/account/schedule/', call_rescheduled: '/account/schedule/', call_cancelled: '/account/schedule/', call_reminder: '/account/schedule/', offer_ready: '/account/offer/', message: '/account/messages/', document_ready: '/account/documents/', closing_scheduled: '/account/closing/', closing_changed: '/account/closing/', closed: '/account/closing/', action_needed: '/account/' };
  for (const [kind, path] of Object.entries(paths)) {
    const email = renderSellerEmail({ kind, context: { start_at: NOW.toISOString(), timezone: 'America/New_York', reason: 'My offer', label: 'Title commitment' } }, { SELLER_PORTAL_PUBLIC_BASE_URL: 'https://example.test' });
    assert.ok(email.html.includes(`https://example.test${path}"`), kind);
    assert.doesNotMatch(email.text, /call us|\(\d{3}\)\s?\d{3}-\d{4}/i);
    assert.doesNotMatch(email.html, /[?&](token|session|code)=/i, 'no sensitive state in links');
  }
});

test('every email renders with only its own context (no other template is evaluated)', () => {
  for (const kind of ['sign_in_code', 'action_needed', 'document_ready', 'message', 'offer_ready', 'closed']) {
    assert.ok(renderSellerEmail({ kind, context: { code: '123456', minutes: 15 } }, {}), kind);
  }
});

test('a failed notification can be retried; a sent one never repeats', async () => {
  const w = world();
  await signIn(w, 'blair@example.test');
  let fail = true;
  const deps = { store: w.store, force: true, notify: async () => (fail ? { sent: false, reason: 'brevo_timeout' } : { sent: true }) };
  assert.equal((await emitSellerLifecycle({ kind: 'closed', opportunityId: OPP_B, dedupeKey: 'closed:x' }, deps)).sent, 0);
  assert.equal(w.store.state.notifications[0].status, 'failed');
  fail = false;
  assert.equal((await emitSellerLifecycle({ kind: 'closed', opportunityId: OPP_B, dedupeKey: 'closed:x' }, deps)).sent, 1, 'retried after the failure');
  assert.equal((await emitSellerLifecycle({ kind: 'closed', opportunityId: OPP_B, dedupeKey: 'closed:x' }, deps)).sent, 0, 'never twice once sent');
});

test('public booking is throttled per network and per phone', async () => {
  const w = world();
  const { slots } = await listCallSlots({ reason: 'property' }, w.deps);
  for (let i = 0; i < SIGN_IN_LIMITS.publicBookingsPerPhoneDay; i++) {
    await bookCall({ reason: 'property', startAt: slots[i * 2].start_at, contact: { name: 'Same Phone', phone: '555-555-0444' }, ip: `10.1.0.${i}` }, w.deps);
  }
  await assert.rejects(bookCall({ reason: 'property', startAt: slots[10].start_at, contact: { name: 'Same Phone', phone: '555-555-0444' }, ip: '10.1.0.99' }, w.deps), (e) => e.code === 'too_many_requests' && e.status === 429);
  const w2 = world();
  const s2 = (await listCallSlots({ reason: 'property' }, w2.deps)).slots;
  for (let i = 0; i < SIGN_IN_LIMITS.publicBookingsPerIpHour; i++) {
    await bookCall({ reason: 'property', startAt: s2[i * 2].start_at, contact: { name: 'Bot', phone: `555-555-05${10 + i}` }, ip: '203.0.113.50' }, w2.deps);
  }
  await assert.rejects(bookCall({ reason: 'property', startAt: s2[12].start_at, contact: { name: 'Bot', phone: '555-555-0599' }, ip: '203.0.113.50' }, w2.deps), (e) => e.code === 'too_many_requests');
  assert.ok(w2.store.state.audits.some((a) => a.event === 'public_booking_throttled'));
});
