import test from "node:test";
import assert from "node:assert/strict";

import { getDealContextCounts, listDealContexts } from "../../src/lib/domain/deal-context/deal-context-service.js";
import { getLiveInbox } from "../../src/lib/domain/inbox/live-inbox-service.js";

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
        or(val) { state.or = val; return api; },
        order() { return api; },
        range(start, end) { state.range = [start, end]; return api; },
        limit(n) { state.limit = n; return api; },
        async then(resolve) {
          let data = [...rows];
          
          // Apply filters
          for (const f of state.filters) {
            if (f.type === 'eq') {
              data = data.filter(r => r[f.col] === f.val);
            } else if (f.type === 'not') {
              if (f.op === 'eq') {
                data = data.filter(r => r[f.col] !== f.val);
              }
            }
          }
          
          if (state.or) {
             const clauses = state.or.split(',');
             data = data.filter(r => {
               return clauses.some(c => {
                 const [col, op, val] = c.split('.');
                 if (op === 'eq') return r[col] === val;
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
    { deal_context_id: '1', inbox_bucket: 'dead', universal_status: 'dead', opt_out: false, wrong_number: false, not_interested: false },
    { deal_context_id: '2', inbox_bucket: 'priority', universal_status: 'active', opt_out: false, wrong_number: false, not_interested: false },
  ];
  
  const supabase = makeSupabaseStub(rows);
  const result = await getLiveInbox({ filter: 'all' }, { supabase });

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
      canonical_e164: '+15550001111',
      our_number: '+15550001111',
      latest_message_event_data: {
        from_phone_number: '+15550001111',
        to_phone_number: '+16660002222',
        direction: 'outbound',
      },
      thread_state_data: {
        our_number: '+15550001111',
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
  assert.equal(result.rows[0].our_number, '+15550001111');
});
