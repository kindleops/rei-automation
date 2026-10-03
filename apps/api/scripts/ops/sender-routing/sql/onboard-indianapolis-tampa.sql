-- SENDER ROUTING 2.0 — ONBOARD +13173494612 (Indianapolis) and +18138947553 (Tampa).
-- DRY-RUN-ONLY BY DEFAULT. Owner-run. NOT executed by this build.
--
-- Lifecycle (existing fields only; textgrid_numbers.status CHECK allows active|paused):
--   DISCOVERED        provider only (today)
--   CONFIGURING       local row, status paused, metadata.onboarding_stage 'configuring'
--   INBOUND_VERIFIED  owner sent the test text; inbound-proof.mjs PASSED; stage 'inbound_verified'
--   ACTIVE            status active, daily_limit 25 (owner: fixed, no warm-up algorithm), joins its
--                     pool. ONLY via scripts/ops/sender-routing/activate-number.mjs, which re-reads the
--                     TextGrid campaign + webhook and re-verifies inbound immediately before printing
--                     the guarded activation SQL. This file never activates.
-- CONFIGURING sets daily_limit 25 (column is NOT NULL in prod; verified 2026-10-03). Safe while
-- paused: every picker filters status='active' (rc-7.1 textgridRouting.ts .eq('status','active')).
-- Paused / pre-production stages are refused by BOTH routers (legacy: status paused;
-- Sender Routing 2.0: onboarding_incomplete), so no seller traffic before WARMING.
--
-- DAILY LIMIT: 25 per number, fixed (owner decision 2026-10-02). There is no warm-up
-- algorithm; raising it later is a separate owner decision.
--
-- Usage (each step separately, in order; the proof must pass between 1 and 2):
--   psql "$DB" -v step=configuring      -v actor="'owner@…'"                 -f onboard-indianapolis-tampa.sql
--   psql "$DB" -v step=inbound_verified -v actor="'owner@…'" -v proof_at="'2026-10-0XT..Z'" -f …
--   then: node scripts/ops/sender-routing/activate-number.mjs --number=+13173494612 (and Tampa)
-- Every run ends in ROLLBACK unless -v commit=owner_approved is passed.

\set ON_ERROR_STOP on
\if :{?step}
\else
  \echo 'set -v step=configuring|inbound_verified (activation: activate-number.mjs)'
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
  ('+13173494612', 'INDIANAPOLIS', 'Indianapolis, IN', 'paused', 'unverified', 'registered', 25, 0,
   jsonb_build_object('market', 'Indianapolis, IN', 'friendly_name', 'INDIANAPOLIS', 'campaign_id_10dlc', 'CHM4NL2',
     'onboarding_stage', 'configuring', 'sms_webhook_status', 'configured', 'provider_checked_at', '2026-10-02',
     'onboarded_by', :actor, 'provider_purchased_at', '2026-06-04')),
  ('+18138947553', 'TAMPA, FL', 'Tampa, FL', 'paused', 'unverified', 'registered', 25, 0,
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

select phone_number, status, daily_limit, registration_status, metadata->>'onboarding_stage' as stage, metadata->>'sms_webhook_status' as webhook
  from public.textgrid_numbers where phone_number in ('+13173494612', '+18138947553');

select :'commit' = 'owner_approved' as do_commit \gset
\if :do_commit
commit;
\else
\echo 'DRY RUN: rolled back. Pass -v commit=owner_approved to keep it.'
rollback;
\endif
