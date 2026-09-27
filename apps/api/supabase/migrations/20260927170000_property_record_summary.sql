-- ENTITY GRAPH: A PROPERTY'S RECORDS — mortgages, liens, sales, foreclosures.
--
-- The recorded-document tables live in the `seller` schema, which PostgREST
-- does not expose, so Entity Graph could not show them and no filter could
-- reach them (measured 2026-09-27: 243,126 mortgages on 116,272 properties,
-- 29,185 liens on 26,855, 271,486 sales on 170,841, 947 foreclosures).
--
-- Two read paths, both read-only against `seller`:
--
--   entity_graph_property_records(property_id)
--       one property's full record set, for the property sheet
--
--   property_record_summary (+ computed relationship `record_summary`)
--       one row per property of the facts an operator filters on (has a
--       probate filing, private lender, rate above 7%, last sale was a
--       trustee's deed ...). properties.property_id carries only a PARTIAL
--       unique index, so it cannot be a foreign-key target; the computed
--       relationship lets PostgREST embed and `!inner`-filter the summary
--       from `properties` without one.
--
-- Nothing here writes to `seller` or to `properties`.

create table if not exists public.property_record_summary (
  property_id text primary key,
  -- open mortgages (slots mtg1..mtgN; concurrent*/prev* are history)
  mortgage_count int not null default 0,
  mortgage_balance bigint,
  mortgage_payment numeric,
  mortgage_original bigint,
  first_rate numeric,
  max_rate numeric,
  first_lender text,
  first_loan_type text,
  first_financing_type text,
  first_recording_date date,
  first_due_date date,
  has_private_lender boolean not null default false,
  has_heloc boolean not null default false,
  has_fha boolean not null default false,
  has_va boolean not null default false,
  has_seller_financing boolean not null default false,
  has_adjustable boolean not null default false,
  -- liens and recorded notices
  lien_count int not null default 0,
  lien_amount_due numeric,
  lien_categories text[],
  latest_lien_date date,
  has_probate boolean not null default false,
  has_lis_pendens boolean not null default false,
  has_death_record boolean not null default false,
  has_divorce_record boolean not null default false,
  has_judgment boolean not null default false,
  has_mechanics_lien boolean not null default false,
  has_tax_lien boolean not null default false,
  has_hoa_lien boolean not null default false,
  has_general_lien boolean not null default false,
  has_default_notice boolean not null default false,
  -- sale history
  sale_count int not null default 0,
  last_sale_date date,
  last_sale_price bigint,
  last_sale_doc_type text,
  last_buyer text,
  last_seller text,
  last_sale_cash boolean,
  last_sale_distress boolean not null default false,
  last_sale_intrafamily boolean not null default false,
  prior_sale_date date,
  prior_sale_price bigint,
  years_owned int,
  -- foreclosure
  foreclosure_count int not null default 0,
  foreclosure_stage text,
  foreclosure_recording_date date,
  foreclosure_default_date date,
  auction_date date,
  foreclosure_unpaid_balance numeric,
  refreshed_at timestamptz not null default now()
);

alter table public.property_record_summary enable row level security;
revoke all on public.property_record_summary from public, anon, authenticated;
grant select on public.property_record_summary to service_role;

create index if not exists property_record_summary_mortgage_idx on public.property_record_summary (mortgage_count, first_rate);
create index if not exists property_record_summary_lien_idx on public.property_record_summary (property_id) where lien_count > 0;
create index if not exists property_record_summary_fc_idx on public.property_record_summary (property_id) where foreclosure_count > 0;

-- Computed relationship: properties -> its summary row (to-one).
create or replace function public.record_summary(public.properties)
returns setof public.property_record_summary
language sql stable rows 1
set search_path = public, pg_temp
as $$
  select s.* from public.property_record_summary s where s.property_id = $1.property_id
$$;
revoke all on function public.record_summary(public.properties) from public, anon, authenticated;
grant execute on function public.record_summary(public.properties) to service_role;

create or replace function public.refresh_property_record_summary()
returns bigint
language plpgsql
security definer
set search_path = public, seller, pg_temp
set statement_timeout = '600s'
as $$
declare n bigint;
begin
  create temp table _mort on commit drop as
  select property_id,
    count(*) filter (where slot like 'mtg%')::int as mortgage_count,
    sum(est_balance) filter (where slot like 'mtg%')::bigint as mortgage_balance,
    sum(est_payment) filter (where slot like 'mtg%') as mortgage_payment,
    sum(loan_amount) filter (where slot like 'mtg%')::bigint as mortgage_original,
    max(interest_rate) filter (where slot = 'mtg1') as first_rate,
    max(interest_rate) filter (where slot like 'mtg%') as max_rate,
    max(lender_name) filter (where slot = 'mtg1') as first_lender,
    max(loan_type) filter (where slot = 'mtg1') as first_loan_type,
    max(financing_type) filter (where slot = 'mtg1') as first_financing_type,
    max(recording_date) filter (where slot = 'mtg1') as first_recording_date,
    max(due_date) filter (where slot = 'mtg1') as first_due_date,
    coalesce(bool_or(is_private_lender) filter (where slot like 'mtg%'), false) as has_private_lender,
    coalesce(bool_or(loan_type = 'Credit Line') filter (where slot like 'mtg%'), false) as has_heloc,
    coalesce(bool_or(loan_type = 'FHA') filter (where slot like 'mtg%'), false) as has_fha,
    coalesce(bool_or(loan_type = 'VA') filter (where slot like 'mtg%'), false) as has_va,
    coalesce(bool_or(loan_type = 'Seller take-back') filter (where slot like 'mtg%'), false) as has_seller_financing,
    coalesce(bool_or(financing_type in ('Variable', 'Adjustable')) filter (where slot like 'mtg%'), false) as has_adjustable
  from seller.property_mortgage group by property_id;

  create temp table _lien on commit drop as
  select property_id,
    count(*)::int as lien_count,
    nullif(sum(coalesce(amount_due, 0) + coalesce(hoa_lien_amount, 0)), 0) as lien_amount_due,
    array_remove(array_agg(distinct coalesce(doc_category, case when lien_type = 'hoa_lien' then 'HOA LIEN' end)), null) as lien_categories,
    max(coalesce(recording_date, filing_date, nod_recording_date, date_updated)) as latest_lien_date,
    bool_or(doc_category = 'PROBATE') as has_probate,
    bool_or(doc_category = 'LIS PENDENS') as has_lis_pendens,
    bool_or(doc_category = 'AFFIDAVIT OF DEATH' or date_of_death is not null) as has_death_record,
    bool_or(date_of_divorce is not null) as has_divorce_record,
    bool_or(doc_category = 'JUDGMENT') as has_judgment,
    bool_or(doc_category = 'MECHANICS LIEN') as has_mechanics_lien,
    bool_or(doc_category ilike '%TAX LIEN%' or tax_period_begin is not null) as has_tax_lien,
    bool_or(lien_type = 'hoa_lien') as has_hoa_lien,
    bool_or(doc_category = 'LIEN <GENERAL>') as has_general_lien,
    bool_or(nod_recording_date is not null) as has_default_notice
  from seller.property_lien group by property_id;

  create temp table _sale on commit drop as
  select property_id,
    count(*)::int as sale_count,
    max(event_date) filter (where slot = 'current') as last_sale_date,
    max(price) filter (where slot = 'current') as last_sale_price,
    max(doc_type) filter (where slot = 'current') as last_sale_doc_type,
    max(buyer_1_name) filter (where slot = 'current') as last_buyer,
    max(seller_1_name) filter (where slot = 'current') as last_seller,
    bool_or(is_cash_purchase) filter (where slot = 'current') as last_sale_cash,
    coalesce(bool_or(doc_type ilike '%trustee%' or doc_type ilike '%sheriff%' or doc_type ilike '%foreclos%') filter (where slot = 'current'), false) as last_sale_distress,
    coalesce(bool_or(doc_type ilike 'intrafamily%' or doc_type ilike 'quit%claim%') filter (where slot = 'current'), false) as last_sale_intrafamily,
    max(event_date) filter (where slot = 'prior') as prior_sale_date,
    max(price) filter (where slot = 'prior') as prior_sale_price
  from seller.property_sale group by property_id;

  create temp table _fc on commit drop as
  select distinct on (property_id) property_id,
    count(*) over (partition by property_id)::int as foreclosure_count,
    doc_type as foreclosure_stage,
    recording_date as foreclosure_recording_date,
    default_date as foreclosure_default_date,
    auction_date,
    unpaid_balance as foreclosure_unpaid_balance
  from seller.property_foreclosure
  order by property_id, coalesce(recording_date, default_date) desc nulls last;

  truncate public.property_record_summary;

  insert into public.property_record_summary
  select k.property_id,
    coalesce(m.mortgage_count, 0), m.mortgage_balance, m.mortgage_payment, m.mortgage_original,
    m.first_rate, m.max_rate, m.first_lender, m.first_loan_type, m.first_financing_type,
    m.first_recording_date, m.first_due_date,
    coalesce(m.has_private_lender, false), coalesce(m.has_heloc, false), coalesce(m.has_fha, false),
    coalesce(m.has_va, false), coalesce(m.has_seller_financing, false), coalesce(m.has_adjustable, false),
    coalesce(l.lien_count, 0), l.lien_amount_due, l.lien_categories, l.latest_lien_date,
    coalesce(l.has_probate, false), coalesce(l.has_lis_pendens, false), coalesce(l.has_death_record, false),
    coalesce(l.has_divorce_record, false), coalesce(l.has_judgment, false), coalesce(l.has_mechanics_lien, false),
    coalesce(l.has_tax_lien, false), coalesce(l.has_hoa_lien, false), coalesce(l.has_general_lien, false),
    coalesce(l.has_default_notice, false),
    coalesce(s.sale_count, 0), s.last_sale_date, s.last_sale_price, s.last_sale_doc_type, s.last_buyer, s.last_seller,
    s.last_sale_cash, coalesce(s.last_sale_distress, false), coalesce(s.last_sale_intrafamily, false),
    s.prior_sale_date, s.prior_sale_price,
    case when s.last_sale_date is not null then extract(year from age(current_date, s.last_sale_date))::int end,
    coalesce(f.foreclosure_count, 0), f.foreclosure_stage, f.foreclosure_recording_date, f.foreclosure_default_date,
    f.auction_date, f.foreclosure_unpaid_balance,
    now()
  from (
    select property_id from _mort union select property_id from _lien
    union select property_id from _sale union select property_id from _fc
  ) k
  left join _mort m using (property_id)
  left join _lien l using (property_id)
  left join _sale s using (property_id)
  left join _fc f using (property_id)
  where k.property_id is not null;

  get diagnostics n = row_count;
  analyze public.property_record_summary;
  return n;
end
$$;
revoke all on function public.refresh_property_record_summary() from public, anon, authenticated;
grant execute on function public.refresh_property_record_summary() to service_role;

-- One property's full record set, newest first within each kind.
create or replace function public.entity_graph_property_records(p_property_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, seller, pg_temp
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
      select jsonb_agg(jsonb_strip_nulls(to_jsonb(s) - 'source_row_uid' - 'import_batch_id' - 'property_id')
        order by s.event_date desc nulls last)
      from seller.property_sale s where s.property_id = p_property_id), '[]'::jsonb),
    'foreclosures', coalesce((
      select jsonb_agg(jsonb_strip_nulls(to_jsonb(f) - 'source_row_uid' - 'import_batch_id' - 'property_id')
        order by coalesce(f.recording_date, f.default_date) desc nulls last)
      from seller.property_foreclosure f where f.property_id = p_property_id), '[]'::jsonb)
  )
$$;
revoke all on function public.entity_graph_property_records(text) from public, anon, authenticated;
grant execute on function public.entity_graph_property_records(text) to service_role;

select public.refresh_property_record_summary();

notify pgrst, 'reload schema';
