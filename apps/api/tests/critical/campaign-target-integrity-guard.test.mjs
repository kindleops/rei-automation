import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkExplicitTargetContainment,
  explicitSelectedPropertyIds,
} from '../../src/lib/domain/campaigns/campaign-automation-service.js';

/**
 * CAMPAIGN-COMMAND-MOBILE-LOCK-1B §2/§3 — explicit targeting is a pinned set.
 *
 * The guard exists because fixing the BUILDER is not enough. Before
 * 2026-09-14 an unresolved target filter meant "no narrowing", so a build
 * targeted every reachable row; the builder now refuses on dropped filters,
 * but campaigns contaminated by that bug already exist and their rows are
 * still in campaign_targets. Production, campaign df0671fa, measured
 * 2026-09-15:
 *
 *   186 properties selected
 *   984 target rows, across 984 distinct properties
 *   106 rows inside the selection
 *   878 rows outside it
 *
 * So containment is enforced at the pre-queue authority
 * (createCampaignQueuePlan), which every execution path funnels through and
 * which is the only writer of campaign send_queue rows.
 *
 * The subtlety these tests pin: the check must look at the campaign's WHOLE
 * target set, not the rows that happen to be queueable. Every one of those 984
 * contaminated rows carries `target_status = 'blocked'`, so a first version
 * that inspected ready candidates found nothing and reported the campaign
 * "contained".
 */

/** Counts rows the way the guard does: exact, head-only, in the database. */
function fakeSupabase({ rowsByPropertyId }) {
  const calls = [];
  return {
    calls,
    from() {
      const state = { inList: null };
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        in(_column, values) { state.inList = values; return builder; },
        then(resolve) {
          calls.push(state.inList ? { in: state.inList.length } : { all: true });
          const count = state.inList
            ? rowsByPropertyId.filter((pid) => state.inList.includes(pid)).length
            : rowsByPropertyId.length;
          return Promise.resolve({ count, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const explicitCampaign = (ids, rows) => ({
  campaign: {
    id: 'c1',
    metadata: {
      target_filters: {
        properties: [{ field_key: 'properties.property_id', operator: 'in', value: ids }],
      },
    },
  },
  deps: { supabase: fakeSupabase({ rowsByPropertyId: rows }) },
});

test('the production contamination is detected with exact numbers', async () => {
  // 186 selected; 984 rows of which only 106 are inside.
  const selected = Array.from({ length: 186 }, (_, i) => `sel_${i}`);
  const rows = [
    ...selected.slice(0, 106),
    ...Array.from({ length: 878 }, (_, i) => `outside_${i}`),
  ];
  const { campaign, deps } = explicitCampaign(selected, rows);

  const result = await checkExplicitTargetContainment(campaign, deps);

  assert.equal(result.applies, true);
  assert.equal(result.contained, false, 'a widened campaign must never read as contained');
  assert.equal(result.reason, 'targets_outside_explicit_selection');
  assert.equal(result.selected_property_count, 186);
  assert.equal(result.candidate_target_count, 984);
  assert.equal(result.inside_selection_count, 106);
  assert.equal(result.outside_selection_count, 878);
});

/**
 * The regression that made the first version of this guard useless: the
 * contaminated rows are all `blocked`, so a check over queueable candidates
 * inspects nothing. Readiness is transient; a widened target set is not.
 */
test('checks the whole target set, not just queueable rows', async () => {
  const selected = ['a', 'b'];
  const { campaign, deps } = explicitCampaign(selected, ['a', 'zzz']);
  const result = await checkExplicitTargetContainment(campaign, deps);
  assert.equal(result.contained, false);
  assert.equal(result.outside_selection_count, 1);
  // Nothing in the guard's inputs mentions status — that is the point.
  assert.ok(!JSON.stringify(result).includes('ready'));
});

test('a clean explicit campaign passes, and says so positively', async () => {
  const { campaign, deps } = explicitCampaign(['p1', 'p2', 'p3', 'p4', 'p5'], ['p1', 'p3']);
  const result = await checkExplicitTargetContainment(campaign, deps);
  assert.equal(result.applies, true);
  assert.equal(result.contained, true);
  assert.equal(result.selected_property_count, 5);
  assert.equal(result.candidate_target_count, 2);
  assert.equal(result.outside_selection_count, 0);
});

/**
 * 5 selected resolving to 2 rows is CORRECT — campaign_targets is
 * contact-grained and eligibility filters. Fewer rows than selected ids must
 * not be mistaken for a violation.
 */
test('fewer target rows than selected ids is not a violation', async () => {
  const { campaign, deps } = explicitCampaign(['p1', 'p2', 'p3', 'p4', 'p5'], ['p1']);
  const result = await checkExplicitTargetContainment(campaign, deps);
  assert.equal(result.contained, true);
  assert.equal(result.outside_selection_count, 0);
});

/** More rows than selected ids is also fine, while they stay inside the set. */
test('more target rows than selected ids is fine when all are inside', async () => {
  const { campaign, deps } = explicitCampaign(['p1', 'p2'], ['p1', 'p1', 'p2', 'p2', 'p2']);
  const result = await checkExplicitTargetContainment(campaign, deps);
  assert.equal(result.contained, true);
  assert.equal(result.candidate_target_count, 5);
  assert.equal(result.outside_selection_count, 0);
});

test('a dynamic cohort is not subject to containment', async () => {
  const campaign = {
    id: 'c2',
    metadata: {
      target_filters: { properties: [{ field_key: 'properties.market', operator: 'in', value: ['Miami'] }] },
    },
  };
  const result = await checkExplicitTargetContainment(campaign, {
    supabase: fakeSupabase({ rowsByPropertyId: ['anything', 'at', 'all'] }),
  });
  assert.equal(result.applies, false);
  assert.equal(result.contained, true, 'a re-resolved cohort has no pinned set to violate');
});

/**
 * An explicit mode whose ids cannot be resolved has nothing to contain
 * against, so nothing may be enqueued — fail closed rather than open.
 */
test('an explicit definition with no resolvable ids fails closed', async () => {
  const campaign = {
    id: 'c3',
    metadata: {
      target_filters: { properties: [{ field_key: 'properties.property_id', operator: 'in', value: [] }] },
    },
  };
  const result = await checkExplicitTargetContainment(campaign, {
    supabase: fakeSupabase({ rowsByPropertyId: ['x', 'y'] }),
  });
  assert.equal(result.contained, false);
  assert.equal(result.reason, 'explicit_selection_empty');
  assert.equal(result.outside_selection_count, 2);
});

test('an empty explicit definition with no targets is vacuously contained', async () => {
  const campaign = {
    id: 'c4',
    metadata: {
      target_filters: { properties: [{ field_key: 'properties.property_id', operator: 'in', value: [] }] },
    },
  };
  const result = await checkExplicitTargetContainment(campaign, {
    supabase: fakeSupabase({ rowsByPropertyId: [] }),
  });
  assert.equal(result.contained, true, 'nothing targeted cannot be outside anything');
});

/** A large pinned list must be chunked, not shoved into one `in` list. */
test('chunks a large pinned list rather than sending one huge filter', async () => {
  const selected = Array.from({ length: 460 }, (_, i) => `p_${i}`);
  const { campaign, deps } = explicitCampaign(selected, selected.slice(0, 300));
  const result = await checkExplicitTargetContainment(campaign, deps);
  assert.equal(result.contained, true);
  assert.equal(result.inside_selection_count, 300);
  const chunked = deps.supabase.calls.filter((c) => c.in);
  assert.ok(chunked.length >= 2, `460 ids must be chunked, saw ${chunked.length} filtered call(s)`);
  assert.ok(chunked.every((c) => c.in <= 150), 'no chunk may exceed the chunk size');
});

test('reads the selected ids from the same definition the build reads', () => {
  const ids = explicitSelectedPropertyIds({
    metadata: {
      target_filters: {
        properties: [
          { field_key: 'properties.property_id', operator: 'in', value: ['1', '2'] },
          { field_key: 'properties.market', operator: 'in', value: ['Miami'] },
        ],
        owners: [{ field_key: 'properties.property_id', operator: 'eq', value: '3' }],
      },
    },
  });
  assert.deepEqual([...ids].sort(), ['1', '2', '3']);
});
