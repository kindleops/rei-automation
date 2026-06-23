import test from "node:test";
import assert from "node:assert/strict";

import { getDealContextCounts, listDealContexts } from "../../src/lib/domain/deal-context/deal-context-service.js";
import { getLiveInbox } from "../../src/lib/domain/inbox/live-inbox-service.js";

function clean(value) {
  return String(value ?? '').trim();
}

function buildLiveCountRow(rows = []) {
  const byBucket = (bucket) => rows.filter((row) => row.inbox_bucket === bucket).length;
  return {
    all: rows.length,
    priority: byBucket('priority'),
    new_replies: byBucket('new_replies'),
    needs_review: byBucket('needs_review'),
    follow_up: byBucket('follow_up'),
    cold: byBucket('cold'),
    dead: byBucket('dead'),
    suppressed: byBucket('suppressed'),
    active: rows.filter((row) => ['priority', 'new_replies', 'needs_review', 'follow_up'].includes(row.inbox_bucket)).length,
    waiting: byBucket('waiting'),
    unlinked: rows.filter((row) => row.property_id == null).length,
  };
}

function makeSupabaseStub(rows = []) {
  return {
    from(table) {
      const state = { 
        table, 
        filters: [], 
        range: null, 
        or: null,
        head: false,
        count: null
      };
      const api = {
        select(cols, opts = {}) { 
          if (opts.count) state.count = opts.count;
          if (opts.head) state.head = true;
          return api; 
        },
        eq(col, val) { state.filters.push({ type: 'eq', col, val }); return api; },
        not(col, op, val) { state.filters.push({ type: 'not', col, op, val }); return api; },
        in(col, val) { state.filters.push({ type: 'in', col, val }); return api; },
        lt(col, val) { state.filters.push({ type: 'lt', col, val }); return api; },
        or(val) { state.or = val; return api; },
        order() { return api; },
        range(start, end) { state.range = [start, end]; return api; },
        limit(n) { state.limit = n; return api; },
        async then(resolve) {
          let data = table === 'v_inbox_thread_counts_live_v2'
            ? [buildLiveCountRow(rows)]
            : [...rows];
          
          // Apply filters
          for (const f of state.filters) {
            if (f.type === 'eq') {
              data = data.filter(r => clean(r[f.col]) === clean(f.val));
            } else if (f.type === 'not') {
              if (f.op === 'eq') {
                data = data.filter(r => clean(r[f.col]) !== clean(f.val));
              }
            }
          }
          
          if (state.or) {
             const clauses = state.or.split(',');
             data = data.filter(r => {
               return clauses.some(c => {
                 const [col, op, val] = c.split('.');
                 if (op === 'eq') return clean(r[col]) === clean(val);
                 return false;
               });
             });
          }

          const count = data.length;
          if (state.head) return resolve({ count, data: null, error: null });
          
          if (state.range) {
            data = data.slice(state.range[0], state.range[1] + 1);
          }

          return resolve({ data, count, error: null });
        }
      };
      return api;
    }
  };
}

test("getDealContextCounts accurately counts 'dead' rows from deal_thread_state", async () => {
  const rows = [
    { inbox_bucket: 'priority', universal_status: 'active', opt_out: false, wrong_number: false, not_interested: false },
    { inbox_bucket: 'cold', universal_status: 'active', opt_out: false, wrong_number: false, not_interested: false },
    { inbox_bucket: 'cold', universal_status: 'active', opt_out: false, wrong_number: false, not_interested: false },
    { inbox_bucket: 'dead', universal_status: 'dead', opt_out: false, wrong_number: true, not_interested: false },
    { inbox_bucket: 'dead', universal_status: 'dead', opt_out: false, wrong_number: false, not_interested: true },
    { inbox_bucket: 'new_replies', universal_status: 'active', opt_out: false, wrong_number: false, not_interested: false },
    { inbox_bucket: 'suppressed', universal_status: 'suppressed', opt_out: true, wrong_number: false, not_interested: false },
  ];
  
  const supabase = makeSupabaseStub(rows);
  const counts = await getDealContextCounts({}, { supabase });

  assert.equal(counts.total, 7);
  assert.equal(counts.by_inbox_bucket.priority, 1);
  assert.equal(counts.by_inbox_bucket.new_replies, 1);
  assert.equal(counts.by_inbox_bucket.cold, 2);
  assert.equal(counts.by_inbox_bucket.dead, 2);
  assert.equal(counts.by_inbox_bucket.suppressed, 1);
});

test("listDealContexts filtering supports inbox_bucket=dead", async () => {
  const rows = [
    { deal_context_id: '1', inbox_bucket: 'cold', universal_status: 'active', opt_out: false, wrong_number: false, not_interested: false },
    { deal_context_id: '2', inbox_bucket: 'cold', universal_status: 'dead', opt_out: false, wrong_number: false, not_interested: false },
    { deal_context_id: '3', inbox_bucket: 'dead', universal_status: 'dead', opt_out: false, wrong_number: false, not_interested: false },
  ];
  
  const supabase = makeSupabaseStub(rows);
  
  const deadResult = await listDealContexts({ inbox_bucket: 'dead' }, { supabase });
  assert.equal(deadResult.rows.length, 2);
  assert.ok(deadResult.rows.every(r => r.universal_status === 'dead' || r.inbox_bucket === 'dead'));

  const coldResult = await listDealContexts({ inbox_bucket: 'cold' }, { supabase });
  assert.equal(coldResult.rows.length, 1);
  assert.equal(coldResult.rows[0].deal_context_id, '1');
});

test("getLiveInbox returns canonical counts including dead", async () => {
  const rows = [
    {
      thread_key: '+15550000001',
      canonical_thread_key: '+15550000001',
      canonical_e164: '+15550000001',
      latest_message_at: '2026-05-29T12:00:00.000Z',
      latest_message_direction: 'inbound',
      latest_message_body: 'Stop texting me',
      inbox_bucket: 'dead',
      universal_status: 'dead',
      opt_out: false,
      wrong_number: true,
      not_interested: false,
      property_id: null,
    },
    {
      thread_key: '+15550000002',
      canonical_thread_key: '+15550000002',
      canonical_e164: '+15550000002',
      latest_message_at: '2026-05-29T11:00:00.000Z',
      latest_message_direction: 'inbound',
      latest_message_body: 'Yes I am interested',
      inbox_bucket: 'priority',
      universal_status: 'active',
      opt_out: false,
      wrong_number: false,
      not_interested: false,
      property_id: 'prop-2',
    },
  ];
  
  const supabase = makeSupabaseStub(rows);
  const result = await getLiveInbox({ filter: 'all', skip_delivery: 'true' }, { supabase });

  assert.equal(result.counts.all, 2);
  assert.equal(result.counts.dead, 1);
  assert.equal(result.counts.priority, 1);
  assert.equal(result.counts.cold, 0);
});

test("listDealContexts resolves seller_phone from latest message counterparty instead of our TextGrid number", async () => {
  const rows = [
    {
      deal_context_id: 'ctx-1',
      latest_message_direction: 'outbound',
      canonical_e164: '+16128060495',
      our_number: '+16128060495',
      latest_message_event_data: {
        from_phone_number: '+16128060495',
        to_phone_number: '+16660002222',
        direction: 'outbound',
      },
      thread_state_data: {
        our_number: '+16128060495',
      },
      inbox_bucket: 'priority',
      universal_status: 'active',
      opt_out: false,
      wrong_number: false,
      not_interested: false,
    },
  ];

  const supabase = makeSupabaseStub(rows);
  const result = await listDealContexts({}, { supabase });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].seller_phone, '+16660002222');
  assert.equal(result.rows[0].canonical_e164, '+16660002222');
  assert.equal(result.rows[0].best_phone, '+16660002222');
  assert.equal(result.rows[0].our_number, '+16128060495');
});
