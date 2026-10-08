-- PROPOSED · NOT APPLIED. Run via execute_sql BEFORE the main file (CONCURRENTLY: no transaction).
-- 1) Reverse lookup number → person (alias detection + the refresh candidate set). OPTION_B §3
--    already called for it; without it every call scans seller.owner_phone (~261 MB).
CREATE INDEX CONCURRENTLY IF NOT EXISTS owner_phone_phone_value_plain_idx
  ON seller.owner_phone (phone_value) WHERE NOT is_encrypted;
-- 2) The refresh re-visits currently flagged rows; partial index keeps that a small scan.
--    (Run AFTER the main file, once the columns exist.)
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ctg_contact_truths_flagged_idx
--   ON public.campaign_target_graph (graph_id)
--   WHERE property_ever_contacted OR person_ever_contacted OR current_best_contact_touched OR retext_hold;
