-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.18 — Persistent missions + autonomous operations (small delta on R2).
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT inside, so the pretest can wrap it):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261014120000_persistent_missions.sql
-- Run PROPOSED_20261014120000_persistent_missions_pretest.sql first.
-- ORDER: after PROPOSED_20261012140000_intel_runtime.sql (R2) and
--        PROPOSED_20261013120000_agent_capabilities.sql (approvals the discovery
--        draft's launch approval is written to). Independent of the
--        conversation-ai shadow migrations (20261013160000 / 20261013161000).
--
-- WHAT IT CHANGES (no table, no new write path, no grant widening):
--   1. agent.runtime_kind_limits_valid: a kind's max_concurrency may be 1..3
--      (R2 allowed 1..2) so a mission.supervisor's ≤ 3 sub-missions can run at
--      once. max_concurrency_global (1..4) and tick_max_jobs (1..5) are unchanged
--      and still bound the total. Absent kinds stay OFF.
--   2. Indexes for the Missions API and the discovery de-dupe (reads only):
--      research_job (requested_by, created_at desc, job_id desc) where runtime_managed
--      finding (finding_type, key, retrieved_at desc) where job_id is not null
-- Everything a mission writes still goes through the R2 agent.runtime_* SECURITY
-- DEFINER functions (job rows, job_event, job-owned spend_ledger reserves under
-- agent.spend_ledger_guard, agent.finding). Nothing here can send SMS or email or
-- touch send_queue, campaigns or campaign_targets.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function agent.runtime_kind_limits_valid(j jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, agent
as $$
declare k text; v jsonb;
begin
  if j is null or jsonb_typeof(j) <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(j) loop
    if not agent.runtime_kind_valid(k) or jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) x where x not in ('enabled', 'max_concurrency', 'armed_by')) then return false; end if;
    if jsonb_typeof(v -> 'enabled') is distinct from 'boolean' then return false; end if;
    -- 8.5.18: 1..3 (a supervisor's sub-missions); R2 was 1..2
    if v ? 'max_concurrency' and (jsonb_typeof(v -> 'max_concurrency') <> 'number' or (v ->> 'max_concurrency') !~ '^[123]$') then return false; end if;
    if v ? 'armed_by' and not agent.runtime_is_named_operator(v ->> 'armed_by') then return false; end if;
    if (v ->> 'enabled') = 'true' and not (v ? 'armed_by') then return false; end if;
  end loop;
  return true;
end
$$;
comment on function agent.runtime_kind_limits_valid(jsonb) is
  'kind_limits shape: {"<kind>":{"enabled":bool,"max_concurrency":1|2|3,"armed_by":"<operator uuid>"}}; enabled=true requires a named armed_by. 8.5.18 widened max_concurrency to 3 (supervisor sub-missions).';
revoke all on function agent.runtime_kind_limits_valid(jsonb) from public, anon, authenticated;
grant execute on function agent.runtime_kind_limits_valid(jsonb) to agent_api, service_role;

create index if not exists research_job_requested_recent_idx on agent.research_job (requested_by, created_at desc, job_id desc) where runtime_managed;
create index if not exists finding_type_key_job_idx on agent.finding (finding_type, key, retrieved_at desc) where job_id is not null;

comment on index agent.research_job_requested_recent_idx is '8.5.18 Missions API: an operator''s missions, newest first (keyset on created_at, job_id).';
comment on index agent.finding_type_key_job_idx is '8.5.18 discovery de-dupe: was this property surfaced by a discovery finding recently?';
