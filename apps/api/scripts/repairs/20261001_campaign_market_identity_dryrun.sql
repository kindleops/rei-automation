-- RC 7.1 B1/B2 — campaign market identity + schedule timezone repair.
--
-- DRY RUN BY DEFAULT. Part 1 is a read-only SELECT: for every non-archived,
-- non-completed campaign with built targets it shows the market identity the
-- branch code (apps/api/src/lib/domain/campaigns/campaign-market-identity.js)
-- would record at the next Build, next to what the row holds today.
--
-- Part 2 (the APPLY) lives in 20261001_campaign_market_identity_APPLY.sql. It is owner-approved and
-- must run only AFTER the branch code is deployed (otherwise a builder autosave on
-- the old code can re-stamp the operator-browser zone). It writes campaigns.market,
-- campaigns.state and metadata.{market_identity, canonical_market_id(s),
-- recipient_timezones, timezone, launch_timezone, timezone_basis} — nothing else,
-- no targets, no queue rows, no status.
--
-- Authority: campaign_targets.market (canonical display names since the
-- 2026-09-24 backfill) joined to canonical_markets; campaign_targets.timezone
-- (property-derived IANA on every live campaign). Never campaign names.

-- ── Part 1: DRY RUN (read-only) ──────────────────────────────────────────────
with t as (
  select t.campaign_id, t.market, t.state, t.timezone
  from campaign_targets t
  join campaigns c on c.id = t.campaign_id
  where c.status not in ('archived', 'completed')
),
mk as (
  select t.campaign_id, t.market, min(t.state) as state, cm.id as canonical_market_id, count(*) as targets
  from t left join canonical_markets cm on cm.display_name = t.market
  where t.market is not null
  group by t.campaign_id, t.market, cm.id
),
tz as (
  select campaign_id, timezone, count(*) as targets
  from t
  where timezone like '%/%'
  group by campaign_id, timezone
),
ident as (
  select c.id,
    c.name,
    c.status,
    c.market as current_market,
    c.metadata->>'timezone' as current_timezone,
    (select count(*) from mk where mk.campaign_id = c.id) as n_markets,
    (select count(*) from tz where tz.campaign_id = c.id) as n_timezones,
    (select jsonb_agg(jsonb_build_object('market_name', mk.market, 'canonical_market_id', mk.canonical_market_id, 'state', mk.state, 'targets', mk.targets) order by mk.targets desc, mk.market) from mk where mk.campaign_id = c.id) as markets,
    (select jsonb_agg(jsonb_build_object('timezone', tz.timezone, 'targets', tz.targets) order by tz.targets desc, tz.timezone) from tz where tz.campaign_id = c.id) as timezones,
    (select count(*) from t where t.campaign_id = c.id) as target_count,
    (select count(*) from t where t.campaign_id = c.id and t.timezone not like '%/%') as label_timezone_targets
  from campaigns c
  where c.status not in ('archived', 'completed')
    and exists (select 1 from t where t.campaign_id = c.id)
)
select id, name, status,
  current_market,
  case when n_markets = 1 then markets->0->>'market_name' else null end as proposed_market,
  case when n_markets = 0 then 'unresolved' when n_markets = 1 then 'single_market' else 'multi_market' end as proposed_kind,
  current_timezone,
  case when n_timezones = 1 then timezones->0->>'timezone' else null end as proposed_timezone,
  case when n_timezones = 1 then 'single' when n_timezones > 1 then 'per_recipient' else 'unresolved' end as proposed_timezone_mode,
  n_markets, n_timezones, target_count, label_timezone_targets,
  (current_market is distinct from case when n_markets = 1 then markets->0->>'market_name' else null end) as market_changes,
  (current_timezone is distinct from case when n_timezones = 1 then timezones->0->>'timezone' else null end) as timezone_changes,
  markets, timezones
from ident
order by status, name;

-- ── Part 2: APPLY ────────────────────────────────────────────────────────────
-- Moved to 20261001_campaign_market_identity_APPLY.sql (owner-approved; runbook
-- step R1, first repair after deploy). That version is re-run safe (only
-- campaigns not yet stamped repaired_by; existing previous_* values are never
-- overwritten; previous_state is kept too) and writes one campaign_events row
-- ('campaign.market_identity_repaired') per touched campaign in the same
-- statement. It refuses without its session flag and ends in ROLLBACK.
