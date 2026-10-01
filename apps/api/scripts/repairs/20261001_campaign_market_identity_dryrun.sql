-- RC 7.1 B1/B2 — campaign market identity + schedule timezone repair.
--
-- DRY RUN BY DEFAULT. Part 1 is a read-only SELECT: for every non-archived,
-- non-completed campaign with built targets it shows the market identity the
-- branch code (apps/api/src/lib/domain/campaigns/campaign-market-identity.js)
-- would record at the next Build, next to what the row holds today.
--
-- Part 2 (the APPLY block) is commented out. It needs explicit owner approval and
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

-- ── Part 2: APPLY (owner approval required; run after deploy) ───────────────
-- begin;
-- with t as (
--   select t.campaign_id, t.market, t.state, t.timezone
--   from campaign_targets t join campaigns c on c.id = t.campaign_id
--   where c.status not in ('archived', 'completed')
-- ),
-- mk as (
--   select t.campaign_id, t.market, min(t.state) state, cm.id canonical_market_id, count(*) targets
--   from t left join canonical_markets cm on cm.display_name = t.market
--   where t.market is not null group by 1, 2, 4
-- ),
-- tz as (select campaign_id, timezone, count(*) targets from t where timezone like '%/%' group by 1, 2),
-- ident as (
--   select c.id,
--     (select count(*) from mk where mk.campaign_id = c.id) n_markets,
--     (select count(*) from tz where tz.campaign_id = c.id) n_tz,
--     coalesce((select jsonb_agg(jsonb_build_object('market_name', market, 'canonical_market_id', canonical_market_id, 'state', state, 'targets', targets) order by targets desc, market) from mk where mk.campaign_id = c.id), '[]') markets,
--     coalesce((select jsonb_agg(jsonb_build_object('timezone', timezone, 'targets', targets) order by targets desc, timezone) from tz where tz.campaign_id = c.id), '[]') timezones,
--     (select count(*) from t where t.campaign_id = c.id) target_count
--   from campaigns c
--   where c.status not in ('archived', 'completed') and exists (select 1 from t where t.campaign_id = c.id)
-- )
-- update campaigns c set
--   market = case when i.n_markets = 1 then i.markets->0->>'market_name' else null end,
--   state  = case when i.n_markets = 1 then i.markets->0->>'state' else null end,
--   metadata = c.metadata
--     || jsonb_build_object(
--          'market_identity', jsonb_build_object(
--             'version', 'campaign_market_identity_v1', 'basis', 'campaign_targets', 'derived_at', now(),
--             'kind', case when i.n_markets = 0 then 'unresolved' when i.n_markets = 1 then 'single_market' else 'multi_market' end,
--             'target_count', i.target_count, 'markets', i.markets, 'timezones', i.timezones,
--             'timezone_mode', case when i.n_tz = 1 then 'single' when i.n_tz > 1 then 'per_recipient' else 'unresolved' end,
--             'repaired_by', 'rc71_campaign_market_identity'),
--          'canonical_market_id', case when i.n_markets = 1 then i.markets->0->'canonical_market_id' else 'null'::jsonb end,
--          'canonical_market_ids', (select coalesce(jsonb_agg(m->'canonical_market_id'), '[]') from jsonb_array_elements(i.markets) m where m->>'canonical_market_id' is not null),
--          'recipient_timezones', (select coalesce(jsonb_agg(z->'timezone'), '[]') from jsonb_array_elements(i.timezones) z),
--          'previous_timezone', c.metadata->'timezone',
--          'previous_market', to_jsonb(c.market))
--     || case when i.n_tz = 1 then jsonb_build_object('timezone', i.timezones->0->'timezone', 'launch_timezone', i.timezones->0->'timezone', 'timezone_basis', 'campaign_targets')
--             when i.n_tz > 1 then jsonb_build_object('timezone', null, 'launch_timezone', null, 'timezone_basis', 'per_recipient')
--             else '{}'::jsonb end,
--   updated_at = now()
-- from ident i
-- where c.id = i.id;
-- -- Rollback data: metadata.previous_market / metadata.previous_timezone on every touched row.
-- commit;
