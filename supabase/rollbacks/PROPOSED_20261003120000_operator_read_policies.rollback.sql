-- Rollback for supabase/migrations/PROPOSED_20261003120000_operator_read_policies.sql
-- This returns the database exactly to the pre-migration state: operators lose direct
-- reads again (the silent-empty outage comes back). No data is touched, except that the
-- ops_operators allowlist rows are dropped with the table.
begin;
set local lock_timeout = '5s';

do $$
declare
  rel text;
begin
  foreach rel in array array[
    'properties','prospects','master_owners','phones','emails','campaigns',
    'campaign_targets','campaign_target_graph','recently_sold_properties',
    'sms_suppression_list','sub_owners','thread_ai_state',
    'property_acquisition_scores','universal_lead_command_cache',
    'property_cash_offer_snapshots','sms_campaign_targets'
  ] loop
    if to_regclass('public.' || rel) is not null then
      execute format('drop policy if exists ops_operator_read on public.%I', rel);
    end if;
  end loop;
end
$$;

-- These three had no authenticated SELECT before the migration.
revoke select on table public.campaign_target_graph        from authenticated;
revoke select on table public.property_acquisition_scores  from authenticated;
revoke select on table public.universal_lead_command_cache from authenticated;

drop function if exists public.is_ops_operator();
drop table if exists public.ops_operators;

commit;
