-- PROPOSED ONLY. NOT APPLIED. OWNER PATH (service_role / owner session).
--
-- 8.5.20 part B schedule definition — BORN DISABLED (p_enabled = false). Creating a schedule
-- runs nothing: a slot is enqueued only when the schedule is enabled AND
-- agent.runtime_limits.runtime_enabled AND the kind is enabled + armed in kind_limits (and the
-- sweep handler itself is registered only with PROPERTY_RESEARCH_ENABLED=1).
--
--   psql "$DB" -v ON_ERROR_STOP=1 -v owner_id=<owner auth uuid> -f PROPOSED_20261016100100_property_research_schedules.sql
--
-- Mirrors PROPERTY_RESEARCH_SWEEP in apps/api/src/lib/agent/missions/property-research-triggers.js.
--   property-research-sweep   property.research_sweep   every 6 h   $0 (deterministic: enqueues at most
--                             25 property.research jobs for pipeline properties with a missing / stale valuation)
-- Requires PROPOSED_20261012140000_intel_runtime.sql (agent.runtime_upsert_schedule).
\set ON_ERROR_STOP on
begin;
select agent.runtime_upsert_schedule('property-research-sweep', 'property.research_sweep', 21600, :'owner_id', '{"limit": 25}'::jsonb, false, null, 0);
select name, kind, enabled, interval_seconds, next_run_at from agent.runtime_schedule where name in ('property-research-sweep') order by name;
commit;
