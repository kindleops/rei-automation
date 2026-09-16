/**
 * ANALYTICS-MOBILE-LOCK-1 §46. Each case pins a defect found on 2026-09-16.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWindowedRows } from '../../src/lib/domain/metrics/war-room-service.js';

// ─────────────────────────── §32/§33 exact aggregation past the 1000-row cap

/**
 * THE DEFECT CLASS. PostgREST caps responses at max-rows regardless of
 * `.limit()`, so counting the rows one select returns under-reports any cohort
 * larger than the cap — and a suspiciously round total is the only tell. No
 * window this surface offers currently reaches 1000 rows (the widest, 40d,
 * holds ~974), so live data cannot exercise the pager and a regression would
 * stay invisible until the corpus grew. Hence synthetic full pages.
 */
function pagingClient(totalRows, { pageSize = 1000, failOnPage = null } = {}) {
  const calls = [];
  return {
    calls,
    from() {
      const state = {};
      const chain = {
        select() { return chain; },
        gte() { return chain; },
        lte() { return chain; },
        order() { return chain; },
        range(from, to) {
          calls.push({ from, to });
          const pageIndex = Math.floor(from / pageSize);
          if (failOnPage !== null && pageIndex === failOnPage) {
            return Promise.resolve({ data: null, error: { message: 'page read failed' } });
          }
          const rows = [];
          for (let i = from; i <= Math.min(to, totalRows - 1); i += 1) rows.push({ id: i });
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
  };
}

test('a cohort larger than one page is counted exactly, not truncated', async () => {
  const client = pagingClient(2350);
  const { data, error } = await fetchWindowedRows(client, 'send_queue', 'id', 'a', 'b');
  assert.equal(error, null);
  assert.equal(data.length, 2350, 'every row must be returned, not the first page');
  assert.notEqual(data.length, 1000, 'a 1000 result is the signature of silent truncation');
  assert.equal(client.calls.length, 3, 'three pages for 2350 rows');
  assert.deepEqual(client.calls[0], { from: 0, to: 999 });
  assert.deepEqual(client.calls[1], { from: 1000, to: 1999 });
});

test('an exactly-full final page still terminates', async () => {
  const client = pagingClient(2000);
  const { data } = await fetchWindowedRows(client, 'send_queue', 'id', 'a', 'b');
  assert.equal(data.length, 2000);
  // 2000 rows = two full pages, then a third that comes back empty.
  assert.equal(client.calls.length, 3);
});

test('a cohort under one page makes exactly one request', async () => {
  const client = pagingClient(974);
  const { data } = await fetchWindowedRows(client, 'send_queue', 'id', 'a', 'b');
  assert.equal(data.length, 974);
  assert.equal(client.calls.length, 1, 'a short page proves the end');
});

/**
 * §43 — a failed page must surface the error WITH what was gathered, so the
 * caller can report degradation. Returning partial data silently would let
 * Analytics present an incomplete total as complete.
 */
test('a failed page returns the error alongside the partial rows', async () => {
  const client = pagingClient(2350, { failOnPage: 1 });
  const { data, error } = await fetchWindowedRows(client, 'send_queue', 'id', 'a', 'b');
  assert.ok(error, 'the failure must be reported');
  assert.equal(data.length, 1000, 'the rows gathered before the failure are returned');
  assert.ok(data.length < 2350, 'partial data must never be mistaken for the whole cohort');
});

test('an empty cohort is one request and zero rows', async () => {
  const client = pagingClient(0);
  const { data, error } = await fetchWindowedRows(client, 'send_queue', 'id', 'a', 'b');
  assert.equal(error, null);
  assert.equal(data.length, 0);
  assert.equal(client.calls.length, 1);
});
