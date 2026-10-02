-- ════════════════════════════════════════════════════════════════════════════
-- RC 7.1 B1/B2 — APPLY: campaign market identity + schedule timezone repair
-- ════════════════════════════════════════════════════════════════════════════
-- OWNER-APPROVED (RC 7.1 approvals: "campaign market identity" is on the
-- approved post-deploy repair list). Runbook step R1, FIRST repair after deploy.
-- Run ONLY after the branch code is deployed (/api/version = RC_SHA): on the old
-- code a builder autosave can re-stamp the operator-browser zone.
-- Preview first: 20261001_campaign_market_identity_dryrun.sql (Part 1) — the
-- number of rows it returns is the expected `repaired` count below.
--
-- Refuses unless, in the SAME transaction:
--   set local rc71.market_identity_apply = 'apply-market-identity';
-- Ends in ROLLBACK by default: change the last line to COMMIT only after the
-- printed counts match the preview.
--
-- Writes (one statement — the update and its audit rows land together):
--   campaigns.market / campaigns.state (single-market cohorts only; cleared for
--   multi-market), metadata.{market_identity, canonical_market_id(s),
--   recipient_timezones, timezone, launch_timezone, timezone_basis} and the
--   rollback data metadata.{previous_market, previous_state, previous_timezone}.
--   Nothing else: no targets, no queue rows, no status.
--   One campaign_events row per touched campaign
--   (event_type 'campaign.market_identity_repaired', previous + new values).
--
-- RE-RUN SAFE:
--   * the update only touches campaigns NOT yet stamped
--     metadata.market_identity.repaired_by = 'rc71_campaign_market_identity',
--     so a second run updates 0 rows and writes 0 audit rows;
--   * previous_* are written with coalesce(existing previous_*, current value):
--     an existing previous_* value is never overwritten.
--
-- ROLLBACK (exact inverse, reads the stored previous_* values):
--   update campaigns c set
--     market = c.metadata->>'previous_market',
--     state  = c.metadata->>'previous_state',
--     metadata = (c.metadata - 'market_identity' - 'canonical_market_id' - 'canonical_market_ids'
--                 - 'recipient_timezones' - 'launch_timezone' - 'timezone_basis'
--                 - 'previous_market' - 'previous_state' - 'previous_timezone')
--                || case when c.metadata ? 'previous_timezone'
--                        then jsonb_build_object('timezone', c.metadata->'previous_timezone') else '{}'::jsonb end
--   where c.metadata->'market_identity'->>'repaired_by' = 'rc71_campaign_market_identity';
--   (launch_timezone/timezone_basis did not exist before on these rows — verified
--    2026-10-02: 0 campaigns carried market_identity.)
-- ════════════════════════════════════════════════════════════════════════════
begin;
-- set local rc71.market_identity_apply = 'apply-market-identity';   -- the apply flag

do $$
begin
  if coalesce(current_setting('rc71.market_identity_apply', true), '') <> 'apply-market-identity' then
    raise exception 'market identity apply refused: set local rc71.market_identity_apply = ''apply-market-identity'' in this transaction (owner-approved, after deploy)';
  end if;
end $$;

set local lock_timeout = '5s';

with t as (
  select t.campaign_id, t.market, t.state, t.timezone
  from campaign_targets t join campaigns c on c.id = t.campaign_id
  where c.status not in ('archived', 'completed')
),
mk as (
  select t.campaign_id, t.market, min(t.state) state, cm.id canonical_market_id, count(*) targets
  from t left join canonical_markets cm on cm.display_name = t.market
  where t.market is not null group by 1, 2, 4
),
tz as (select campaign_id, timezone, count(*) targets from t where timezone like '%/%' group by 1, 2),
ident as (
  select c.id,
    (select count(*) from mk where mk.campaign_id = c.id) n_markets,
    (select count(*) from tz where tz.campaign_id = c.id) n_tz,
    coalesce((select jsonb_agg(jsonb_build_object('market_name', market, 'canonical_market_id', canonical_market_id, 'state', state, 'targets', targets) order by targets desc, market) from mk where mk.campaign_id = c.id), '[]') markets,
    coalesce((select jsonb_agg(jsonb_build_object('timezone', timezone, 'targets', targets) order by targets desc, timezone) from tz where tz.campaign_id = c.id), '[]') timezones,
    (select count(*) from t where t.campaign_id = c.id) target_count
  from campaigns c
  where c.status not in ('archived', 'completed')
    and exists (select 1 from t where t.campaign_id = c.id)
    -- re-run guard: never touch a campaign this repair already stamped
    and coalesce(c.metadata->'market_identity'->>'repaired_by', '') <> 'rc71_campaign_market_identity'
),
prior as (
  select c.id, c.market, c.state, c.metadata->'timezone' as timezone, c.metadata from campaigns c join ident i on i.id = c.id
),
upd as (
  update campaigns c set
    market = case when i.n_markets = 1 then i.markets->0->>'market_name' else null end,
    state  = case when i.n_markets = 1 then i.markets->0->>'state' else null end,
    metadata = coalesce(c.metadata, '{}'::jsonb)
      || jsonb_build_object(
           'market_identity', jsonb_build_object(
              'version', 'campaign_market_identity_v1', 'basis', 'campaign_targets', 'derived_at', now(),
              'kind', case when i.n_markets = 0 then 'unresolved' when i.n_markets = 1 then 'single_market' else 'multi_market' end,
              'target_count', i.target_count, 'markets', i.markets, 'timezones', i.timezones,
              'timezone_mode', case when i.n_tz = 1 then 'single' when i.n_tz > 1 then 'per_recipient' else 'unresolved' end,
              'repaired_by', 'rc71_campaign_market_identity'),
           'canonical_market_id', case when i.n_markets = 1 then i.markets->0->'canonical_market_id' else 'null'::jsonb end,
           'canonical_market_ids', (select coalesce(jsonb_agg(m->'canonical_market_id'), '[]') from jsonb_array_elements(i.markets) m where m->>'canonical_market_id' is not null),
           'recipient_timezones', (select coalesce(jsonb_agg(z->'timezone'), '[]') from jsonb_array_elements(i.timezones) z),
           -- rollback data: an existing previous_* value is NEVER overwritten
           'previous_timezone', coalesce(c.metadata->'previous_timezone', c.metadata->'timezone', 'null'::jsonb),
           'previous_market',   coalesce(c.metadata->'previous_market', to_jsonb(c.market)),
           'previous_state',    coalesce(c.metadata->'previous_state', to_jsonb(c.state)))
      || case when i.n_tz = 1 then jsonb_build_object('timezone', i.timezones->0->'timezone', 'launch_timezone', i.timezones->0->'timezone', 'timezone_basis', 'campaign_targets')
              when i.n_tz > 1 then jsonb_build_object('timezone', null, 'launch_timezone', null, 'timezone_basis', 'per_recipient')
              else '{}'::jsonb end,
    updated_at = now()
  from ident i
  where c.id = i.id
    and coalesce(c.metadata->'market_identity'->>'repaired_by', '') <> 'rc71_campaign_market_identity'
  returning c.id, c.name, c.market, c.state, c.metadata
),
audit as (
  insert into campaign_events (campaign_id, event_type, severity, title, description, metadata, created_at)
  select u.id, 'campaign.market_identity_repaired', 'info',
         'Market identity repaired (RC 7.1)',
         'Owner-approved RC 7.1 repair: market/state/time zones derived from campaign_targets.',
         jsonb_build_object(
           'source', 'rc71_campaign_market_identity',
           'previous', jsonb_build_object('market', b.market, 'state', b.state, 'timezone', b.timezone),
           'new', jsonb_build_object('market', u.market, 'state', u.state, 'timezone', u.metadata->'timezone',
                                     'kind', u.metadata->'market_identity'->>'kind',
                                     'timezone_mode', u.metadata->'market_identity'->>'timezone_mode')),
         now()
  from upd u join prior b on b.id = u.id
  returning campaign_id
)
select (select count(*) from upd) as campaigns_repaired, (select count(*) from audit) as audit_rows;
-- expect campaigns_repaired = audit_rows = the dry run's row count (14 on 2026-10-02); 0 / 0 on a re-run

-- verify (same transaction):
select name, status, market, state, metadata->>'timezone' tz, metadata->'market_identity'->>'kind' kind,
       metadata->'market_identity'->>'timezone_mode' tz_mode, metadata->'previous_timezone' prev_tz
from campaigns where metadata->'market_identity'->>'repaired_by' = 'rc71_campaign_market_identity'
order by status, name;

rollback;   -- change to COMMIT only after the counts match the preview
