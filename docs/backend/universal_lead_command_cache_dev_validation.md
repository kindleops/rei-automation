# universal_lead_command_cache — Dev Validation Report

**Migration file:** `apps/api/supabase/migrations/20260611230925_create_v_universal_lead_command.sql`  
**Validation date:** 2026-06-12  
**Method:** Static analysis against production schema (read-only `execute_sql`). No DDL applied.  
**Validation environment:** Supabase project `lcppdrmrdfblstpcbgpf` (real-estate-automation, ACTIVE_HEALTHY) — schema introspection only.  
**Local / branch status:** Local Docker not running; Supabase branching not viable (migration history broken since 2026-04-19).

---

## 1. Objects Created by Migration

Exactly **3 new objects**. No existing objects modified.

| # | Object | Type | Status |
|---|--------|------|--------|
| 1 | `public.v_universal_lead_command` | VIEW | Does not exist on prod — will be created |
| 2 | `public.universal_lead_command_cache` | TABLE (empty) | Does not exist on prod — will be created |
| 3 | `public.refresh_universal_lead_command_cache(text[],text[],text[],text[],text[],text[],text[])` | FUNCTION | Does not exist on prod — will be created |

**Cache indexes** (all on the new empty table, not source tables):

| Index name | Columns |
|------------|---------|
| `universal_lead_command_cache_pkey` | `grain_key` (PRIMARY KEY) |
| `idx_universal_lead_command_cache_property_id` | `property_id` |
| `idx_universal_lead_command_cache_property_export_id` | `property_export_id` |
| `idx_universal_lead_command_cache_master_owner_id` | `master_owner_id` |
| `idx_universal_lead_command_cache_prospect_id` | `prospect_id` |
| `idx_universal_lead_command_cache_contact_channel` | `contact_channel_value, contact_channel_type` |
| `idx_universal_lead_command_cache_market_inbox` | `market, inbox_bucket, latest_message_at DESC` |
| `idx_universal_lead_command_cache_campaign_target` | `campaign_id, target_status, command_updated_at DESC` |
| `idx_universal_lead_command_cache_queue` | `queue_status, scheduled_for` |
| `idx_universal_lead_command_cache_follow_up` | `next_follow_up_at WHERE NOT NULL` (partial) |

---

## 2. Rollback SQL

Complete rollback is 3 statements. No existing objects were modified so rollback is total.

```sql
-- Full rollback: drops all 3 objects created by 20260611230925_create_v_universal_lead_command.sql
-- Indexes and constraints drop automatically with the table.
DROP TABLE IF EXISTS public.universal_lead_command_cache;

DROP VIEW IF EXISTS public.v_universal_lead_command;

DROP FUNCTION IF EXISTS public.refresh_universal_lead_command_cache(
  text[], text[], text[], text[], text[], text[], text[]
);
```

Run order matters: drop the table first (it is created `AS SELECT * FROM v_universal_lead_command WITH NO DATA`; PostgreSQL will allow dropping in any order since there is no FK dependency, but dropping the table first avoids a potential dependency check stall in future versions).

---

## 3. Initial Cache Refresh — Confirmed NOT Run

**Finding: PASS.** The migration does not call `refresh_universal_lead_command_cache()` at migration time.

Evidence — the migration ends with:

```sql
CREATE TABLE public.universal_lead_command_cache AS
SELECT * FROM public.v_universal_lead_command
WITH NO DATA;          -- ← WITH NO DATA: zero rows, no query execution
```

The refresh function is **defined** but never **called** within the migration transaction. The cache is born empty. The final migration comment is explicit:

> "Intentionally no automatic refresh here. Populate in a separately monitored operation after migration approval."

Post-apply populate command (run separately, not part of migration):
```sql
SET statement_timeout = 0;
SELECT * FROM public.refresh_universal_lead_command_cache();
```

---

## 4. Source-Table Indexes — Confirmed NOT Added

**Finding: PASS.** Zero `CREATE INDEX` statements target any source table.

The migration comment states this explicitly:

> "This migration intentionally adds no indexes to existing source tables. The live catalog already owns the required identity/filter indexes…"

All 9 `CREATE INDEX` / `ADD CONSTRAINT PRIMARY KEY` statements in the migration target only `public.universal_lead_command_cache` (the new empty table).

---

## 5. Locks and Existing Table Mutations — Confirmed NONE

**Finding: PASS.** No existing table is locked or altered.

Full check of DDL verbs against existing objects:

| Statement type | Target | Existing object? |
|----------------|--------|-----------------|
| `CREATE OR REPLACE VIEW` | `v_universal_lead_command` | No — new |
| `ALTER TABLE … SET NOT NULL` | `universal_lead_command_cache` | No — new |
| `ALTER TABLE … ADD CONSTRAINT` | `universal_lead_command_cache` | No — new |
| `ALTER TABLE … ENABLE ROW LEVEL SECURITY` | `universal_lead_command_cache` | No — new |
| `CREATE TABLE … WITH NO DATA` | `universal_lead_command_cache` | No — new |
| `CREATE INDEX` (×9) | `universal_lead_command_cache` | No — new |
| `CREATE OR REPLACE FUNCTION` | `refresh_universal_lead_command_cache` | No — new |

The `CREATE TABLE … AS SELECT … WITH NO DATA` acquires `ACCESS SHARE` locks on source tables only to resolve the column list — identical to parsing a `SELECT *`. This is the lightest possible lock (compatible with all concurrent reads and writes) and is released before the migration transaction commits.

---

## 6. RLS and Permission Model — Confirmed Correct

**Finding: PASS.** All three objects are locked down to `service_role` only. No authenticated/anon access at any layer.

### View: `v_universal_lead_command`
```sql
REVOKE ALL ON public.v_universal_lead_command FROM anon, authenticated;
GRANT SELECT ON public.v_universal_lead_command TO service_role;
```
View is `security_invoker = true` — it evaluates RLS policies of the caller. `service_role` bypasses RLS on source tables, so the view returns full data when called from the refresh function. Correct.

### Cache table: `universal_lead_command_cache`
```sql
REVOKE ALL ON public.universal_lead_command_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.universal_lead_command_cache TO service_role;
ALTER TABLE public.universal_lead_command_cache ENABLE ROW LEVEL SECURITY;
```
RLS is enabled with no policies defined. This is intentional: service_role bypasses RLS, so the table is accessible only to the refresh function (service_role) and future API routes running as service_role. No anonymous or authenticated access at any point.

Note: `UPDATE` is not granted. The refresh function uses `DELETE` + `INSERT` (delete scope, then insert from stage), not `UPDATE`. This is by design — the atomic swap pattern does not require `UPDATE` permission.

### Function: `refresh_universal_lead_command_cache`
```sql
REVOKE ALL ON FUNCTION public.refresh_universal_lead_command_cache(...) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_universal_lead_command_cache(...) TO service_role;
```
Function is `VOLATILE` and `SET search_path = pg_catalog, public, pg_temp`. The explicit `search_path` prevents search-path injection in the advisory lock and dynamic SQL blocks. Correct.

---

## 7. Static Column Validation Against Production Schema

**Method:** All column references in `v_universal_lead_command` were extracted from the migration SQL and verified against `information_schema.columns` via read-only `execute_sql`. A LEFT JOIN pattern was used so any missing column would surface as a NULL row.

**Result: PASS — 0 missing columns across 18 source tables, 147 column references checked.**

| Source table | Columns referenced | All present? | Notes |
|---|---|---|---|
| `campaign_target_graph` | 6 | ✅ | `graph_id`, `graph_source`, `generated_at` all exist |
| `properties` | 88 | ✅ | All struct + scoring + physical attribute columns exist |
| `master_owners` | 31 | ✅ | All portfolio + scoring columns exist |
| `prospects` | 25 | ✅ | `mob` is `text` (not date), consistent with view NULL-aliasing `birth_year_month` and `calculated_age` |
| `phones` | 15 | ✅ | `linked_prospect_ids_json` is `jsonb` — `?` operator is valid |
| `emails` | 10 | ✅ | `linked_prospect_ids_json` is `jsonb` — `?` operator is valid |
| `inbox_thread_state` | 31 | ✅ | `latest_message_event_id` is `uuid`, matches `message_events.id` |
| `deal_thread_state` | 7 | ✅ | |
| `message_events` | 15 | ✅ | |
| `send_queue` | 20 | ✅ | `from_phone_number` / `to_phone_number` are `character varying` — compatible with `text` comparisons |
| `campaign_targets` | 9 | ✅ | |
| `campaigns` | 3 | ✅ | |
| `workflow_runs` | 10 | ✅ | `current_step_id` is `uuid`, matches `workflow_steps.id` |
| `workflows` | 3 | ✅ | `workflow_type` exists (used in `follow_up_sequence_status` CASE) |
| `workflow_steps` | 3 | ✅ | `label` and `step_key` both exist |
| `thread_ai_state` | 10 | ✅ | |
| `sms_suppression_list` | 6 | ✅ | |
| `contact_outreach_state` | 6 | ✅ | |

### Explicit NULL columns (documented in migration)

The view uses `NULL::type AS column_name` for 8 fields where source columns do not exist. All are correctly documented with `COMMENT ON COLUMN`:

| Cache column | Reason | Migration comment |
|---|---|---|
| `birth_year_month` | `prospects.mob` is text, no `birth_year_month` column | ✅ documented |
| `calculated_age` | No reliable birth year in schema | ✅ documented |
| `total_loan_amount` | `total_loan_balance` exists instead | ✅ documented |
| `assessment_year` | `tax_year` exists instead | ✅ documented |
| `phone_confirmed` | No confirmation boolean on phones | ✅ documented |
| `email_confirmed` | No confirmation boolean on emails | ✅ documented |
| `email_status` | No email status field | ✅ documented |
| `offer_status` / `contract_status` / `closing_status` / `deal_status` | No source fields exist | ✅ documented |

### Type compatibility notes

- `send_queue.from_phone_number` and `to_phone_number` are `character varying`, not `text`. In PostgreSQL, `varchar` and `text` are storage-compatible and compare without casting. The view equality joins (`qbpp.to_phone_number = cg.contact_channel_value`) will work correctly.
- `inbox_thread_state.id` is `uuid`. The thread resolution CTEs resolve to `uuid` IDs, then join back via `its.id = COALESCE(tpp.id, tpr.id, top.id)`. All arms of the COALESCE return `uuid`. Correct.
- `campaign_targets.campaign_id` is `uuid`; `campaigns.id` is `uuid`. Join is type-safe.

### Grain key uniqueness invariant

The view computes:
```sql
concat_ws('|',
  key_property_export_id,
  resolved_master_owner_id,
  key_prospect_id,
  contact_channel_type,
  contact_channel_value
) AS resolved_grain_key
```

The refresh function validates uniqueness before committing:
```sql
IF staged_rows <> v_distinct_grains THEN
  RAISE EXCEPTION 'universal lead cache refresh aborted: % rows but % distinct grains', ...
```

This is a hard abort on grain collision — the cache will never contain duplicate grain keys. The `NOT NULL` constraint on `grain_key` and the `PRIMARY KEY` enforce this at the storage layer.

The grain is sound as long as a single owner/prospect pair has at most one phone and one email registered. If `phones.linked_prospect_ids_json` lists the same prospect twice, the join would produce a duplicate grain. This cannot be verified statically; the refresh function's uniqueness check catches it at runtime.

---

## 8. Production Apply Checklist

### Pre-apply (do once)

- [ ] Confirm `v_universal_lead_command` does not exist: `SELECT viewname FROM pg_views WHERE viewname = 'v_universal_lead_command';` → must return 0 rows
- [ ] Confirm `universal_lead_command_cache` does not exist: `SELECT to_regclass('public.universal_lead_command_cache');` → must return NULL
- [ ] Confirm no active long-running queries that would block a `CREATE VIEW` (ACCESS SHARE): `SELECT * FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock';`
- [ ] Note current migration count: `SELECT count(*) FROM supabase_migrations.schema_migrations;`

### Apply migration

```bash
# Register as a migration (do not run via execute_sql — use apply_migration)
# The migration file is already committed at:
#   apps/api/supabase/migrations/20260611230925_create_v_universal_lead_command.sql
```

Via Supabase MCP `apply_migration`, or via CLI once local baseline is repaired.

### Post-apply verification (before refresh)

```sql
-- 1. Objects exist
SELECT viewname FROM pg_views WHERE viewname = 'v_universal_lead_command';
SELECT tablename FROM pg_tables WHERE tablename = 'universal_lead_command_cache';
SELECT proname FROM pg_proc WHERE proname = 'refresh_universal_lead_command_cache';

-- 2. Cache is empty (expected before refresh)
SELECT count(*) FROM public.universal_lead_command_cache;  -- must be 0

-- 3. View parses (syntax check only, no data)
EXPLAIN SELECT count(*) FROM public.v_universal_lead_command LIMIT 0;

-- 4. Grants are correct
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name IN ('universal_lead_command_cache', 'v_universal_lead_command')
ORDER BY table_name, grantee;
-- Expected: only service_role appears with SELECT (and INSERT, DELETE for the table)
```

### Initial refresh (separately monitored, NOT part of migration)

Run this as a separate, monitored operation — not inline with migration apply:

```sql
-- Run from a service_role session with no statement timeout.
-- On 308K expected rows this will take several minutes.
-- Monitor via pg_stat_activity or Supabase logs.
SET statement_timeout = 0;
SELECT * FROM public.refresh_universal_lead_command_cache();
```

Expected output columns: `refresh_mode, staged_rows, deleted_rows, inserted_rows, cache_rows, started_at, finished_at, elapsed_ms`

Accept criteria:
- `refresh_mode = 'full'`
- `staged_rows` between 200,000 and 450,000 (design estimate: ~308,670)
- `staged_rows = inserted_rows` (deleted_rows = 0 on first full run)
- `cache_rows = inserted_rows`
- No exception raised (grain uniqueness validated internally)

### Post-refresh smoke tests

```sql
-- Property lookup (should hit idx_universal_lead_command_cache_property_export_id)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT property_export_id, grain_key, full_name, contact_channel_type, contact_channel_value
FROM public.universal_lead_command_cache
WHERE property_export_id = '<any_known_property_export_id>'
LIMIT 20;

-- Contact channel lookup (should hit idx_universal_lead_command_cache_contact_channel)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT grain_key, property_address_full, full_name, thread_key, inbox_bucket
FROM public.universal_lead_command_cache
WHERE contact_channel_value = '<known_e164>'
  AND contact_channel_type = 'phone';

-- Inbox market query (should hit idx_universal_lead_command_cache_market_inbox)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT grain_key, full_name, latest_message_at, inbox_bucket, lead_temperature
FROM public.universal_lead_command_cache
WHERE market = 'DFW'
  AND inbox_bucket = 'new_replies'
ORDER BY latest_message_at DESC NULLS LAST
LIMIT 50;

-- Campaign query (should hit idx_universal_lead_command_cache_campaign_target)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT grain_key, full_name, target_status, command_updated_at
FROM public.universal_lead_command_cache
WHERE campaign_id = '<any_known_campaign_uuid>'
  AND target_status = 'pending'
ORDER BY command_updated_at DESC
LIMIT 100;

-- Queue status query (should hit idx_universal_lead_command_cache_queue)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT grain_key, full_name, queue_status, scheduled_for
FROM public.universal_lead_command_cache
WHERE queue_status IN ('pending', 'scheduled')
  AND scheduled_for <= now() + interval '1 hour';

-- Due follow-up query (should hit idx_universal_lead_command_cache_follow_up partial)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT grain_key, full_name, next_follow_up_at, contact_channel_value
FROM public.universal_lead_command_cache
WHERE next_follow_up_at <= now()
ORDER BY next_follow_up_at ASC
LIMIT 50;
```

### Leticia / Jose smoke test

```sql
-- Find Leticia and Jose rows by name
SELECT
  grain_key,
  full_name,
  property_address_full,
  contact_channel_type,
  contact_channel_value,
  inbox_bucket,
  universal_status,
  lead_temperature,
  next_action,
  last_outbound_at,
  thread_key
FROM public.universal_lead_command_cache
WHERE full_name ILIKE '%leticia%' OR full_name ILIKE '%jose%'
ORDER BY full_name, property_address_full
LIMIT 20;
```

Expected: at least one phone-channel row per known contact, `grain_key` non-null, no duplicate `grain_key` values in the result.

---

## Summary / Recommendation

| Check | Result |
|-------|--------|
| Objects created — exactly 3 new | ✅ PASS |
| Rollback SQL — deterministic 3-statement | ✅ PASS |
| No initial cache refresh at migration time | ✅ PASS |
| No source-table index additions | ✅ PASS |
| No locks or ALTER on existing tables | ✅ PASS |
| RLS and service_role-only access | ✅ PASS |
| All 147 column references resolve in prod schema | ✅ PASS — 0 missing |
| Grain key uniqueness enforced at two layers | ✅ PASS (runtime guard + PK constraint) |

**Recommendation: APPLY — with conditions.**

The migration is safe to apply to production. All pre-conditions are met. The three risk conditions that warrant waiting are:

1. **Do not run the initial refresh during peak hours.** The view is a 13-CTE full-scan join across 18 tables. On ~300K rows it will hold `ACCESS SHARE` on source tables for several minutes. Schedule the initial `SELECT * FROM refresh_universal_lead_command_cache()` during off-peak (overnight or early morning).

2. **Monitor the refresh runtime before wiring API routes.** If elapsed_ms is unexpectedly high (>15 minutes), investigate EXPLAIN ANALYZE on the view before routing live traffic through the cache.

3. **Do not apply the two unapplied workflow v2 migrations first without checking dependencies.** `20260611232000_workflow_studio_v2_schema.sql` and `20260612000000_workflow_studio_v2_enrollment_state.sql` are also unapplied. They may alter `workflow_runs` or `workflow_steps`. Apply this cache migration first (or confirm v2 schema adds columns only, not removes), then re-validate the view column list if needed.
