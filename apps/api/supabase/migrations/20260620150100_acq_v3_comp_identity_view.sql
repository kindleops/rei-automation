-- Acquisition Engine V3 — additive transaction-identity view for comp clustering.
--
-- The primary comp path (RPC get_comp_candidates_for_subject -> v_recent_sold_comps)
-- is identity-blind: it exposes no buyer/seller/APN/recording/document fields, so
-- V3 cannot cluster by transaction identity on that path (audit §6). Rather than
-- CREATE OR REPLACE the prod-authoritative v_recent_sold_comps (whose full body is
-- NOT in the repo — migration drift), this migration adds a SEPARATE, purely
-- additive view that surfaces the identity keys from recently_sold_properties,
-- keyed by `id` so it can be joined onto comp candidates.
--
-- ADDITIVE ONLY. Creates one view. No table/view drops or redefinitions.

CREATE OR REPLACE VIEW public.v_recent_sold_comp_identity AS
SELECT
  rsp.id,
  rsp.property_id,
  rsp.apn_parcel_id,
  rsp.property_address_full,
  rsp.property_address_zip,
  rsp.property_address_city,
  rsp.property_address_county_name,
  rsp.buyer_name_clean,
  rsp.buyer_key,
  rsp.owner_name_clean,
  rsp.owner_key,
  rsp.is_corporate_owner,
  rsp.out_of_state_owner,
  rsp.sale_date,
  rsp.recording_date,
  rsp.sale_price
FROM public.recently_sold_properties rsp;

COMMENT ON VIEW public.v_recent_sold_comp_identity IS
  'Acq V3: transaction-identity keys (apn/buyer/seller/recording/sale) for clustering comp candidates by economic transaction rather than by row. Additive companion to v_recent_sold_comps.';

NOTIFY pgrst, 'reload schema';
