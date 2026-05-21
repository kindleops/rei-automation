-- ============================================================
-- RPC: get_thread_enrichment
-- Returns owner/property enrichment data for inbox threads.
-- SECURITY DEFINER bypasses RLS so the anon key can access data.
-- Uses set-based joins for performance.
-- ============================================================

drop function if exists public.get_thread_enrichment(text[]);

create or replace function public.get_thread_enrichment(p_thread_keys text[])
returns table (
  thread_key text,
  property_id text,
  master_owner_id text,
  prospect_id text,
  owner_display_name text,
  seller_first_name text,
  seller_last_name text,
  owner_type text,
  contact_language text,
  best_phone text,
  phone_confidence text,
  property_address_full text,
  property_street text,
  property_city text,
  property_state text,
  property_zip text,
  property_type text,
  market_name text,
  beds numeric,
  baths numeric,
  sqft numeric,
  year_built numeric,
  effective_year_built numeric,
  estimated_value numeric,
  cash_offer numeric,
  equity_amount numeric,
  equity_percent numeric,
  estimated_repair_cost numeric,
  final_acquisition_score numeric,
  motivation_score numeric,
  motivation_summary text,
  deal_next_step text,
  podio_tags text,
  is_owner_occupied boolean,
  is_absentee boolean,
  is_vacant boolean,
  has_lien boolean,
  is_probate boolean,
  is_tax_delinquent boolean,
  streetview_image text,
  zillow_url text,
  realtor_url text
)
language sql
security definer
set search_path = public
as $$
  with thread_ids as (
    select
      tk.thread_key,
      case when tk.thread_key like 'phone:%' then substring(tk.thread_key from 7) end as phone_raw,
      case when tk.thread_key like 'owner:%' then substring(tk.thread_key from 7) end as owner_id_raw,
      case when tk.thread_key like 'prospect:%' then substring(tk.thread_key from 8) end as prospect_id_raw,
      case when tk.thread_key like 'property:%' then substring(tk.thread_key from 11) end as property_id_raw,
      case when tk.thread_key like 'event:%' then substring(tk.thread_key from 7)::uuid end as event_id_raw
    from unnest(p_thread_keys) as tk(thread_key)
  ),
  -- Find latest message_event for each thread
  latest_events as (
    select distinct on (ti.thread_key)
      ti.thread_key,
      me.property_id,
      me.master_owner_id,
      me.prospect_id,
      me.market_id,
      me.property_address
    from thread_ids ti
    left join public.message_events me on (
      (ti.phone_raw is not null and (me.from_phone_number = ti.phone_raw or me.to_phone_number = ti.phone_raw))
      or (ti.owner_id_raw is not null and me.master_owner_id = ti.owner_id_raw)
      or (ti.prospect_id_raw is not null and me.prospect_id = ti.prospect_id_raw)
      or (ti.property_id_raw is not null and me.property_id = ti.property_id_raw)
      or (ti.event_id_raw is not null and me.id = ti.event_id_raw)
    )
    order by ti.thread_key, me.event_timestamp desc nulls last, me.id desc
  ),
  -- Enrich with property data
  property_enriched as (
    select
      le.thread_key,
      coalesce(p.property_id::text, le.property_id) as property_id,
      le.master_owner_id,
      le.prospect_id,
      le.market_id,
      p.property_address_full,
      p.property_address as property_street,
      p.property_address_city as property_city,
      p.property_address_state as property_state,
      p.property_address_zip as property_zip,
      p.property_type,
      p.total_bedrooms as beds,
      p.total_baths as baths,
      p.building_square_feet as sqft,
      p.year_built,
      p.effective_year_built,
      p.estimated_value,
      p.cash_offer,
      p.equity_amount,
      p.equity_percent,
      p.estimated_repair_cost,
      p.final_acquisition_score,
      p.structured_motivation_score as motivation_score,
      null::text as motivation_summary,
      null::text as deal_next_step,
      p.podio_tags,
      p.streetview_image,
      p.tax_delinquent as is_tax_delinquent,
      p.active_lien as has_lien,
      null::boolean as is_owner_occupied,
      null::boolean as is_absentee,
      null::boolean as is_vacant,
      null::boolean as is_probate,
      null::text as zillow_url,
      null::text as realtor_url,
      coalesce(p.market, le.market_id) as market_name,
      p.owner_1_firstname as seller_first_name,
      p.owner_1_lastname as seller_last_name
    from latest_events le
    left join public.properties p on p.property_id::text = coalesce(le.property_id, null)
  ),
  -- Enrich with owner data
  owner_enriched as (
    select
      pe.thread_key,
      pe.property_id,
      pe.master_owner_id,
      pe.prospect_id,
      pe.property_address_full,
      pe.property_street,
      pe.property_city,
      pe.property_state,
      pe.property_zip,
      pe.property_type,
      pe.beds,
      pe.baths,
      pe.sqft,
      pe.year_built,
      pe.effective_year_built,
      pe.estimated_value,
      pe.cash_offer,
      pe.equity_amount,
      pe.equity_percent,
      pe.estimated_repair_cost,
      pe.final_acquisition_score,
      pe.motivation_score,
      pe.motivation_summary,
      pe.deal_next_step,
      pe.podio_tags,
      pe.streetview_image,
      pe.is_tax_delinquent,
      pe.has_lien,
      pe.is_owner_occupied,
      pe.is_absentee,
      pe.is_vacant,
      pe.is_probate,
      pe.zillow_url,
      pe.realtor_url,
      pe.market_name,
      coalesce(pe.seller_first_name, so.owner_name) as seller_first_name,
      pe.seller_last_name,
      mo.display_name as owner_display_name,
      mo.owner_type_guess as owner_type,
      mo.best_language as contact_language,
      mo.best_phone_1 as best_phone,
      mo.best_phone_confidence as phone_confidence
    from property_enriched pe
    left join public.master_owners mo on mo.master_owner_id::text = pe.master_owner_id
    left join public.sub_owners so on so.master_owner_id::text = pe.master_owner_id
  )
  select
    oe.thread_key,
    oe.property_id,
    oe.master_owner_id,
    oe.prospect_id,
    oe.owner_display_name,
    oe.seller_first_name,
    oe.seller_last_name,
    oe.owner_type,
    oe.contact_language,
    oe.best_phone,
    oe.phone_confidence,
    oe.property_address_full,
    oe.property_street,
    oe.property_city,
    oe.property_state,
    oe.property_zip,
    oe.property_type,
    oe.market_name,
    oe.beds,
    oe.baths,
    oe.sqft,
    oe.year_built,
    oe.effective_year_built,
    oe.estimated_value,
    oe.cash_offer,
    oe.equity_amount,
    oe.equity_percent,
    oe.estimated_repair_cost,
    oe.final_acquisition_score,
    oe.motivation_score,
    oe.motivation_summary,
    oe.deal_next_step,
    oe.podio_tags,
    oe.is_owner_occupied,
    oe.is_absentee,
    oe.is_vacant,
    oe.has_lien,
    oe.is_probate,
    oe.is_tax_delinquent,
    oe.streetview_image,
    oe.zillow_url,
    oe.realtor_url
  from owner_enriched oe;
$$;

grant execute on function public.get_thread_enrichment(text[]) to anon, authenticated;
