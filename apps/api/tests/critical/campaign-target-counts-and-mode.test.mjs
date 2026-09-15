import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCampaignTargetStatusCounts } from '../../src/lib/domain/campaigns/campaign-recipient-metrics.js';
import { resolveCampaignTargetMode } from '../../src/lib/domain/campaigns/campaign-automation-service.js';

/**
 * CAMPAIGN-COMMAND-MOBILE-LOCK-1 §2/§3/§5/§21 — campaign target counts.
 *
 * Two defects, both measured against production on 2026-09-15.
 *
 * 1. THE COUNTS WERE A TRUNCATED SAMPLE. The scan asked for `.limit(100000)`
 *    in one query, which looks unbounded but is overridden by PostgREST's own
 *    max-rows: it returned 1000 of the 2,578 existing campaign_targets rows,
 *    with no error and no signal. The campaign list reported exactly 1000
 *    targets across all campaigns while 1,578 were invisible, and campaigns at
 *    the cut were undercounted — "Entity Graph · 5 properties" has two rows and
 *    the list said one. A silent cap is the worst kind: the number looks fine.
 *
 * 2. EXPLICIT AND DYNAMIC TARGETING WERE INDISTINGUISHABLE. They are different
 *    promises — a pinned set of ids versus a query re-resolved at build time —
 *    and nothing in the projection said which one a campaign had.
 */

/** Fake PostgREST builder that enforces a server max-rows, like the real one. */
function fakeSupabase({ rows, maxRows = 1000 }) {
  let pageFrom = 0;
  let pageTo = maxRows - 1;
  const calls = [];
  const builder = {
    select() { return builder; },
    in() { return builder; },
    order() { return builder; },
    range(from, to) {
      pageFrom = from;
      // The server never returns more than maxRows, whatever was asked for.
      pageTo = Math.min(to, from + maxRows - 1);
      calls.push([from, to]);
      return Promise.resolve({ data: rows.slice(pageFrom, pageTo + 1), error: null });
    },
  };
  return { calls, from() { return builder; } };
}

const rowsFor = (spec) => {
  const out = [];
  for (const [campaignId, count, status] of spec) {
    for (let i = 0; i < count; i += 1) {
      out.push({ campaign_id: campaignId, target_status: status ?? 'ready', block_reason: null });
    }
  }
  return out;
};

test('counts every target row even when the corpus exceeds one server page', async () => {
  // 2,578 rows across two campaigns — the production shape that produced 1000.
  const rows = rowsFor([['a', 1578], ['b', 1000]]);
  const client = fakeSupabase({ rows, maxRows: 1000 });

  const counts = await fetchCampaignTargetStatusCounts(['a', 'b'], { supabase: client });

  assert.equal(counts.get('a').total, 1578, 'campaign a undercounted');
  assert.equal(counts.get('b').total, 1000, 'campaign b undercounted');
  const grandTotal = [...counts.values()].reduce((n, b) => n + b.total, 0);
  assert.equal(grandTotal, 2578, `total must be the corpus, not a page: got ${grandTotal}`);
  assert.ok(client.calls.length > 1, 'a corpus larger than one page must be paged');
});

/**
 * The exact regression: a campaign whose rows straddle the page boundary. With
 * a single capped query its tail simply vanished.
 */
test('does not lose a campaign whose rows straddle the page boundary', async () => {
  const rows = rowsFor([['big', 999], ['straddler', 2]]);
  const counts = await fetchCampaignTargetStatusCounts(['big', 'straddler'], {
    supabase: fakeSupabase({ rows, maxRows: 1000 }),
  });
  assert.equal(counts.get('big').total, 999);
  assert.equal(counts.get('straddler').total, 2, 'the row past the cap was dropped');
});

test('a single short page still terminates without extra queries', async () => {
  const client = fakeSupabase({ rows: rowsFor([['a', 12]]), maxRows: 1000 });
  const counts = await fetchCampaignTargetStatusCounts(['a'], { supabase: client });
  assert.equal(counts.get('a').total, 12);
  assert.equal(client.calls.length, 1, 'a partial first page means the scan is done');
});

test('an empty campaign list makes no query at all', async () => {
  const client = fakeSupabase({ rows: [] });
  const counts = await fetchCampaignTargetStatusCounts([], { supabase: client });
  assert.equal(counts.size, 0);
  assert.equal(client.calls.length, 0);
});

test('statuses and block reasons are tallied per campaign, not pooled', async () => {
  const rows = [
    { campaign_id: 'a', target_status: 'ready', block_reason: null },
    { campaign_id: 'a', target_status: 'blocked', block_reason: 'missing_identity_linkage' },
    { campaign_id: 'b', target_status: 'blocked', block_reason: 'suppression_blocked' },
  ];
  const counts = await fetchCampaignTargetStatusCounts(['a', 'b'], { supabase: fakeSupabase({ rows }) });
  assert.deepEqual(counts.get('a').statuses, { ready: 1, blocked: 1 });
  assert.deepEqual(counts.get('a').blocked, { missing_identity_linkage: 1 });
  assert.deepEqual(counts.get('b').blocked, { suppression_blocked: 1 });
});

// ─────────────────────────────────────────────── explicit vs dynamic targeting

const explicitFilters = (ids) => ({
  target_filters: {
    properties: [{ field_key: 'properties.property_id', operator: 'in', value: ids }],
  },
});

test('a pinned id list is explicit, and reports how many were selected', () => {
  // The operator's real handoff: five property ids.
  const mode = resolveCampaignTargetMode(
    explicitFilters(['273588014', '229081541', '273657631', '212296224', '217298095']),
  );
  assert.equal(mode.target_mode, 'explicit');
  assert.equal(mode.explicit_target_count, 5, 'five selected means five, always');
});

test('browsable dimensions are a dynamic cohort with no fixed count', () => {
  // The real shape of "Tax Delinquent - Poor and Unsound".
  const mode = resolveCampaignTargetMode({
    target_filters: {
      properties: [
        { field_key: 'properties.tax_delinquent', operator: 'eq', value: true },
        { field_key: 'properties.property_type', operator: 'in', value: ['SFR'] },
        { field_key: 'properties.building_condition', operator: 'in', value: ['Poor'] },
      ],
    },
  });
  assert.equal(mode.target_mode, 'dynamic');
  assert.equal(mode.explicit_target_count, null, 'a cohort re-resolves; it has no pinned size');
});

test('no filters is neither promise', () => {
  for (const metadata of [{}, { target_filters: {} }, { target_filters: { properties: [] } }, null, undefined]) {
    const mode = resolveCampaignTargetMode(metadata ?? undefined);
    assert.equal(mode.target_mode, 'none', JSON.stringify(metadata));
    assert.equal(mode.explicit_target_count, null);
  }
});

/**
 * A pinned list narrowed by dimensions is neither promise cleanly, so it gets
 * its own label rather than being passed off as one of them — calling it
 * "explicit" would imply the ids are the whole story.
 */
test('a pinned list plus dimensions is reported as its own mode', () => {
  const mode = resolveCampaignTargetMode({
    target_filters: {
      properties: [
        { field_key: 'properties.property_id', operator: 'in', value: ['1', '2', '3'] },
        { field_key: 'properties.market', operator: 'in', value: ['Miami'] },
      ],
    },
  });
  assert.equal(mode.target_mode, 'explicit_filtered');
  assert.equal(mode.explicit_target_count, 3);
});

test('owner ids are an identity anchor too, not a targeting dimension', () => {
  const mode = resolveCampaignTargetMode({
    target_filters: {
      properties: [{ field_key: 'properties.master_owner_id', operator: 'in', value: ['mo_1', 'mo_2'] }],
    },
  });
  assert.equal(mode.target_mode, 'explicit');
  assert.equal(mode.explicit_target_count, 2);
});

test('a single non-array value still counts as one selected identity', () => {
  const mode = resolveCampaignTargetMode({
    target_filters: { properties: [{ field_key: 'properties.property_id', operator: 'eq', value: '273588014' }] },
  });
  assert.equal(mode.target_mode, 'explicit');
  assert.equal(mode.explicit_target_count, 1);
});
