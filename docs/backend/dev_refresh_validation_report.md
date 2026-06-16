# Universal Lead Command Cache Dev Refresh Validation

## Recommendation

**APPLY**

Apply the migration to production, then run the initial cache population as a
separately monitored maintenance operation. Do not wire API routes until the
production cache count, Leticia/Jose smoke test, and index plans pass.

The initial full refresh is acceptable for launch, but it is not appropriate as
a frequent steady-state refresh:

- Runtime was 383.559 seconds.
- It generated approximately 1.94 GiB of WAL.
- It added approximately 1.46 GiB to the database.
- Future source changes should use targeted/incremental refresh scopes.

Before production population, confirm at least 3 GiB of free database disk and
monitor replica lag/WAL retention during the refresh. If replica lag grows
materially, let replication catch up before any route migration.

## Scope And Safety

- Validation date: June 12, 2026
- Environment: isolated local Supabase PostgreSQL container
- PostgreSQL image: `supabase/postgres:17.6.1.104`
- PostgreSQL server: `17.6`
- Docker CPUs visible: 16
- Docker memory available: 7.654 GiB
- `shared_buffers`: 128 MB
- `work_mem`: 4 MB
- `max_parallel_workers_per_gather`: 2
- Source snapshot: read-only `pg_dump` of production `public`
- Production DDL/DML performed: none
- Dashboard/API/provider code changed: none

The production snapshot was 8.3 GB and compressed to a 971 MB dump. Core local
row counts matched production before migration:

| Source | Rows |
| --- | ---: |
| `properties` | 124,046 |
| `campaign_target_graph` | 124,046 |
| `prospects` | 149,798 |
| `phones` | 121,287 |
| `emails` | 165,655 |

The local restore omitted only the production HTTP trigger on
`message_events`, because the isolated database does not contain the
`supabase_functions` schema. That omission prevents external side effects and
does not affect the canonical view or cache refresh.

## Migration Apply

Migration:

`apps/api/supabase/migrations/20260611230925_create_v_universal_lead_command.sql`

| Measure | Result |
| --- | ---: |
| Migration apply runtime | 0.90 seconds |
| Cache rows immediately after apply | 0 |
| Source-table indexes added | 0 |
| Cache indexes created | 10 including primary key |
| Apply errors | 0 |

The cache was intentionally created empty. Its indexes were built against the
empty relation, avoiding index builds on production source tables.

## Initial Full Refresh

Command:

```sql
set statement_timeout = 0;
select * from public.refresh_universal_lead_command_cache();
```

Function result:

| Field | Result |
| --- | ---: |
| `refresh_mode` | `full` |
| `staged_rows` | 308,670 |
| `deleted_rows` | 0 |
| `inserted_rows` | 308,670 |
| `cache_rows` | 308,670 |
| Function elapsed time | 383,559.484 ms |
| Client wall time | 384.28 seconds |

The refresh completed successfully with no null or duplicate grain keys.

## Cardinality

The exact cardinality query completed in 3,936.752 ms.

| Measure | Count |
| --- | ---: |
| Total cache rows | 308,670 |
| Distinct `property_id` | 84,772 |
| Distinct `property_export_id` | 84,772 |
| Distinct `master_owner_id` | 68,293 |
| Distinct `prospect_id` | 99,313 |
| Distinct `contact_channel_value` | 224,750 |
| Phone rows | 132,527 |
| Email rows | 176,143 |
| Duplicate grain keys | 0 |
| Null grain keys | 0 |

## Storage

| Measure | Bytes | Display |
| --- | ---: | ---: |
| Cache heap | 632,160,256 | 603 MB |
| Cache indexes | 114,384,896 | 109 MB |
| Cache TOAST | 816,504,832 | 779 MB |
| Cache total | 1,563,009,024 | 1,491 MB |
| Database growth | 1,562,992,640 | 1.456 GiB |

Largest indexes:

| Index | Size |
| --- | ---: |
| Primary key on `grain_key` | 58 MB |
| Contact channel | 14 MB |
| Prospect | 8.9 MB |
| Property export | 8.2 MB |
| Master owner | 7.0 MB |
| Property | 5.9 MB |

The wide JSON/entity projections account for the 779 MB TOAST footprint.

## WAL And Replica Risk

| Measure | Result |
| --- | ---: |
| WAL LSN delta | 2,078,531,528 bytes |
| `pg_stat_wal.wal_bytes` delta | 2,060,224,974 bytes |
| WAL LSN delta | 1.936 GiB |
| Average WAL rate | 5.168 MiB/s |

Replica lag was not observable in the isolated single-node database. The WAL
volume is large enough to warrant production monitoring but not large enough,
by itself, to block launch.

Operational conclusions:

- Run the initial refresh once during a controlled window.
- Verify disk headroom before starting.
- Monitor replica replay lag and retained WAL until caught up.
- Do not schedule repeated full refreshes.
- Use the scoped refresh function for normal source changes.
- A later full refresh on a populated cache will also delete old rows and may
  generate more WAL/dead tuples than this initial empty-cache refresh.

## Leticia/Jose Smoke Test

Property `2109507191` returned six rows with:

- Owner: Jose L Calzada
- Owner ID: `mo_8d60153f76aa86fd94728d5e`
- Two prospects
- Two phone rows
- Four email rows
- Leticia prospect:
  `pros1_5cbfdd6944b42b81f466e353`
- Leticia phone:
  `+19184074839`
- Leticia thread:
  `+19184074839`
- Inbox bucket:
  `new_replies`
- Universal status:
  `active`

## Query Performance

These are warm-cache local `EXPLAIN (ANALYZE, BUFFERS, WAL, COSTS OFF)`
measurements after `ANALYZE`. Every query selected its intended cache index.

| Access path | Rows | Planning | Execution | Index |
| --- | ---: | ---: | ---: | --- |
| Inbox `Tulsa, OK + new_replies` | 34 | 0.457 ms | 0.921 ms | Market/inbox |
| Campaign + `planned` | 1 | 0.267 ms | 0.133 ms | Campaign/target |
| Property ID | 6 | 2.563 ms | 0.110 ms | Property |
| Property export ID | 6 | 0.135 ms | 0.105 ms | Property export |
| Master owner ID | 6 | 0.164 ms | 0.135 ms | Master owner |
| Prospect ID | 4 | 0.248 ms | 0.158 ms | Prospect |
| Phone/contact | 1 | 0.173 ms | 0.714 ms | Contact channel |
| Queue status `sent`, limit 100 | 100 | 0.163 ms | 1.627 ms | Queue status/schedule |
| Due follow-up | 0 | 0.158 ms | 0.033 ms | Partial follow-up |

The due-follow-up plan used the partial index, but the cloned data currently
contains no due follow-up rows. Index selection is verified; non-empty runtime
remains a post-launch observation item.

## Production Gate

Recommended sequence:

1. Apply the migration without running route changes.
2. Confirm the cache table is empty and all ten indexes exist.
3. Confirm at least 3 GiB database disk headroom.
4. Start the full refresh with no statement timeout.
5. Monitor database CPU, WAL retention, and replica replay lag.
6. Run the cardinality and Leticia/Jose validations.
7. Run the launch access-path EXPLAIN queries.
8. Keep routes unchanged until those production checks pass.

Final recommendation: **APPLY**.
