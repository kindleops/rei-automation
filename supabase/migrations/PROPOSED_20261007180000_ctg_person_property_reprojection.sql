-- PROPOSED — NOT APPLIED. Campaign audience: person + property re-projection (2026-10-07).
--
-- campaign_target_graph is a DISPOSABLE TARGETING PROJECTION. seller.owner,
-- public.prospects, public.properties and property_acquisition_scores stay
-- authoritative; nothing here writes to them.
--
-- ROOT CAUSE (measured read-only 2026-10-07 ~10:30Z, 1% block samples):
--   1. Every demographic / property column of the graph is written ONLY by
--      campaign_target_graph_enrich_rows (PROPOSED_20261003220000, applied). The
--      full rebuild (refresh_campaign_target_graph_stage_commit) TRUNCATEs the graph
--      and re-inserts the stage rows, which never carry those columns. The rebuild
--      committed at 2026-10-07 10:18:28Z (run b58b2b93…) therefore reset gender,
--      age_bucket, income, … and building_condition, beds, … to NULL on all 176,605
--      rows. The nightly reconcile had finished its cycle at 06:46Z and will not
--      start another for 18 h; the incremental tick only re-projects rows whose
--      PHONE activity changed. Result: ~1% fill until the next night — every
--      demographic filter silently returned ~0.
--   2. prospect_id / canonical_prospect_id were never projected at all (the build
--      writes NULL "legacy provenance"; enrich_rows reads prospects only for names).
--   3. Age: seller.owner.month_of_birth is the source (99% of linked persons), in
--      two formats — YYYYMM and MM/YYYY. enrich_rows only parsed YYYYMM, dropping
--      ~4%. public.prospects.mob (YYYYMM, 97%) is the fallback.
--
-- THE JOIN (one person truth, no substitute principal):
--   graph.seller_person_key = seller.owner.individual_key   (PK; 100% of rows that
--     have a person key = 81.8% of the graph)
--   graph.seller_person_key = public.prospects.individual_key (indexed; the vendor
--     export covers 52% of person keys = ~42% of the graph). The primary prospect
--     wins (is_primary_prospect DESC, prospect_id). It supplies prospect_id and
--     fills a demographic seller.owner lacks.
--   Rows with no person key (entity-owned without a selected person, 18%) stay
--   UNKNOWN: no master_owner "primary prospect" and no phone-linked prospect is
--   substituted for the owner (outreach policy 10-05).
--   Projected fill after the backfill (same join, 1% sample, n=1,696): gender 78.7%,
--   income 79.2%, net_asset_value 79.1%, age_bucket 78.2%, buying_power 73.6%,
--   marital 71.5%, education 68.6%, language 68.2%, occupation 59.6%, prospect_id 40.4%.
--
-- WHAT THIS ADDS
--   §1 helpers  campaign_birth_month_age(text), campaign_age_bucket(int)
--   §2 sources  campaign_target_graph_person_source(ids)   — person columns
--               campaign_target_graph_property_source(ids) — property + score columns
--      (STABLE, read-only, bounded by the id list; the ONE place each column set is
--       derived — enrich_rows and the re-projection both read them)
--   §3 enrich_rows: same single UPDATE as before, person/property columns now come
--      from §2 (adds prospect_id, canonical_prospect_id, prospects fallback, MM/YYYY).
--   §4 re-projection: campaign_target_graph_reproject_rows(ids, sets) and the keyset
--      driver campaign_target_graph_reproject_batch(after, limit, sets, market).
--      sets ⊆ {person, property, scores, contact}; 'contact' = the full enrich_rows.
--      Only rows whose values actually change are written (resumable / idempotent).
--   §5 stage_commit: before the TRUNCATE the stage rows inherit the person/property/
--      score columns of the same graph row (same graph_id, property and person), so a
--      rebuild no longer blanks them; after the swap the nightly reconcile cycle is
--      reset so the next window re-projects everything from source.
--   §6 incremental_tick: spare capacity re-projects rows never enriched since the
--      last rebuild (enriched_at IS NULL), changed phones first. Needs the partial
--      index in PROPOSED_20261007180000_ctg_person_property_reprojection_index.sql
--      (CREATE INDEX CONCURRENTLY — apply that file FIRST, outside a transaction).
--
-- Not touched: sender coverage / routing (refresh_campaign_target_graph_sender_coverage,
-- resolve_campaign_safe_sender_route) — stage_commit calls them exactly as before.
--
-- Apply order (owner, off-peak, after the index):
--   1. psql -X -v ON_ERROR_STOP=1 -f PROPOSED_20261007180000_ctg_person_property_reprojection_index.sql
--   2. psql -X -1 -v ON_ERROR_STOP=1 -f PROPOSED_20261007180000_ctg_person_property_reprojection.sql
--   3. backfill: node apps/api/scripts/ops/campaign-graph/reproject-backfill.mjs --sets=person,property,scores
-- Rollback: PROPOSED_20261007180000_ctg_person_property_reprojection_rollback.sql
--
-- Locks: only pg_proc rows (CREATE OR REPLACE FUNCTION). No table DDL.

SET LOCAL lock_timeout = '5s';

-- ── §1 helpers ──────────────────────────────────────────────────────────────────
-- Vendor birth month → age in whole years. Accepts YYYYMM, YYYY-MM, MM/YYYY.
-- Anything else (or an impossible month/year) is unknown (NULL), never a guess.
CREATE OR REPLACE FUNCTION public.campaign_birth_month_age(p_value text, p_today date DEFAULT current_date)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH v AS (SELECT btrim(COALESCE(p_value, '')) AS t),
  ym AS (
    SELECT CASE
             WHEN t ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])$'      THEN left(t, 4)::int
             WHEN t ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'     THEN left(t, 4)::int
             WHEN t ~ '^(0?[1-9]|1[0-2])/(19|20)[0-9]{2}$'    THEN right(t, 4)::int
           END AS y,
           CASE
             WHEN t ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])$'      THEN right(t, 2)::int
             WHEN t ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'     THEN right(t, 2)::int
             WHEN t ~ '^(0?[1-9]|1[0-2])/(19|20)[0-9]{2}$'    THEN split_part(t, '/', 1)::int
           END AS m
    FROM v
  )
  SELECT CASE WHEN y IS NULL OR make_date(y, m, 1) > p_today THEN NULL
              ELSE date_part('year', age(p_today, make_date(y, m, 1)))::int END
  FROM ym;
$function$;

-- The catalog's age buckets (campaign-field-catalog.js). Out of range = unknown.
CREATE OR REPLACE FUNCTION public.campaign_age_bucket(p_age integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_age IS NULL OR p_age < 18 OR p_age > 120 THEN NULL
    WHEN p_age < 35 THEN 'Under 35'
    WHEN p_age <= 44 THEN '35-44'
    WHEN p_age <= 54 THEN '45-54'
    WHEN p_age <= 64 THEN '55-64'
    WHEN p_age <= 74 THEN '65-74'
    ELSE '75+' END;
$function$;

-- ── §2 column-set sources (read-only, bounded by the id list) ───────────────────
-- PERSON: seller.owner (canonical) by seller_person_key, then the person's primary
-- public.prospects row for prospect_id and any value seller.owner lacks.
CREATE OR REPLACE FUNCTION public.campaign_target_graph_person_source(p_graph_ids text[])
 RETURNS TABLE(
   graph_id text, prospect_id text, canonical_prospect_id text,
   first_name text, full_name text, language text, gender text, marital_status text,
   education_model text, occupation_group text, income text, net_asset_value text,
   buying_power text, age_bucket text, matching_flags_text text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH g AS (
    SELECT g.graph_id, g.seller_person_key
    FROM public.campaign_target_graph g
    WHERE g.graph_id = ANY(p_graph_ids)
  )
  SELECT
    g.graph_id,
    pr.prospect_id,
    NULLIF(pr.canonical_prospect_id, ''),
    COALESCE(NULLIF(btrim(o.given_name), ''), NULLIF(btrim(pr.first_name), '')),
    COALESCE(NULLIF(btrim(o.full_name), ''), NULLIF(btrim(pr.full_name), '')),
    COALESCE(NULLIF(o.language_preference, ''), NULLIF(pr.language_preference, '')),
    COALESCE(NULLIF(o.gender, ''), NULLIF(pr.gender, '')),
    COALESCE(NULLIF(o.marital_status, ''), NULLIF(pr.marital_status, '')),
    COALESCE(NULLIF(o.education_model, ''), NULLIF(pr.education_model, '')),
    COALESCE(NULLIF(o.occupation_group, ''), NULLIF(pr.occupation_group, '')),
    COALESCE(NULLIF(o.est_household_income, ''), NULLIF(pr.est_household_income, '')),
    COALESCE(NULLIF(o.net_asset_value, ''), NULLIF(pr.net_asset_value, '')),
    COALESCE(NULLIF(o.buying_power, ''), NULLIF(pr.buying_power, '')),
    public.campaign_age_bucket(COALESCE(
      public.campaign_birth_month_age(o.month_of_birth),
      public.campaign_birth_month_age(pr.mob))),
    COALESCE(NULLIF(array_to_string(o.person_flags, '; '), ''), NULLIF(pr.person_flags_text, ''))
  FROM g
  LEFT JOIN seller.owner o ON o.individual_key = g.seller_person_key
  LEFT JOIN LATERAL (
    SELECT p.prospect_id, p.canonical_prospect_id, p.first_name, p.full_name, p.language_preference,
           p.gender, p.marital_status, p.education_model, p.occupation_group, p.est_household_income,
           p.net_asset_value, p.buying_power, p.mob, p.person_flags_text
    FROM public.prospects p
    WHERE p.individual_key = g.seller_person_key
    ORDER BY p.is_primary_prospect DESC NULLS LAST, p.prospect_id
    LIMIT 1
  ) pr ON g.seller_person_key IS NOT NULL;
$function$;

-- PROPERTY (+ SCORES): public.properties by property_id; latest canonical score.
CREATE OR REPLACE FUNCTION public.campaign_target_graph_property_source(p_graph_ids text[])
 RETURNS TABLE(
   graph_id text, units_count numeric, building_condition text, building_quality text,
   rehab_level text, property_flags_text text, beds numeric, baths numeric,
   building_sqft numeric, year_built integer, lot_sqft numeric, total_loan_balance numeric,
   ownership_years numeric, tax_delinquent_year integer, estimated_repair_cost numeric,
   aos_score integer, decision_tier text, acquisition_confidence integer,
   transaction_probability_365 integer, best_strategy text, scores_computed_at timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH g AS (
    SELECT g.graph_id, g.property_id
    FROM public.campaign_target_graph g
    WHERE g.graph_id = ANY(p_graph_ids)
  )
  SELECT
    g.graph_id,
    p.units_count::numeric,
    NULLIF(p.building_condition, ''),
    NULLIF(p.building_quality, ''),
    COALESCE(NULLIF(p.rehab_level, ''), NULLIF(p.renovation_level_classification, '')),
    COALESCE(NULLIF(p.property_flags_text, ''), NULLIF(p.podio_tags, '')),
    p.total_bedrooms::numeric, p.total_baths::numeric, p.building_square_feet::numeric,
    p.year_built::integer, p.lot_square_feet::numeric, p.total_loan_balance::numeric,
    p.ownership_years::numeric, p.tax_delinquent_year::integer, p.estimated_repair_cost::numeric,
    pas.aos_score::integer, pas.decision_tier::text, pas.confidence::integer,
    pas.transaction_probability_365::integer, pas.best_strategy::text, pas.computed_at
  FROM g
  LEFT JOIN public.properties p ON p.property_id = g.property_id
  LEFT JOIN LATERAL (
    SELECT s.aos_score, s.decision_tier, s.confidence, s.transaction_probability_365, s.best_strategy, s.computed_at
    FROM public.property_acquisition_scores s
    WHERE s.property_id = g.property_id
    ORDER BY s.computed_at DESC NULLS LAST
    LIMIT 1
  ) pas ON true;
$function$;

-- ── §3 enrich_rows: unchanged contact/outreach logic; person + property from §2 ──
CREATE OR REPLACE FUNCTION public.campaign_target_graph_enrich_rows(p_graph_ids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows integer := 0;
BEGIN
  IF p_graph_ids IS NULL OR cardinality(p_graph_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_graph_ids) > 2000 THEN
    RAISE EXCEPTION 'campaign_target_graph_enrich_rows: % ids exceeds the 2000-row bound', cardinality(p_graph_ids);
  END IF;

  WITH g AS (
    SELECT g.graph_id, g.property_id, g.seller_person_key, g.canonical_e164, g.extra_data, g.blocker_flags,
           g.wrong_number, g.sender_covered,
           CASE WHEN g.canonical_e164 ~ '^[0-9]{10}$' THEN '+1' || g.canonical_e164 END AS e164
    FROM public.campaign_target_graph g
    WHERE g.graph_id = ANY(p_graph_ids)
  ),
  phones_in AS (SELECT DISTINCT e164 FROM g WHERE e164 IS NOT NULL),
  me AS (
    SELECT CASE WHEN m.direction ILIKE 'in%' THEN m.from_phone_number ELSE m.to_phone_number END AS e164,
           max(COALESCE(m.event_timestamp, m.sent_at, m.created_at)) FILTER (WHERE m.direction ILIKE 'out%') AS last_out,
           max(COALESCE(m.event_timestamp, m.received_at, m.created_at)) FILTER (WHERE m.direction ILIKE 'in%') AS last_in,
           count(*) FILTER (WHERE m.direction ILIKE 'out%') AS outs
    FROM public.message_events m
    WHERE (m.to_phone_number IN (SELECT e164 FROM phones_in) AND m.direction ILIKE 'out%')
       OR (m.from_phone_number IN (SELECT e164 FROM phones_in) AND m.direction ILIKE 'in%')
    GROUP BY 1
  ),
  sq AS (
    SELECT CASE WHEN s.to_phone_number LIKE '+1%' THEN s.to_phone_number ELSE '+1' || s.to_phone_number END AS e164,
           max(s.sent_at) AS last_sent,
           count(*) FILTER (WHERE s.sent_at IS NOT NULL) AS sent,
           bool_or(s.sent_at IS NULL AND lower(COALESCE(s.queue_status,'')) IN
                   ('queued','scheduled','pending','ready','approved','processing','sending','retry')) AS active
    FROM public.send_queue s
    WHERE s.to_phone_number IN (SELECT e164 FROM phones_in UNION ALL SELECT substr(e164, 3) FROM phones_in)
    GROUP BY 1
  ),
  supp AS (
    SELECT x.e164 FROM (
      SELECT s.phone_e164 AS e164 FROM public.sms_suppression_list s
       WHERE s.phone_e164 IN (SELECT e164 FROM phones_in) AND COALESCE(s.is_active, true)
      UNION
      SELECT a.phone_e164 FROM public.automation_suppressions a
       WHERE a.phone_e164 IN (SELECT e164 FROM phones_in)
         AND (a.expires_at IS NULL OR a.expires_at > now())
    ) x
  ),
  src AS (
    SELECT g.*,
      ps.prospect_id AS ps_prospect_id, ps.canonical_prospect_id AS ps_canonical_prospect_id,
      ps.first_name AS ps_first, ps.full_name AS ps_full, ps.language AS ps_language, ps.gender AS ps_gender,
      ps.marital_status AS ps_marital, ps.education_model AS ps_education, ps.occupation_group AS ps_occupation,
      ps.income AS ps_income, ps.net_asset_value AS ps_nav, ps.buying_power AS ps_buying_power,
      ps.age_bucket AS ps_age_bucket, ps.matching_flags_text AS ps_flags,
      opt.ptype AS op_type, opt.carrier AS op_carrier,
      ph.phone_type AS ph_type, ph.phone_owner, ph.activity_status, ph.usage_12_months, ph.usage_2_months, ph.wrong_number_at,
      pp.units_count, pp.building_condition, pp.building_quality, pp.rehab_level, pp.property_flags_text,
      pp.beds, pp.baths, pp.building_sqft, pp.year_built, pp.lot_sqft, pp.total_loan_balance, pp.ownership_years,
      pp.tax_delinquent_year, pp.estimated_repair_cost,
      pp.aos_score, pp.decision_tier, pp.acquisition_confidence, pp.transaction_probability_365,
      pp.best_strategy, pp.scores_computed_at,
      me.last_out, me.last_in, me.outs, sq.last_sent, sq.sent, sq.active,
      (supp.e164 IS NOT NULL) AS on_suppression
    FROM g
    LEFT JOIN public.campaign_target_graph_person_source(p_graph_ids) ps ON ps.graph_id = g.graph_id
    LEFT JOIN public.campaign_target_graph_property_source(p_graph_ids) pp ON pp.graph_id = g.graph_id
    LEFT JOIN LATERAL (
      SELECT CASE
               WHEN bool_or(op.phone_type IN ('W','Wireless')) AND NOT bool_or(op.phone_type IN ('L','Landline')) THEN 'W'
               WHEN bool_or(op.phone_type IN ('L','Landline')) AND NOT bool_or(op.phone_type IN ('W','Wireless')) THEN 'L'
             END AS ptype,
             max(NULLIF(op.carrier,'')) AS carrier
      FROM seller.owner_phone op
      WHERE op.individual_key = g.seller_person_key AND op.phone_value = g.canonical_e164
    ) opt ON g.seller_person_key IS NOT NULL AND g.canonical_e164 IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT ph.phone_type, ph.phone_owner, ph.activity_status, ph.usage_12_months, ph.usage_2_months, ph.wrong_number_at
      FROM public.phones ph WHERE ph.canonical_e164 = g.e164
      ORDER BY ph.best_phone_score DESC NULLS LAST LIMIT 1
    ) ph ON g.e164 IS NOT NULL
    LEFT JOIN me ON me.e164 = g.e164
    LEFT JOIN sq ON sq.e164 = g.e164
    LEFT JOIN supp ON supp.e164 = g.e164
  ),
  calc AS (
    SELECT s.*,
      COALESCE(
        s.op_type,
        CASE WHEN s.extra_data->>'phone_type' IN ('W','Wireless') THEN 'W'
             WHEN s.extra_data->>'phone_type' IN ('L','Landline') THEN 'L' END,
        CASE WHEN s.ph_type IN ('W','Wireless','mobile') THEN 'W'
             WHEN s.ph_type IN ('L','Landline','landline') THEN 'L' END
      ) AS ptype,
      CASE WHEN s.op_type IS NOT NULL THEN 'seller.owner_phone'
           WHEN s.extra_data->>'phone_type' IN ('W','Wireless','L','Landline') THEN 'seller.property_best_contact_v1'
           WHEN s.ph_type IN ('W','Wireless','mobile','L','Landline','landline') THEN 'public.phones'
           ELSE 'unknown' END AS ptype_source,
      NULLIF(GREATEST(COALESCE(s.last_out, 'epoch'::timestamptz), COALESCE(s.last_sent, 'epoch'::timestamptz)), 'epoch'::timestamptz) AS last_outbound,
      (COALESCE(s.wrong_number, false) OR s.wrong_number_at IS NOT NULL) AS wrong,
      (s.on_suppression OR COALESCE((s.blocker_flags->>'operational_excluded')::boolean, false)) AS suppressed
    FROM src s
  )
  UPDATE public.campaign_target_graph t SET
    prospect_id         = c.ps_prospect_id,
    canonical_prospect_id = c.ps_canonical_prospect_id,
    seller_first_name   = COALESCE(c.ps_first, t.seller_first_name),
    seller_full_name    = COALESCE(c.ps_full, t.seller_full_name),
    language            = COALESCE(c.ps_language, t.language),
    gender              = c.ps_gender,
    marital_status      = c.ps_marital,
    education_model     = c.ps_education,
    occupation_group    = c.ps_occupation,
    income              = c.ps_income,
    net_asset_value     = c.ps_nav,
    buying_power        = c.ps_buying_power,
    age_bucket          = c.ps_age_bucket,
    matching_flags_text = c.ps_flags,
    phone_type          = c.ptype,
    phone_type_source   = c.ptype_source,
    phone_owner         = COALESCE(NULLIF(c.op_carrier, ''), NULLIF(c.phone_owner, '')),
    phone_activity_status = NULLIF(c.activity_status, ''),
    usage_12_months     = NULLIF(c.usage_12_months, ''),
    usage_2_months      = NULLIF(c.usage_2_months, ''),
    last_outbound_at    = c.last_outbound,
    last_inbound_at     = c.last_in,
    latest_contact_at   = NULLIF(GREATEST(COALESCE(c.last_outbound, 'epoch'::timestamptz), COALESCE(c.last_in, 'epoch'::timestamptz)), 'epoch'::timestamptz),
    touch_count         = GREATEST(COALESCE(c.outs, 0), COALESCE(c.sent, 0))::integer,
    never_contacted     = (c.last_outbound IS NULL),
    pending_prior_touch = (c.last_outbound IS NOT NULL AND c.last_outbound >= now() - interval '30 days'),
    active_queue_item   = COALESCE(c.active, false),
    true_post_contact_suppression = COALESCE(c.suppressed, false),
    wrong_number        = COALESCE(c.wrong, false),
    sms_eligible        = COALESCE(c.canonical_e164 IS NOT NULL AND c.ptype = 'W' AND NOT COALESCE(c.wrong, false), false),
    queue_eligible      = COALESCE(
      c.canonical_e164 IS NOT NULL
      AND NOT COALESCE(c.wrong, false)
      AND c.ptype = 'W'
      AND NOT COALESCE(c.suppressed, false)
      AND NOT (c.last_outbound IS NOT NULL AND c.last_outbound >= now() - interval '30 days')
      AND NOT COALESCE(c.active, false)
      AND COALESCE(c.sender_covered, false)
    , false),
    queue_block_reason  = CASE
      WHEN c.canonical_e164 IS NULL                                              THEN 'missing_phone'
      WHEN c.wrong                                                               THEN 'wrong_number'
      WHEN c.ptype IS DISTINCT FROM 'W'                                          THEN 'non_sms_capable'
      WHEN c.suppressed                                                          THEN 'suppressed'
      WHEN c.last_outbound IS NOT NULL AND c.last_outbound >= now() - interval '30 days' THEN 'pending_prior_touch'
      WHEN COALESCE(c.active, false)                                             THEN 'active_queue_item'
      WHEN NOT COALESCE(c.sender_covered, false)                                 THEN 'no_sender_coverage'
      ELSE NULL END,
    blocker_flags       = COALESCE(t.blocker_flags, '{}'::jsonb) || jsonb_build_object(
      'wrong_number', c.wrong,
      'suppressed', c.on_suppression,
      'active_queue', COALESCE(c.active, false),
      'non_sms_capable', (c.canonical_e164 IS NOT NULL AND c.ptype IS DISTINCT FROM 'W'),
      'phone_type_unknown', (c.canonical_e164 IS NOT NULL AND c.ptype IS NULL)),
    units_count         = COALESCE(c.units_count, t.units_count),
    building_condition  = c.building_condition,
    building_quality    = c.building_quality,
    rehab_level         = c.rehab_level,
    property_flags_text = c.property_flags_text,
    beds                = c.beds,
    baths               = c.baths,
    building_sqft       = c.building_sqft,
    year_built          = c.year_built,
    lot_sqft            = c.lot_sqft,
    total_loan_balance  = c.total_loan_balance,
    ownership_years     = c.ownership_years,
    tax_delinquent_year = c.tax_delinquent_year,
    estimated_repair_cost = c.estimated_repair_cost,
    aos_score           = c.aos_score,
    decision_tier       = c.decision_tier,
    acquisition_confidence = c.acquisition_confidence,
    transaction_probability_365 = c.transaction_probability_365,
    best_strategy       = c.best_strategy,
    scores_computed_at  = c.scores_computed_at,
    enriched_at         = now(),
    enrich_version      = 'ctg_enrich_v2'
  FROM calc c
  WHERE t.graph_id = c.graph_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

-- ── §4 shared re-projection (one backfill for person + property + scores) ───────
-- sets: 'person'   prospect_id, canonical_prospect_id, names, language, gender,
--                  marital_status, education_model, occupation_group, income,
--                  net_asset_value, buying_power, age_bucket, matching_flags_text
--       'property' units_count, building_condition, building_quality, rehab_level,
--                  property_flags_text, beds, baths, building_sqft, year_built,
--                  lot_sqft, total_loan_balance, ownership_years, tax_delinquent_year,
--                  estimated_repair_cost
--       'scores'   aos_score, decision_tier, acquisition_confidence,
--                  transaction_probability_365, best_strategy, scores_computed_at
--       'contact'  the full campaign_target_graph_enrich_rows (phone type, outreach,
--                  suppression, eligibility) — implies the three sets above.
-- person/property/scores never touch eligibility, enriched_at or sender coverage.
-- A row is written only when one of its requested columns changes.
CREATE OR REPLACE FUNCTION public.campaign_target_graph_reproject_rows(p_graph_ids text[], p_sets text[] DEFAULT ARRAY['person','property','scores'])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sets text[] := ARRAY(SELECT DISTINCT lower(btrim(s)) FROM unnest(COALESCE(p_sets, ARRAY[]::text[])) s WHERE btrim(s) <> '');
  v_person boolean;
  v_property boolean;
  v_scores boolean;
  v_rows integer := 0;
BEGIN
  IF p_graph_ids IS NULL OR cardinality(p_graph_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_graph_ids) > 2000 THEN
    RAISE EXCEPTION 'campaign_target_graph_reproject_rows: % ids exceeds the 2000-row bound', cardinality(p_graph_ids);
  END IF;
  IF cardinality(v_sets) = 0 OR NOT v_sets <@ ARRAY['person','property','scores','contact'] THEN
    RAISE EXCEPTION 'campaign_target_graph_reproject_rows: sets must be a non-empty subset of {person,property,scores,contact}, got %', p_sets;
  END IF;
  IF 'contact' = ANY(v_sets) THEN
    RETURN public.campaign_target_graph_enrich_rows(p_graph_ids);
  END IF;
  v_person := 'person' = ANY(v_sets);
  v_property := 'property' = ANY(v_sets);
  v_scores := 'scores' = ANY(v_sets);

  WITH ps AS (
    SELECT * FROM public.campaign_target_graph_person_source(CASE WHEN v_person THEN p_graph_ids ELSE ARRAY[]::text[] END)
  ),
  pp AS (
    SELECT * FROM public.campaign_target_graph_property_source(CASE WHEN v_property OR v_scores THEN p_graph_ids ELSE ARRAY[]::text[] END)
  ),
  nv AS (
    SELECT t.graph_id,
      CASE WHEN v_person THEN ps.prospect_id ELSE t.prospect_id END AS prospect_id,
      CASE WHEN v_person THEN ps.canonical_prospect_id ELSE t.canonical_prospect_id END AS canonical_prospect_id,
      CASE WHEN v_person THEN COALESCE(ps.first_name, t.seller_first_name) ELSE t.seller_first_name END AS seller_first_name,
      CASE WHEN v_person THEN COALESCE(ps.full_name, t.seller_full_name) ELSE t.seller_full_name END AS seller_full_name,
      CASE WHEN v_person THEN COALESCE(ps.language, t.language) ELSE t.language END AS language,
      CASE WHEN v_person THEN ps.gender ELSE t.gender END AS gender,
      CASE WHEN v_person THEN ps.marital_status ELSE t.marital_status END AS marital_status,
      CASE WHEN v_person THEN ps.education_model ELSE t.education_model END AS education_model,
      CASE WHEN v_person THEN ps.occupation_group ELSE t.occupation_group END AS occupation_group,
      CASE WHEN v_person THEN ps.income ELSE t.income END AS income,
      CASE WHEN v_person THEN ps.net_asset_value ELSE t.net_asset_value END AS net_asset_value,
      CASE WHEN v_person THEN ps.buying_power ELSE t.buying_power END AS buying_power,
      CASE WHEN v_person THEN ps.age_bucket ELSE t.age_bucket END AS age_bucket,
      CASE WHEN v_person THEN ps.matching_flags_text ELSE t.matching_flags_text END AS matching_flags_text,
      CASE WHEN v_property THEN COALESCE(pp.units_count, t.units_count) ELSE t.units_count END AS units_count,
      CASE WHEN v_property THEN pp.building_condition ELSE t.building_condition END AS building_condition,
      CASE WHEN v_property THEN pp.building_quality ELSE t.building_quality END AS building_quality,
      CASE WHEN v_property THEN pp.rehab_level ELSE t.rehab_level END AS rehab_level,
      CASE WHEN v_property THEN pp.property_flags_text ELSE t.property_flags_text END AS property_flags_text,
      CASE WHEN v_property THEN pp.beds ELSE t.beds END AS beds,
      CASE WHEN v_property THEN pp.baths ELSE t.baths END AS baths,
      CASE WHEN v_property THEN pp.building_sqft ELSE t.building_sqft END AS building_sqft,
      CASE WHEN v_property THEN pp.year_built ELSE t.year_built END AS year_built,
      CASE WHEN v_property THEN pp.lot_sqft ELSE t.lot_sqft END AS lot_sqft,
      CASE WHEN v_property THEN pp.total_loan_balance ELSE t.total_loan_balance END AS total_loan_balance,
      CASE WHEN v_property THEN pp.ownership_years ELSE t.ownership_years END AS ownership_years,
      CASE WHEN v_property THEN pp.tax_delinquent_year ELSE t.tax_delinquent_year END AS tax_delinquent_year,
      CASE WHEN v_property THEN pp.estimated_repair_cost ELSE t.estimated_repair_cost END AS estimated_repair_cost,
      CASE WHEN v_scores THEN pp.aos_score ELSE t.aos_score END AS aos_score,
      CASE WHEN v_scores THEN pp.decision_tier ELSE t.decision_tier END AS decision_tier,
      CASE WHEN v_scores THEN pp.acquisition_confidence ELSE t.acquisition_confidence END AS acquisition_confidence,
      CASE WHEN v_scores THEN pp.transaction_probability_365 ELSE t.transaction_probability_365 END AS transaction_probability_365,
      CASE WHEN v_scores THEN pp.best_strategy ELSE t.best_strategy END AS best_strategy,
      CASE WHEN v_scores THEN pp.scores_computed_at ELSE t.scores_computed_at END AS scores_computed_at
    FROM public.campaign_target_graph t
    LEFT JOIN ps ON ps.graph_id = t.graph_id
    LEFT JOIN pp ON pp.graph_id = t.graph_id
    WHERE t.graph_id = ANY(p_graph_ids)
  )
  UPDATE public.campaign_target_graph t SET
    prospect_id = nv.prospect_id, canonical_prospect_id = nv.canonical_prospect_id,
    seller_first_name = nv.seller_first_name, seller_full_name = nv.seller_full_name,
    language = nv.language, gender = nv.gender, marital_status = nv.marital_status,
    education_model = nv.education_model, occupation_group = nv.occupation_group, income = nv.income,
    net_asset_value = nv.net_asset_value, buying_power = nv.buying_power, age_bucket = nv.age_bucket,
    matching_flags_text = nv.matching_flags_text,
    units_count = nv.units_count, building_condition = nv.building_condition, building_quality = nv.building_quality,
    rehab_level = nv.rehab_level, property_flags_text = nv.property_flags_text, beds = nv.beds, baths = nv.baths,
    building_sqft = nv.building_sqft, year_built = nv.year_built, lot_sqft = nv.lot_sqft,
    total_loan_balance = nv.total_loan_balance, ownership_years = nv.ownership_years,
    tax_delinquent_year = nv.tax_delinquent_year, estimated_repair_cost = nv.estimated_repair_cost,
    aos_score = nv.aos_score, decision_tier = nv.decision_tier, acquisition_confidence = nv.acquisition_confidence,
    transaction_probability_365 = nv.transaction_probability_365, best_strategy = nv.best_strategy,
    scores_computed_at = nv.scores_computed_at
  FROM nv
  WHERE t.graph_id = nv.graph_id
    AND (t.prospect_id, t.canonical_prospect_id, t.seller_first_name, t.seller_full_name, t.language, t.gender,
         t.marital_status, t.education_model, t.occupation_group, t.income, t.net_asset_value, t.buying_power,
         t.age_bucket, t.matching_flags_text,
         t.units_count, t.building_condition, t.building_quality, t.rehab_level, t.property_flags_text, t.beds,
         t.baths, t.building_sqft, t.year_built, t.lot_sqft, t.total_loan_balance, t.ownership_years,
         t.tax_delinquent_year, t.estimated_repair_cost,
         t.aos_score, t.decision_tier, t.acquisition_confidence, t.transaction_probability_365, t.best_strategy,
         t.scores_computed_at)
        IS DISTINCT FROM
        (nv.prospect_id, nv.canonical_prospect_id, nv.seller_first_name, nv.seller_full_name, nv.language, nv.gender,
         nv.marital_status, nv.education_model, nv.occupation_group, nv.income, nv.net_asset_value, nv.buying_power,
         nv.age_bucket, nv.matching_flags_text,
         nv.units_count, nv.building_condition, nv.building_quality, nv.rehab_level, nv.property_flags_text, nv.beds,
         nv.baths, nv.building_sqft, nv.year_built, nv.lot_sqft, nv.total_loan_balance, nv.ownership_years,
         nv.tax_delinquent_year, nv.estimated_repair_cost,
         nv.aos_score, nv.decision_tier, nv.acquisition_confidence, nv.transaction_probability_365, nv.best_strategy,
         nv.scores_computed_at);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

-- Keyset driver for the off-peak backfill and any per-market repair. Shares the
-- projection advisory lock with reconcile/incremental (never runs alongside them)
-- and their load shedding; a skipped call returns the SAME cursor so the caller
-- simply retries after its pause.
CREATE OR REPLACE FUNCTION public.campaign_target_graph_reproject_batch(
  p_after_graph_id text DEFAULT NULL,
  p_limit integer DEFAULT 400,
  p_sets text[] DEFAULT ARRAY['person','property','scores'],
  p_market text DEFAULT NULL)
 RETURNS TABLE(rows_scanned integer, rows_updated integer, next_after_graph_id text, has_more boolean, skipped text, elapsed_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 400), 1), 1000);
  v_ids text[];
BEGIN
  rows_scanned := 0; rows_updated := 0; next_after_graph_id := p_after_graph_id; has_more := true; skipped := NULL;
  IF NOT pg_try_advisory_xact_lock(hashtext('campaign_target_graph_projection')) THEN
    skipped := 'locked';
  ELSIF NOT public.campaign_target_graph_load_ok() THEN
    skipped := 'busy';
  ELSE
    SELECT array_agg(x.graph_id ORDER BY x.graph_id) INTO v_ids
    FROM (
      SELECT g.graph_id FROM public.campaign_target_graph g
      WHERE (p_after_graph_id IS NULL OR g.graph_id > p_after_graph_id)
        AND (p_market IS NULL OR g.market = p_market)
      ORDER BY g.graph_id
      LIMIT v_limit
    ) x;
    rows_scanned := COALESCE(cardinality(v_ids), 0);
    rows_updated := public.campaign_target_graph_reproject_rows(v_ids, p_sets);
    next_after_graph_id := COALESCE(v_ids[cardinality(v_ids)], p_after_graph_id);
    has_more := rows_scanned = v_limit;
  END IF;
  elapsed_ms := floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer;
  RETURN NEXT;
END;
$function$;

-- ── §5 stage_commit: a rebuild keeps the projection; the next night re-derives it ──
-- Identical to the live definition (2026-10-07) except the two marked blocks.
CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_stage_commit(p_run_id uuid, p_force_partial boolean DEFAULT false)
 RETURNS TABLE(run_id uuid, graph_rows integer, facet_rows integer, graph_refresh_scope text, elapsed_ms integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_stage_rows integer := 0;
  v_graph_rows integer := 0;
  v_facet_rows integer := 0;
  v_carried_rows integer := 0;
  v_elapsed_ms integer := 0;
  v_scope text := 'partial';
  v_run_metadata jsonb := '{}'::jsonb;
  v_sender_coverage record;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '128MB', true);

  SELECT COALESCE(refresh_run.metadata, '{}'::jsonb)
  INTO v_run_metadata
  FROM public.campaign_target_graph_refresh_runs refresh_run
  WHERE refresh_run.id = p_run_id
    AND refresh_run.status = 'started';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign target graph refresh run % is not active', p_run_id;
  END IF;

  SELECT COUNT(*)::integer
  INTO v_stage_rows
  FROM public.campaign_target_graph_stage;

  IF v_stage_rows <= 0 THEN
    UPDATE public.campaign_target_graph_refresh_runs
    SET
      status = 'failed',
      finished_at = now(),
      graph_rows = 0,
      facet_rows = 0,
      error_message = 'campaign_target_graph_stage_empty',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'graph_refresh_scope', 'empty',
        'stage_rows', 0
      )
    WHERE id = p_run_id;

    RAISE EXCEPTION 'campaign_target_graph_stage is empty for run %', p_run_id;
  END IF;

  v_scope := CASE
    WHEN COALESCE(v_run_metadata->>'completed_all_batches', 'false') = 'true' THEN 'full'
    ELSE 'partial'
  END;

  -- Guard: Refuse to commit partial graph unless forced
  IF v_scope = 'partial' AND COALESCE(p_force_partial, false) = false AND COALESCE((v_run_metadata->>'force_partial')::boolean, false) = false THEN
    UPDATE public.campaign_target_graph_refresh_runs
    SET
      status = 'failed',
      finished_at = now(),
      error_message = 'refused_partial_commit',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'graph_refresh_scope', 'partial',
        'stage_rows', v_stage_rows,
        'guard_reason', 'Refusing to overwrite full production graph with partial data. Use p_force_partial=true or add force_partial:true to run metadata.'
      )
    WHERE id = p_run_id;

    RAISE EXCEPTION 'Refusing to commit partial campaign target graph to production for run %. Data remains in campaign_target_graph_stage.', p_run_id;
  END IF;

  -- [20261007180000] Carry the person / property / score projection forward. The
  -- stage never derives these columns; without this a rebuild blanks every
  -- demographic and property filter until the next nightly reconcile. Only the
  -- same contact (graph_id) for the same property and the same person inherits,
  -- and only where the stage has no value of its own. Runs BEFORE the TRUNCATE, so
  -- graph readers are not blocked by it.
  UPDATE public.campaign_target_graph_stage s SET
    prospect_id = COALESCE(s.prospect_id, g.prospect_id),
    canonical_prospect_id = COALESCE(s.canonical_prospect_id, g.canonical_prospect_id),
    language = COALESCE(s.language, g.language),
    gender = COALESCE(s.gender, g.gender),
    marital_status = COALESCE(s.marital_status, g.marital_status),
    education_model = COALESCE(s.education_model, g.education_model),
    occupation_group = COALESCE(s.occupation_group, g.occupation_group),
    income = COALESCE(s.income, g.income),
    net_asset_value = COALESCE(s.net_asset_value, g.net_asset_value),
    buying_power = COALESCE(s.buying_power, g.buying_power),
    age_bucket = COALESCE(s.age_bucket, g.age_bucket),
    matching_flags_text = COALESCE(s.matching_flags_text, g.matching_flags_text),
    units_count = COALESCE(s.units_count, g.units_count),
    building_condition = COALESCE(s.building_condition, g.building_condition),
    building_quality = COALESCE(s.building_quality, g.building_quality),
    rehab_level = COALESCE(s.rehab_level, g.rehab_level),
    property_flags_text = COALESCE(s.property_flags_text, g.property_flags_text),
    beds = COALESCE(s.beds, g.beds),
    baths = COALESCE(s.baths, g.baths),
    building_sqft = COALESCE(s.building_sqft, g.building_sqft),
    year_built = COALESCE(s.year_built, g.year_built),
    lot_sqft = COALESCE(s.lot_sqft, g.lot_sqft),
    total_loan_balance = COALESCE(s.total_loan_balance, g.total_loan_balance),
    ownership_years = COALESCE(s.ownership_years, g.ownership_years),
    tax_delinquent_year = COALESCE(s.tax_delinquent_year, g.tax_delinquent_year),
    estimated_repair_cost = COALESCE(s.estimated_repair_cost, g.estimated_repair_cost),
    aos_score = COALESCE(s.aos_score, g.aos_score),
    decision_tier = COALESCE(s.decision_tier, g.decision_tier),
    acquisition_confidence = COALESCE(s.acquisition_confidence, g.acquisition_confidence),
    transaction_probability_365 = COALESCE(s.transaction_probability_365, g.transaction_probability_365),
    best_strategy = COALESCE(s.best_strategy, g.best_strategy),
    scores_computed_at = COALESCE(s.scores_computed_at, g.scores_computed_at)
  FROM public.campaign_target_graph g
  WHERE g.graph_id = s.graph_id
    AND g.property_id IS NOT DISTINCT FROM s.property_id
    AND g.seller_person_key IS NOT DISTINCT FROM s.seller_person_key
    AND (g.enriched_at IS NOT NULL OR g.gender IS NOT NULL OR g.building_condition IS NOT NULL OR g.prospect_id IS NOT NULL);
  GET DIAGNOSTICS v_carried_rows = ROW_COUNT;
  -- [/20261007180000]

  TRUNCATE TABLE public.campaign_target_graph;

  INSERT INTO public.campaign_target_graph
  SELECT *
  FROM public.campaign_target_graph_stage;

  GET DIAGNOSTICS v_graph_rows = ROW_COUNT;

  SELECT *
  INTO v_sender_coverage
  FROM public.refresh_campaign_target_graph_sender_coverage(
    'refresh_campaign_target_graph_stage_commit'
  );

  SELECT public.refresh_campaign_target_graph_facets()
  INTO v_facet_rows;

  -- [20261007180000] The swapped-in rows were never enriched against today's
  -- sources: open a new reconcile cycle so the next night window re-projects them
  -- all (the daytime incremental tick also works through enriched_at IS NULL).
  UPDATE public.campaign_target_graph_sync_state
  SET cursor_text = NULL, cycle_finished_at = NULL, cycle_started_at = NULL, updated_at = now()
  WHERE key = 'reconcile';
  -- [/20261007180000]

  v_elapsed_ms := GREATEST(
    0,
    floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );

  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'completed',
    finished_at = now(),
    graph_rows = v_graph_rows,
    facet_rows = v_facet_rows,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'source', 'refresh_campaign_target_graph_stage_commit',
      'stage_rows', v_stage_rows,
      'graph_rows', v_graph_rows,
      'facet_rows', v_facet_rows,
      'projection_carried_rows', v_carried_rows,
      'graph_refresh_scope', v_scope,
      'fallback_enabled', true,
      'sender_route_mode', 'health_safe_exact_then_approved_state_fallback',
      'first_touch_regional_fallback_enabled', true,
      'exact_market_covered', v_sender_coverage.exact_market_covered,
      'health_safe_exact', v_sender_coverage.health_safe_exact,
      'fallback_covered', v_sender_coverage.fallback_covered,
      'sender_covered', v_sender_coverage.sender_covered,
      'expanded_deliverable', v_sender_coverage.expanded_deliverable,
      'uncovered_gap', v_sender_coverage.uncovered_gap,
      'health_blocked_sender_count', v_sender_coverage.health_blocked_sender_count,
      'elapsed_ms_commit', v_elapsed_ms
    )
  WHERE id = p_run_id;

  run_id := p_run_id;
  graph_rows := v_graph_rows;
  facet_rows := v_facet_rows;
  graph_refresh_scope := v_scope;
  elapsed_ms := v_elapsed_ms;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'failed',
    finished_at = now(),
    error_message = SQLERRM,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'source', 'refresh_campaign_target_graph_stage_commit',
      'error_sqlstate', SQLSTATE
    )
  WHERE id = p_run_id;
  RAISE;
END;
$function$;

-- ── §6 incremental tick: changed phones first, then never-enriched rows ─────────
-- Identical to the live definition except the `unprojected` leg (marked).
CREATE OR REPLACE FUNCTION public.campaign_target_graph_incremental_tick(p_max_rows integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_wm timestamptz;
  v_new_wm timestamptz;
  v_limit integer := LEAST(GREATEST(COALESCE(p_max_rows, 300), 1), 1000);
  v_ids text[];
  v_rows integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('campaign_target_graph_projection')) THEN
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;
  IF NOT public.campaign_target_graph_load_ok() THEN
    UPDATE public.campaign_target_graph_sync_state SET last_run_at = now(), last_skip_reason = 'busy', updated_at = now() WHERE key = 'incremental';
    RETURN jsonb_build_object('skipped', 'busy');
  END IF;
  SELECT COALESCE(watermark, now() - interval '1 hour') INTO v_wm
  FROM public.campaign_target_graph_sync_state WHERE key = 'incremental' FOR UPDATE;

  WITH changed AS (
    SELECT CASE WHEN m.direction ILIKE 'in%' THEN m.from_phone_number ELSE m.to_phone_number END AS e164, m.created_at AS ts
      FROM public.message_events m WHERE m.created_at > v_wm
    UNION ALL
    SELECT s.to_phone_number, s.updated_at FROM public.send_queue s
     WHERE s.updated_at > v_wm AND s.to_phone_number IS NOT NULL AND s.to_phone_number <> ''
    UNION ALL
    SELECT l.phone_e164, COALESCE(l.suppressed_at, l.created_at) FROM public.sms_suppression_list l
     WHERE COALESCE(l.suppressed_at, l.created_at) > v_wm
    UNION ALL
    SELECT a.phone_e164, a.updated_at FROM public.automation_suppressions a
     WHERE a.updated_at > v_wm AND a.phone_e164 IS NOT NULL
  ),
  changed_phones AS (
    SELECT CASE WHEN e164 LIKE '+1%' THEN substr(e164, 3) ELSE e164 END AS p10, max(ts) AS ts
    FROM changed WHERE e164 IS NOT NULL GROUP BY 1
  ),
  expired AS (
    SELECT g.graph_id, g.last_outbound_at + interval '30 days' AS ts
    FROM public.campaign_target_graph g
    WHERE g.pending_prior_touch = true AND g.last_outbound_at < now() - interval '30 days'
    LIMIT v_limit
  ),
  -- [20261007180000] rows a rebuild swapped in and nothing has enriched yet
  -- (partial index ctg_unenriched_graph_id_idx). NULL ts: they only take capacity
  -- the change legs leave free, and never move the watermark.
  unprojected AS (
    SELECT g.graph_id, NULL::timestamptz AS ts
    FROM public.campaign_target_graph g
    WHERE g.enriched_at IS NULL
    ORDER BY g.graph_id
    LIMIT v_limit
  ),
  -- [/20261007180000]
  picked AS (
    SELECT g.graph_id, p.ts FROM changed_phones p JOIN public.campaign_target_graph g ON g.canonical_e164 = p.p10
    UNION
    SELECT graph_id, ts FROM expired
    UNION
    SELECT graph_id, ts FROM unprojected
    ORDER BY 2 NULLS LAST
    LIMIT v_limit
  )
  SELECT array_agg(graph_id), max(ts) FILTER (WHERE ts <= now()) INTO v_ids, v_new_wm FROM picked;

  v_rows := public.campaign_target_graph_enrich_rows(v_ids);

  UPDATE public.campaign_target_graph_sync_state SET
    watermark = GREATEST(COALESCE(v_new_wm, v_wm), v_wm),
    last_run_at = now(), last_rows = v_rows, last_skip_reason = NULL,
    last_ms = floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer,
    updated_at = now()
  WHERE key = 'incremental';
  RETURN jsonb_build_object('rows', v_rows, 'watermark', GREATEST(COALESCE(v_new_wm, v_wm), v_wm));
END;
$function$;

-- ── grants: new definer functions are operator/cron only (existing ACLs unchanged) ──
REVOKE ALL ON FUNCTION public.campaign_birth_month_age(text, date) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_person_source(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_property_source(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_reproject_rows(text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_reproject_batch(text, integer, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_target_graph_reproject_rows(text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_target_graph_reproject_batch(text, integer, text[], text) TO service_role;
