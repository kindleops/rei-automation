# v_universal_lead_command Plan

## Status

- Draft migration:
  `apps/api/supabase/migrations/20260611230925_create_v_universal_lead_command.sql`
- Live schema/field audit:
  `docs/backend/v_universal_lead_command_schema_audit.md`
- Applied to Supabase: **No**
- Cache populated: **No**
- API routes migrated: **No**
- Existing tables/views dropped: **No**
- Dashboard files changed by this task: **No**

## Purpose

The universal command model has two layers:

1. `public.v_universal_lead_command` is the canonical SQL definition, source
   ownership contract, and rebuild source.
2. `public.universal_lead_command_cache` is the physical production read table
   for Inbox, Deal Intelligence, Map, Pipeline, Queue, Campaigns, and Comp
   Intelligence.

API and dashboard list/filter routes must eventually read the cache, not execute
the heavy canonical view. The view remains available to `service_role` for
validation, targeted rebuilds, and provenance debugging.

It is not one property row containing contact slots. It emits multiple rows when
a property/owner has multiple prospects or channels.

The migration creates the cache empty and does not run the initial full refresh
automatically. Initial population is a separately monitored operation after the
migration is approved and applied.

## Correct Grain

One row per:

`property_export_id + master_owner_id + prospect_id +
contact_channel_type + contact_channel_value`

A channel is one phone or one email explicitly linked to the prospect. Phone and
email are separate rows.

Live pre-view grain audit:

| Measure | Count |
| --- | ---: |
| Total command rows | 308,670 |
| Distinct properties | 84,772 |
| Distinct master owners | 68,293 |
| Distinct prospects | 99,313 |
| Distinct channel values | 224,750 |
| Phone rows | 132,527 |
| Email rows | 176,143 |

The 124,046-row property universe is not the operational contact grain.
Properties without a valid linked phone/email prospect do not produce a command
row.

## Exact Join Path

1. Start from the all-property `campaign_target_graph g` and join
   `properties p` by `property_export_id`.
2. Use `campaign_target_graph.master_owner_id` when populated.
3. Use `properties.master_owner_id` only for graph rows where the graph owner is
   null. The SQL uses two indexable branches rather than a runtime `coalesce`
   scan.
4. Join `master_owners mo` by the resolved owner.
5. Join every `prospects pr` for that resolved owner.
6. Phone branch:
   join `phones ph` where `ph.master_owner_id = pr.master_owner_id` and
   `ph.linked_prospect_ids_json ? pr.prospect_id`.
7. Email branch:
   join `emails em` where `em.master_owner_id = pr.master_owner_id` and
   `em.linked_prospect_ids_json ? pr.prospect_id`.
8. Union the phone and email branches. This creates the required grain.
9. For phone rows only, resolve the most specific `inbox_thread_state` row by:
   property + phone, prospect + phone, then owner + phone.
10. Load one latest `message_events` row for that thread. Never aggregate full
    message history.
11. Join `deal_thread_state` and `thread_ai_state` by resolved thread key.
12. Resolve the latest queue item by thread, property + phone, then owner +
    phone.
13. Resolve the latest campaign target from the queue FK, property + phone, then
    owner + phone; join `campaigns`.
14. Resolve the latest workflow run by conversation thread, then
    property/owner/prospect; join `workflows` and `workflow_steps`.
15. Resolve current phone suppression and outreach state from
    `sms_suppression_list` and `contact_outreach_state`.

`campaign_target_graph` stabilizes property ownership and campaign routing. Its
selected prospect/phone never limits the view to one contact.

## Owner Resolution

The graph owner takes precedence because the live audit found:

- 53,193 properties where graph supplies a missing property owner.
- 93 rows where graph and property owner disagree.
- In all 93 disagreements, the graph prospect and phone belong to the graph
  owner.
- All 81,306 populated graph prospect/phone pairs exist and have zero graph
  owner mismatches.

The view exposes `owner_resolution_source`.

## Field Contract

The complete requested-field mapping and missing-field lock are in
`v_universal_lead_command_schema_audit.md`.

Important real-name mappings include:

| Business output | Physical source |
| --- | --- |
| `language` | `prospects.language_preference` |
| `estimated_household_income` | `prospects.est_household_income` |
| `tax_amount` | `properties.tax_amt` |
| `apn_parcel_id` | `properties.apn_parcel_id` |
| `hoa_one_name` | `properties.hoa1_name` |
| `hoa_one_type` | `properties.hoa1_type` |
| `square_foot_range` | `properties.sqft_range` |
| `average_square_foot_per_unit` | `properties.avg_sqft_per_unit` |
| `number_of_fireplaces` | `properties.num_of_fireplaces` |
| `sum_buildings` | `properties.sum_buildings_nbr` |
| `sum_garage_square_feet` | `properties.sum_garage_sqft` |
| `phone_activity_status` | `phones.activity_status` |
| `phone_rank` | `phones.sort_rank` |
| `phone_status` | `phones.phone_contact_status` |
| `campaign_status` | `campaigns.status` |
| `sender_phone` | `send_queue.from_phone_number` |
| `ai_conversation_state` | `thread_ai_state.current_stage` |
| `ai_next_action` | `thread_ai_state.next_best_action` |

Missing source fields are emitted only as typed `NULL` columns and are commented
in SQL:

- `calculated_age`
- `birth_year_month`
- `total_loan_amount`
- `assessment_year`
- `phone_confirmed`
- `email_confirmed`
- `email_status`
- `offer_status`
- `contract_status`
- `closing_status`
- `deal_status`

## Source Of Truth

| Field group | Source of truth |
| --- | --- |
| Property facts | `properties` |
| Property-owner stabilization | `campaign_target_graph`, then `properties` |
| Master owner facts | `master_owners` |
| Prospect facts | `prospects` |
| Phone facts/linkage | `phones` |
| Email facts/linkage | `emails` |
| Current inbox controls | `inbox_thread_state` |
| Universal thread classification | `deal_thread_state` |
| Latest message summary | One latest `message_events` row |
| Queue state | Latest applicable `send_queue` row |
| Campaign state | `campaigns` and latest `campaign_targets` row |
| Workflow state | `workflow_runs`, `workflows`, `workflow_steps` |
| AI/deal analysis | `thread_ai_state` |
| SMS opt-out/suppression | `sms_suppression_list` |
| Contact DNC state | `contact_outreach_state` |

## Message Architecture

- `message_events` remains immutable full message history.
- `inbox_thread_state` remains current mutable thread/control state.
- The universal view contains one latest-message summary only.
- `contact_threads` contains navigation/current-state summaries and no message
  arrays.
- Full messages continue to load separately by `thread_key` /
  `conversation_thread_id`.
- Email command rows do not borrow an SMS thread. Their thread fields remain
  null until an email-thread source exists.

## Leticia/Jose Smoke Contract

Property `2109507191` returns six operational rows:

| Prospect | Channel rows |
| --- | ---: |
| Leticia M Calzada | 1 phone + 3 emails |
| Courtney Graves | 1 phone + 1 email |

Leticia's phone row resolves:

- Owner: `mo_8d60153f76aa86fd94728d5e`
- Prospect: `pros1_5cbfdd6944b42b81f466e353`
- Phone: `ph_3bd9156c203dc38d2369e7d1`
- Phone value: `+19184074839`
- Thread: `+19184074839`
- Current inbox bucket: `new_replies`
- Current universal status: `active`

Her three email rows remain distinct email commands.

## Views That Become Legacy Later

Nothing is dropped by this migration. After cache population, parity checks, API
route migration, and rollback-window verification, these become
compatibility/legacy candidates:

- `v_universal_inbox_threads`
- `inbox_threads_view`
- `v_inbox_threads_live_v2`
- `canonical_inbox_threads`
- `v_inbox_enriched`
- `v_deal_context_cards`
- `deal_context_index`
- `deal_intelligence_view`
- `pipeline_cards_view`
- `list_rows_view`
- `map_markers_view`
- `v_command_map_seller_pin_feed`
- `v_map_property_pins`
- `v_property_map_points_live`

Source tables, message history, queue execution, workflow state, and graph
routing remain active.

## API Migration Order After Verification

Every route below must read `public.universal_lead_command_cache`, not
`public.v_universal_lead_command`:

1. Inbox list/count/thread-summary reads.
2. Deal context and pipeline reads.
3. Internal dashboard map reads.
4. Queue control summary/read portions only.
5. Campaign preview/options/field-catalog reads.
6. Comp Intelligence subject hydration.

Mutation routes, campaign launch, queue creation, provider send logic,
system-control, and full message-history routes remain unchanged.

## Cache Structure And Indexes

`universal_lead_command_cache` is created from the canonical view with the same
column order and PostgreSQL types. `grain_key` is non-null and is the table
primary key.

Launch indexes:

- `property_id`
- `property_export_id`
- `master_owner_id`
- `prospect_id`
- `(contact_channel_value, contact_channel_type)`
- `(market, inbox_bucket, latest_message_at desc)`
- `(campaign_id, target_status, command_updated_at desc)`
- `(queue_status, scheduled_for)`
- `next_follow_up_at where next_follow_up_at is not null`

The migration intentionally creates no source-table indexes. The live catalog
already contains the property, graph, phone, campaign, queue, and thread
identity indexes needed for the current definition. In particular,
`idx_campaign_target_graph_property_export_id` already covers
`campaign_target_graph(property_export_id)`, so the duplicate
`idx_universal_command_graph_property_export` was removed.

The cache indexes are built while the table is empty. They therefore do not
block writers on the large source tables. Any future source index must be
justified by a post-cache `EXPLAIN` and created concurrently in a dedicated
out-of-transaction migration. PostgreSQL does not permit `CREATE INDEX
CONCURRENTLY` inside a transaction, and current Supabase CLI migration replay
can pipeline migration statements.

## Refresh Contract

`public.refresh_universal_lead_command_cache()` supports full and targeted
refreshes.

Only an invocation with every argument omitted/`NULL` is a full refresh.
Explicit empty arrays are treated as an incremental no-op, preventing an empty
worker batch from accidentally rebuilding the entire cache.

Full refresh:

```sql
set statement_timeout = 0;
select * from public.refresh_universal_lead_command_cache();
```

The function:

1. Acquires a transaction advisory lock so only one cache writer runs.
2. Stages canonical rows in a temporary table.
3. Rejects null or duplicate grain keys.
4. Deletes the affected cache scope.
5. Inserts the staged replacement rows.
6. Commits atomically with its caller.

Readers continue to see the previous committed cache while a refresh runs.
There is no `TRUNCATE`, table rename, or swap that takes an access-exclusive
lock on the production cache. A full refresh does rewrite every cache row and
generates corresponding WAL and dead tuples, so it is a controlled
maintenance operation rather than the steady-state refresh mechanism.

The previously measured canonical count was about 13.55 seconds, but that does
not measure materializing every wide row. Exact full-refresh runtime, resulting
table size, WAL volume, and replica lag must be measured on a Supabase
development branch before production population.

Targeted example:

```sql
select *
from public.refresh_universal_lead_command_cache(
  p_property_export_ids => array['prop_244fa5b5fa41c1af61c33fc6']
);
```

Targeted refresh source mapping:

| Changed source | Preferred scope |
| --- | --- |
| `campaign_target_graph`, `properties` | `p_property_export_ids` |
| `master_owners` | `p_master_owner_ids` |
| `prospects` | `p_master_owner_ids` and/or `p_prospect_ids` |
| `phones`, `emails` | owner/prospect plus `p_contact_channel_values` |
| `inbox_thread_state` | `p_thread_keys`; property/owner when identity changed |
| `message_events` | `p_thread_keys` after current thread state is updated |
| `send_queue`, `campaign_targets` | thread, property, owner, or contact scope |
| `workflow_runs`, `thread_ai_state` | `p_thread_keys`; identity fallback |

No source triggers are installed in this migration. High-write tables such as
`message_events` and `send_queue` should not receive synchronous heavy-view
refresh triggers. After route verification, existing write workers/jobs should
enqueue or call narrow refresh scopes after their source transaction commits.
When an identity changes, callers must pass both old and new identities or the
containing property/owner scope so stale cache rows are deleted.

## Measured View Baseline

Production-data EXPLAIN validation of the canonical normal view, before this
cache migration is applied:

| Query | Execution time |
| --- | ---: |
| Property detail | 1.057 seconds |
| Inbox market + bucket | 12.651 seconds |
| Thread/contact | 0.707 seconds |
| Campaign + target status | 167.602 seconds |
| Due follow-up | 0.130 seconds, with zero qualifying rows |

These results are why production routes must use the indexed cache.

Rollback-only migration validation:

- Canonical view columns: 245.
- Cache columns: 245.
- Column name/type mismatches: 0.
- Leticia/Jose targeted rows and distinct grains: 6 / 6.
- Property-scoped refresh after warm planning: about 0.3-0.6 seconds.
- Thread-scoped refresh, after resolving the thread to its property identity:
  about 0.3 seconds.
- Empty-array refresh: incremental no-op with zero staged/deleted/inserted rows.
- Every launch query shape selected its intended cache index during the index
  usability sweep.
- All tests ran inside transactions ending in `ROLLBACK`; no database objects
  were left behind.

## Risks

- This is a wide cache over approximately 308,670 rows and repeats property and
  owner facts at contact-channel grain.
- Initial storage size and full-refresh WAL volume have not yet been measured.
- Full refresh uses transactional `DELETE` plus `INSERT`; it preserves read
  availability but creates dead tuples for autovacuum to reclaim.
- Incremental refresh is only correct when the caller supplies a scope broad
  enough to delete stale pre-change identities.
- The canonical view remains expensive and must not become a production
  list/filter endpoint.
- `deal_thread_state`, workflow tables, AI state, suppression, and outreach
  state expand the source scope beyond the original ten tables.
- Email rows currently have no email-thread source and therefore no thread
  state.
- Current queue/campaign/workflow fields are latest-row projections, not
  histories.
- Missing locked fields remain null until a real write owner is introduced.
- Cache index maintenance adds write cost during refresh but removes broad-view
  execution from user-facing reads.

## Validation Queries

```sql
-- 0. Populate only after the migration is approved/applied and the full
-- refresh is started as a separately monitored operation.
set statement_timeout = 0;
select * from public.refresh_universal_lead_command_cache();

-- 1. Cache cardinality requested for launch.
select
  count(*) as cache_row_count,
  count(distinct property_id) as distinct_property_ids,
  count(distinct prospect_id) as distinct_prospect_ids,
  count(distinct (contact_channel_type, contact_channel_value))
    as distinct_contacts
from public.universal_lead_command_cache;

-- 2. Canonical/cache parity and grain uniqueness.
select
  (select count(*) from public.v_universal_lead_command)
    as canonical_rows,
  (select count(*) from public.universal_lead_command_cache)
    as cache_rows,
  (select count(distinct grain_key)
   from public.universal_lead_command_cache)
    as cache_distinct_grains;

-- 3. Leticia/Jose smoke test. Expected: six rows.
select property_id, master_owner_id, display_name, prospect_id, full_name,
       contact_channel_type, contact_channel_value, phone_id, email_id,
       thread_key, inbox_bucket, universal_status, latest_message_at
from public.universal_lead_command_cache
where property_id = '2109507191'
order by full_name, contact_channel_type, contact_channel_value;

-- 4. Inbox market query performance.
explain (analyze, buffers, costs off)
select command_id, property_id, market, inbox_bucket, latest_message_at
from public.universal_lead_command_cache
where market = 'Tulsa, OK'
  and inbox_bucket = 'new_replies'
order by latest_message_at desc nulls last
limit 50;

-- 5. Campaign query performance.
explain (analyze, buffers, costs off)
select command_id, campaign_id, campaign_target_id, target_status, queue_status
from public.universal_lead_command_cache
where campaign_id = '28b1d0be-1a8f-454f-b466-43b6fbef623b'::uuid
  and target_status = 'planned'
order by command_updated_at desc nulls last
limit 50;

-- 6. Property lookup performance.
explain (analyze, buffers, costs off)
select *
from public.universal_lead_command_cache
where property_id = '2109507191';

-- 7. Contact lookup performance.
explain (analyze, buffers, costs off)
select *
from public.universal_lead_command_cache
where contact_channel_value = '+19184074839'
  and contact_channel_type = 'phone';

-- 8. Follow-up queue performance.
explain (analyze, buffers, costs off)
select command_id, thread_key, next_follow_up_at, next_action
from public.universal_lead_command_cache
where next_follow_up_at is not null
  and next_follow_up_at <= now()
order by next_follow_up_at
limit 100;

-- 9. Queue-status performance.
explain (analyze, buffers, costs off)
select command_id, queue_status, scheduled_for
from public.universal_lead_command_cache
where queue_status in ('queued', 'retry')
order by scheduled_for
limit 100;

-- 10. Targeted refresh smoke test. Run only after initial population.
select *
from public.refresh_universal_lead_command_cache(
  p_property_export_ids => array['prop_244fa5b5fa41c1af61c33fc6']
);

-- 11. Confirm Leticia/Jose parity after targeted refresh.
select grain_key, command_updated_at
from public.universal_lead_command_cache
where property_id = '2109507191'
order by grain_key;

-- 12. Direct cache index inventory.
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'universal_lead_command_cache'
order by indexname;

-- Optional canonical diagnostic. Do not use this query shape in API routes.
explain (analyze, buffers, costs off)
select *
from public.v_universal_lead_command
where contact_channel_value = '+19184074839';

/*
Historic heavy-view validation retained for provenance:

explain (analyze, buffers)
select * from public.v_universal_lead_command
where contact_channel_value = '+19184074839';
*/
```
