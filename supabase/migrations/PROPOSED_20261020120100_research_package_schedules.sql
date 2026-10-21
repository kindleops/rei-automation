-- PROPOSED ONLY. NOT APPLIED. OWNER PATH (service_role / owner session).
--
-- PACKAGE A (hotfix/research-runtime) schedule definitions — ALL BORN DISABLED (p_enabled = false).
-- Creating a schedule runs nothing: a slot is enqueued only when the schedule is enabled AND
-- agent.runtime_limits.runtime_enabled AND NOT emergency_stop AND the kind is enabled + armed in
-- kind_limits (and the handler is registered: PROPERTY_RESEARCH_ENABLED / VALUATION_REFRESH_ENABLED /
-- AGENT_OPERATIONS_ENABLED). Enabling is a separate owner step (apps/api/scripts/ops/research-package-a/).
--
--   psql "$DB" -v ON_ERROR_STOP=1 -v owner_id=<owner auth uuid> -f PROPOSED_20261020120100_research_package_schedules.sql
--
-- Mirrors PROPERTY_RESEARCH_SWEEP (missions/property-research-triggers.js), OPERATIONS_SCHEDULE_DEFINITIONS
-- (operations/operations-kinds.js, without pipeline-reconcile) and SCHEDULE_DEFINITIONS (missions/mission-kinds.js,
-- without acquisition-discovery). Kept in step by tests/critical/research-package-a.test.mjs.
--   property-research-sweep     property.research_sweep     every 6 h   $0 (enqueues ≤ 10 property.research jobs)
--   valuation-refresh           valuation.refresh           every 24 h  $0 (DRY RUN; ≤ 25 properties)
--   recovery-sweep              recovery.sweep              every 6 h   $0 (approved_programs = [] ⇒ nothing "eligible")
--   inbox-action-center         inbox.action_center         every 15 m  $0
--   ops-supervisor              ops.supervisor              every 30 m  $0
--   conversation-review-digest  conversation.review_digest  every 24 h  $0, first slot 12:00 UTC (the daily brief)
--   ops-health-check            ops.health_check            every 15 m  $0
-- Requires PROPOSED_20261012140000_intel_runtime.sql (agent.runtime_upsert_schedule).
\set ON_ERROR_STOP on
begin;
select agent.runtime_upsert_schedule('property-research-sweep', 'property.research_sweep', 21600, :'owner_id', '{"limit": 10}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('valuation-refresh', 'valuation.refresh', 86400, :'owner_id', '{"limit": 25}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('recovery-sweep', 'recovery.sweep', 21600, :'owner_id', '{"batch_limit": 300, "approved_programs": [], "full_pass_hours": 24}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('inbox-action-center', 'inbox.action_center', 900, :'owner_id', '{"batch_limit": 500, "full_pass_hours": 1}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('ops-supervisor', 'ops.supervisor', 1800, :'owner_id', '{}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('conversation-review-digest', 'conversation.review_digest', 86400, :'owner_id',
  '{"window_hours": 24}'::jsonb, false, (date_trunc('day', clock_timestamp() at time zone 'utc') + interval '1 day 12 hours') at time zone 'utc', 0);
select agent.runtime_upsert_schedule('ops-health-check', 'ops.health_check', 900, :'owner_id', '{}'::jsonb, false, null, 0);
select name, kind, enabled, interval_seconds, next_run_at from agent.runtime_schedule
 where name in ('property-research-sweep', 'valuation-refresh', 'recovery-sweep', 'inbox-action-center', 'ops-supervisor', 'conversation-review-digest', 'ops-health-check') order by name;
commit;
