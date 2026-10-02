-- =============================================================================
-- send_queue access lockdown  (RC 7.1 / workstream C1)
-- STATUS: PROPOSED — NOT APPLIED. Owner approval required before apply.
-- Post-apply verification: supabase/tests/send_queue_rls_policy_test.sql
-- =============================================================================
--
-- CURRENT STATE (prod lcppdrmrdfblstpcbgpf, read from pg_policies /
-- role_table_grants / pg_proc.proacl on 2026-10-01):
--   RLS enabled (not forced).
--   Policies:
--     "Allow anon to insert into send_queue"   INSERT  anon           WITH CHECK true
--     "Allow anon to update send_queue"        UPDATE  anon           USING (queued & unlocked) OR (sending & locked) WITH CHECK true
--     "anon_select_send_queue"                 SELECT  anon           USING true
--     "Authenticated users can manage send_queue" ALL  authenticated  USING true
--     "Service role can manage send_queue"     ALL     service_role   USING true
--   Table grants: anon + authenticated hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE/
--   REFERENCES/TRIGGER (Supabase default). TRUNCATE is NOT governed by RLS.
--   Function EXECUTE (PUBLIC, anon, authenticated) on SECURITY INVOKER queue
--   mutators: claim_queue_jobs, mark_job_sent, mark_job_failed,
--   unlock_stale_jobs, queue_atomic_claim_send_row,
--   queue_guarded_mutate_scheduled_for, campaign_enqueue_next_touch.
--   Origin: migrations 20260508011554 allow_anon_send_queue_insert /
--   20260508012952..013005 fix_send_queue_rls_update_policy(_v2).
--
--   Net effect today: anyone holding the public anon key (shipped in the
--   dashboard bundle) can INSERT a queued SMS row, flip queued rows, TRUNCATE
--   the table, and call the claim/mark RPCs. Any Supabase Auth user (if
--   sign-ups are open) can do anything to the table.
--
-- WHO LEGITIMATELY WRITES send_queue (code audit, branch feat/mobile-product-v1):
--   * apps/api (Next.js, Cloudflare Worker -> Container) — service_role key only
--     (apps/api/src/lib/supabase/client.js; workflow-automation-activity-service.js).
--     Includes the queue runner / feeder / campaign scheduler / webhooks and the
--     operator action route POST /api/cockpit/queue/control (ensureMutationAuth).
--   * DB functions/triggers executed by service_role or postgres (pg_cron).
--   * apps/dashboard: NO direct writes. Every .from('send_queue') call in
--     apps/dashboard/src is a SELECT (propertyData, inboxWorkflowData, inboxData,
--     InboxPage, inboxBase, queueSearchProvider, MapEventCard,
--     ownership-check-template-picker, campaigns.adapter) plus realtime
--     postgres_changes subscriptions (SELECT-gated). The dashboard calls no RPC
--     that writes send_queue.
--
-- NEW STATE:
--   anon           no privileges at all (policy anon_select_send_queue dropped).
--   authenticated  SELECT only (dashboard reads + realtime). No write policy.
--   service_role   unchanged: ALL (bypasses RLS anyway).
--   Queue mutator RPCs: EXECUTE for service_role (and owner) only.
--
-- EXPECTED API BEHAVIOUR AFTER APPLY:
--   * apps/api, queue worker, operator queue control: unchanged (service_role).
--   * Dashboard reads / realtime: unchanged (authenticated SELECT kept).
--   * PostgREST with the anon key: every verb on /rest/v1/send_queue -> 42501.
--     With a user JWT: GET allowed; POST/PATCH/DELETE -> 42501.
--     POST /rest/v1/rpc/claim_queue_jobs etc. -> 42501 permission denied for function.
--
-- LOCKS: DROP/CREATE POLICY and GRANT/REVOKE take a brief ACCESS EXCLUSIVE /
--   SHARE ROW EXCLUSIVE lock on send_queue's catalog entry. Instant; run off-peak
--   (outside a feeder tick) with lock_timeout so it fails fast instead of queueing
--   behind the runner.
-- BACKFILL: none. No rows read or written.
--
-- ANON READ (owner-approved 2026-10-01): anon SELECT is removed too. Prod edge
-- logs (24h) show anon reads only from local QA browsers and proof scripts;
-- production operators read as authenticated.
--
-- ROLLBACK (restores today's exact state):
--   begin;
--   create policy "anon_select_send_queue" on public.send_queue for select to anon using (true);
--   grant select on public.send_queue to anon;
--   create policy "Allow anon to insert into send_queue" on public.send_queue
--     for insert to anon with check (true);
--   create policy "Allow anon to update send_queue" on public.send_queue
--     for update to anon
--     using (((queue_status = 'queued') and (is_locked = false)) or ((queue_status = 'sending') and (is_locked = true)))
--     with check (true);
--   drop policy if exists "Authenticated users can read send_queue" on public.send_queue;
--   create policy "Authenticated users can manage send_queue" on public.send_queue
--     for all to authenticated using (true);
--   grant insert, update, delete, truncate, references, trigger on public.send_queue to anon, authenticated;
--   grant execute on function public.claim_queue_jobs(integer, text),
--     public.mark_job_sent(uuid, text, text), public.mark_job_failed(uuid, text, text),
--     public.unlock_stale_jobs(integer),
--     public.queue_atomic_claim_send_row(uuid, text, uuid, text, text, uuid),
--     public.queue_guarded_mutate_scheduled_for(uuid[], timestamptz, text, jsonb),
--     public.campaign_enqueue_next_touch(text, text)
--     to public, anon, authenticated;
--   commit;
-- =============================================================================

begin;

set local lock_timeout = '5s';

-- 1. Remove every anonymous policy (write and read).
drop policy if exists "Allow anon to insert into send_queue" on public.send_queue;
drop policy if exists "Allow anon to update send_queue"      on public.send_queue;
drop policy if exists "anon_select_send_queue"               on public.send_queue;

-- 2. authenticated: ALL -> SELECT only.
drop policy if exists "Authenticated users can manage send_queue" on public.send_queue;
drop policy if exists "Authenticated users can read send_queue"   on public.send_queue;
create policy "Authenticated users can read send_queue"
  on public.send_queue for select to authenticated using (true);

-- 3. Table privileges: writes (incl. TRUNCATE, which RLS does not cover) are
--    service_role only.
revoke all on public.send_queue from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.send_queue from authenticated;
grant select on public.send_queue to authenticated;
grant all    on public.send_queue to service_role;

-- 4. SECURITY INVOKER queue mutators: no longer callable via PostgREST by
--    anon / authenticated (they are only called by apps/api with service_role;
--    none is called from another function or trigger).
revoke execute on function
  public.claim_queue_jobs(integer, text),
  public.mark_job_sent(uuid, text, text),
  public.mark_job_failed(uuid, text, text),
  public.unlock_stale_jobs(integer),
  public.queue_atomic_claim_send_row(uuid, text, uuid, text, text, uuid),
  public.queue_guarded_mutate_scheduled_for(uuid[], timestamptz, text, jsonb),
  public.campaign_enqueue_next_touch(text, text)
  from public, anon, authenticated;

grant execute on function
  public.claim_queue_jobs(integer, text),
  public.mark_job_sent(uuid, text, text),
  public.mark_job_failed(uuid, text, text),
  public.unlock_stale_jobs(integer),
  public.queue_atomic_claim_send_row(uuid, text, uuid, text, text, uuid),
  public.queue_guarded_mutate_scheduled_for(uuid[], timestamptz, text, jsonb),
  public.campaign_enqueue_next_touch(text, text)
  to service_role;

commit;
