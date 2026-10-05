-- =============================================================================
-- Rollback-only pretest for
--   supabase/migrations/PROPOSED_20261005120000_campaign_identity_release_evidence.sql
-- and its rollback. ONE transaction, ends in ROLLBACK — nothing persists.
--
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/campaign_identity_release_evidence_test.sql
--
-- Proves (each check RAISEs on failure; ends with 'ALL PASS'):
--   A. the function and index exist; anon/authenticated cannot EXECUTE it.
--   B. on 200 real queue-eligible held rows from the 4 launch markets it returns
--      exactly one row per input, every row has the four evidence keys, and an
--      entity-owned input carries entity + person; a NULL phone yields no holders.
--   C. it is read-only (STABLE, no writes) and runs < 20 s for 200 properties.
--   D. the rollback removes both objects.
-- =============================================================================
\set ON_ERROR_STOP on
begin;
set local statement_timeout = '60s';
set local lock_timeout = '5s';

\ir ../migrations/PROPOSED_20261005120000_campaign_identity_release_evidence.sql

do $$
declare n int; v_ok boolean; t0 timestamptz; ms numeric;
begin
  if to_regprocedure('public.campaign_identity_release_evidence(text[],text[])') is null then raise exception 'FAIL A: function missing'; end if;
  if to_regclass('seller.property_entity_contact_v1_selected_person_idx') is null then raise exception 'FAIL A: index missing'; end if;
  if has_function_privilege('anon', 'public.campaign_identity_release_evidence(text[],text[])', 'execute') then raise exception 'FAIL A: anon can execute'; end if;
  if has_function_privilege('authenticated', 'public.campaign_identity_release_evidence(text[],text[])', 'execute') then raise exception 'FAIL A: authenticated can execute'; end if;
  if (select provolatile from pg_proc where oid = 'public.campaign_identity_release_evidence(text[],text[])'::regprocedure) <> 's' then raise exception 'FAIL C: not STABLE'; end if;

  create temp table t_in on commit drop as
  select g.property_id, g.canonical_e164 as phone
  from public.campaign_target_graph g
  left join seller.property_entity_contact_v1 ec on ec.property_id = g.property_id
  where g.market in ('Minneapolis, MN','Dallas, TX','Houston, TX','Tampa, FL') and g.queue_eligible
    and (g.seller_person_key is null or coalesce(ec.requires_review, false))
  limit 200;

  t0 := clock_timestamp();
  create temp table t_out on commit drop as
  select * from public.campaign_identity_release_evidence(
    (select array_agg(property_id) from t_in), (select array_agg(phone) from t_in));
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  raise notice 'evidence for % properties in % ms', (select count(*) from t_in), round(ms);
  if ms > 20000 then raise exception 'FAIL C: % ms for 200 properties', ms; end if;

  if (select count(*) from t_out) <> (select count(*) from t_in) then raise exception 'FAIL B: % rows out for % in', (select count(*) from t_out), (select count(*) from t_in); end if;
  if exists (select 1 from t_out where not (evidence ? 'resolution' and evidence ? 'phone_holders' and evidence ? 'entity' and evidence ? 'person')) then raise exception 'FAIL B: missing evidence keys'; end if;
  if exists (select 1 from t_out o join seller.property_entity_contact_v1 ec on ec.property_id = o.property_id
             join seller.owner ow on ow.individual_key = ec.selected_person_key
             where jsonb_typeof(o.evidence->'entity') <> 'object' or jsonb_typeof(o.evidence->'person') <> 'object') then raise exception 'FAIL B: entity input without entity/person evidence'; end if;
  select jsonb_array_length(evidence->'phone_holders') = 0 into v_ok
  from public.campaign_identity_release_evidence(array[(select property_id from t_in limit 1)], array[null::text]);
  if not v_ok then raise exception 'FAIL B: NULL phone produced holders'; end if;
end $$;

\ir ../migrations/PROPOSED_20261005120000_campaign_identity_release_evidence_rollback.sql

do $$ begin
  if to_regprocedure('public.campaign_identity_release_evidence(text[],text[])') is not null then raise exception 'FAIL D: function survived rollback'; end if;
  if to_regclass('seller.property_entity_contact_v1_selected_person_idx') is not null then raise exception 'FAIL D: index survived rollback'; end if;
  raise notice 'ALL PASS';
end $$;
rollback;
