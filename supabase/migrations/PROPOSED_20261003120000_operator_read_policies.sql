-- =============================================================================
-- Operator read policies: give allowlisted operators back their direct dashboard reads
-- STATUS: PROPOSED. NOT APPLIED. Apply only with the owner present.
-- Pretest (rollback-only):  supabase/tests/operator_read_policies_test.sql
-- Rollback:                 supabase/rollbacks/PROPOSED_20261003120000_operator_read_policies.rollback.sql
-- =============================================================================
--
-- WHY
--   Since 2026-09-21 the dashboard's browser client (apps/dashboard/src/lib/
--   supabaseClient.ts, persistSession: true) sends the operator's user JWT, so
--   PostgREST runs every direct read as role `authenticated`. Those tables only had
--   anon read policies, service_role policies, or no policy at all. RLS returned
--   0 rows with no error, so it failed silently. Measured on prod (lcppdrmrdfblstpcbgpf)
--   2026-10-03 with `set local role authenticated` plus real operator claims:
--     EMPTY  (service sees rows, authenticated sees 0): properties, prospects,
--            master_owners, phones, emails, campaigns, campaign_targets,
--            recently_sold_properties, sms_suppression_list, sub_owners,
--            thread_ai_state
--     DENIED (no SELECT grant for authenticated, 42501): campaign_target_graph,
--            property_acquisition_scores, universal_lead_command_cache
--     Currently empty tables with no authenticated policy, included so they do
--     not go silent once populated: property_cash_offer_snapshots,
--     sms_campaign_targets
--   The SECURITY INVOKER RPCs get_comp_candidates_for_subject and
--   get_buyers_for_property read `properties`, so they also return 0 rows for
--   operators. This migration fixes them too; the RPCs themselves are unchanged.
--
-- DESIGN
--   * public.ops_operators is the canonical DB allowlist. It mirrors the Worker
--     secret OPS_ALLOWED_USER_IDS (infra/cloudflare/worker/index.ts). RLS is on
--     with NO policies and no anon/authenticated grants, so only service_role and
--     postgres can read or change it.
--   * public.is_ops_operator() is SECURITY DEFINER, STABLE, search_path=''.
--     It returns true when auth.uid() is in ops_operators.
--   * Per relation: one permissive policy, FOR SELECT TO authenticated USING
--     ((select public.is_ops_operator())). The scalar-subquery wrapper makes the
--     planner hoist it into an InitPlan, which runs once per query as a
--     One-Time Filter. It is not evaluated per row, and index use on the user's
--     quals is unaffected.
--   * GRANT SELECT only where it was missing (the three DENIED tables).
--   * This migration grants NO INSERT/UPDATE/DELETE. It adds NO write policy and
--     touches NOTHING for anon (the RC 7.1 and Map lockdowns stand). It does not
--     touch send_queue or message_events.
--   * An authenticated user who is NOT in ops_operators still sees 0 rows.
--
-- SEED
--   a2ee0ffe-6f27-475b-a795-ee617c9472c6 is the only auth.users row that has ever
--   signed in (last sign-in 2026-10-03), and the Worker-gated API works for that
--   session, so it must be in OPS_ALLOWED_USER_IDS.
--   3d9faeb0-391a-4099-a8be-f9bb49df3947 exists in auth.users but has never signed
--   in. The Worker secret cannot be read back, so its membership is UNCONFIRMED.
--   It is left commented out. Owner: uncomment only if that ID is in
--   OPS_ALLOWED_USER_IDS. Keep this table and that secret in lockstep from now on.
--
-- LOCKS
--   CREATE POLICY / GRANT take a brief ACCESS EXCLUSIVE lock per table.
--   properties and campaign_target_graph are read constantly by the API.
--   lock_timeout makes the run fail fast instead of queueing behind long readers.
--   Run off-peak. No rows are read or rewritten (no backfill).
-- =============================================================================

set local lock_timeout = '5s';

-- ------------------------------------------------------------ allowlist ----
create table if not exists public.ops_operators (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  label      text,
  added_at   timestamptz not null default now(),
  added_by   text not null default current_user
);

comment on table public.ops_operators is
  'Canonical operator allowlist for direct dashboard reads under RLS. Mirror of the Worker secret OPS_ALLOWED_USER_IDS; keep both in lockstep. Writable only by service_role/postgres.';

alter table public.ops_operators enable row level security;
revoke all on table public.ops_operators from public, anon, authenticated;

insert into public.ops_operators (user_id, label)
select v.user_id, v.label
from (values
  ('a2ee0ffe-6f27-475b-a795-ee617c9472c6'::uuid, 'owner (only signed-in operator, verified 2026-10-03)')
  -- , ('3d9faeb0-391a-4099-a8be-f9bb49df3947'::uuid, 'UNCONFIRMED: add only if in OPS_ALLOWED_USER_IDS')
) as v(user_id, label)
where exists (select 1 from auth.users u where u.id = v.user_id)
on conflict (user_id) do nothing;

-- --------------------------------------------------------------- helper ----
create or replace function public.is_ops_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.ops_operators o where o.user_id = (select auth.uid())
  );
$$;

comment on function public.is_ops_operator() is
  'True when the JWT subject is an allowlisted operator (public.ops_operators). Use in policies as (select public.is_ops_operator()) so it is evaluated once per query.';

revoke all on function public.is_ops_operator() from public, anon;
grant execute on function public.is_ops_operator() to authenticated, service_role;

-- ----------------------------------------------- grants where missing ----
grant select on table public.campaign_target_graph        to authenticated;
grant select on table public.property_acquisition_scores  to authenticated;
grant select on table public.universal_lead_command_cache to authenticated;

-- ------------------------------------------------------------- policies ----
do $$
declare
  rel text;
  rels text[] := array[
    'properties',
    'prospects',
    'master_owners',
    'phones',
    'emails',
    'campaigns',
    'campaign_targets',
    'campaign_target_graph',
    'recently_sold_properties',
    'sms_suppression_list',
    'sub_owners',
    'thread_ai_state',
    'property_acquisition_scores',
    'universal_lead_command_cache',
    'property_cash_offer_snapshots',
    'sms_campaign_targets'
  ];
begin
  foreach rel in array rels loop
    if to_regclass('public.' || rel) is null then
      raise exception 'operator_read_policies: public.% does not exist; refusing partial apply', rel;
    end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || rel)::regclass) then
      raise exception 'operator_read_policies: RLS is OFF on public.%; a policy would be inert, refusing', rel;
    end if;
    execute format('drop policy if exists ops_operator_read on public.%I', rel);
    execute format(
      'create policy ops_operator_read on public.%I as permissive for select to authenticated using ((select public.is_ops_operator()))',
      rel
    );
  end loop;
end
$$;
