-- ANALYTICS LAB (desktop 2.0) — PROPOSED, NOT APPLIED.
--
-- STATUS: PROPOSED 2026-09-30. Requires operator approval before anyone
-- applies it (Supabase MCP apply_migration or an execute_sql DO-block, per the
-- migration-channel rule). The PROPOSED_ prefix keeps it outside
-- `supabase db push`. Do NOT rename it.
--
-- ADDITIVE ONLY. One new table, its indexes and grants, plus one optional
-- index. No existing table, view, RPC or policy is altered or dropped.
-- Re-running is safe (IF NOT EXISTS throughout). Nothing here writes to an
-- existing row.
--
-- WHY
-- 1. Saved views. The Lab encodes its whole analytical context in the URL
--    (?lab=<base64url>) and keeps named views on the operator's device today.
--    A shared, server-side list needs a store. The only existing candidate,
--    public.pipeline_saved_views, belongs to Pipeline and has a different
--    shape (filters/group_by), so the Lab does not borrow it.
--    lab-service reads/writes this table ONLY through
--    src/lib/domain/analytics/lab/saved-views.js, which validates every
--    context through the query contract before storing it and reports
--    `store: 'unavailable'` while the table is absent.
-- 2. (optional) seller_automation_executions has no created_at index; the
--    Lab reads it by created_at window. 5,852 rows today (a seq scan is
--    ~1 ms), so this is only worth applying once the table grows past ~100K.

create table if not exists public.analytics_saved_views (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(label) between 1 and 80),
  description text check (description is null or char_length(description) <= 280),
  -- the normalised public context (range, compare, grain, filters, segment, mode, metric)
  context jsonb not null,
  -- the metric-registry definition version the view was saved under
  definition_version text not null,
  is_pinned boolean not null default false,
  is_shared boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists analytics_saved_views_pinned_updated_idx
  on public.analytics_saved_views (is_pinned desc, updated_at desc);

alter table public.analytics_saved_views enable row level security;
-- No policies: only the service role (the API) reads or writes it.
revoke all on public.analytics_saved_views from anon, authenticated;
grant select, insert, update, delete on public.analytics_saved_views to service_role;

-- (optional, see WHY 2) — apply outside a transaction if used:
-- create index concurrently if not exists seller_automation_executions_created_at_idx
--   on public.seller_automation_executions (created_at);
