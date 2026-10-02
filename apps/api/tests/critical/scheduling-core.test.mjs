/**
 * Shared scheduling core — brand-agnostic availability, routing, atomic
 * booking, Google Calendar sync, reminders, time zones.
 *
 * All fixtures are synthetic. "Test Advisor (fixture)" is the single internal
 * person; two brands (Prominent and a generic second brand) share them.
 * Google is a faithful in-memory fake of the endpoints the core calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createInMemorySchedulingStore } from '@/lib/domain/scheduling/scheduling-store.js';
import { createSchedulingService, SchedulingError } from '@/lib/domain/scheduling/scheduling-service.js';
import { computeAvailability } from '@/lib/domain/scheduling/scheduling-availability.js';
import { planRouting, rankForSlot } from '@/lib/domain/scheduling/scheduling-routing.js';
import { wallTimeToInstant, zoneAbbreviation } from '@/lib/domain/scheduling/scheduling-time.js';
import { decryptSecret, encryptSecret } from '@/lib/domain/scheduling/scheduling-token-crypto.js';
import { revalidateSchedulingEmail } from '@/lib/domain/scheduling/scheduling-reminders.js';
import { createTestBrandAdapter, TEST_BRAND } from '@/lib/domain/scheduling/test-brand-adapter.js';
import { handleSchedulingClientRequest } from '@/app/api/internal/scheduling/[action]/route.js';

const NOW = new Date('2026-10-05T14:00:00.000Z'); // Monday 10:00 New York
const P = 'prominent_cash_offer';
const PERSON = 'aaaaaaaa-0000-4000-8000-000000000001';
const PERSON_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const KEYS = { k1: randomBytes(32).toString('base64') };
const ENV = { NODE_ENV: 'test', SCHEDULING_TOKEN_KEYS: JSON.stringify(KEYS), SCHEDULING_TOKEN_ACTIVE_KEY: 'k1' };
const WEEKDAYS = (from = '09:00', to = '17:00') => Object.fromEntries([1, 2, 3, 4, 5].map((d) => [String(d), [[from, to]]]));

const type = (brand, key, extra = {}) => ({ id: `${brand}:${key}`, brand_key: brand, type_key: key, name: key.replace(/_/g, ' '), duration_minutes: 30, slot_interval_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 0, min_notice_minutes: 60, horizon_days: 7, routing: { strategy: 'qualified_pool', pool: 'team' }, reminder_offsets_minutes: [1440, 60], environment: 'production', active: true, ...extra });

function fakeGoogle() {
  const events = new Map();
  const busy = [];
  const changes = [];
  let seq = 0;
  const g = {
    config: { configured: true }, events, busy, changes, calls: [],
    async accessToken(refresh) { g.calls.push('token'); if (refresh === 'revoked-refresh') throw Object.assign(new Error('x'), { code: 'google_invalid_grant' }); return 'access'; },
    async freeBusy(_t, { timeMin, timeMax }) {
      g.calls.push('freebusy');
      const ours = [...events.values()].filter((e) => e.status !== 'cancelled').map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }));
      return [...busy, ...ours].filter((b) => Date.parse(b.start) < Date.parse(timeMax) && Date.parse(b.end) > Date.parse(timeMin));
    },
    async insertEvent(_t, _c, body) { const id = `ev${++seq}`; events.set(id, { id, status: 'confirmed', ...structuredClone(body) }); g.calls.push('insert'); return { id }; },
    async patchEvent(_t, _c, id, body) { g.calls.push('patch'); const e = events.get(id); if (!e || e.status === 'cancelled') throw Object.assign(new Error('x'), { code: 'google_not_found' }); Object.assign(e, structuredClone(body)); return { id }; },
    async deleteEvent(_t, _c, id) { g.calls.push('delete'); const e = events.get(id); if (e) e.status = 'cancelled'; },
    async listEvents() { const items = changes.splice(0); return { items, nextSyncToken: `sync-${seq}` }; },
    async watch() { return { resourceId: 'res-1', expiration: String(NOW.getTime() + 7 * 86400e3) }; },
    async stopChannel() {},
    async revoke() {},
  };
  return g;
}

function world({ people = [PERSON], google = null, connected = [], extraTypes = [] } = {}) {
  const store = createInMemorySchedulingStore({
    eventTypes: [type(P, 'offer_review'), type(TEST_BRAND, 'onboarding', { environment: 'test', routing: { strategy: 'qualified_pool', pool: 'team' } }), ...extraTypes],
    resources: people.map((id, i) => ({ id, display_name: `Test Advisor ${i + 1} (fixture)`, timezone: 'America/New_York', weekly_hours: WEEKDAYS(), active: true, operator_keys: [`op-${i + 1}`] })),
    pools: [{ id: 'pool-p', brand_key: P, pool_key: 'team' }, { id: 'pool-t', brand_key: TEST_BRAND, pool_key: 'team' }],
    poolMembers: people.flatMap((id) => [{ pool_id: 'pool-p', resource_id: id, active: true }, { pool_id: 'pool-t', resource_id: id, active: true }]),
    connections: connected.map((rid, i) => ({ id: `conn-${i}`, resource_id: rid, provider: 'google', calendar_id: 'primary', status: 'connected', refresh_token_ciphertext: encryptSecret('refresh-token-value', ENV).ciphertext, busy_synced_at: NOW.toISOString() })),
  });
  const notified = [];
  const reminders = [];
  const adapters = new Map([
    [P, { brand_key: P, resolveOwner: async ({ refs }) => (refs.includes('opportunity:owned') ? 'op-2' : null), describe: ({ eventType }) => ({ summary: `Prominent · ${eventType.name}`, description: 'Seller: Test Seller' }), onChange: async (kind, { appointment }) => notified.push({ brand: P, kind, id: appointment.id }), reminder: () => ({ subject: 'r', html: '<p>r</p>', text: 'r' }) }],
    [TEST_BRAND, createTestBrandAdapter({ sent: notified })],
  ]);
  const service = createSchedulingService({ store, env: ENV, now: () => NOW, google: google ?? { config: { configured: false } }, adapters, enqueueEmail: async (row) => { reminders.push(row); return { ok: true }; } });
  return { store, service, notified, reminders };
}

// ---------------------------------------------------------------------------
// Time zones and DST
// ---------------------------------------------------------------------------

test('wall times across DST: the spring gap does not exist, the fall overlap resolves to its first instant', () => {
  assert.equal(wallTimeToInstant('2027-03-14', '02:30', 'America/New_York'), null);
  assert.equal(wallTimeToInstant('2027-03-14', '03:00', 'America/New_York').toISOString(), '2027-03-14T07:00:00.000Z');
  assert.equal(wallTimeToInstant('2026-11-01', '01:30', 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(wallTimeToInstant('2026-10-25', '09:00', 'America/New_York').toISOString(), '2026-10-25T13:00:00.000Z');
  assert.equal(wallTimeToInstant('2026-11-01', '09:00', 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z');
  assert.equal(wallTimeToInstant('2026-10-25', '09:00', 'Europe/London').toISOString(), '2026-10-25T09:00:00.000Z');
});

test('working hours keep their local meaning across both DST transitions', () => {
  const resource = { id: 'r', timezone: 'America/New_York', weekly_hours: { 7: [['09:00', '10:00']] } };
  const et = { duration_minutes: 30, slot_interval_minutes: 30, min_notice_minutes: 0, horizon_days: 30 };
  const fall = computeAvailability({ eventType: et, resources: [resource], now: '2026-10-24T00:00:00Z', from: '2026-10-24T00:00:00Z', to: '2026-11-02T00:00:00Z' }).map((s) => s.start_at);
  assert.deepEqual(fall, ['2026-10-25T13:00:00.000Z', '2026-10-25T13:30:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-01T14:30:00.000Z'], '9:00 EDT then 9:00 EST');
  const spring = computeAvailability({ eventType: et, resources: [resource], now: '2027-03-06T00:00:00Z', from: '2027-03-06T00:00:00Z', to: '2027-03-15T00:00:00Z' }).map((s) => s.start_at);
  assert.deepEqual(spring, ['2027-03-07T14:00:00.000Z', '2027-03-07T14:30:00.000Z', '2027-03-14T13:00:00.000Z', '2027-03-14T13:30:00.000Z'], '9:00 EST then 9:00 EDT');
  // Hours straddling the spring-forward gap: 01:00–04:00 local holds 2 real hours.
  const night = { id: 'n', timezone: 'America/New_York', weekly_hours: { 7: [['01:00', '04:00']] } };
  const gap = computeAvailability({ eventType: et, resources: [night], now: '2027-03-13T00:00:00Z', from: '2027-03-14T00:00:00Z', to: '2027-03-15T00:00:00Z' }).map((s) => s.start_at);
  assert.deepEqual(gap, ['2027-03-14T06:00:00.000Z', '2027-03-14T06:30:00.000Z', '2027-03-14T07:00:00.000Z', '2027-03-14T07:30:00.000Z']);
  assert.equal(zoneAbbreviation('2026-11-01T14:00:00Z', 'America/New_York'), 'EST');
  assert.equal(zoneAbbreviation('2026-10-25T13:00:00Z', 'America/New_York'), 'EDT');
});

test('slots are labelled in the customer’s zone; the instant never changes', async () => {
  const { service } = world();
  const ny = await service.getAvailability({ brand: P, typeKey: 'offer_review', timezone: 'America/New_York' });
  const la = await service.getAvailability({ brand: P, typeKey: 'offer_review', timezone: 'America/Los_Angeles' });
  assert.equal(ny.slots[0].start_at, la.slots[0].start_at);
  assert.equal(ny.slots[0].zone, 'EDT');
  assert.equal(la.slots[0].zone, 'PDT');
});

// ---------------------------------------------------------------------------
// Availability rules
// ---------------------------------------------------------------------------

test('a slot exists only when every rule allows it', () => {
  const r = { id: 'r', timezone: 'America/New_York', weekly_hours: WEEKDAYS('09:00', '12:00') };
  const et = { duration_minutes: 30, slot_interval_minutes: 30, buffer_before_minutes: 15, buffer_after_minutes: 15, min_notice_minutes: 60, horizon_days: 1 };
  const busy = { r: [{ start: '2026-10-05T15:30:00Z', end: '2026-10-05T15:45:00Z' }] }; // 11:30–11:45 local
  const slots = computeAvailability({ eventType: et, resources: [r], busy, now: NOW, from: NOW, to: '2026-10-06T00:00:00Z' }).map((s) => s.start_at);
  // Now 10:00; notice → 11:00 earliest. 11:00 block [10:45,11:45) hits busy; 11:30 overlaps busy.
  assert.deepEqual(slots, []);
  const free = computeAvailability({ eventType: { ...et, buffer_before_minutes: 0, buffer_after_minutes: 0 }, resources: [r], busy: {}, now: NOW, from: NOW, to: '2026-10-06T00:00:00Z' }).map((s) => s.start_at);
  assert.deepEqual(free, ['2026-10-05T15:00:00.000Z', '2026-10-05T15:30:00.000Z'], 'the meeting must end within working hours');
  const horizon = computeAvailability({ eventType: { ...et, buffer_before_minutes: 0, buffer_after_minutes: 0, horizon_days: 1 }, resources: [r], now: NOW, from: NOW, to: '2026-10-20T00:00:00Z' });
  assert.ok(horizon.every((s) => Date.parse(s.start_at) <= NOW.getTime() + 86400e3), 'horizon');
});

test('time off and connected-calendar busy both remove time', async () => {
  const { service, store } = world();
  const before = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  const first = before.slots[0];
  store.state.timeOff.push({ resource_id: PERSON, start_at: first.start_at, end_at: first.end_at });
  const afterPto = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  assert.ok(!afterPto.slots.some((s) => s.start_at === first.start_at));
  store.state.externalBusy.push({ connection_id: 'c', resource_id: PERSON, external_event_id: 'x', start_at: before.slots[1].start_at, end_at: before.slots[1].end_at });
  const afterBusy = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  assert.ok(!afterBusy.slots.some((s) => s.start_at === before.slots[1].start_at));
});

test('the public slot response reveals times only', async () => {
  const { service, store } = world();
  store.state.externalBusy.push({ connection_id: 'c', resource_id: PERSON, external_event_id: 'secret-event', start_at: '2026-10-06T14:00:00Z', end_at: '2026-10-06T15:00:00Z' });
  const res = await service.getAvailability({ brand: P, typeKey: 'offer_review', timezone: 'America/New_York' });
  const text = JSON.stringify(res);
  assert.doesNotMatch(text, /secret-event|Test Advisor|aaaaaaaa|resource|calendar/i);
  assert.deepEqual(Object.keys(res.slots[0]).sort(), ['end_at', 'start_at', 'zone']);
});

test('test-environment appointment types are refused in production', async () => {
  const { store } = world();
  const prod = createSchedulingService({ store, env: { NODE_ENV: 'production' }, now: () => NOW, google: { config: {} }, adapters: new Map() });
  await assert.rejects(prod.getAvailability({ brand: TEST_BRAND, typeKey: 'onboarding' }), (e) => e.code === 'event_type_not_found');
});

// ---------------------------------------------------------------------------
// One availability truth across brands
// ---------------------------------------------------------------------------

test('cross-brand: a Prominent booking removes that time from the second brand, and Google busy blocks both', async () => {
  const google = fakeGoogle();
  const { service } = world({ google, connected: [PERSON] });
  const p0 = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  const t0 = await service.getAvailability({ brand: TEST_BRAND, typeKey: 'onboarding' });
  assert.deepEqual(p0.slots.map((s) => s.start_at), t0.slots.map((s) => s.start_at), 'one person, one truth');

  // Busy created directly in Google, seen through the booking-time freeBusy check and the mirror.
  google.busy.push({ start: p0.slots[2].start_at, end: p0.slots[2].end_at });
  await assert.rejects(service.bookAppointment({ brand: TEST_BRAND, typeKey: 'onboarding', startAt: p0.slots[2].start_at, customer: { name: 'T' }, source: 'test' }), (e) => e.code === 'slot_unavailable');
  await assert.rejects(service.bookAppointment({ brand: P, typeKey: 'offer_review', startAt: p0.slots[2].start_at, customer: { name: 'T' }, source: 'test' }), (e) => e.code === 'slot_unavailable');

  const booked = await service.bookAppointment({ brand: P, typeKey: 'offer_review', startAt: p0.slots[0].start_at, refs: ['opportunity:x'], customer: { name: 'Test Seller', email: 'seller@example.test' }, source: 'test' });
  assert.equal(booked.appointment.status, 'scheduled');
  const t1 = await service.getAvailability({ brand: TEST_BRAND, typeKey: 'onboarding' });
  assert.ok(!t1.slots.some((s) => s.start_at === p0.slots[0].start_at), 'the second brand no longer offers it');
  await assert.rejects(service.bookAppointment({ brand: TEST_BRAND, typeKey: 'onboarding', startAt: p0.slots[0].start_at, customer: { name: 'T' }, source: 'test' }), (e) => e.code === 'slot_unavailable');
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('concurrency: two sessions race for the last slot — exactly one wins, the other gets a clean refusal with fresh times', async () => {
  const lastSlot = type(P, 'last_slot', { min_notice_minutes: 0, horizon_days: 1 });
  const { service, store } = world({ extraTypes: [lastSlot] });
  store.state.resources[0].weekly_hours = { 1: [['16:00', '16:30']] }; // one 30-minute slot today
  const avail = await service.getAvailability({ brand: P, typeKey: 'last_slot' });
  assert.equal(avail.slots.length, 1);
  const attempt = (n) => service.bookAppointment({ brand: P, typeKey: 'last_slot', startAt: avail.slots[0].start_at, customer: { name: `Session ${n}` }, source: 'race' });
  const results = await Promise.allSettled([attempt(1), attempt(2)]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, 'slot_unavailable');
  assert.equal(lost[0].reason.status, 409);
  assert.deepEqual(lost[0].reason.slots, [], 'refreshed availability no longer contains the slot');
  assert.equal(store.state.appointments.filter((a) => a.status === 'scheduled').length, 1);
  // Every brand sharing the person loses it.
  assert.equal((await service.getAvailability({ brand: TEST_BRAND, typeKey: 'onboarding', from: avail.slots[0].start_at, to: avail.slots[0].end_at })).slots.length, 0);
});

test('concurrency at scale: 25 parallel bookings across two brands never double-book a person', async () => {
  const { service, store } = world({ people: [PERSON, PERSON_2] });
  const avail = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  const target = avail.slots[0].start_at;
  const attempts = Array.from({ length: 25 }, (_, i) => (i % 2
    ? service.bookAppointment({ brand: TEST_BRAND, typeKey: 'onboarding', startAt: target, customer: { name: `t${i}` }, source: 'race' })
    : service.bookAppointment({ brand: P, typeKey: 'offer_review', startAt: target, customer: { name: `p${i}` }, source: 'race' })));
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, 'two people, two bookings');
  const live = store.state.appointments.filter((a) => a.status === 'scheduled');
  assert.deepEqual(live.map((a) => a.resource_id).sort(), [PERSON, PERSON_2].sort());
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'slot_unavailable'));
});

test('idempotent booking: a retried request returns the same appointment', async () => {
  const { service, store } = world();
  const { slots } = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  const a = await service.bookAppointment({ brand: P, typeKey: 'offer_review', startAt: slots[0].start_at, customer: { name: 'x' }, source: 't', idempotencyKey: 'req-1' });
  const b = await service.bookAppointment({ brand: P, typeKey: 'offer_review', startAt: slots[0].start_at, customer: { name: 'x' }, source: 't', idempotencyKey: 'req-1' });
  assert.equal(a.appointment.id, b.appointment.id);
  assert.equal(b.duplicate, true);
  assert.equal(store.state.appointments.length, 1);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('routing: owner first, pool when the owner is busy, round robin, fallback, and nothing invented', async () => {
  // specific owner, owner_unavailable=route_to_pool
  const ownerType = type(P, 'owner_review', { routing: { strategy: 'specific_owner', owner: 'opportunity_owner', owner_unavailable: 'route_to_pool', pool: 'team' } });
  const strict = type(P, 'owner_only', { routing: { strategy: 'specific_owner', owner: 'opportunity_owner', owner_unavailable: 'next_available_owner' } });
  const { service, store } = world({ people: [PERSON, PERSON_2], extraTypes: [ownerType, strict] });
  const slots = (await service.getAvailability({ brand: P, typeKey: 'owner_review', refs: ['opportunity:owned'] })).slots;
  const first = await service.bookAppointment({ brand: P, typeKey: 'owner_review', startAt: slots[0].start_at, refs: ['opportunity:owned'], customer: { name: 'a' }, source: 't' });
  assert.equal(store.state.appointments.find((a) => a.id === first.appointment.id).resource_id, PERSON_2, 'the opportunity owner (op-2) takes it');
  const second = await service.bookAppointment({ brand: P, typeKey: 'owner_review', startAt: slots[0].start_at, refs: ['opportunity:owned'], customer: { name: 'b' }, source: 't' });
  assert.equal(store.state.appointments.find((a) => a.id === second.appointment.id).resource_id, PERSON, 'owner busy → routed to the pool');
  // next_available_owner: only the owner's own free times are offered.
  const ownerOnly = await service.getAvailability({ brand: P, typeKey: 'owner_only', refs: ['opportunity:owned'] });
  assert.ok(!ownerOnly.slots.some((s) => s.start_at === slots[0].start_at), 'owner busy then → that time is not offered');
  // No owner resolvable and no pool → no availability (no fabricated assignment).
  assert.equal((await service.getAvailability({ brand: P, typeKey: 'owner_only', refs: ['opportunity:unowned'] })).slots.length, 0);

  const plan = planRouting({ routing: { strategy: 'round_robin', pool: 'a', fallback_pool: 'b' }, pools: { a: ['x', 'y'], b: ['z'] } });
  assert.deepEqual(plan.tiers.map((t) => t.via), ['round_robin', 'fallback_pool']);
  assert.deepEqual(rankForSlot({ strategy: 'round_robin', via: 'round_robin', freeIds: ['x', 'y'], stats: { x: { lastAssignedAt: 200 }, y: { lastAssignedAt: 100 } } }), ['y', 'x'], 'least recently assigned first');
  assert.deepEqual(rankForSlot({ strategy: 'qualified_pool', via: 'qualified_pool', freeIds: ['x', 'y'], stats: { x: { upcoming: 1 }, y: { upcoming: 4 } } }), ['x', 'y'], 'least loaded first');
});

test('fallback pool is used only when the primary pool has no time', async () => {
  const fb = type(P, 'with_fallback', { routing: { strategy: 'qualified_pool', pool: 'empty_pool', fallback_pool: 'team' } });
  const { service } = world({ extraTypes: [fb] });
  const res = await service.getAvailability({ brand: P, typeKey: 'with_fallback' });
  assert.ok(res.slots.length > 0);
});

// ---------------------------------------------------------------------------
// Google Calendar: create, move, cancel, drift, webhook, reconciliation
// ---------------------------------------------------------------------------

test('Google: booking creates the event, reschedule moves it, cancel removes it; slots return each time', async () => {
  const google = fakeGoogle();
  const { service, store } = world({ google, connected: [PERSON] });
  const { slots } = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  const { appointment } = await service.bookAppointment({ brand: P, typeKey: 'offer_review', startAt: slots[0].start_at, refs: ['opportunity:x'], customer: { name: 'Test Seller', email: 'seller@example.test', phone: '+15555550100' }, source: 't' });
  const row = await store.getAppointment(appointment.id);
  assert.equal(row.sync_status, 'synced');
  const event = google.events.get(row.google_event_id);
  assert.equal(event.summary, 'Prominent · offer review');
  assert.equal(event.visibility, 'private');
  assert.equal(event.start.dateTime, slots[0].start_at);
  assert.equal(event.extendedProperties.private.scheduling_appointment_id, appointment.id);
  assert.doesNotMatch(JSON.stringify(event), /5555550100|seller@example/, 'no customer phone or email on the calendar');

  const moved = await service.rescheduleAppointment({ appointmentId: appointment.id, startAt: slots[3].start_at, actor: 't' });
  const movedRow = await store.getAppointment(moved.appointment.id);
  assert.equal(movedRow.google_event_id, row.google_event_id, 'the same Google event moves');
  assert.equal(google.events.get(row.google_event_id).start.dateTime, slots[3].start_at);
  assert.equal((await store.getAppointment(appointment.id)).status, 'rescheduled');
  assert.ok((await service.getAvailability({ brand: P, typeKey: 'offer_review' })).slots.some((s) => s.start_at === slots[0].start_at), 'old time returns');

  await service.cancelAppointment({ appointmentId: moved.appointment.id, actor: 't' });
  assert.equal(google.events.get(row.google_event_id).status, 'cancelled', 'cancellation removes the Google event');
  assert.equal((await store.getAppointment(moved.appointment.id)).sync_status, 'synced');
  assert.ok((await service.getAvailability({ brand: P, typeKey: 'offer_review' })).slots.some((s) => s.start_at === slots[3].start_at), 'released');
});

test('Google → us: other events become busy times only; edits to our events are flagged, never applied', async () => {
  const google = fakeGoogle();
  const { service, store } = world({ google, connected: [PERSON] });
  const { slots } = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  const { appointment } = await service.bookAppointment({ brand: P, typeKey: 'offer_review', startAt: slots[0].start_at, customer: { name: 's' }, source: 't' });
  const evId = (await store.getAppointment(appointment.id)).google_event_id;
  google.changes.push(
    { id: 'dentist', status: 'confirmed', start: { dateTime: slots[5].start_at }, end: { dateTime: slots[5].end_at } },
    { id: 'lunch-free', status: 'confirmed', transparency: 'transparent', start: { dateTime: slots[6].start_at }, end: { dateTime: slots[6].end_at } },
    { id: evId, status: 'confirmed', start: { dateTime: slots[1].start_at }, end: { dateTime: slots[1].end_at }, extendedProperties: { private: { scheduling_appointment_id: appointment.id } } },
  );
  const result = await service.syncConnectionBusy(store.state.connections[0]);
  assert.equal(result.ok, true);
  assert.deepEqual(store.state.externalBusy.map((b) => Object.keys(b).sort()), [['connection_id', 'end_at', 'external_event_id', 'resource_id', 'start_at', 'updated_at']], 'times only, no titles');
  assert.equal(store.state.externalBusy[0].external_event_id, 'dentist');
  const after = await store.getAppointment(appointment.id);
  assert.equal(after.start_at, slots[0].start_at, 'a move in Google does not move the customer’s appointment');
  assert.equal(after.sync_status, 'drift');
  assert.ok((await store.listEvents(appointment.id)).some((e) => e.event === 'drift_detected'));
  assert.equal((await service.listForOps({ view: 'needs_assignment' })).appointments.length, 1, 'drift surfaces for a person to resolve');
});

test('Google: orphaned events we created are removed; expired access is reported, not hidden', async () => {
  const google = fakeGoogle();
  const { service, store } = world({ google, connected: [PERSON] });
  google.events.set('orphan', { id: 'orphan', status: 'confirmed' });
  google.changes.push({ id: 'orphan', status: 'confirmed', start: { dateTime: '2026-10-06T14:00:00Z' }, end: { dateTime: '2026-10-06T14:30:00Z' }, extendedProperties: { private: { scheduling_appointment_id: '00000000-0000-4000-8000-000000000000' } } });
  const r = await service.syncConnectionBusy(store.state.connections[0]);
  assert.equal(r.orphans, 1);
  assert.equal(google.events.get('orphan').status, 'cancelled');
  store.state.connections[0].refresh_token_ciphertext = encryptSecret('revoked-refresh', ENV).ciphertext;
  const failed = await service.syncConnectionBusy(store.state.connections[0]);
  assert.equal(failed.ok, false);
  assert.equal(store.state.connections[0].status, 'needs_reauth');
  assert.equal(service.presentConnection(store.state.connections[0]).health, 'needs_reauth');
});

test('Google failure never loses a booking; reconciliation repairs it', async () => {
  const google = fakeGoogle();
  const { service, store } = world({ google, connected: [PERSON] });
  const realInsert = google.insertEvent;
  google.insertEvent = async () => { throw Object.assign(new Error('x'), { code: 'google_unreachable' }); };
  const { slots } = await service.getAvailability({ brand: P, typeKey: 'offer_review' });
  const { appointment } = await service.bookAppointment({ brand: P, typeKey: 'offer_review', startAt: slots[0].start_at, customer: { name: 's' }, source: 't' });
  assert.equal((await store.getAppointment(appointment.id)).sync_status, 'failed');
  google.insertEvent = realInsert;
  const summary = await service.reconcile();
  assert.equal(summary.appointments_resynced, 1);
  assert.equal((await store.getAppointment(appointment.id)).sync_status, 'synced');
});

test('webhook: only our channel with its secret token triggers a sync', async () => {
  const google = fakeGoogle();
  const { service, store } = world({ google, connected: [PERSON] });
  const token = 'channel-secret-token';
  store.state.connections[0].watch_channel_id = 'ch-1';
  store.state.connections[0].watch_token_hash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  assert.equal((await service.handleGoogleNotification({ 'x-goog-channel-id': 'ch-1', 'x-goog-channel-token': 'wrong', 'x-goog-resource-state': 'exists' })).status, 404);
  assert.equal((await service.handleGoogleNotification({ 'x-goog-channel-id': 'nope', 'x-goog-channel-token': token })).status, 404);
  const ok = await service.handleGoogleNotification({ 'x-goog-channel-id': 'ch-1', 'x-goog-channel-token': token, 'x-goog-resource-state': 'exists' });
  assert.equal(ok.status, 200);
  assert.equal(ok.result.ok, true);
});

// ---------------------------------------------------------------------------
// OAuth and credentials
// ---------------------------------------------------------------------------

test('OAuth: a person connects only their own calendar; state is single-use; tokens are encrypted at rest', async () => {
  const google = { ...fakeGoogle(), authorizationUrl: ({ state }) => `https://accounts.example/auth?state=${state}`, exchangeCode: async () => ({ accessToken: 'a', refreshToken: 'the-refresh-token', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'], email: 'advisor@example.test' }) };
  const { service, store } = world({ google });
  store.state.resources[0].ops_user_id = 'user-1';
  await assert.rejects(service.startGoogleConnect({ opsUserId: 'user-2', resourceId: PERSON }), (e) => e.code === 'forbidden');
  const { url } = await service.startGoogleConnect({ opsUserId: 'user-1' });
  const state = new URL(url).searchParams.get('state');
  const done = await service.completeGoogleConnect({ state, code: 'auth-code' });
  assert.equal(done.connection.status, 'connected');
  assert.doesNotMatch(JSON.stringify(done), /the-refresh-token/);
  const conn = store.state.connections[0];
  assert.doesNotMatch(conn.refresh_token_ciphertext, /the-refresh-token/);
  assert.equal(decryptSecret(conn.refresh_token_ciphertext, ENV), 'the-refresh-token');
  await assert.rejects(service.completeGoogleConnect({ state, code: 'auth-code' }), (e) => e.code === 'oauth_state_invalid', 'replay refused');
  assert.ok(store.state.oauthStates.every((s) => s.state_hash !== state), 'state stored only as a hash');
  await service.disconnectGoogle({ resourceId: PERSON, opsUserId: 'user-1' });
  assert.equal(store.state.connections[0].refresh_token_ciphertext, null, 'disconnect destroys the credential');
  assert.equal(store.state.connections[0].status, 'disconnected');
});

test('token encryption: authenticated, key-rotatable, tamper-evident', () => {
  const env2 = { SCHEDULING_TOKEN_KEYS: JSON.stringify({ ...KEYS, k2: randomBytes(32).toString('base64') }), SCHEDULING_TOKEN_ACTIVE_KEY: 'k2' };
  const old = encryptSecret('secret-a', ENV);
  const fresh = encryptSecret('secret-b', env2);
  assert.equal(decryptSecret(old.ciphertext, env2), 'secret-a', 'old key still decrypts after rotation');
  assert.equal(fresh.keyId, 'k2');
  const parts = fresh.ciphertext.split('.');
  parts[4] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), env2), (e) => e.code === 'token_decrypt_failed');
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

test('reminders: queued centrally, dropped automatically if the appointment moves or is cancelled', async () => {
  const later = type(P, 'later', { min_notice_minutes: 48 * 60, horizon_days: 7 });
  const { service, reminders, store } = world({ extraTypes: [later] });
  const { slots } = await service.getAvailability({ brand: P, typeKey: 'later' });
  const { appointment } = await service.bookAppointment({ brand: P, typeKey: 'later', startAt: slots[0].start_at, customer: { name: 's', email: 'seller@example.test' }, source: 't' });
  assert.deepEqual(reminders.map((r) => r.action_key).sort(), ['scheduling.reminder.1440', 'scheduling.reminder.60']);
  assert.ok(reminders.every((r) => r.source === 'scheduling' && r.brand_key === P && r.metadata.appointment_id === appointment.id));
  const fakeDb = { from: () => ({ select: () => ({ eq: (_c, id) => ({ maybeSingle: async () => ({ data: store.state.appointments.find((a) => a.id === id) ?? null, error: null }) }) }) }) };
  assert.equal((await revalidateSchedulingEmail(fakeDb, reminders[0])).state, 'still_needed');
  await service.rescheduleAppointment({ appointmentId: appointment.id, startAt: slots[2].start_at, actor: 't' });
  assert.equal((await revalidateSchedulingEmail(fakeDb, reminders[0])).state, 'cancelled', 'old reminder dropped on reschedule');
});

// ---------------------------------------------------------------------------
// Client API (brand isolation)
// ---------------------------------------------------------------------------

test('client API: each brand authenticates separately and can never touch another brand’s appointment', async () => {
  const { service } = world();
  const secrets = { [P]: 'p'.repeat(40), [TEST_BRAND]: 't'.repeat(40) };
  const env = { SCHEDULING_CLIENT_SECRETS: JSON.stringify(secrets) };
  const call = (brand, secret, action, body) => handleSchedulingClientRequest(new Request(`http://local/api/internal/scheduling/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-scheduling-client': brand, 'x-scheduling-secret': secret }, body: JSON.stringify(body) }), action, { env, service });
  assert.equal((await call(P, 'wrong', 'availability', { event_type: 'offer_review' })).status, 401);
  const avail = await (await call(P, secrets[P], 'availability', { event_type: 'offer_review' })).json();
  const booked = await (await call(P, secrets[P], 'book', { event_type: 'offer_review', start_at: avail.slots[0].start_at, customer: { name: 'x' } })).json();
  assert.equal(booked.ok, true);
  const cross = await call(TEST_BRAND, secrets[TEST_BRAND], 'cancel', { appointment_id: booked.appointment.id });
  assert.equal(cross.status, 404);
  const stale = await call(P, secrets[P], 'book', { event_type: 'offer_review', start_at: avail.slots[0].start_at, customer: { name: 'y' } });
  assert.equal(stale.status, 409);
  assert.ok(Array.isArray((await stale.json()).slots), 'refreshed availability returned with the refusal');
});
