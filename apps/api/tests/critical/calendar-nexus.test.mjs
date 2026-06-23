import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateOverdue } from '../../src/lib/domain/calendar/calendar-overdue.js';
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