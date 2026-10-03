-- SENDER ROUTING 2.0 — ONBOARD +13173494612 (Indianapolis) and +18138947553 (Tampa).
-- DRY-RUN-ONLY BY DEFAULT. Owner-run. NOT executed by this build.
--
-- Lifecycle (existing fields only; textgrid_numbers.status CHECK allows active|paused):
--   DISCOVERED        provider only (today)
--   CONFIGURING       local row, status paused, metadata.onboarding_stage 'configuring'
--   INBOUND_VERIFIED  owner sent the test text; inbound-proof.mjs PASSED; stage 'inbound_verified'
--   WARMING           status active, stage 'warming', daily_limit = the warm-up limit, joins its pool
--   ACTIVE            stage 'active', daily_limit = the fleet's per-number limit
-- CONFIGURING sets daily_limit NULL (the legacy evaluator reads NULL as 0 = refused, and
-- textgrid_numbers_dashboard divides by daily_limit, so 0 would raise division by zero).
-- Paused / pre-production stages are refused by BOTH routers (legacy: status paused;
-- Sender Routing 2.0: onboarding_incomplete), so no seller traffic before WARMING.
--
-- WARM-UP LIMIT: the codebase has NO warm-up daily-limit policy (searched 2026-10-02:
-- no warm-up limit in code, config, system_control or history; every number carries
-- daily_limit 800 = system_control.queue_per_number_cap). This script therefore
-- REQUIRES the owner to pass it (-v warmup_limit=N); it never invents one.
--
-- Usage (each step separately, in order; the proof must pass between 1 and 2):
--   psql "$DB" -v step=configuring      -v actor="'owner@…'"                 -f onboard-indianapolis-tampa.sql
--   psql "$DB" -v step=inbound_verified -v actor="'owner@…'" -v proof_at="'2026-10-0XT..Z'" -f …
--   psql "$DB" -v step=warming          -v actor="'owner@…'" -v warmup_limit=N -f …
--   psql "$DB" -v step=active           -v actor="'owner@…'" -f …
-- Every run ends in ROLLBACK unless -v commit=owner_approved is passed.

\set ON_ERROR_STOP on
\if :{?step}
\else
  \echo 'set -v step=configuring|inbound_verified|warming|active'
  \quit
\endif
\if :{?actor}
\else
  \echo 'set -v actor=...'
  \quit
\endif

begin;

\if :{?commit}
\else
  \set commit 'dry_run'
\endif

-- Refuse duplicates up front: a number may exist once.
select phone_number, status, metadata->>'onboarding_stage' as stage
  from public.textgrid_numbers where phone_number in ('+13173494612', '+18138947553');

select :'step' = 'configuring' as is_configuring \gset
\if :is_configuring
insert into public.textgrid_numbers (phone_number, friendly_name, market, status, health_state, registration_status, daily_limit, messages_sent_today, metadata)
values
  ('+13173494612', 'INDIANAPOLIS', 'Indianapolis, IN', 'paused', 'unverified', 'registered', null, 0,
   jsonb_build_object('market', 'Indianapolis, IN', 'friendly_name', 'INDIANAPOLIS', 'campaign_id_10dlc', 'CHM4NL2',
     'onboarding_stage', 'configuring', 'sms_webhook_status', 'configured', 'provider_checked_at', '2026-10-02',
     'onboarded_by', :actor, 'provider_purchased_at', '2026-06-04')),
  ('+18138947553', 'TAMPA, FL', 'Tampa, FL', 'paused', 'unverified', 'registered', null, 0,
   jsonb_build_object('market', 'Tampa, FL', 'friendly_name', 'TAMPA, FL', 'campaign_id_10dlc', 'CHM4NL2',
     'onboarding_stage', 'configuring', 'sms_webhook_status', 'configured', 'provider_checked_at', '2026-10-02',
     'onboarded_by', :actor, 'provider_purchased_at', '2026-06-04'))
on conflict (phone_number) do nothing;
\endif

select :'step' = 'inbound_verified' as is_verified \gset
\if :is_verified
\if :{?proof_at}
\else
  \echo 'inbound_verified needs -v proof_at=<timestamp printed by inbound-proof.mjs PASS>'
  rollback;
  \quit
\endif
update public.textgrid_numbers
   set metadata = metadata || jsonb_build_object('onboarding_stage', 'inbound_verified', 'sms_webhook_status', 'verified',
                                                  'inbound_verified_at', :proof_at, 'inbound_verified_by', :actor)
 where phone_number in ('+13173494612', '+18138947553') and metadata->>'onboarding_stage' = 'configuring';
\endif

select :'step' = 'warming' as is_warming \gset
\if :is_warming
\if :{?warmup_limit}
\else
  \echo 'warming needs -v warmup_limit=N (no warm-up policy exists; the owner sets it)'
  rollback;
  \quit
\endif
update public.textgrid_numbers
   set status = 'active', daily_limit = :warmup_limit,
       metadata = metadata || jsonb_build_object('onboarding_stage', 'warming', 'warmup_daily_limit', :warmup_limit, 'warming_since', now())
 where phone_number in ('+13173494612', '+18138947553') and metadata->>'onboarding_stage' = 'inbound_verified';
-- pool membership (only if the Sender Routing 2.0 schema is applied)
set local sender_routing.actor = :actor;
do $$ begin
  if to_regclass('public.sender_pool_numbers') is not null then
    insert into public.sender_pool_numbers (sender_pool_id, textgrid_number_id)
    select sp.id, tn.id from public.sender_pools sp join public.textgrid_numbers tn
      on (sp.pool_key = 'indianapolis' and tn.phone_number = '+13173494612') or (sp.pool_key = 'tampa' and tn.phone_number = '+18138947553')
    on conflict (textgrid_number_id) do nothing;
    insert into public.sender_routing_audit (graph_version, event_type, actor, reason, subject)
    values (nextval('public.sender_routing_graph_version_seq'), 'activation', current_setting('sender_routing.actor', true), 'warming: pool membership', '{"numbers":["+13173494612","+18138947553"]}'::jsonb);
  end if;
end $$;
\endif

select :'step' = 'active' as is_active \gset
\if :is_active
update public.textgrid_numbers tn
   set daily_limit = coalesce(nullif((select value from public.system_control where key = 'queue_per_number_cap'), '')::int, 800),
       metadata = tn.metadata || jsonb_build_object('onboarding_stage', 'active', 'activated_at', now())
 where phone_number in ('+13173494612', '+18138947553') and metadata->>'onboarding_stage' = 'warming';
\endif

select phone_number, status, daily_limit, registration_status, metadata->>'onboarding_stage' as stage, metadata->>'sms_webhook_status' as webhook
  from public.textgrid_numbers where phone_number in ('+13173494612', '+18138947553');

select :'commit' = 'owner_approved' as do_commit \gset
\if :do_commit
commit;
\else
\echo 'DRY RUN: rolled back. Pass -v commit=owner_approved to keep it.'
rollback;
\endif
