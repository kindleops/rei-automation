-- Pre-Send Eligibility Engine: surface the renter ownership signal end-to-end.
--
-- The outbound feeder hard-blocks auto-send for likely_renting=true +
-- likely_owner=false, but the `likely_renting` boolean was never surfaced to the
-- runtime: the materialized feeder table lacked the column, and the expanded
-- view used for next-best-owner-contact selection did not expose it. Renters
-- whose matching_flags text does not carry the renter phrase (~7.7% of renters)
-- therefore slipped past the gate.
--
-- This migration:
--   1. Adds outbound_feeder_candidates.likely_renting and backfills it from the
--      same lateral-chosen prospect the refresh script uses.
--   2. Re-creates v_sms_ready_contacts_expanded to expose pr.likely_renting so
--      the per-phone fallback selector can score each contact point truthfully.
--
-- Idempotent / additive. The authoritative population path remains
-- scripts/outbound-feeder-candidates-refresh.sql.

-- 1. Feeder table column ------------------------------------------------------
ALTER TABLE public.outbound_feeder_candidates
  ADD COLUMN IF NOT EXISTS likely_renting boolean;

-- Backfill from the lateral-chosen prospect (mirrors the refresh script's pick).
-- Correlated scalar subquery (UPDATE ... FROM LATERAL cannot reference the
-- target table in Postgres).
UPDATE public.outbound_feeder_candidates ofc
SET likely_renting = (
  SELECT p.likely_renting
  FROM public.prospects p
  WHERE p.master_owner_id = ofc.master_owner_id
  ORDER BY
    (p.matching_flags IS NOT NULL AND p.matching_flags <> '') DESC,
    p.is_primary_prospect DESC NULLS LAST,
    p.phone_score_final DESC NULLS LAST,
    p.prospect_id
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM public.prospects p2 WHERE p2.master_owner_id = ofc.master_owner_id
);

-- 2. Expanded view: expose per-phone ownership signals -----------------------
-- The LIVE prod view (unlike the repo's 20260525 migration) has NO prospects
-- join and exposes none of likely_owner / matching_flags / person_flags_text /
-- likely_renting. The next-best-owner-contact selector needs these per-phone.
--
-- CREATE OR REPLACE VIEW only permits APPENDING columns at the end, so the live
-- column list (positions 1–45) is reproduced verbatim and the prospect signals
-- are appended (positions 46–50). The prospects LEFT JOIN is additive and does
-- not change the existing FROM (master_owners JOIN phones JOIN properties), so
-- existing column values are unchanged. Column position is irrelevant to the app
-- (rows are read by name).
CREATE OR REPLACE VIEW public.v_sms_ready_contacts_expanded AS
SELECT
  p.property_export_id,
  p.property_id,
  p.property_address_full,
  p.property_address_city,
  p.property_address_state,
  p.property_address_zip,
  p.property_county_name AS property_address_county_name,
  p.market,
  COALESCE(NULLIF(to_jsonb(p.*) ->> 'cash_offer'::text, ''::text)::numeric, NULL::numeric) AS cash_offer,
  p.estimated_value,
  p.equity_amount,
  p.equity_percent,
  COALESCE(NULLIF(to_jsonb(p.*) ->> 'final_acquisition_score'::text, ''::text)::numeric, NULLIF(to_jsonb(mo.*) ->> 'priority_score'::text, ''::text)::numeric, NULL::numeric) AS final_acquisition_score,
  p.seller_tags_text AS podio_tags,
  mo.master_owner_id,
  mo.master_key,
  mo.display_name,
  mo.primary_owner_address,
  mo.priority_tier,
  mo.follow_up_cadence,
  mo.agent_persona,
  mo.agent_family,
  mo.best_language,
  ph.phone_id AS best_phone_id,
  ph.phone_id,
  ph.phone,
  ph.canonical_e164,
  ph.best_phone_score,
  ph.phone_type,
  ph.activity_status,
  ph.usage_12_months,
  ph.usage_2_months,
  ph.contact_window,
  COALESCE(ph.timezone, mo.routing_timezone) AS timezone,
  ph.primary_prospect_id,
  ph.canonical_prospect_id,
  ph.phone_contact_status IS DISTINCT FROM 'wrong_number'::text AS sms_eligible,
  ph.phone_first_name,
  ph.phone_full_name,
  ph.primary_display_name,
  COALESCE(NULLIF(ph.phone_first_name, ''::text), split_part(NULLIF(ph.phone_full_name, ''::text), ' '::text, 1)) AS seller_first_name,
  COALESCE(NULLIF(ph.phone_full_name, ''::text), NULLIF(ph.primary_display_name, ''::text)) AS seller_full_name,
  'properties.master_owner_id'::text AS joined_property_source,
  row_number() OVER (PARTITION BY p.property_id, mo.master_owner_id ORDER BY (COALESCE(ph.best_phone_score, 0)) DESC NULLS LAST, (COALESCE(ph.contact_score_final, 0)) DESC NULLS LAST, ph.sort_rank) AS phone_rank,
  COALESCE(ph.best_phone_score, 0) + COALESCE(ph.contact_score_final, 0) AS candidate_confidence_score,
  -- Appended ownership signals (positions 46–50; must stay last).
  pr.likely_owner,
  pr.matching_flags,
  pr.person_flags_text,
  pr.person_flags_json,
  pr.likely_renting
FROM master_owners mo
  JOIN phones ph ON ph.master_owner_id = mo.master_owner_id
  JOIN properties p ON p.master_owner_id = mo.master_owner_id
  -- primary_prospect_id (pros*_) is the link to prospects.prospect_id in this DB;
  -- canonical_prospect_id (cpros_) is a separate id space that matches nothing,
  -- so it must be the fallback, not the primary key, or the join yields no signal.
  LEFT JOIN prospects pr
    ON pr.prospect_id::text = COALESCE(NULLIF(ph.primary_prospect_id::text, ''::text), NULLIF(ph.canonical_prospect_id::text, ''::text))
-- NOTE: the original live filter only accepted 'Mobile'/'VoIP'/'Unknown'/NULL,
-- but every phone in this DB carries phone_type = 'W' (wireless), so the view
-- returned 0 rows (dead). 'W' is added so the next-best-owner-contact selector
-- has rows to choose from. SMS-capability is still enforced downstream via
-- sms_eligible (phone_contact_status <> 'wrong_number').
WHERE ph.canonical_e164 IS NOT NULL
  AND ((ph.phone_type = ANY (ARRAY['Mobile'::text, 'VoIP'::text, 'W'::text])) OR ph.phone_type IS NULL OR ph.phone_type = 'Unknown'::text);
