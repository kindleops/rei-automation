-- Hydrate prospect match flags into the outbound feeder source views so
-- relationship-probe template routing can use the exact prospect match flags.

create or replace view public.v_sms_ready_contacts_expanded as
select
  -- Property
  p.property_export_id,
  p.property_id,
  p.property_address_full,
  p.property_address_city,
  p.property_address_state,
  p.property_address_zip,
  p.property_county_name as property_address_county_name,
  p.market,
  coalesce(nullif(to_jsonb(p)->>'cash_offer', '')::numeric, null::numeric) as cash_offer,
  p.estimated_value,
  p.equity_amount,
  p.equity_percent,
  coalesce(
    nullif(to_jsonb(p)->>'final_acquisition_score', '')::numeric,
    nullif(to_jsonb(mo)->>'priority_score', '')::numeric,
    null::numeric
  ) as final_acquisition_score,
  p.seller_tags_text as podio_tags,

  -- Master owner
  mo.master_owner_id,
  mo.master_key,
  mo.display_name,
  mo.primary_owner_address,
  mo.priority_tier,
  mo.follow_up_cadence,
  mo.agent_persona,
  mo.agent_family,
  mo.best_language,

  -- Phone linkage directly from phones
  ph.phone_id::text as best_phone_id,
  ph.phone_id::text as phone_id,
  ph.phone,
  ph.canonical_e164,
  ph.best_phone_score,
  ph.phone_type,
  ph.activity_status,
  ph.usage_12_months,
  ph.usage_2_months,
  ph.contact_window,
  coalesce(ph.timezone, mo.routing_timezone) as timezone,
  ph.primary_prospect_id,
  ph.canonical_prospect_id,
  pr.likely_owner,
  pr.matching_flags,
  pr.person_flags_text,
  pr.person_flags_json,
  (ph.phone_contact_status is distinct from 'wrong_number') as sms_eligible,
  ph.phone_first_name,
  ph.phone_full_name,
  ph.primary_display_name,
  coalesce(
    nullif(ph.phone_first_name, ''),
    split_part(nullif(ph.phone_full_name, ''), ' ', 1)
  ) as seller_first_name,
  coalesce(
    nullif(ph.phone_full_name, ''),
    nullif(ph.primary_display_name, '')
  ) as seller_full_name,
  'properties.master_owner_id'::text as joined_property_source,

  -- Expansion additions
  row_number() over (
    partition by p.property_id, mo.master_owner_id
    order by
      coalesce(ph.best_phone_score, 0) desc nulls last,
      coalesce(ph.contact_score_final, 0) desc nulls last,
      ph.sort_rank asc nulls last
  ) as phone_rank,
  (coalesce(ph.best_phone_score, 0) + coalesce(ph.contact_score_final, 0)) as candidate_confidence_score
from public.master_owners mo
join public.phones ph on ph.master_owner_id = mo.master_owner_id
join public.properties p on p.master_owner_id = mo.master_owner_id
left join public.prospects pr
  on pr.prospect_id::text = coalesce(
    nullif(ph.canonical_prospect_id::text, ''),
    nullif(ph.primary_prospect_id::text, '')
  )
where ph.canonical_e164 is not null
  and (ph.phone_type in ('Mobile', 'VoIP') or ph.phone_type is null or ph.phone_type = 'Unknown');

create or replace view public.v_sms_ready_contacts as
select
  -- Property
  p.property_export_id,
  p.property_id,
  p.property_address_full,
  p.property_address_city,
  p.property_address_state,
  p.property_address_zip,
  p.property_county_name as property_address_county_name,
  p.market,
  coalesce(nullif(to_jsonb(p)->>'cash_offer', '')::numeric, null::numeric) as cash_offer,
  p.estimated_value,
  p.equity_amount,
  p.equity_percent,
  coalesce(
    nullif(to_jsonb(p)->>'final_acquisition_score', '')::numeric,
    nullif(to_jsonb(mo)->>'priority_score', '')::numeric,
    null::numeric
  ) as final_acquisition_score,
  p.seller_tags_text as podio_tags,

  -- Master owner
  mo.master_owner_id,
  mo.master_key,
  mo.display_name,
  mo.primary_owner_address,
  mo.priority_tier,
  mo.follow_up_cadence,
  mo.agent_persona,
  mo.agent_family,
  mo.best_language,

  -- Authoritative phone linkage (primary_phone_id -> best_phone_1)
  coalesce(nullif(mo.primary_phone_id, ''), nullif(mo.best_phone_1, '')) as best_phone_id,
  coalesce(ph.phone_id::text, coalesce(nullif(mo.primary_phone_id, ''), nullif(mo.best_phone_1, ''))) as phone_id,
  ph.phone,
  ph.canonical_e164,
  ph.best_phone_score,
  ph.phone_type,
  ph.activity_status,
  ph.usage_12_months,
  ph.usage_2_months,
  ph.contact_window,
  coalesce(ph.timezone, mo.routing_timezone) as timezone,
  ph.primary_prospect_id,
  ph.canonical_prospect_id,
  pr.likely_owner,
  pr.matching_flags,
  pr.person_flags_text,
  pr.person_flags_json,
  (coalesce(ph.canonical_e164, ph.phone) is not null and ph.phone_contact_status is distinct from 'wrong_number') as sms_eligible,
  ph.phone_first_name,
  ph.phone_full_name,
  ph.primary_display_name,
  coalesce(
    nullif(ph.phone_first_name, ''),
    split_part(nullif(ph.phone_full_name, ''), ' ', 1)
  ) as seller_first_name,
  coalesce(
    nullif(ph.phone_full_name, ''),
    nullif(ph.primary_display_name, '')
  ) as seller_full_name,
  'properties.master_owner_id'::text as joined_property_source
from public.master_owners mo
left join public.phones ph
  on ph.phone_id::text = coalesce(nullif(mo.primary_phone_id, ''), nullif(mo.best_phone_1, ''))
left join public.properties p
  on p.master_owner_id = mo.master_owner_id
left join public.prospects pr
  on pr.prospect_id::text = coalesce(
    nullif(ph.canonical_prospect_id::text, ''),
    nullif(ph.primary_prospect_id::text, '')
  );
