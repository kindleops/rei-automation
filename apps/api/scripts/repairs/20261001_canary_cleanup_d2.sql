-- ════════════════════════════════════════════════════════════════════════════
-- RC 7.1 D2 — internal canary deals: ARCHIVE + FLAG ONLY. Runbook step R3.
-- ════════════════════════════════════════════════════════════════════════════
-- Supersedes ~/.claude/jobs/c39b0175/tmp/rc/d2-canary-cleanup.sql. Changes:
--   * §1c (2157 N Dequincy, a REAL seller) is REMOVED from this file. It is the
--     owner-approved "Dequincy Option A (nurture, not lost)" and runs as its own
--     audited step with the nurture repair:
--     scripts/repairs/20261002_dequincy_option_a_nurture.mjs
--   * re-run safe: the archive and its audit row are ONE statement (writable
--     CTE: both land or neither), the audit insert is `on conflict
--     (idempotency_key) do nothing`, and every write is guarded by the exact id,
--     the current status and the canary provenance marker. A second run
--     archives 0 rows and writes 0 audit rows.
--   * thread archives now write one universal_lead_state_events audit row each.
-- No deletes. send_queue / message_events / history are ledgers: untouched.
-- Project lcppdrmrdfblstpcbgpf. Ends in ROLLBACK by default.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. PREVIEW (read-only; run first, compare with the runbook) ─────────────
select id, primary_property_id, master_owner_id, primary_thread_key, acquisition_stage,
       opportunity_status, next_action, next_action_due, version, updated_at
from acquisition_opportunities
where id in ('1cda1a2f-b34a-4031-9cd8-06992354b253',   -- canaryprop_offerauth_v2_75060, 0 Internal Canary Way
             'f554add3-4503-4454-bcd3-ea6b578ee8a2',   -- canaryprop_6bb8a464…, 4157 Pillsbury Ave S Unit B
             'b228d1d0-13a7-4241-b447-ea29e514ba0a');  -- thread-only canary, owner mo_canary_v2_3055376631
-- expect: 3 rows, all opportunity_status = 'active' (2026-10-02 06:55Z: versions 3, 41, 110)
select thread_key, is_archived from inbox_thread_state
where thread_key in ('+13059807795','6128072000','+16128072000','+13055376631');
-- expect: +13059807795 is_archived = false; the other three already true
-- must be 0 before applying (no live sends on any canary thread):
select count(*) live_sends from send_queue
where thread_key in ('+13059807795','6128072000','+16128072000','+13055376631')
  and queue_status in ('scheduled','queued','pending','approved','ready','processing','sending');

-- ── 1. APPLY (ends in ROLLBACK — change to COMMIT after the counts match) ───
begin;
set local lock_timeout = '5s';

-- 1a. Canary deals: archive + explicit test flag + audit row, atomically.
with upd as (
  update acquisition_opportunities o
  set opportunity_status  = 'archived',
      automation_state    = 'inactive',
      next_action         = null,
      next_action_due     = null,
      last_updated_source = 'operator_data_cleanup',
      last_updated_by     = 'rc7.1_canary_cleanup',
      metadata = coalesce(o.metadata, '{}'::jsonb) || jsonb_build_object(
        'test_fixture', true,
        'fixture_kind', 'internal_canary',
        'archived_reason', 'internal_canary_fixture_rc7_1',
        'archived_at', now()),
      version    = o.version + 1,
      updated_at = now()
  where o.id in ('1cda1a2f-b34a-4031-9cd8-06992354b253','f554add3-4503-4454-bcd3-ea6b578ee8a2','b228d1d0-13a7-4241-b447-ea29e514ba0a')
    and o.opportunity_status = 'active'
    and (
          o.primary_property_id like 'canaryprop\_%' or o.master_owner_id like 'mo\_canary\_%'
          -- b228d1d0 is the thread-only canary: owner and property are NULL on the
          -- deal (verified 2026-10-02), so the marker above evaluates NULL and the
          -- original d2 would have silently archived only 2 of 3. Guard it by its
          -- exact canary thread instead (owner mo_canary_v2_3055376631's number).
       or (o.id = 'b228d1d0-13a7-4241-b447-ea29e514ba0a' and o.primary_thread_key = '+13055376631'
           and o.master_owner_id is null and o.primary_property_id is null)
        )
  returning o.id
), audit as (
  insert into acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata, created_at)
  select id, 'opportunity_status_changed', 'opportunity_status', 'active', 'archived',
         'internal_canary_fixture_rc7_1', 'rc7.1_canary_cleanup', 'operator_data_cleanup',
         'rc71_canary_archive:' || id::text, jsonb_build_object('test_fixture', true), now()
  from upd
  on conflict (idempotency_key) do nothing
  returning opportunity_id
)
select (select count(*) from upd) as deals_archived, (select count(*) from audit) as audit_rows;
-- expect 3 / 3 on the first run; 0 / 0 on a re-run. STOP if the two numbers differ.

-- 1b. Canary threads out of the live inbox (reversible flag; no message touched) + audit.
with upd as (
  update inbox_thread_state
  set is_archived = true, updated_at = now()
  where thread_key in ('+13059807795','6128072000','+16128072000','+13055376631')
    and coalesce(is_archived, false) = false
  returning thread_key, property_id
), audit as (
  insert into universal_lead_state_events (thread_key, property_id, field_name, previous_value, new_value,
    operator_id, source_view, reason, change_source, executed_next_action, metadata, created_at)
  select thread_key, property_id, 'is_archived', 'false', 'true', null, 'rc71_canary_cleanup',
         'internal_canary_fixture_rc7_1', 'system', false, jsonb_build_object('rc', '7.1', 'test_fixture', true), now()
  from upd
  returning thread_key
)
select (select count(*) from upd) as threads_archived, (select count(*) from audit) as audit_rows;
-- expect 1 / 1 (+13059807795) on the first run; 0 / 0 on a re-run.

rollback;   -- <- change to COMMIT only after the counts above match

-- ── 2. REVERT (if ever needed; reads the archived_reason marker) ───────────
-- update acquisition_opportunities set opportunity_status = 'active',
--   metadata = metadata - 'archived_reason' - 'archived_at', version = version + 1, updated_at = now()
-- where id in ('1cda1a2f-b34a-4031-9cd8-06992354b253','f554add3-4503-4454-bcd3-ea6b578ee8a2','b228d1d0-13a7-4241-b447-ea29e514ba0a')
--   and metadata->>'archived_reason' = 'internal_canary_fixture_rc7_1';
-- update inbox_thread_state t set is_archived = false, updated_at = now()
--   from universal_lead_state_events e
--  where e.source_view = 'rc71_canary_cleanup' and e.thread_key = t.thread_key and e.reason = 'internal_canary_fixture_rc7_1';
