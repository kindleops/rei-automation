-- ════════════════════════════════════════════════════════════════════════════
-- IC8.1 L2 / RC 7.1 — canary deals 78e4cce2 + bdd43b67: ARCHIVE + FLAG ONLY.
-- Runbook step R3 (after 20261001_canary_cleanup_d2.sql).
-- ════════════════════════════════════════════════════════════════════════════
-- Supersedes ~/.claude/jobs/c39b0175/tmp/rc/d2b-canary-cleanup-78e4cce2-bdd43b67.sql.
-- Changes: re-run safe (archive + audit row in ONE statement, `on conflict
-- (idempotency_key) do nothing`, exact id/status/provenance guards — a second
-- run writes nothing) and the thread archive writes an audit row.
-- NO deletes. send_queue / message_events / history / automation_events untouched.
-- Evidence: tmp/ic8/reports/canary-verification.md. Ends in ROLLBACK by default.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. PREVIEW (read-only) ─────────────────────────────────────────────────
select id, primary_property_id, master_owner_id, primary_thread_key, acquisition_stage,
       opportunity_status, automation_state, next_action, next_action_due, version, updated_at
from acquisition_opportunities
where id in ('78e4cce2-c5fc-42b3-9923-f8ad3428dda2',   -- thread +16127433952 (INTERNAL_TEST_PHONE_SET), no owner/property
             'bdd43b67-0ffc-4bac-ba2d-af9ef2d1d1a1');  -- owner selftest_ryan, property selftest_property, thread +16128072000
-- expect: both opportunity_status = 'active'; versions 49 and 5 (2026-10-02 06:55Z)
select thread_key, is_archived from inbox_thread_state
where thread_key in ('+16127433952','6127433952','+16128072000','6128072000');
-- expect: only 6127433952 is_archived = false
-- must be 0 before applying:
select count(*) live_sends from send_queue
where (thread_key in ('+16127433952','6127433952','+16128072000','6128072000')
       or to_phone_number in ('+16127433952','+16128072000'))
  and queue_status in ('scheduled','queued','pending','approved','ready','processing','sending');

-- ── 1. APPLY (ends in ROLLBACK; change to COMMIT after the counts match) ───
begin;
set local lock_timeout = '5s';

with upd as (
  update acquisition_opportunities o
  set opportunity_status  = 'archived',
      automation_state    = 'inactive',
      next_action         = null,
      next_action_due     = null,
      last_updated_source = 'operator_data_cleanup',
      last_updated_by     = 'ic8.1_canary_cleanup',
      metadata = coalesce(o.metadata, '{}'::jsonb) || jsonb_build_object(
        'test_fixture', true,
        'fixture_kind', case when o.id = 'bdd43b67-0ffc-4bac-ba2d-af9ef2d1d1a1'
                             then 'internal_selftest' else 'internal_test_phone' end,
        'archived_reason', 'internal_canary_fixture_ic8_1',
        'archived_at', now()),
      version    = o.version + 1,
      updated_at = now()
  where o.opportunity_status = 'active'
    and (
          (o.id = '78e4cce2-c5fc-42b3-9923-f8ad3428dda2'
            and o.primary_thread_key = '+16127433952'
            and o.master_owner_id is null and o.primary_property_id is null)
       or (o.id = 'bdd43b67-0ffc-4bac-ba2d-af9ef2d1d1a1'
            and o.master_owner_id = 'selftest_ryan'
            and o.primary_property_id = 'selftest_property'
            and o.primary_thread_key = '+16128072000')
        )
  returning o.id
), audit as (
  insert into acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata, created_at)
  select id, 'opportunity_status_changed', 'opportunity_status', 'active', 'archived',
         'internal_canary_fixture_ic8_1', 'ic8.1_canary_cleanup', 'operator_data_cleanup',
         'ic81_canary_archive:' || id::text,
         jsonb_build_object('test_fixture', true, 'evidence', 'tmp/ic8/reports/canary-verification.md'), now()
  from upd
  on conflict (idempotency_key) do nothing
  returning opportunity_id
)
select (select count(*) from upd) as deals_archived, (select count(*) from audit) as audit_rows;
-- expect 2 / 2 on the first run; 0 / 0 on a re-run. STOP if the two numbers differ.

-- Inbox: '+16127433952', '+16128072000' and '6128072000' are already archived.
-- The bare-digit duplicate '6127433952' is not.
with upd as (
  update inbox_thread_state
  set is_archived = true, updated_at = now()
  where thread_key = '6127433952'
    and coalesce(is_archived, false) = false
  returning thread_key, property_id
), audit as (
  insert into universal_lead_state_events (thread_key, property_id, field_name, previous_value, new_value,
    operator_id, source_view, reason, change_source, executed_next_action, metadata, created_at)
  select thread_key, property_id, 'is_archived', 'false', 'true', null, 'rc71_canary_cleanup',
         'internal_canary_fixture_ic8_1', 'system', false, jsonb_build_object('rc', '7.1', 'test_fixture', true), now()
  from upd
  returning thread_key
)
select (select count(*) from upd) as threads_archived, (select count(*) from audit) as audit_rows;
-- expect 1 / 1 on the first run; 0 / 0 on a re-run.

rollback;   -- <- change to COMMIT only after the counts above match

-- ── 2. REVERT (if ever needed; reads the archived_reason marker) ───────────
-- update acquisition_opportunities set opportunity_status='active',
--   metadata = metadata - 'archived_reason' - 'archived_at', version = version + 1, updated_at = now()
-- where id in ('78e4cce2-c5fc-42b3-9923-f8ad3428dda2','bdd43b67-0ffc-4bac-ba2d-af9ef2d1d1a1')
--   and metadata->>'archived_reason' = 'internal_canary_fixture_ic8_1';
-- update inbox_thread_state set is_archived = false, updated_at = now() where thread_key = '6127433952';
