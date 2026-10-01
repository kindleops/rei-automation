-- =============================================================================
-- Public-schema write lockdown  (RC 7.1 / workstream C1, BLOCKER-class tables)
-- STATUS: PROPOSED — NOT APPLIED. Owner approval required before apply.
-- Apply AFTER 20261001120000_send_queue_rls_lockdown.sql.
-- Post-apply verification: supabase/tests/public_write_lockdown_policy_test.sql
-- =============================================================================
--
-- CURRENT STATE (prod lcppdrmrdfblstpcbgpf, catalog read 2026-10-01)
--   A. RLS DISABLED, no policies, and anon + authenticated hold
--      SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER. Anyone with the
--      public anon key can read, rewrite or truncate them:
--        queue_global_execution_lock, queue_canary_authorizations,
--        acquisition_opportunities, acquisition_opportunity_history,
--        acquisition_score_snapshots, buyer_offers, buyer_agreements,
--        emd_receipts, settlement_records, seller_automation_executions,
--        seller_automation_execution_steps, seller_followup_state,
--        contact_property_resolution, thread_identity_binding,
--        workflow_scheduled_tasks
--      All are owned by postgres. The only other grantees are postgres and
--      service_role, and both have BYPASSRLS, so enabling RLS cannot affect them.
--   B. sms_templates: RLS on. Policies:
--        "Service role has full access to templates"  ALL  to public
--            USING (auth.role() = 'service_role')
--        "anon_select_sms_templates"                  SELECT to anon USING true
--      The first policy is NOT an anon write hole: auth.role() comes from the
--      verified JWT. An earlier scan flagged it only because it is granted to
--      `public`. The real exposure is the table GRANTS: anon and authenticated
--      hold INSERT/UPDATE/DELETE/TRUNCATE, and RLS does not cover TRUNCATE.
--      There is also NO authenticated SELECT policy, so the dashboard's
--      signed-in read (acquisitionData.ts:625, inboxData.ts:4786) gets 0 rows.
--   C. message_events: RLS on. Policies:
--        "Allow anon to insert message_events"           INSERT to anon WITH CHECK true
--        "Authenticated users can insert message_events" INSERT to authenticated WITH CHECK true
--        "Authenticated users can read message_events"   SELECT to authenticated
--        "anon_select_message_events"                    SELECT to anon
--        "Service role can manage message_events"        ALL to service_role
--      anon and authenticated also hold UPDATE/DELETE/TRUNCATE grants.
--   D. SECURITY INVOKER functions that write the tables above, all EXECUTE-able
--      by PUBLIC/anon/authenticated through PostgREST:
--        queue_acquire_global_execution_lock, queue_release_global_execution_lock,
--        backfill_acquisition_opportunities_from_threads,
--        reconcile_acquisition_opportunities_from_canonical_truth,
--        apply_template_quarantine, bulk_import_templates, log_message_event
--      Callers: apps/api (service role). Two are also called by other invoker
--      functions: log_message_event by campaign_enqueue_next_touch (which
--      20261001120000 makes service_role-only), and
--      reconcile_acquisition_opportunities_from_canonical_truth by
--      report_pipeline_reconciliation_counts (called from apps/api only).
--      No pg_cron job calls any of them.
--
-- WHO WRITES THESE TABLES (code audit, branch feat/mobile-product-v1)
--   * apps/api: service_role only (apps/api/src/lib/supabase/client.js,
--     workflow-automation-activity-service.js).
--   * infra/cloudflare/worker/index.ts: forwards SUPABASE_SERVICE_ROLE_KEY and
--     SUPABASE_DB_URL. Its mentions of acquisition_opportunities and
--     workflow_scheduled_tasks are comments.
--   * supabase/functions/rei-import: service role; writes import_log only.
--   * apps/dashboard/src writes NONE of these tables. Its direct writes are, in
--     full:
--       notification_watchlist  (lib/data/watchlistData.ts:68,73,94)
--       inbox_activity_events   (lib/data/inboxActivityData.ts:39)
--       buyer_match_candidates  (modules/inbox/components/BuyerMatchWorkspace.tsx:2917,2925;
--                                views/buyer-match/buyer-match-actions.ts:49)
--     Those three are EXCLUDED here and are not touched. None of them has a
--     trigger that writes a table in this file.
--   * Dashboard READS of the tables in this file, with the user JWT, which must
--     keep working:
--       message_events (about 30 select sites + realtime), sms_templates (select),
--       acquisition_opportunities (realtime, usePipelineOpportunities.ts:278),
--       seller_automation_executions / _steps (realtime,
--       views/workflow-studio/sellerAutomationRealtime.ts:79,100; both are in
--       the supabase_realtime publication).
--     Realtime applies RLS SELECT for the subscriber, so every table in group A
--     gets an authenticated SELECT policy. That keeps today's signed-in read
--     surface exactly as it is: views and invoker functions over these tables
--     keep working for signed-in users.
--
-- NEW STATE
--   A (15 tables): RLS ENABLED. authenticated: SELECT only (policy USING true).
--      anon: no privileges at all. service_role: ALL (bypasses RLS).
--   B sms_templates: authenticated SELECT policy added (fixes the empty read).
--      anon SELECT policy dropped and anon fully revoked. authenticated keeps
--      SELECT only. The service-role policy is unchanged.
--   C message_events: both INSERT policies dropped (anon, authenticated).
--      INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER revoked from anon and
--      authenticated. SELECT is unchanged for both (anon SELECT is an owner
--      follow-up, same as send_queue; conversation_detail_view is a
--      security_invoker view that anon can select).
--   D EXECUTE on the 7 writer functions: service_role only.
--
-- EXPECTED API BEHAVIOUR AFTER APPLY
--   * apps/api, Cloudflare worker, queue runner, edge function: unchanged
--     (service_role or postgres).
--   * Dashboard, signed in: unchanged reads and realtime. The sms_templates read
--     starts returning rows.
--   * PostgREST with the anon key, any table above: 401/42501 on every verb
--     (message_events SELECT still allowed).
--     With a user JWT: SELECT allowed; POST/PATCH/DELETE give 42501.
--     RPCs in D give 42501 for anon and authenticated.
--
-- LOCKS: ENABLE ROW LEVEL SECURITY and CREATE/DROP POLICY take ACCESS EXCLUSIVE
--   on each table, held for milliseconds. Every statement is under a 5s
--   lock_timeout, so the migration aborts (and rolls back as a whole) instead
--   of queueing behind a long runner transaction. Run between feeder ticks.
-- BACKFILL / WRITES TO EXISTING ROWS: none.
--
-- ROLLBACK (restores today's exact state):
--   begin;
--   do $$ declare t text; begin
--     foreach t in array array['queue_global_execution_lock','queue_canary_authorizations',
--       'acquisition_opportunities','acquisition_opportunity_history','acquisition_score_snapshots',
--       'buyer_offers','buyer_agreements','emd_receipts','settlement_records',
--       'seller_automation_executions','seller_automation_execution_steps','seller_followup_state',
--       'contact_property_resolution','thread_identity_binding','workflow_scheduled_tasks'] loop
--       execute format('drop policy if exists %I on public.%I', t || '_authenticated_read', t);
--       execute format('alter table public.%I disable row level security', t);
--       execute format('grant all on public.%I to anon, authenticated', t);
--     end loop; end $$;
--   drop policy if exists "sms_templates_authenticated_read" on public.sms_templates;
--   create policy "anon_select_sms_templates" on public.sms_templates for select to anon using (true);
--   grant all on public.sms_templates to anon, authenticated;
--   create policy "Allow anon to insert message_events" on public.message_events
--     for insert to anon with check (true);
--   create policy "Authenticated users can insert message_events" on public.message_events
--     for insert to authenticated with check (true);
--   grant all on public.message_events to anon, authenticated;
--   grant execute on function
--     public.queue_acquire_global_execution_lock(text, uuid, text, text, integer),
--     public.queue_release_global_execution_lock(uuid),
--     public.backfill_acquisition_opportunities_from_threads(),
--     public.reconcile_acquisition_opportunities_from_canonical_truth(),
--     public.apply_template_quarantine(integer, numeric, integer, numeric, boolean),
--     public.bulk_import_templates(jsonb),
--     public.log_message_event(text, text, integer, text, text, text)
--     to public, anon, authenticated;
--   commit;
-- =============================================================================

begin;
set local lock_timeout = '5s';

-- A. RLS-off tables -------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'queue_global_execution_lock', 'queue_canary_authorizations',
    'acquisition_opportunities', 'acquisition_opportunity_history', 'acquisition_score_snapshots',
    'buyer_offers', 'buyer_agreements', 'emd_receipts', 'settlement_records',
    'seller_automation_executions', 'seller_automation_execution_steps', 'seller_followup_state',
    'contact_property_resolution', 'thread_identity_binding', 'workflow_scheduled_tasks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)',
                   t || '_authenticated_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- B. sms_templates --------------------------------------------------------------
drop policy if exists "anon_select_sms_templates"        on public.sms_templates;
drop policy if exists "sms_templates_authenticated_read" on public.sms_templates;
create policy "sms_templates_authenticated_read"
  on public.sms_templates for select to authenticated using (true);
revoke all on public.sms_templates from anon;
revoke insert, update, delete, truncate, references, trigger on public.sms_templates from authenticated;
grant select on public.sms_templates to authenticated;
grant all    on public.sms_templates to service_role;

-- C. message_events -------------------------------------------------------------
drop policy if exists "Allow anon to insert message_events"           on public.message_events;
drop policy if exists "Authenticated users can insert message_events" on public.message_events;
revoke insert, update, delete, truncate, references, trigger on public.message_events from anon, authenticated;
grant all on public.message_events to service_role;

-- D. SECURITY INVOKER writer RPCs ----------------------------------------------
revoke execute on function
  public.queue_acquire_global_execution_lock(text, uuid, text, text, integer),
  public.queue_release_global_execution_lock(uuid),
  public.backfill_acquisition_opportunities_from_threads(),
  public.reconcile_acquisition_opportunities_from_canonical_truth(),
  public.apply_template_quarantine(integer, numeric, integer, numeric, boolean),
  public.bulk_import_templates(jsonb),
  public.log_message_event(text, text, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.queue_acquire_global_execution_lock(text, uuid, text, text, integer),
  public.queue_release_global_execution_lock(uuid),
  public.backfill_acquisition_opportunities_from_threads(),
  public.reconcile_acquisition_opportunities_from_canonical_truth(),
  public.apply_template_quarantine(integer, numeric, integer, numeric, boolean),
  public.bulk_import_templates(jsonb),
  public.log_message_event(text, text, integer, text, text, text)
  to service_role;

commit;
