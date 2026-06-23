// acquisition-state.test.mjs
//
// Proves the Supabase-native acquisition contact state layer.
// Run: npm run proof:acquisition-state

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOrCreateAcquisitionContact,
  updateAcquisitionContact,
  updateStage,
  updateTemperature,
  markOptOut,
  markWrongNumber,
  recordDelivered,
  recordInbound,
  recordSellerAskingPrice,
  recordOfferTarget,
  findAcquisitionContact,
} from '@/lib/domain/acquisition/acquisition-contact-service.js';

import {
  emitAcquisitionEvent,
  listRecentAcquisitionEvents,
} from '@/lib/domain/acquisition/acquisition-event-service.js';
import { ACQUISITION_RUNTIME_FLAGS } from '@/lib/domain/acquisition/acquisition-runtime-control.js';

// ─────────────────────────────────────────────
// Minimal mock client — same pattern as wfv2-context-propagation.test.mjs
// ─────────────────────────────────────────────

function makeClient(config = {}) {
  const calls = [];

  function resolve(table, op) {
    const r =
      config[`${table}.${op}`] ??
      config[table] ??
      { data: null, error: null };
    return typeof r === 'function' ? r() : r;
  }

  function chain(table, op) {
    const c = {
      select:      ()        => chain(table, op ?? 'select'),
      insert:      (data)    => { calls.push({ table, op: 'insert', data }); return chain(table, 'insert'); },
      update:      (data)    => { calls.push({ table, op: 'update', data }); return chain(table, 'update'); },
      upsert:      (data, o) => { calls.push({ table, op: 'upsert', data, opts: o }); return chain(table, 'upsert'); },
      delete:      ()        => chain(table, 'delete'),
      eq:          ()        => c,
      in:          ()        => c,
      or:          ()        => c,
      gte:         ()        => c,
      lte:         ()        => c,
      order:       ()        => c,
      limit:       ()        => c,
      head:        ()        => c,
      maybeSingle: ()        => Promise.resolve(resolve(table, op ?? 'select')),
      single:      ()        => Promise.resolve(resolve(table, op ?? 'select')),
      then: (res, rej)       => Promise.resolve(resolve(table, op ?? 'select')).then(res, rej),
    };
    return c;
  }

  return { calls, from: (table) => chain(table, null) };
}

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const CONTACT_ID = 'acq-contact-001';

const BASE_CONTACT = {
  id: CONTACT_ID,
  master_owner_id: 'mo-001',
  property_id: 'prop-001',
  phone: '+15551230001',
  current_stage: 'ownership_check',
  stage_updated_at: null,
  contact_temperature: 'cold',
  priority: 'normal',
  is_opt_out: false,
  is_wrong_number: false,
  property_type: null,
  unit_count: null,
  seller_asking_price: null,
  internal_target_price: null,
  offer_ratio: null,
  last_delivered_at: null,
  last_inbound_at: null,
  retry_count: 0,
  tried_template_ids: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const CTX = {
  master_owner_id: 'mo-001',
  property_id: 'prop-001',
  phone: '+15551230001',
  stage: 'ownership_check',
};

const ACQUISITION_FLAGS_ENABLED = Object.fromEntries(
  Object.values(ACQUISITION_RUNTIME_FLAGS).map((key) => [key, true]),
);

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

test('getOrCreateAcquisitionContact: creates new contact when none exists', async () => {
  // findAcquisitionContact returns null → insert fires
  let insertedRow = null;
  const client = makeClient({
    // maybeSingle after select returns null (not found)
    'acquisition_contacts.select': { data: null, error: null },
    // insert returns the new row
    'acquisition_contacts.insert': () => {
      return { data: insertedRow, error: null };
    },
  });

  // Patch insert to capture and return the row
  const original = client.from;
  client.from = (table) => {
    const c = original.call(client, table);
    if (table === 'acquisition_contacts') {
      const origInsert = c.insert.bind(c);
      c.insert = (row) => {
        insertedRow = { ...BASE_CONTACT, ...row };
        client._config = { [`${table}.insert`]: { data: insertedRow, error: null } };
        return origInsert(row);
      };
    }
    return c;
  };

  // Use a simpler client that directly manages state
  const state = { contact: null };
  const simpleClient = {
    calls: [],
    from(table) {
      const self = this;
      function chain(op) {
        const c = {
          select:      ()     => chain(op ?? 'select'),
          insert:      (row)  => {
            self.calls.push({ table, op: 'insert', data: row });
            state.contact = { ...BASE_CONTACT, ...row };
            return chain('insert');
          },
          update:      (row)  => {
            self.calls.push({ table, op: 'update', data: row });
            state.contact = { ...state.contact, ...row };
            return chain('update');
          },
          eq:          ()     => c,
          order:       ()     => c,
          limit:       ()     => c,
          maybeSingle: ()     => {
            if (op === 'select' && !state.contact) return Promise.resolve({ data: null, error: null });
            if (op === 'insert') return Promise.resolve({ data: state.contact, error: null });
            return Promise.resolve({ data: state.contact, error: null });
          },
          single: () => {
            return Promise.resolve({ data: state.contact, error: null });
          },
          then: (res, rej) => Promise.resolve({ data: state.contact, error: null }).then(res, rej),
        };
        return c;
      }
      return chain(null);
    },
  };

  const result = await getOrCreateAcquisitionContact(CTX, {
    supabase: simpleClient,
    acquisitionRuntimeFlags: ACQUISITION_FLAGS_ENABLED,
  });

  assert.ok(result.ok, 'should succeed');
  assert.ok(result.created, 'should mark as created');
  assert.ok(result.contact, 'should return contact');
  assert.equal(result.contact.phone, '+15551230001');
  assert.equal(result.contact.master_owner_id, 'mo-001');
  assert.equal(result.contact.current_stage, 'ownership_check');
});

test('getOrCreateAcquisitionContact: returns existing contact without re-inserting', async () => {
  const client = makeClient({
    'acquisition_contacts.select': { data: BASE_CONTACT, error: null },
  });

  const result = await getOrCreateAcquisitionContact(CTX, { supabase: client });

  assert.ok(result.ok);
  assert.equal(result.created, false, 'should not mark as created');
  assert.equal(result.contact.id, CONTACT_ID);

  const insertCalls = client.calls.filter((c) => c.op === 'insert');
  assert.equal(insertCalls.length, 0, 'should not insert when contact exists');
});

test('findAcquisitionContact: looks up by phone and property_id', async () => {
  const client = makeClient({
    'acquisition_contacts.select': { data: BASE_CONTACT, error: null },
  });

  const result = await findAcquisitionContact(
    { phone: '+15551230001', property_id: 'prop-001' },
    { supabase: client },
  );

  assert.ok(result.ok);
  assert.equal(result.contact.id, CONTACT_ID);
});

test('findAcquisitionContact: returns null when not found', async () => {
  const client = makeClient({
    'acquisition_contacts.select': { data: null, error: null },
  });

  const result = await findAcquisitionContact(
    { phone: '+15550000000' },
    { supabase: client },
  );

  assert.ok(result.ok);
  assert.equal(result.contact, null);
});

test('updateStage: persists stage and stage_updated_at', async () => {
  let patched = null;
  const client = makeClient({
    'acquisition_contacts.update': () => {
      return { data: { ...BASE_CONTACT, ...patched }, error: null };
    },
  });
  const origFrom = client.from.bind(client);
  client.from = (table) => {
    const c = origFrom(table);
    if (table === 'acquisition_contacts') {
      const origUpdate = c.update.bind(c);
      c.update = (data) => {
        patched = data;
        client.calls.push({ table, op: 'update', data });
        return origUpdate(data);
      };
    }
    return c;
  };

  const stateClient = buildStatefulClient(BASE_CONTACT);
  const result = await updateStage(CONTACT_ID, 'consider_selling', {}, { supabase: stateClient });

  assert.ok(result.ok);
  assert.equal(result.contact.current_stage, 'consider_selling');
  assert.ok(result.contact.stage_updated_at, 'stage_updated_at should be set');
});

test('updateTemperature: persists temperature', async () => {
  const stateClient = buildStatefulClient(BASE_CONTACT);
  const result = await updateTemperature(CONTACT_ID, 'hot', {}, { supabase: stateClient });

  assert.ok(result.ok);
  assert.equal(result.contact.contact_temperature, 'hot');
});

test('updateTemperature: rejects invalid temperature', async () => {
  const stateClient = buildStatefulClient(BASE_CONTACT);
  const result = await updateTemperature(CONTACT_ID, 'blazing', {}, { supabase: stateClient });

  assert.ok(!result.ok);
  assert.match(result.error, /invalid_temperature/);
});

test('markOptOut: sets is_opt_out and temperature to suppressed', async () => {
  const stateClient = buildStatefulClient(BASE_CONTACT);
  const result = await markOptOut(CONTACT_ID, {}, { supabase: stateClient });

  assert.ok(result.ok);
  assert.equal(result.contact.is_opt_out, true);
  assert.equal(result.contact.contact_temperature, 'suppressed');
});

test('markWrongNumber: sets is_wrong_number and temperature to suppressed', async () => {
  const stateClient = buildStatefulClient(BASE_CONTACT);
  const result = await markWrongNumber(CONTACT_ID, {}, { supabase: stateClient });

  assert.ok(result.ok);
  assert.equal(result.contact.is_wrong_number, true);
  assert.equal(result.contact.contact_temperature, 'suppressed');
});

test('recordDelivered: sets last_delivered_at', async () => {
  const stateClient = buildStatefulClient(BASE_CONTACT);
  const before = new Date();
  const result = await recordDelivered(CONTACT_ID, {}, { supabase: stateClient });

  assert.ok(result.ok);
  assert.ok(result.contact.last_delivered_at, 'last_delivered_at should be set');
  assert.ok(new Date(result.contact.last_delivered_at) >= before);
});

test('recordInbound: sets last_inbound_at', async () => {
  const stateClient = buildStatefulClient(BASE_CONTACT);
  const before = new Date();
  const result = await recordInbound(CONTACT_ID, {}, { supabase: stateClient });

  assert.ok(result.ok);
  assert.ok(result.contact.last_inbound_at, 'last_inbound_at should be set');
  assert.ok(new Date(result.contact.last_inbound_at) >= before);
});

test('recordSellerAskingPrice: persists asking price', async () => {
  // Contact without a target price yet
  const stateClient = buildStatefulClient(BASE_CONTACT);
  const result = await recordSellerAskingPrice(CONTACT_ID, 250000, {}, { supabase: stateClient });

  assert.ok(result.ok);
  assert.equal(result.contact.seller_asking_price, 250000);
  // No target price yet — offer_ratio should not be set by this call alone
  // (the stateful client doesn't have internal_target_price)
  assert.equal(result.contact.offer_ratio, null);
});

test('recordOfferTarget: persists target price', async () => {
  const stateClient = buildStatefulClient(BASE_CONTACT);
  const result = await recordOfferTarget(CONTACT_ID, 200000, {}, {
    supabase: stateClient,
    acquisitionRuntimeFlags: ACQUISITION_FLAGS_ENABLED,
  });

  assert.ok(result.ok);
  assert.equal(result.contact.internal_target_price, 200000);
});

test('recordSellerAskingPrice + recordOfferTarget: offer_ratio computed when both prices known', async () => {
  // Pre-seed a contact that already has an internal target price
  const contactWithTarget = { ...BASE_CONTACT, internal_target_price: 200000 };
  const stateClient = buildStatefulClient(contactWithTarget);

  const result = await recordSellerAskingPrice(CONTACT_ID, 250000, {}, { supabase: stateClient });

  assert.ok(result.ok);
  assert.equal(result.contact.seller_asking_price, 250000);
  // 250000 / 200000 = 1.250
  assert.equal(result.contact.offer_ratio, 1.25);
});

test('emitAcquisitionEvent: writes event row to acquisition_events', async () => {
  let insertedRow = null;
  const client = {
    calls: [],
    from(table) {
      const self = this;
      function chain(op) {
        const c = {
          select:      ()     => chain(op ?? 'select'),
          insert:      (row)  => {
            self.calls.push({ table, op: 'insert', data: row });
            insertedRow = row;
            return chain('insert');
          },
          eq:          ()     => c,
          maybeSingle: ()     => Promise.resolve({ data: null, error: null }),
          single:      ()     => Promise.resolve({ data: insertedRow ? { ...insertedRow, id: 'evt-001' } : null, error: null }),
          then: (res, rej) => {
            const resolved = insertedRow ? { ...insertedRow, id: 'evt-001' } : null;
            return Promise.resolve({ data: resolved, error: null }).then(res, rej);
          },
        };
        return c;
      }
      return chain(null);
    },
  };

  const eventCtx = { master_owner_id: 'mo-001', phone: '+15551230001', property_id: 'prop-001' };
  const result = await emitAcquisitionEvent(
    'lead.ownership_confirmed',
    eventCtx,
    { intent: 'ownership_confirmed' },
    { supabase: client },
  );

  const insertCalls = client.calls.filter((c) => c.table === 'acquisition_events' && c.op === 'insert');
  assert.equal(insertCalls.length, 1, 'should insert one row into acquisition_events');

  const row = insertCalls[0].data;
  assert.equal(row.event_type, 'lead.ownership_confirmed');
  assert.equal(row.subject_type, 'acquisition_contact');
  assert.equal(row.subject_id, 'mo-001', 'subject_id should be master_owner_id');
  assert.equal(row.payload.master_owner_id, 'mo-001');
  assert.equal(row.payload._acquisition_event, true);
  assert.ok(row.dedupe_key, 'dedupe_key should be set');
});

test('emitAcquisitionEvent: requires event_type', async () => {
  const result = await emitAcquisitionEvent('', {}, {}, {});
  assert.ok(!result.ok);
  assert.equal(result.error, 'event_type_required');
});

test('emitAcquisitionEvent: requires subject_id (phone or master_owner_id)', async () => {
  const result = await emitAcquisitionEvent('test.event', {}, {}, {});
  assert.ok(!result.ok);
  assert.equal(result.error, 'acq_event_subject_id_required');
});

// ─────────────────────────────────────────────
// Stateful mock client helper
//
// Simulates real DB reads for functions that call getAcquisitionContact
// internally (like recordSellerAskingPrice). The state object is mutated
// on each update call so the final result reflects all patches.
// ─────────────────────────────────────────────

function buildStatefulClient(initialContact) {
  let state = { ...initialContact };

  return {
    calls: [],
    from(table) {
      const self = this;
      function chain(op) {
        const c = {
          select:      ()     => chain(op ?? 'select'),
          insert:      (row)  => {
            self.calls.push({ table, op: 'insert', data: row });
            state = { ...state, ...row };
            return chain('insert');
          },
          update:      (row)  => {
            self.calls.push({ table, op: 'update', data: row });
            state = { ...state, ...row };
            return chain('update');
          },
          eq:          ()     => c,
          order:       ()     => c,
          limit:       ()     => c,
          maybeSingle: ()     => Promise.resolve({ data: { ...state }, error: null }),
          single:      ()     => Promise.resolve({ data: { ...state }, error: null }),
          then: (res, rej) => Promise.resolve({ data: { ...state }, error: null }).then(res, rej),
        };
        return c;
      }
      return chain(null);
    },
  };
}
