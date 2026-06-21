-- Acquisition Engine V3 — additive transaction-identity view for comp clustering.
--
-- AMENDED 2026-06-21 after the Item 5A live join-lineage audit (audit §12).
-- The primary comp path (RPC get_comp_candidates_for_subject -> v_recent_sold_comps)
-- is identity-blind. The PROVEN deterministic identity key is:
--   candidate.comp_id == v_recent_sold_comps.id == buyer_comp_raw_v2.id   (5000/5000)
-- NOT recently_sold_properties (only ~1/8 of candidate property_ids appear there),
-- and NOT buyer_purchase_events_v2.comp_property_id (100% NULL). The original draft
-- of this view sourced from recently_sold_properties — that join is WRONG for the
-- primary path and is corrected here to source from buyer_comp_raw_v2 by id.
--
-- NOTE: the production-compatible loader (compCandidateLoader.js) already reads
-- buyer_comp_raw_v2 directly by id and does NOT require this view. This view is an
-- optional convenience/optimization for a single-join enrichment path; the loader
-- is fully testable and operational WITHOUT applying this migration.
--
-- ADDITIVE ONLY. Creates one view. No table/view drops or redefinitions.

CREATE OR REPLACE VIEW public.v_recent_sold_comp_identity AS
SELECT
  r.id,                              -- == v_recent_sold_comps.id == candidate comp_id
  r.property_id,
  r.apn_parcel_id,
  -- grantee (the comp's buyer) — buyer_comp_raw_v2 stores it as owner_*
  r.owner_name        AS buyer_name,
  r.owner_1_name      AS buyer_name_1,
  r.is_corporate_owner,
  r.out_of_state_owner,
  r.owner_address_full AS buyer_mailing_address,
  r.document_type,
  r.last_sale_doc_type,
  r.recording_date,
  r.sale_date,
  r.sale_price,
  r.mls_sold_price,
  r.subdivision_name,
  r.school_district_name,
  r.total_loan_amt,
  r.total_loan_balance,
  r.total_loan_payment,
  r.lienholder_name
FROM public.buyer_comp_raw_v2 r;

COMMENT ON VIEW public.v_recent_sold_comp_identity IS
  'Acq V3 (amended): transaction-identity keys for comp candidates, keyed by id == v_recent_sold_comps.id == buyer_comp_raw_v2.id. Buyer/grantee = owner_name. Optional optimization; compCandidateLoader reads buyer_comp_raw_v2 directly and does not require this view.';

NOTIFY pgrst, 'reload schema';
