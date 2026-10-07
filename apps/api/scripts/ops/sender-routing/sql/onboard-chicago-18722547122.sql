-- SENDER ROUTING 2.0 r3 — ONBOARD +18722547122 (Chicago, IL). DRY-RUN BY DEFAULT. Owner-run.
-- NOT executed by this build.
--
-- Provider (TextGrid API GET, 2026-10-07, read-only): on the account as "CHICAGO",
-- campaignId CHM4NL2, sms_url https://ops.leadcommand.ai/api/webhooks/textgrid/inbound.
-- It was NOT in the owner's 18-number console list earlier on 2026-10-07: the owner
-- confirms in the TextGrid console (webhook + 10DLC CHM4NL2) before step 1.
-- Local: no textgrid_numbers row; zero message_events in either direction.
--
-- Lifecycle (existing fields only; textgrid_numbers.status CHECK allows active|paused):
--   CONFIGURING       local row, status paused, onboarding_stage 'configuring' (this file, step 1;
--                     the r3 seed writes the same row with ON CONFLICT DO NOTHING)
--   INBOUND_VERIFIED  owner texts the number from his own phone; inbound-proof.mjs PASSES; step 2
--   ACTIVE            ONLY via activate-number.mjs --number=+18722547122 (re-reads TextGrid
--                     campaign + webhook and the inbound proof immediately before printing the
--                     guarded activation SQL; status active; daily_limit 800)
-- Paused / pre-production rows are refused by BOTH routers (legacy: status paused; v2:
-- onboarding_incomplete), so no seller traffic before ACTIVE.
-- DAILY LIMIT: 800 = the fleet standard (system_control queue_per_number_cap). The owner
-- rejected low warm-up limits (25/day, 2026-10-03).
--
-- Usage (each step separately; the proof must pass between 1 and 2):
--   psql "$DB" -v step=configuring      -v actor="'owner:…'"                                 -f onboard-chicago-18722547122.sql
--   psql "$DB" -v step=inbound_verified -v actor="'owner:…'" -v proof_at="'2026-10-0XT..Z'" -f onboard-chicago-18722547122.sql
--   node --import ./scripts/register-aliases-ops.mjs scripts/ops/sender-routing/activate-number.mjs --number=+18722547122
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
\if :{?commit}
\else
  \set commit 'dry_run'
\endif

begin;

select phone_number, status, metadata->>'onboarding_stage' as stage
  from public.textgrid_numbers where phone_number = '+18722547122';

select :'step' = 'configuring' as is_configuring \gset
\if :is_configuring
insert into public.textgrid_numbers (phone_number, friendly_name, market, status, health_state, registration_status, daily_limit, messages_sent_today, metadata)
values ('+18722547122', 'CHICAGO', 'Chicago, IL', 'paused', 'unverified', 'registered', 800, 0,
  jsonb_build_object('market', 'Chicago, IL', 'friendly_name', 'CHICAGO', 'campaign_id_10dlc', 'CHM4NL2',
    'onboarding_stage', 'configuring', 'sms_webhook_status', 'configured', 'provider_checked_at', '2026-10-07',
    'onboarded_by', :actor))
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
 where phone_number = '+18722547122' and metadata->>'onboarding_stage' = 'configuring';
\endif

select phone_number, status, daily_limit, registration_status, metadata->>'onboarding_stage' as stage, metadata->>'sms_webhook_status' as webhook
  from public.textgrid_numbers where phone_number = '+18722547122';

select :'commit' = 'owner_approved' as do_commit \gset
\if :do_commit
commit;
\else
\echo 'DRY RUN: rolled back. Pass -v commit=owner_approved to keep it.'
rollback;
\endif
