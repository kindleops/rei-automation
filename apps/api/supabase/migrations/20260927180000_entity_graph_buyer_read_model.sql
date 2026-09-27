-- ENTITY GRAPH: BUYERS AS FIRST-CLASS ENTITIES (read model).
--
-- Buyer intelligence lives in comp_private (w8c_* tables, one materialization
-- run). It is NEVER exposed to the browser: everything below is readable by
-- service_role only and served through authenticated API routes.
--
-- Identity vs role. A company is one identity (`company:<jurisdiction>:<number>`,
-- the same registry key seller.company carries) that can hold several roles:
-- current owner, buyer on a sale, seller on a sale, agent. Roles come with
-- their BASIS so the UI can separate fact from inference:
--   registry  seller.property_company -> seller.company by registry number
--   link      comp_private.w8c_transaction_buyer_links (resolved, has confidence)
--   name      exact normalized-name match against an UNAMBIGUOUS company alias
--             (a key shared by two buyer entities is never used)
-- Person buyers are matched only by individual_key — never by name.
--
-- Nothing here writes to seller, comp_private or properties.

create or replace function public.eg_name_key(t text)
returns text language sql immutable parallel safe
as $$
  select nullif(upper(trim(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]+', ' ', 'g'))), '')
$$;

-- Company alias keys, unambiguous only (a key that maps to two entities is dropped).
drop materialized view if exists public.eg_buyer_index;
drop materialized view if exists public.eg_property_owner_buyer;
drop materialized view if exists public.eg_buyer_alias_keys;

create materialized view public.eg_buyer_alias_keys as
with raw as (
  select a.buyer_entity_id, public.eg_name_key(a.normalized_alias) as name_key
  from comp_private.w8c_buyer_entity_aliases a
  join comp_private.w8c_buyer_entities e using (buyer_entity_id)
  where e.entity_type = 'company'
  union
  select a.buyer_entity_id, public.eg_name_key(f)
  from comp_private.w8c_buyer_entity_aliases a
  join comp_private.w8c_buyer_entities e using (buyer_entity_id)
  cross join lateral unnest(a.observed_forms) f
  where e.entity_type = 'company'
  union
  select e.buyer_entity_id, public.eg_name_key(e.canonical_display_name)
  from comp_private.w8c_buyer_entities e where e.entity_type = 'company'
)
select name_key, min(buyer_entity_id) as buyer_entity_id
from raw
where name_key is not null and length(name_key) >= 6
group by name_key
having count(distinct buyer_entity_id) = 1;
create unique index eg_buyer_alias_keys_key on public.eg_buyer_alias_keys (name_key);
create index eg_buyer_alias_keys_entity on public.eg_buyer_alias_keys (buyer_entity_id);

-- Who owns each property, when the owner is a known buyer entity.
create materialized view public.eg_property_owner_buyer as
with registry as (
  select distinct on (pc.property_id) pc.property_id,
    'company:' || c.jurisdiction_code || ':' || c.company_number as buyer_entity_id,
    'registry'::text as basis
  from seller.property_company pc
  join seller.company c on c.source_row_uid = pc.source_row_uid
  where pc.matched_party is null and c.company_number is not null
    and exists (select 1 from comp_private.w8c_buyer_entities e
                where e.buyer_entity_id = 'company:' || c.jurisdiction_code || ':' || c.company_number)
  order by pc.property_id
),
person as (
  select distinct on (r.property_id) r.property_id, e.buyer_entity_id, 'individual_key'::text as basis
  from seller.property_owner_resolution_v1 r
  join comp_private.w8c_buyer_entities e on e.individual_key = r.individual_key and e.entity_type = 'person'
  where r.individual_key is not null
  order by r.property_id
),
named as (
  select distinct on (p.property_id) p.property_id, k.buyer_entity_id, 'name'::text as basis
  from public.properties p
  join public.eg_buyer_alias_keys k on k.name_key = public.eg_name_key(p.owner_name)
  where p.property_id is not null
  order by p.property_id
)
select distinct on (property_id) property_id, buyer_entity_id, basis
from (
  select *, 1 as rank from registry
  union all select *, 2 from person
  union all select *, 3 from named
) u
order by property_id, rank;
create unique index eg_property_owner_buyer_pk on public.eg_property_owner_buyer (property_id);
create index eg_property_owner_buyer_entity on public.eg_property_owner_buyer (buyer_entity_id);

create materialized view public.eg_buyer_index as
with sold as (
  select k.buyer_entity_id, count(*)::int as sold_count, max(t.event_date) as last_sold
  from comp_private.comp_canonical_transactions t
  join public.eg_buyer_alias_keys k on k.name_key = public.eg_name_key(t.seller_1_name)
  group by 1
),
owned as (
  select buyer_entity_id, count(*)::int as owned_count,
    count(*) filter (where basis = 'registry')::int as owned_registry
  from public.eg_property_owner_buyer group by 1
),
linked as (
  select l.buyer_entity_id, count(*)::int as linked_sales
  from comp_private.w8c_transaction_buyer_links l
  join comp_private.comp_canonical_transactions t on t.id = l.canonical_transaction_id
  where exists (select 1 from public.properties p where p.property_id = t.primary_property_id)
  group by 1
),
portfolio as (
  select buyer_entity_id, sum(property_count)::int as portfolio_count, sum(portfolio_value)::bigint as portfolio_value
  from comp_private.w8c_buyer_portfolio_observations group by 1
),
alias_text as (
  select buyer_entity_id, string_agg(distinct normalized_alias, ' | ') as aliases
  from comp_private.w8c_buyer_entity_aliases group by 1
)
select
  e.buyer_entity_id as entity_key,
  case when e.entity_type = 'person' then 'person:' || substr(md5('eg:' || e.buyer_entity_id), 1, 20)
       else e.buyer_entity_id end as buyer_id,
  case when e.entity_type = 'person' then null else e.canonical_display_name end as display_name,
  e.entity_type,
  e.entity_grade,
  e.confidence,
  e.jurisdiction_code,
  e.company_number,
  e.alias_count,
  b.acquisition_count,
  b.disposition_count,
  b.first_acquisition,
  b.last_acquisition,
  b.days_since_last,
  b.trailing_90d,
  b.trailing_180d,
  b.trailing_365d,
  b.acquisitions_per_year,
  b.activity_status,
  b.activity_score,
  b.archetype,
  b.hold_flip_classification as hold_flip,
  b.asset_profile ->> 'dominant_family' as dominant_family,
  array(select x ->> 0 from jsonb_array_elements(coalesce(b.asset_profile -> 'families', '[]'::jsonb)) x) as asset_families,
  (b.geography_profile -> 'states' -> 0 ->> 0) as top_state,
  (b.geography_profile -> 'primary_markets' ->> 0) as primary_market,
  array(select x ->> 0 from jsonb_array_elements(coalesce(b.geography_profile -> 'states', '[]'::jsonb)) x) as states,
  array(select x ->> 0 from jsonb_array_elements(coalesce(b.geography_profile -> 'counties', '[]'::jsonb)) x) as counties,
  array(select x ->> 0 from jsonb_array_elements(coalesce(b.geography_profile -> 'zips', '[]'::jsonb)) x) as zips,
  nullif(b.price_profile -> 'lifetime' ->> 'p25', '')::numeric::bigint as price_p25,
  nullif(b.price_profile -> 'lifetime' ->> 'p50', '')::numeric::bigint as price_p50,
  nullif(b.price_profile -> 'lifetime' ->> 'p75', '')::numeric::bigint as price_p75,
  nullif(b.price_profile ->> 'cash_share', '')::numeric as cash_share,
  (bb.buyer_entity_id is not null) as has_buybox,
  coalesce(pf.portfolio_count, 0) as portfolio_count,
  pf.portfolio_value,
  coalesce(o.owned_count, 0) as owned_count,
  coalesce(o.owned_registry, 0) as owned_registry,
  coalesce(s.sold_count, 0) as sold_count,
  s.last_sold,
  coalesce(l.linked_sales, 0) as linked_sales,
  (coalesce(o.owned_count, 0) > 0 and coalesce(s.sold_count, 0) > 0) as is_crossover,
  case when e.entity_type = 'person' then null
       else upper(coalesce(e.canonical_display_name, '') || ' | ' || coalesce(a.aliases, '')) end as search_text
from comp_private.w8c_buyer_entities e
left join comp_private.w8c_buyer_behavior_profiles b using (buyer_entity_id)
left join comp_private.w8c_buyer_buyboxes bb using (buyer_entity_id)
left join portfolio pf using (buyer_entity_id)
left join owned o using (buyer_entity_id)
left join sold s using (buyer_entity_id)
left join linked l using (buyer_entity_id)
left join alias_text a using (buyer_entity_id);

create unique index eg_buyer_index_pk on public.eg_buyer_index (buyer_id);
create unique index eg_buyer_index_key on public.eg_buyer_index (entity_key);
create index eg_buyer_index_acq on public.eg_buyer_index (acquisition_count desc);
create index eg_buyer_index_last on public.eg_buyer_index (last_acquisition desc nulls last);
create index eg_buyer_index_status on public.eg_buyer_index (activity_status);
create index eg_buyer_index_states on public.eg_buyer_index using gin (states);
create index eg_buyer_index_counties on public.eg_buyer_index using gin (counties);
create index eg_buyer_index_zips on public.eg_buyer_index using gin (zips);
create index eg_buyer_index_search on public.eg_buyer_index using gin (search_text extensions.gin_trgm_ops);

revoke all on public.eg_buyer_alias_keys, public.eg_property_owner_buyer, public.eg_buyer_index from public, anon, authenticated;
grant select on public.eg_buyer_alias_keys, public.eg_property_owner_buyer, public.eg_buyer_index to service_role;

-- Properties view gains the owner-as-buyer role.
create or replace view public.v_entity_graph_properties as
select p.*,
  s.mortgage_count as rec_mortgage_count, s.mortgage_balance as rec_mortgage_balance, s.mortgage_payment as rec_mortgage_payment,
  s.first_rate as rec_first_rate, s.max_rate as rec_max_rate, s.first_lender as rec_first_lender, s.first_loan_type as rec_first_loan_type,
  s.first_recording_date as rec_first_recording_date, s.first_due_date as rec_first_due_date,
  s.has_private_lender as rec_has_private_lender, s.has_heloc as rec_has_heloc, s.has_fha as rec_has_fha, s.has_va as rec_has_va,
  s.has_seller_financing as rec_has_seller_financing, s.has_adjustable as rec_has_adjustable,
  s.lien_count as rec_lien_count, s.lien_amount_due as rec_lien_amount_due, s.lien_categories as rec_lien_categories,
  s.has_probate as rec_has_probate, s.has_lis_pendens as rec_has_lis_pendens, s.has_death_record as rec_has_death_record,
  s.has_divorce_record as rec_has_divorce_record, s.has_judgment as rec_has_judgment, s.has_mechanics_lien as rec_has_mechanics_lien,
  s.has_tax_lien as rec_has_tax_lien, s.has_hoa_lien as rec_has_hoa_lien, s.has_default_notice as rec_has_default_notice,
  s.sale_count as rec_sale_count, s.last_sale_date as rec_last_sale_date, s.last_sale_price as rec_last_sale_price,
  s.last_sale_doc_type as rec_last_sale_doc_type, s.last_sale_distress as rec_last_sale_distress,
  s.last_sale_intrafamily as rec_last_sale_intrafamily, s.years_owned as rec_years_owned,
  s.foreclosure_count as rec_foreclosure_count, s.foreclosure_stage as rec_foreclosure_stage, s.auction_date as rec_auction_date,
  bi.buyer_id as rec_owner_buyer_id, ob.basis as rec_owner_buyer_basis,
  bi.acquisition_count as rec_owner_buyer_acquisitions, bi.activity_status as rec_owner_buyer_status
from public.properties p
left join public.property_record_summary s on s.property_id = p.property_id
left join public.eg_property_owner_buyer ob on ob.property_id = p.property_id
left join public.eg_buyer_index bi on bi.entity_key = ob.buyer_entity_id;

revoke all on public.v_entity_graph_properties from public, anon, authenticated;
grant select on public.v_entity_graph_properties to service_role;

-- The public face of a buyer entity. Persons: opaque id, no name.
create or replace function public.eg_buyer_ref(p_entity_key text, p_basis text default null, p_method text default null, p_confidence numeric default null)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'buyer_id', bi.buyer_id, 'name', bi.display_name, 'entity_type', bi.entity_type,
    'basis', p_basis, 'method', p_method, 'confidence', p_confidence,
    'acquisition_count', bi.acquisition_count, 'sold_count', bi.sold_count, 'owned_count', bi.owned_count,
    'activity_status', bi.activity_status, 'archetype', bi.archetype, 'last_acquisition', bi.last_acquisition))
  from public.eg_buyer_index bi where bi.entity_key = p_entity_key
$$;
revoke all on function public.eg_buyer_ref(text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.eg_buyer_ref(text, text, text, numeric) to service_role;

-- One property's records, sales enriched with transaction + buyer resolution.
create or replace function public.entity_graph_property_records(p_property_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, seller, comp_private, pg_temp
as $$
  select jsonb_build_object(
    'mortgages', coalesce((
      select jsonb_agg(to_jsonb(m) - 'source_row_uid' - 'import_batch_id' - 'property_id'
        order by (m.slot like 'mtg%') desc, m.lien_position nulls last, m.recording_date desc nulls last)
      from seller.property_mortgage m where m.property_id = p_property_id), '[]'::jsonb),
    'liens', coalesce((
      select jsonb_agg(jsonb_strip_nulls(to_jsonb(l) - 'source_row_uid' - 'import_batch_id' - 'property_id')
        order by coalesce(l.recording_date, l.filing_date, l.nod_recording_date, l.date_updated) desc nulls last)
      from seller.property_lien l where l.property_id = p_property_id), '[]'::jsonb),
    'sales', coalesce((
      select jsonb_agg(jsonb_strip_nulls(
          (to_jsonb(s) - 'source_row_uid' - 'import_batch_id' - 'property_id')
          || jsonb_build_object(
            'canonical_transaction_id', t.id,
            'financing_kind', t.financing_kind,
            'concurrent_lender', t.concurrent_lender,
            'concurrent_loan_amount', t.concurrent_loan_amount,
            'is_cash_purchase', coalesce(s.is_cash_purchase, t.is_cash_purchase),
            'is_arms_length', coalesce(s.is_arms_length, t.is_arms_length),
            'buyer', coalesce(
              (select public.eg_buyer_ref(bl.buyer_entity_id, 'link', bl.resolution_method, bl.confidence)
               from comp_private.w8c_transaction_buyer_links bl
               where bl.canonical_transaction_id = t.id and bl.buyer_role = 'buyer_1' limit 1),
              (select public.eg_buyer_ref(k.buyer_entity_id, 'name')
               from public.eg_buyer_alias_keys k where k.name_key = public.eg_name_key(s.buyer_1_name) limit 1)),
            'seller_entity', (
              select public.eg_buyer_ref(k.buyer_entity_id, 'name')
              from public.eg_buyer_alias_keys k where k.name_key = public.eg_name_key(s.seller_1_name) limit 1)
          ))
        order by s.event_date desc nulls last)
      from seller.property_sale s
      left join comp_private.comp_canonical_transactions t on t.provider_transaction_id = s.provider_transaction_id
      where s.property_id = p_property_id), '[]'::jsonb),
    'foreclosures', coalesce((
      select jsonb_agg(jsonb_strip_nulls(to_jsonb(f) - 'source_row_uid' - 'import_batch_id' - 'property_id')
        order by coalesce(f.recording_date, f.default_date) desc nulls last)
      from seller.property_foreclosure f where f.property_id = p_property_id), '[]'::jsonb),
    'owner_buyer', (
      select public.eg_buyer_ref(ob.buyer_entity_id, ob.basis)
      from public.eg_property_owner_buyer ob where ob.property_id = p_property_id),
    -- The county parcel record as imported (assessed values, building detail,
    -- MLS, HOA, zoning, legal description). Import bookkeeping stripped.
    'parcel', (
      select jsonb_strip_nulls(to_jsonb(sp) - 'source_row_uid' - 'import_batch_id' - 'winning_source_row_uid'
        - 'observed_in_files' - 'conflict_flags' - 'property_id' - 'property_data_id' - 'owner_hash' - 'address_mak')
      from seller.property sp where sp.property_id = p_property_id)
  )
$$;
revoke all on function public.entity_graph_property_records(text) from public, anon, authenticated;
grant execute on function public.entity_graph_property_records(text) to service_role;

-- One buyer entity by its PUBLIC id: identity, roles, behaviour, portfolio,
-- network, history. Person entities never return a name, individual_key or
-- raw entity id; their portfolio lists only properties already in the
-- operator's own universe.
create or replace function public.eg_buyer_profile(p_buyer_id text, p_limit int default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, seller, comp_private, pg_temp
as $$
declare
  k text;
  is_person boolean;
  result jsonb;
begin
  select entity_key, entity_type = 'person' into k, is_person from public.eg_buyer_index where buyer_id = p_buyer_id;
  if k is null then return null; end if;

  select jsonb_build_object(
    'index', (select to_jsonb(i) - 'search_text' - 'entity_key' from public.eg_buyer_index i where i.entity_key = k),
    'aliases', case when is_person then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('alias', a.normalized_alias, 'forms', a.observed_forms,
          'canonical', a.is_canonical, 'provisional', a.is_provisional, 'grade', a.evidence_grade)
        order by a.is_canonical desc, a.evidence_grade desc)
      from comp_private.w8c_buyer_entity_aliases a where a.buyer_entity_id = k), '[]'::jsonb) end,
    'identity', (select jsonb_strip_nulls(jsonb_build_object('entity_grade', e.entity_grade, 'name_grade', e.name_grade,
        'strongest_method', e.strongest_method, 'confidence', e.confidence, 'jurisdiction', e.jurisdiction_code,
        'company_number', case when is_person then null else e.company_number end, 'alias_count', e.alias_count,
        'materialized_at', e.materialized_at))
      from comp_private.w8c_buyer_entities e where e.buyer_entity_id = k),
    'behavior', (select to_jsonb(b) - 'run_id' - 'buyer_entity_id' from comp_private.w8c_buyer_behavior_profiles b where b.buyer_entity_id = k),
    'buybox', (select to_jsonb(bb) - 'run_id' - 'buyer_entity_id' from comp_private.w8c_buyer_buyboxes bb where bb.buyer_entity_id = k),
    'registry', case when is_person then null else (
      select jsonb_strip_nulls(jsonb_build_object('company_name', c.company_name, 'company_number', c.company_number,
        'jurisdiction', c.jurisdiction_code, 'status', c.current_status, 'inactive', c.inactive,
        'incorporated', c.incorporation_date, 'dissolved', c.dissolution_date, 'address', c.address,
        'city', c.city, 'state', c.state, 'zip', c.zip, 'registry_url', c.registry_url))
      from seller.company c where 'company:' || c.jurisdiction_code || ':' || c.company_number = k limit 1) end,
    'relationships', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'other', public.eg_buyer_ref(case when r.person_entity_id = k then r.company_entity_id else r.person_entity_id end),
        'direction', case when r.person_entity_id = k then 'officer_of' else 'officer' end,
        'role', r.officer_role, 'relationship', r.relationship_type, 'confidence', r.confidence, 'basis', r.match_basis)))
      from comp_private.w8c_buyer_company_relationships r
      where r.person_entity_id = k or r.company_entity_id = k), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(x order by x ->> 'date' desc nulls last) from (
        select jsonb_strip_nulls(jsonb_build_object(
          'canonical_transaction_id', t.id, 'date', t.event_date, 'price', t.price, 'doc_type', t.doc_type,
          'seller', t.seller_1_name, 'cash', t.is_cash_purchase,
          'arms_length', t.is_arms_length, 'lender', t.concurrent_lender, 'loan_amount', t.concurrent_loan_amount,
          'method', l.resolution_method, 'confidence', l.confidence,
          'property_id', case when p.property_id is not null then t.primary_property_id end,
          'in_universe', (p.property_id is not null),
          'address', coalesce(p.property_address_full, sp.address_full),
          'city', coalesce(p.property_address_city, sp.city), 'state', coalesce(p.property_address_state, sp.state),
          'lat', coalesce(p.latitude, sp.latitude), 'lng', coalesce(p.longitude, sp.longitude),
          'property_type', coalesce(p.property_type, sp.property_type))) as x
        from comp_private.w8c_transaction_buyer_links l
        join comp_private.comp_canonical_transactions t on t.id = l.canonical_transaction_id
        left join public.properties p on p.property_id = t.primary_property_id
        left join seller.property sp on sp.property_id = t.primary_property_id
        where l.buyer_entity_id = k
        order by t.event_date desc nulls last
        limit p_limit) q), '[]'::jsonb),
    'dispositions', case when is_person then '[]'::jsonb else coalesce((select jsonb_agg(x order by x ->> 'date' desc nulls last) from (
        select jsonb_strip_nulls(jsonb_build_object(
          'canonical_transaction_id', t.id, 'date', t.event_date, 'price', t.price, 'doc_type', t.doc_type,
          'buyer', t.buyer_1_name, 'property_id', p.property_id,
          'address', coalesce(p.property_address_full, sp.address_full), 'basis', 'name')) as x
        from comp_private.comp_canonical_transactions t
        left join public.properties p on p.property_id = t.primary_property_id
        left join seller.property sp on sp.property_id = t.primary_property_id
        where public.eg_name_key(t.seller_1_name) = any (array(select name_key from public.eg_buyer_alias_keys where buyer_entity_id = k))
        order by t.event_date desc nulls last
        limit p_limit) q), '[]'::jsonb) end,
    'owned', coalesce((select jsonb_agg(x) from (
        select jsonb_strip_nulls(jsonb_build_object(
          'property_id', p.property_id, 'address', p.property_address_full, 'basis', ob.basis,
          'value', p.estimated_value, 'equity_percent', p.equity_percent, 'property_type', p.property_type,
          'lat', p.latitude, 'lng', p.longitude, 'market', p.market)) as x
        from public.eg_property_owner_buyer ob
        join public.properties p on p.property_id = ob.property_id
        where ob.buyer_entity_id = k
        order by p.estimated_value desc nulls last
        limit p_limit) q), '[]'::jsonb),
    'portfolio', coalesce((select jsonb_agg(x) from (
        select jsonb_strip_nulls(jsonb_build_object(
          'property_id', p.property_id, 'value', opp.estimated_value, 'equity', opp.equity_amount,
          'attribution', opp.attribution_confidence, 'address', p.property_address_full,
          'lat', p.latitude, 'lng', p.longitude, 'property_type', p.property_type)) as x
        from comp_private.w8c_buyer_portfolio_observations o
        join comp_private.comp_owner_portfolio_properties opp on opp.portfolio_id = (o.provenance ->> 'portfolio_id')::bigint
        join public.properties p on p.property_id = opp.property_id
        where o.buyer_entity_id = k
        limit p_limit) q), '[]'::jsonb),
    'purchases_by_year', coalesce((select jsonb_agg(jsonb_build_object('year', y, 'count', n, 'volume', v) order by y) from (
        select extract(year from t.event_date)::int y, count(*)::int n, sum(t.price)::bigint v
        from comp_private.w8c_transaction_buyer_links l
        join comp_private.comp_canonical_transactions t on t.id = l.canonical_transaction_id
        where l.buyer_entity_id = k and t.event_date is not null group by 1) q), '[]'::jsonb)
  ) into result;
  return result;
end
$$;
revoke all on function public.eg_buyer_profile(text, int) from public, anon, authenticated;
grant execute on function public.eg_buyer_profile(text, int) to service_role;

create index if not exists comp_canon_tx_seller_key_idx
  on comp_private.comp_canonical_transactions (public.eg_name_key(seller_1_name));
create index if not exists w8c_links_entity_only_idx on comp_private.w8c_transaction_buyer_links (buyer_entity_id);
create index if not exists w8c_links_tx_idx on comp_private.w8c_transaction_buyer_links (canonical_transaction_id);
create index if not exists w8c_aliases_entity_idx on comp_private.w8c_buyer_entity_aliases (buyer_entity_id);
create index if not exists w8c_company_rel_company_idx on comp_private.w8c_buyer_company_relationships (company_entity_id);
create index if not exists w8c_company_rel_person_idx on comp_private.w8c_buyer_company_relationships (person_entity_id);
create index if not exists w8c_behavior_entity_idx on comp_private.w8c_buyer_behavior_profiles (buyer_entity_id);
create index if not exists w8c_buybox_entity_idx on comp_private.w8c_buyer_buyboxes (buyer_entity_id);
create index if not exists w8c_entities_entity_idx on comp_private.w8c_buyer_entities (buyer_entity_id);

-- Refresh everything Entity Graph derives, in dependency order.
create or replace function public.refresh_entity_graph_read_model()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '1200s'
as $$
declare n bigint;
begin
  n := public.refresh_property_record_summary();
  refresh materialized view public.eg_buyer_alias_keys;
  refresh materialized view public.eg_property_owner_buyer;
  refresh materialized view public.eg_buyer_index;
  return jsonb_build_object('record_summary_rows', n,
    'buyers', (select count(*) from public.eg_buyer_index),
    'owner_buyer_properties', (select count(*) from public.eg_property_owner_buyer),
    'refreshed_at', now());
end
$$;
revoke all on function public.refresh_entity_graph_read_model() from public, anon, authenticated;
grant execute on function public.refresh_entity_graph_read_model() to service_role;

-- Nightly, after imports settle.
select cron.unschedule(jobid) from cron.job where jobname = 'refresh_entity_graph_read_model';
select cron.schedule('refresh_entity_graph_read_model', '17 9 * * *', $$select public.refresh_entity_graph_read_model()$$);

notify pgrst, 'reload schema';
