import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeNonActionable,
  evaluateDueSoon,
  evaluateOverdue,
  isActionableEvent,
} from '../../src/lib/domain/calendar/calendar-overdue.js';
import { describeLayerAvailability } from '../../src/lib/domain/calendar/calendar-taxonomy.js';
import { createEntityResolver } from '../../src/lib/domain/calendar/calendar-entity-resolver.js';
import { CALENDAR_EVENT_SOURCE_INVENTORY, fetchCalendarNexusEvents } from '../../src/lib/domain/calendar/calendar-nexus-service.js';

test('historical SMS sent is not incorrectly overdue', () => {
  const result = evaluateOverdue({
    event_type: 'sms_sent',
    status: 'sent',
    timestamp: '2026-04-18T15:00:00.000Z',
  });
  assert.equal(result.overdue, false);
  assert.ok(['historical', 'completed'].includes(result.risk_state));
});

test('queued scheduled send past due is overdue', () => {
  const result = evaluateOverdue({
    event_type: 'scheduled_sms',
    status: 'scheduled',
    timestamp: '2020-01-01T09:00:00.000Z',
  });
  assert.equal(result.overdue, true);
  assert.equal(result.risk_state, 'overdue');
});

test('workflow wait past due is overdue when still waiting', () => {
  const result = evaluateOverdue({
    event_type: 'workflow_wake',
    status: 'waiting',
    timestamp: '2020-01-01T09:00:00.000Z',
  });
  assert.equal(result.overdue, true);
});

test('entity resolver prefers opportunity and thread keys', () => {
  const resolver = createEntityResolver();
  resolver.ingestOpportunity({
    id: 'opp-1',
    primary_thread_key: 'thread-abc',
    master_owner_id: 'owner-1',
    primary_property_id: 'prop-1',
    seller_display_name: 'Jane Seller',
    property_address_full: '123 Main St',
    market: 'Dallas',
  });

  const resolved = resolver.resolve({
    thread_key: 'thread-abc',
    source_domain: 'queue',
  });

  assert.equal(resolved.sellerName, 'Jane Seller');
  assert.equal(resolved.propertyAddress, '123 Main St');
  assert.equal(resolved.market, 'Dallas');
  assert.equal(resolved.resolutionSource, 'thread_key');
});

test('unresolved queue recipient fallback label', () => {
  const resolver = createEntityResolver();
  const resolved = resolver.resolve({ source_domain: 'queue' });
  assert.equal(resolved.sellerName, 'Unresolved queue recipient');
});

test('canonical event source inventory is documented', () => {
  assert.ok(CALENDAR_EVENT_SOURCE_INVENTORY.messaging_and_queue.length > 0);
  assert.ok(CALENDAR_EVENT_SOURCE_INVENTORY.workflow_studio.length > 0);
  assert.ok(CALENDAR_EVENT_SOURCE_INVENTORY.manual.length > 0);
});

test('fetchCalendarNexusEvents returns unified contract shape with mock client', async () => {
  const now = new Date();
  const startIso = new Date(now.getTime() - 86400000).toISOString();
  const endIso = new Date(now.getTime() + 86400000 * 30).toISOString();

  const payloads = {
    send_queue: [{
      id: 'q1',
      queue_status: 'scheduled',
      scheduled_for: now.toISOString(),
      thread_key: 'thread-1',
      master_owner_id: 'owner-1',
      property_id: 'prop-1',
      message_body: 'Hello',
    }],
    message_events: [],
    workflow_enrollments: [],
    workflow_scheduled_tasks: [],
    acquisition_opportunities: [{
      id: 'opp-1',
      primary_thread_key: 'thread-1',
      master_owner_id: 'owner-1',
      primary_property_id: 'prop-1',
      seller_display_name: 'Jane Seller',
      property_address_full: '123 Main St',
      market: 'Dallas',
      next_action_due: null,
    }],
    offers: [],
    contracts: [],
    closings: [],
    title_routing_closing_engine: [],
    buyer_match: [],
    campaigns: [],
    calendar_manual_events: [],
  };

  const mockClient = {
    from(table) {
      const response = { data: payloads[table] || [], error: null };
      const chain = {
        select() { return chain; },
        gte() { return chain; },
        lte() { return chain; },
        or() { return chain; },
        limit() { return chain; },
        // The real Supabase client supports .in(); the mock must model it or
        // it stops being a faithful stand-in. Identity enrichment uses it.
        in() { return Promise.resolve(response); },
        then(onFulfilled, onRejected) { return Promise.resolve(response).then(onFulfilled, onRejected); },
      };
      return chain;
    },
  };

  const result = await fetchCalendarNexusEvents({ start_date: startIso, end_date: endIso }, { supabase: mockClient });
  assert.equal(result.ok, true);
  assert.ok(result.events.length >= 1);
  const event = result.events[0];
  assert.ok(event.event_id);
  assert.ok(event.start_timestamp);
  assert.ok(event.source_table);
  assert.equal(event.seller_name, 'Jane Seller');
  assert.equal(result.reconciliation.total_events, result.events.length);
});

// ───────────────────────────── §14/§37 held work must not read as live work

/**
 * THE DEFECT. evaluateOverdue() returns early with risk_state 'on_track' for
 * anything scheduled ahead of now, BEFORE looking at status, and
 * evaluateDueSoon() looked only at the timestamp. So a SUPPRESSED opportunity
 * with a future next_action_due came back on_track and due_soon: true, reading
 * to the operator as live executable work. 28 suppressed and 1 dead
 * opportunity carry due dates in production (2026-09-16).
 */
test('a suppressed record is not actionable even when scheduled in the future', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const event = { event_type: 'pipeline_next_action', status: 'suppressed', start_timestamp: future };
  assert.equal(isActionableEvent(event), false);
  assert.equal(evaluateDueSoon(event), false, 'held work is never "due soon"');
  assert.equal(describeNonActionable(event), 'suppressed', 'the reason is stated');
});

test('a dead opportunity is not actionable', () => {
  const event = { event_type: 'pipeline_next_action', status: 'dead', start_timestamp: new Date(Date.now() + 3600000).toISOString() };
  assert.equal(isActionableEvent(event), false);
  assert.equal(describeNonActionable(event), 'closed');
});

test('a cancelled scheduled send is neither actionable nor due soon', () => {
  const event = { event_type: 'scheduled_sms', status: 'cancelled', start_timestamp: new Date(Date.now() + 600000).toISOString() };
  assert.equal(isActionableEvent(event), false);
  assert.equal(evaluateDueSoon(event), false);
  assert.equal(evaluateOverdue(event).overdue, false);
});

test('genuinely pending work IS actionable and can be due soon', () => {
  const event = { event_type: 'scheduled_sms', status: 'scheduled', start_timestamp: new Date(Date.now() + 3600000).toISOString() };
  assert.equal(isActionableEvent(event), true);
  assert.equal(evaluateDueSoon(event), true);
  assert.equal(describeNonActionable(event), null);
});

/**
 * §13 — Not Interested is a seller DISPOSITION, not a record status, and may
 * carry real future reactivation work. Actionability must not be inferred from
 * it. Production carries S1_NOT_INTERESTED_NURTURE_30D follow-ups.
 */
test('Not Interested is not treated as non-actionable', () => {
  const event = {
    event_type: 'pipeline_next_action',
    status: 'active',
    start_timestamp: new Date(Date.now() + 86400000).toISOString(),
    metadata: { negotiation_state: { seller_sentiment: 'not_interested' }, last_reasoning_code: 'S1_NOT_INTERESTED_NURTURE_30D' },
  };
  assert.equal(isActionableEvent(event), true, 'Not Interested is a disposition, not DNC');
});

test('a historical send is not actionable work', () => {
  for (const type of ['sms_sent', 'sms_delivered', 'inbound_reply', 'dnc_suppression']) {
    assert.equal(isActionableEvent({ event_type: type, status: 'sent' }), false, type);
  }
});

// ───────────────────────────────────── §28 no filter without an authority

/**
 * safeSelect returned [] for BOTH "table absent" and "no rows", so the UI
 * could not tell a dead authority from an empty one and offered Offers /
 * Contracts / Closings / Buyers / Appointments filters that can never match.
 * Six of the twelve sources are absent in production.
 */
test('a layer whose source tables are absent is reported unavailable', () => {
  const availability = {
    send_queue: { state: 'available' },
    message_events: { state: 'available' },
    acquisition_opportunities: { state: 'available' },
    workflow_enrollments: { state: 'available' },
    workflow_scheduled_tasks: { state: 'available' },
    campaigns: { state: 'available' },
    offers: { state: 'absent' },
    contracts: { state: 'absent' },
    closings: { state: 'absent' },
    title_routing_closing_engine: { state: 'absent' },
    buyer_match: { state: 'absent' },
    calendar_manual_events: { state: 'absent' },
  };
  const layers = describeLayerAvailability(availability);
  assert.equal(layers.sms.available, true);
  assert.equal(layers.follow_ups.available, true);
  assert.equal(layers.workflow.available, true);
  assert.equal(layers.offers.available, false);
  assert.equal(layers.offers.reason, 'tables_absent');
  assert.equal(layers.manual_events.available, false, 'no appointment authority exists');
});

/** §18 — there is no scheduled-email authority; it must not be faked. */
test('the email layer has no authority and says so', () => {
  const layers = describeLayerAvailability({ send_queue: { state: 'available' } });
  assert.equal(layers.email.available, false);
  assert.equal(layers.email.reason, 'no_authority');
});

test('a source error is distinguished from an absent table', () => {
  const layers = describeLayerAvailability({ campaigns: { state: 'error', reason: 'timeout' } });
  assert.equal(layers.campaigns.available, false);
  assert.equal(layers.campaigns.reason, 'source_error');
});
