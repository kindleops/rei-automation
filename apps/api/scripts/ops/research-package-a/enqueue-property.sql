-- PACKAGE A — OWNER PATH: research ONE named property now (an event job through agent.runtime_enqueue_event,
-- exactly what the sweep / recovery linkage do). Writes ONE agent.research_job row (+ its job_event); nothing else.
-- Refused by the DB unless property.research is armed (step 4); refuses the owner exclusions (Maxwell, Hartford).
--   psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -X -v property_id=<digits> -v trigger=offer_request -f apps/api/scripts/ops/research-package-a/enqueue-property.sql
-- trigger ∈ opportunity_entered | asking_price_revealed | valuation_stale_or_missing | new_comp_evidence | market_shift |
--           recovery_finding | seller_interest | offer_request | counteroffer
\set ON_ERROR_STOP on
begin;
select set_config('lc.pkga_pid', :'property_id', true), set_config('lc.pkga_trigger', :'trigger', true);
do $$
declare
  v_pid text := current_setting('lc.pkga_pid');
  v_trigger text := current_setting('lc.pkga_trigger');
  r jsonb;
begin
  if v_pid !~ '^[0-9]{1,20}$' then raise exception 'package_a.enqueue_property: property_id must be the numeric property id'; end if;
  if v_pid in ('251027062', '225438557') then raise exception 'package_a.enqueue_property: % is an owner exclusion (Maxwell / Hartford)', v_pid; end if;
  if v_trigger not in ('opportunity_entered', 'asking_price_revealed', 'valuation_stale_or_missing', 'new_comp_evidence', 'market_shift', 'recovery_finding', 'seller_interest', 'offer_request', 'counteroffer') then
    raise exception 'package_a.enqueue_property: unknown trigger %', v_trigger;
  end if;
  r := agent.runtime_enqueue_event('property.research', 'owner:' || v_trigger || ':' || v_pid || ':' || to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD'),
         jsonb_build_object('property_ref', 'pid_' || translate(v_pid, '0123456789', 'ghijklmnop'), 'trigger', v_trigger, 'web', true), 110);
  if not coalesce((r ->> 'ok')::boolean, false) then raise exception 'package_a.enqueue_property: refused (%)', r; end if;
  raise notice 'package_a.enqueue_property: %', r;
end $$;
commit;
