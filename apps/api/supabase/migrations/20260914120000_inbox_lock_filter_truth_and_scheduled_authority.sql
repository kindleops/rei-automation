-- ─── INBOX-COMPOSER-LOCK-1 ──────────────────────────────────────────────────
-- Three defects, all measured on production 2026-09-14.
--
-- 1. ADVANCED FILTERS TIMED OUT AND TOOK THE INBOX WITH THEM.
--    inbox_threads_hydrated resolved a thread's phone/prospect identity through
--    two CTEs (phone_links, prospect_links) joined back to the `base` CTE by
--    thread_key. A CTE scan cannot be indexed, and the planner estimates `base`
--    at 45 rows against an actual 8,887, so it chose a nested loop for both
--    joins:
--        Rows Removed by Join Filter: 32,958,174   (x2)
--        Execution Time: 15,702 ms
--    Filtering the Inbox on phoneCarrier=T-Mobile therefore exceeded the
--    statement timeout, PostgREST returned 57014, and the Inbox rendered
--    `degraded / threads: []` -- the filter did not merely return nothing, it
--    emptied the whole surface.
--
--    The same work as LEFT JOIN LATERAL ... LIMIT 1 is semantically identical
--    (DISTINCT ON (thread_key) ORDER BY created_at DESC == one row per thread,
--    newest first) but runs per-row against idx_phones_canonical_e164 /
--    idx_prospects_best_phone:
--        Execution Time: 268 ms   (58x)
--    Column list and types are unchanged, so dependent views do not move.
--
-- 2. "DELIVERY STATUS" WAS AN UNBACKED DROPDOWN.
--    The filter catalog exposes deliveryStatus -> latest_delivery_status, but
--    inbox_command_center_v never selected that column, so both the option list
--    and the filter failed with inbox_filter_invalid_field. The column exists
--    one view down (inbox_threads_hydrated.latest_delivery_status); appending it
--    makes an already-advertised filter real.
--
-- 3. FOURTEEN SELECT FILTERS HAD NO OPTIONS.
--    inbox_filter_allowed_column is the allowlist behind the options RPC. Every
--    column below exists on inbox_hydrated_scoped and was simply never added, so
--    Condition / Phone / Automation dropdowns opened empty -- the "looks
--    functional, returns nothing" shape the certification brief calls out.
--
-- 4. "SCHEDULED" COUNTED THREADS, NOT MESSAGES.
--    v_inbox_zero_counts.scheduled read inbox_thread_state.next_scheduled_for,
--    a per-thread marker stamped by the bulk scheduler. The operator contract is
--    "schedule 20, watch 20 drain one at a time", which only the canonical
--    send_queue rows can express: two follow-ups on one thread are two scheduled
--    messages, and a successful send must decrement by exactly one. Re-derived
--    from send_queue, which is the same ledger the Queue / Outbound Command
--    Center reads -- no second scheduling store.

-- ── 1. inbox_threads_hydrated: CTE self-joins -> LATERAL ─────────────────────
CREATE OR REPLACE VIEW public.inbox_threads_hydrated AS
 WITH base AS (
         SELECT nt.thread_key,
            nt.latest_message_at,
            nt.latest_direction,
            nt.latest_message_body,
            nt.market,
            nt.message_count,
            nt.inbound_count,
            nt.outbound_count,
            nt.pending_queue_count,
            nt.last_inbound_at,
            nt.last_outbound_at,
            nt.ui_intent,
            nt.priority_bucket,
            nt.status,
            nt.stage,
            nt.show_in_priority_inbox,
            nt.event_property_address,
            nt.event_seller_display_name,
            COALESCE(ts.automation_status, ts.automation_state, 'active'::text) AS automation_status,
            ts.follow_up_at,
            ts.agent_id,
            ts.persona_id,
            COALESCE(ts.is_starred, false) AS is_starred,
            COALESCE(ts.is_suppressed, false) AS is_suppressed,
            COALESCE(ts.is_read, nt.is_read) AS is_read,
            COALESCE(ts.is_pinned, nt.is_pinned) AS is_pinned,
            COALESCE(ts.is_archived, nt.is_archived) AS is_archived,
            COALESCE(ts.is_hot_lead, nt.is_hot_lead) AS is_hot_lead,
            COALESCE(NULLIF(ts.canonical_e164, ''::text), NULLIF(ts.seller_phone, ''::text), (regexp_match(nt.thread_key, 'phone:(.+)'::text))[1]) AS best_phone,
            COALESCE(NULLIF(nt.master_owner_id, ''::text), NULLIF(ts.master_owner_id, ''::text)) AS final_master_owner_id,
            COALESCE(NULLIF(nt.prospect_id, ''::text), NULLIF(ts.prospect_id, ''::text)) AS final_prospect_id,
            COALESCE(NULLIF(nt.property_id, ''::text), NULLIF(ts.property_id, ''::text)) AS final_property_id,
            nt.latest_delivery_status,
            nt.latest_delivered_at,
            nt.latest_sent_at,
            nt.latest_provider_sid,
            nt.last_delivered_at
           FROM nexus_inbox_threads_v nt
             LEFT JOIN inbox_thread_state ts ON ts.thread_key = nt.thread_key
        ), resolved_ids AS (
         -- Was: two DISTINCT ON CTEs joined back on thread_key. Same one-row-per
         -- thread, newest-first semantics, but index-driven per row instead of a
         -- 33M-comparison nested loop over an unindexable CTE scan.
         SELECT b_1.thread_key,
            COALESCE(b_1.final_prospect_id, pl.ph_prospect_id, prl.pr_prospect_id) AS res_prospect_id,
            COALESCE(b_1.final_master_owner_id, pl.ph_master_owner_id, prl.pr_master_owner_id) AS res_owner_id,
            b_1.final_property_id AS res_property_id,
            pl.ph_phone_carrier AS res_phone_carrier
           FROM base b_1
             LEFT JOIN LATERAL ( SELECT ph.master_owner_id AS ph_master_owner_id,
                    ph.primary_prospect_id AS ph_prospect_id,
                    ph.phone_owner AS ph_phone_carrier
                   FROM phones ph
                  WHERE b_1.best_phone IS NOT NULL
                    AND b_1.best_phone <> ''::text
                    AND ph.canonical_e164 = b_1.best_phone
                  -- phone_id/prospect_id tiebreak: a single canonical_e164 can carry 24
                  -- `phones` rows sharing 2 created_at values and 24 DIFFERENT owners, so
                  -- created_at alone picked an arbitrary, plan-dependent identity (80 threads
                  -- flipped owner under an otherwise-equivalent rewrite). Both ids are unique.
                  ORDER BY ph.created_at DESC, ph.phone_id DESC
                 LIMIT 1) pl ON true
             LEFT JOIN LATERAL ( SELECT pr_1.prospect_id AS pr_prospect_id,
                    pr_1.master_owner_id AS pr_master_owner_id
                   FROM prospects pr_1
                  WHERE b_1.best_phone IS NOT NULL
                    AND b_1.best_phone <> ''::text
                    AND pr_1.best_phone = b_1.best_phone
                  ORDER BY pr_1.created_at DESC, pr_1.prospect_id DESC
                 LIMIT 1) prl ON true
        )
 SELECT b.thread_key,
    b.latest_message_at,
    b.latest_direction,
    b.latest_message_body,
    b.market,
    b.message_count,
    b.inbound_count,
    b.outbound_count,
    b.pending_queue_count,
    b.last_inbound_at,
    b.last_outbound_at,
    b.ui_intent,
    b.priority_bucket,
    b.status,
    b.stage,
    b.show_in_priority_inbox,
    b.event_property_address,
    b.event_seller_display_name,
    b.automation_status,
    b.follow_up_at,
    b.agent_id,
    b.persona_id,
    b.is_starred,
    b.is_suppressed,
    b.is_read,
    b.is_pinned,
    b.is_archived,
    b.is_hot_lead,
    b.best_phone,
    b.final_master_owner_id,
    b.final_prospect_id,
    b.final_property_id,
    b.best_phone AS seller_phone,
    r.res_owner_id AS master_owner_id,
    r.res_prospect_id AS prospect_id,
    COALESCE(r.res_property_id, lp.property_id) AS property_id,
    r.res_phone_carrier AS phone_carrier,
    p.property_address_full,
    p.property_type,
    p.estimated_value,
    p.cash_offer,
    p.final_acquisition_score,
    p.structured_motivation_score AS priority_score,
    p.property_address_city AS city,
    p.property_address_state AS state,
    p.property_address_zip AS zip,
    mo.best_language,
    mo.priority_score AS owner_priority_score,
    mo.display_name AS owner_display_name,
    pr.full_name AS prospect_full_name,
    pr.first_name AS prospect_first_name,
    pr.canonical_prospect_id,
    pr.cnam,
    pr.gender,
    pr.marital_status,
    pr.education_model,
    pr.occupation_group,
    pr.occupation_code AS occupation,
    pr.est_household_income,
    pr.net_asset_value,
    EXTRACT(year FROM CURRENT_DATE) - NULLIF("substring"(pr.mob, 1, 4), ''::text)::integer::numeric AS prospect_age,
    pr.buying_power,
    pr.likely_owner,
    pr.likely_renting,
    pr.matching_flags,
    pr.person_flags_text,
    pr.person_flags_json,
    pr.contact_score_final AS prospect_contact_score,
    pr.phone_score_final AS prospect_phone_score,
    pr.best_phone AS prospect_best_phone,
    pr.best_email AS prospect_best_email,
    pr.sms_eligible,
    pr.email_eligible,
    mo.primary_owner_address,
    mo.owner_type_guess,
    mo.best_contact_window,
    mo.contactability_score,
    mo.financial_pressure_score,
    mo.urgency_score,
    mo.priority_tier AS owner_priority_tier,
    mo.portfolio_total_value,
    mo.portfolio_total_equity,
    mo.portfolio_total_loan_balance,
    mo.portfolio_total_loan_payment,
    mo.portfolio_total_tax_amount,
    mo.portfolio_total_units,
    mo.property_count,
    mo.tax_delinquent_count,
    mo.oldest_tax_delinquent_year,
    mo.active_lien_count,
    mo.seller_tags_text,
    mo.seller_tags_json,
    mo.follow_up_cadence,
    mo.best_phone_1,
    mo.best_phone_2,
    mo.best_phone_3,
    mo.best_email_1,
    mo.best_email_2,
    mo.agent_persona,
    mo.agent_family,
    mo.joined_property_ids_json,
    p.property_address_city AS property_city,
    p.property_address_state AS property_state,
    p.property_address_zip AS property_zip,
    p.property_county_name,
    p.market_region,
    p.property_class,
    p.estimated_repair_cost,
    p.estimated_repair_cost_per_sqft,
    p.deal_strength_score,
    p.equity_amount,
    p.equity_percent,
    p.total_loan_amt,
    p.total_loan_balance,
    p.total_loan_payment,
    p.tax_delinquent AS property_tax_delinquent,
    p.tax_delinquent_year AS property_tax_delinquent_year,
    p.tax_amt,
    p.tax_year,
    p.active_lien AS property_active_lien,
    p.ownership_years,
    p.units_count,
    p.building_square_feet,
    p.total_bedrooms,
    p.total_baths,
    p.year_built,
    p.effective_year_built,
    p.lot_acreage,
    p.lot_square_feet,
    p.lot_size_depth_feet,
    p.lot_size_frontage_feet,
    p.latitude,
    p.longitude,
    p.building_condition,
    p.building_quality,
    p.rehab_level,
    p.podio_tags,
    p.property_flags_text,
    p.property_flags_json,
    p.streetview_image,
    p.satellite_image,
    p.map_image,
    p.style,
    p.stories,
    p.sum_buildings_nbr,
    p.avg_sqft_per_unit,
    p.beds_per_unit,
    p.sqft_range,
    p.construction_type,
    p.exterior_walls,
    p.floor_cover,
    p.basement,
    p.other_rooms,
    p.num_of_fireplaces,
    p.patio,
    p.porch,
    p.deck,
    p.driveway,
    p.garage,
    p.sum_garage_sqft,
    p.air_conditioning,
    p.heating_type,
    p.heating_fuel_type,
    p.interior_walls,
    p.roof_cover,
    p.roof_type,
    p.pool,
    p.sewer,
    p.water,
    p.zoning,
    p.flood_zone,
    p.legal_description,
    p.subdivision_name,
    p.school_district_name,
    p.assd_total_value,
    p.assd_land_value,
    p.assd_improvement_value,
    p.calculated_total_value,
    p.calculated_land_value,
    p.calculated_improvement_value,
    p.saleprice AS sale_price,
    p.sale_date,
    p.recording_date,
    p.last_sale_doc_type,
    p.past_due_amount,
    p.ai_score,
    p.is_corporate_owner,
    p.out_of_state_owner,
    b.latest_delivery_status,
    b.latest_delivered_at,
    b.latest_sent_at,
    b.latest_provider_sid,
    b.last_delivered_at
   FROM base b
     JOIN resolved_ids r ON r.thread_key = b.thread_key
     LEFT JOIN LATERAL ( SELECT pp.property_id
           FROM properties pp
          WHERE pp.master_owner_id = r.res_owner_id
          ORDER BY pp.estimated_value DESC NULLS LAST
         LIMIT 1) lp ON r.res_property_id IS NULL AND r.res_owner_id IS NOT NULL
     LEFT JOIN properties p ON p.property_id = COALESCE(r.res_property_id, lp.property_id)
     LEFT JOIN master_owners mo ON mo.master_owner_id = r.res_owner_id
     LEFT JOIN prospects pr ON pr.prospect_id = r.res_prospect_id;

-- ── 2. Expose latest_delivery_status on the filter source ────────────────────
-- Appended at the end so CREATE OR REPLACE keeps every existing column position.
CREATE OR REPLACE VIEW public.inbox_command_center_v AS
 SELECT thread_key, latest_message_at, latest_direction, latest_message_body, market,
    message_count, inbound_count, outbound_count, pending_queue_count, last_inbound_at,
    last_outbound_at, ui_intent, priority_bucket, status, stage, show_in_priority_inbox,
    event_property_address, event_seller_display_name, automation_status, follow_up_at,
    agent_id, persona_id, is_starred, is_suppressed, is_read, is_pinned, is_archived,
    is_hot_lead, best_phone, final_master_owner_id, final_prospect_id, final_property_id,
    seller_phone, master_owner_id, prospect_id, property_id, phone_carrier,
    property_address_full, property_type, estimated_value, cash_offer,
    final_acquisition_score, priority_score, city, state, zip, best_language,
    owner_priority_score, owner_display_name, prospect_full_name, prospect_first_name,
    canonical_prospect_id, cnam, gender, marital_status, education_model, occupation_group,
    occupation, est_household_income, net_asset_value, prospect_age, buying_power,
    likely_owner, likely_renting, matching_flags, person_flags_text, person_flags_json,
    prospect_contact_score, prospect_phone_score, prospect_best_phone, prospect_best_email,
    sms_eligible, email_eligible, primary_owner_address, owner_type_guess,
    best_contact_window, contactability_score, financial_pressure_score, urgency_score,
    owner_priority_tier, portfolio_total_value, portfolio_total_equity,
    portfolio_total_loan_balance, portfolio_total_loan_payment, portfolio_total_tax_amount,
    portfolio_total_units, property_count, tax_delinquent_count, oldest_tax_delinquent_year,
    active_lien_count, seller_tags_text, seller_tags_json, follow_up_cadence, best_phone_1,
    best_phone_2, best_phone_3, best_email_1, best_email_2, agent_persona, agent_family,
    joined_property_ids_json, property_city, property_state, property_zip,
    property_county_name, market_region, property_class, estimated_repair_cost,
    estimated_repair_cost_per_sqft, deal_strength_score, equity_amount, equity_percent,
    total_loan_amt, total_loan_balance, total_loan_payment, property_tax_delinquent,
    property_tax_delinquent_year, tax_amt, tax_year, property_active_lien, ownership_years,
    units_count, building_square_feet, total_bedrooms, total_baths, year_built,
    effective_year_built, lot_acreage, lot_square_feet, lot_size_depth_feet,
    lot_size_frontage_feet, latitude, longitude, building_condition, building_quality,
    rehab_level, podio_tags, property_flags_text, property_flags_json, streetview_image,
    satellite_image, map_image, style, stories, sum_buildings_nbr, avg_sqft_per_unit,
    beds_per_unit, sqft_range, construction_type, exterior_walls, floor_cover, basement,
    other_rooms, num_of_fireplaces, patio, porch, deck, driveway, garage, sum_garage_sqft,
    air_conditioning, heating_type, heating_fuel_type, interior_walls, roof_cover, roof_type,
    pool, sewer, water, zoning, flood_zone, legal_description, subdivision_name,
    school_district_name, assd_total_value, assd_land_value, assd_improvement_value,
    calculated_total_value, calculated_land_value, calculated_improvement_value, sale_price,
    sale_date, recording_date, last_sale_doc_type, past_due_amount, ai_score,
    is_corporate_owner, out_of_state_owner,
    ui_intent AS detected_intent,
    stage AS queue_stage,
    automation_status AS automation_state,
    latest_message_at AS last_message_iso,
    latest_message_body AS preview,
    COALESCE(NULLIF(prospect_full_name, ''::text), NULLIF(owner_display_name, ''::text), NULLIF(event_seller_display_name, ''::text), NULLIF(seller_phone, ''::text), thread_key) AS display_name,
    COALESCE(NULLIF(property_address_full, ''::text), NULLIF(event_property_address, ''::text), 'Unknown Property'::text) AS display_address,
    COALESCE(NULLIF(best_phone, ''::text), (regexp_match(thread_key, 'phone:(.+)'::text))[1], 'Unknown Phone'::text) AS display_phone,
    COALESCE(market, 'Unknown'::text) AS display_market,
    COALESCE(status, 'open'::text) AS display_status,
    COALESCE(final_acquisition_score, priority_score, 0::numeric) AS display_score,
        CASE
            WHEN is_hot_lead THEN 'hot_leads'::text
            WHEN show_in_priority_inbox AND (ui_intent = ANY (ARRAY['potential_interest'::text, 'asking_price_provided'::text])) THEN 'hot_leads'::text
            WHEN (ui_intent = ANY (ARRAY['opt_out'::text, 'wrong_number'::text, 'hostile_or_legal'::text])) OR status = 'suppressed'::text OR is_suppressed THEN 'dnc_opt_out'::text
            WHEN automation_status = 'running'::text OR automation_status = 'autonomous'::text THEN 'automated'::text
            WHEN latest_direction = 'inbound'::text AND (stage = 'needs_response'::text OR NOT is_read) THEN 'new_inbound'::text
            WHEN pending_queue_count > 0 THEN 'outbound_active'::text
            WHEN latest_direction = 'outbound'::text AND (stage = ANY (ARRAY['sent_waiting'::text, 'waiting'::text])) THEN 'outbound_active'::text
            WHEN show_in_priority_inbox AND ui_intent = 'unclear'::text THEN 'needs_review'::text
            WHEN stage = 'needs_review'::text THEN 'needs_review'::text
            ELSE 'cold_no_response'::text
        END AS inbox_category,
    latest_delivery_status
   FROM inbox_threads_hydrated h;

-- ── 3. Filter-options allowlist: add the columns that already exist ──────────
CREATE OR REPLACE FUNCTION public.inbox_filter_allowed_column(p_column text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT p_column = ANY (ARRAY[
    'thread_key','market','city','state','zip','property_type','property_class','owner_type_guess',
    'stage','status','ui_intent','latest_direction','best_language','building_condition','priority_bucket',
    'est_household_income','net_asset_value','occupation_group','gender','marital_status','education_model',
    'occupation','owner_priority_tier','phone_carrier','property_county_name','market_region','units_count',
    'total_bedrooms','total_baths','building_square_feet','year_built','effective_year_built','estimated_value',
    'equity_percent','equity_amount','total_loan_balance','total_loan_amt','total_loan_payment','tax_amt',
    'past_due_amount','estimated_repair_cost','ai_score','final_acquisition_score','deal_strength_score',
    'priority_score','ownership_years','prospect_age','buying_power','contactability_score',
    'financial_pressure_score','urgency_score','owner_priority_score','portfolio_total_value',
    'portfolio_total_equity','portfolio_total_loan_balance','portfolio_total_units','property_count',
    'message_count','inbound_count','outbound_count','pending_queue_count','cash_offer','assd_total_value',
    'calculated_total_value','sale_price','lot_square_feet','lot_acreage','latest_message_at','last_inbound_at',
    'last_outbound_at','sale_date','follow_up_at','owner_display_name','best_phone','seller_phone',
    'property_address_full','event_property_address','is_read','is_starred','is_pinned','is_archived',
    'is_suppressed','property_tax_delinquent','property_active_lien','is_corporate_owner','out_of_state_owner',
    'likely_owner','likely_renting','sms_eligible','email_eligible','prospect_best_email','property_flags_text',
    'property_flags_json','person_flags_text','person_flags_json','inbox_category',
    -- INBOX-COMPOSER-LOCK-1: each of these is already a column on
    -- inbox_hydrated_scoped and each was already an exposed dropdown in the
    -- Advanced Filters sheet. Omitting them from the allowlist is what made
    -- those dropdowns open empty.
    'latest_delivery_status','automation_status','best_contact_window',
    'building_quality','rehab_level','construction_type','style','basement','garage',
    'air_conditioning','heating_type','roof_type','pool','zoning','flood_zone'
  ]);
$function$;

-- ── 4. Scheduled = canonical pending send_queue rows ─────────────────────────
-- Mirrors list-scheduled-followups.js exactly: a message still expected to send.
-- Not "sent", not "cancelled", not terminally failed, not blocked/suppressed.
-- Counts MESSAGES, because that is what the operator schedules and watches drain.
CREATE OR REPLACE VIEW public.v_inbox_zero_counts AS
 SELECT ( SELECT count(*) AS count
           FROM inbox_thread_state
          WHERE COALESCE(inbox_thread_state.is_archived, false) = true) AS archived,
    ( SELECT count(*) AS count
           FROM send_queue q
          WHERE lower(q.queue_status) = ANY (ARRAY['scheduled','queued','pending','approved','ready','processing','sending'])
       ) AS scheduled;

COMMENT ON VIEW public.v_inbox_zero_counts IS
  'Inbox chips with no home in canonical_inbox_counts. archived = the inverse of every other bucket predicate. scheduled = canonical send_queue rows still expected to send (message-grained, NOT inbox_thread_state.next_scheduled_for, which is a per-thread marker and cannot decrement one send at a time).';

-- ── 5. ONE PREDICATE PER INBOX CATEGORY ──────────────────────────────────────
-- Every chip used to be counted by one predicate (canonical_inbox_counts, SQL)
-- and listed by another (threadMatchesInboxTab, JS, over whatever page the SQL
-- happened to return). Measured on production 2026-09-14:
--
--   New Replies  chip 136   list 17 of 100 fetched, has_more:false
--   Archived     chip  69   list 0     (canonical_inbox_threads is defined
--                                       `WHERE is_archived IS DISTINCT FROM true`,
--                                       so the Archived tab could never return a
--                                       row from it -- archiving was one-way)
--   Snoozed      chip   0   list 3     (no SQL case -> unfiltered)
--   Scheduled    chip   0   list 3     (no SQL case -> unfiltered)
--   filter=<anything unrecognised>     -> every thread in the system
--
-- This view carries one boolean per category over inbox_thread_state, archived
-- rows INCLUDED. The list filters on the flag; v_inbox_bucket_counts counts the
-- same flag. A chip cannot disagree with its rows, pages are not discarded after
-- the fact, and a category nobody defined has no column to match.
--
-- inbox-bucket-predicates.js#resolveInboxBucketFlags is the JS twin, pinned by
-- tests/critical/inbox-bucket-flag-parity.test.mjs. Change them together.
--
-- NOTE: `SELECT s.*` is expanded at creation time, so a new inbox_thread_state
-- column needs this view recreated before it appears.
CREATE OR REPLACE VIEW public.v_inbox_thread_state_buckets AS
WITH f AS (
  SELECT s.*,
    COALESCE(s.is_archived, false) AS f_archived,
    (s.snoozed_until IS NOT NULL AND s.snoozed_until > now()) AS f_snoozed,
    (s.next_scheduled_for IS NOT NULL AND s.next_scheduled_for > now()) AS f_pending_schedule,
    lower(COALESCE(s.disposition, '')) AS f_disposition,
    lower(COALESCE(s.latest_direction, '')) AS f_direction,
    lower(COALESCE(s.latest_delivery_status, '')) AS f_delivery,
    (s.manual_override = true OR COALESCE(s.confidence, 1::numeric) < 0.5) AS f_needs_review,
    (COALESCE((s.metadata ->> 'terminal_no_contact')::boolean, false)
      OR COALESCE((s.metadata ->> 'do_not_contact')::boolean, false)) AS f_metadata_no_contact,
    COALESCE(s.last_outbound_at, s.latest_message_at) AS f_out_at,
    -- THE DERIVED BUCKET, byte-for-byte the COALESCE/CASE in
    -- canonical_inbox_threads. inbox_thread_state.inbox_bucket is NULL on 9,082
    -- of 9,778 rows (93%), so reading the raw column is not a small error: it
    -- puts almost every thread in the wrong bucket.
    lower(COALESCE(s.inbox_bucket,
      CASE
        WHEN s.is_suppressed = true THEN 'suppressed'
        WHEN lower(COALESCE(s.disposition, '')) = ANY (ARRAY['wrong_number','wrong_person']) THEN 'dead'
        WHEN lower(COALESCE(s.disposition, '')) = 'not_interested' THEN 'follow_up'
        WHEN s.latest_direction = 'inbound' THEN 'new_replies'
        ELSE 'cold'
      END)) AS f_bucket
  FROM public.inbox_thread_state s
), g AS (
  SELECT f.*,
    (COALESCE(f.is_suppressed, false) OR f.f_bucket = 'suppressed') AS f_suppressed_contact,
    (f.f_disposition IN ('wrong_number','wrong_person')) AS f_wrong_number_contact,
    (f.f_delivery = '' OR f.f_delivery = ANY (ARRAY['sent','delivered','accepted','queued','pending','sending','submitted','delivery_unknown'])) AS f_delivery_ok,
    (f.f_out_at IS NOT NULL AND (f.last_inbound_at IS NULL OR f.last_inbound_at < f.f_out_at)) AS f_outbound_last_no_reply
  FROM f
), h AS (
  SELECT g.*, (g.f_bucket IN ('dead','suppressed') OR g.f_wrong_number_contact OR g.f_suppressed_contact) AS f_terminal FROM g
), i AS (
  SELECT h.*,
    (NOT h.f_archived AND NOT h.f_snoozed AND NOT h.f_pending_schedule) AS f_available,
    (NOT h.f_archived AND NOT h.f_terminal AND NOT h.f_snoozed AND NOT h.f_pending_schedule) AS f_actionable,
    (NOT h.f_archived AND NOT h.f_terminal AND NOT h.f_snoozed AND NOT h.f_pending_schedule
      AND h.f_direction = 'outbound' AND h.f_outbound_last_no_reply
      AND h.f_out_at >= (now() - '24:00:00'::interval)
      AND h.f_delivery_ok AND NOT h.f_metadata_no_contact) AS in_waiting
  FROM h
)
SELECT i.*,
  i.f_archived AS in_archived,
  (NOT i.f_archived AND i.f_snoozed) AS in_snoozed,
  (NOT i.f_archived AND i.f_pending_schedule) AS in_scheduled,
  (i.f_actionable AND i.f_bucket = 'priority') AS in_priority,
  -- follow_up is excluded here as well as the other four: a not_interested
  -- seller derives to follow_up, and counting that same thread as a NEW REPLY
  -- is what put 301 declined sellers in both places at once.
  -- COALESCE(last_inbound_at, latest_message_at) mirrors the outbound side; it
  -- affects 0 of 834 inbound production threads today and exists so a thread
  -- with a reply but no last_inbound_at stamp cannot fall out of New Replies.
  (i.f_actionable
    AND i.f_bucket <> ALL (ARRAY['priority','needs_review','waiting','cold','follow_up'])
    AND NOT i.f_needs_review
    AND i.f_direction = 'inbound'
    AND COALESCE(i.last_inbound_at, i.latest_message_at) IS NOT NULL
    AND (i.last_outbound_at IS NULL OR COALESCE(i.last_inbound_at, i.latest_message_at) >= i.last_outbound_at)) AS in_new_replies,
  (i.f_available AND (i.f_bucket = 'needs_review' OR i.f_needs_review)) AS in_needs_review,
  (i.f_available AND i.f_bucket = 'follow_up') AS in_follow_up,
  -- Cold = we sent and the 24h response window has PASSED. Without NOT in_waiting
  -- every thread sent in the last day sat in Cold and Waiting simultaneously.
  (i.f_actionable AND i.f_bucket = 'cold' AND NOT i.in_waiting) AS in_cold,
  (NOT i.f_archived AND (i.f_bucket = 'dead' OR i.f_wrong_number_contact)) AS in_dead,
  (NOT i.f_archived AND (i.f_bucket = 'suppressed' OR i.f_suppressed_contact)) AS in_suppressed,
  (NOT i.f_archived AND NOT i.in_waiting) AS in_all_messages,
  (NOT i.f_archived) AS in_all,
  (NOT i.f_archived AND i.property_id IS NULL) AS in_unlinked,
  -- `active` is a LENS, not a bucket: the union of the four an operator works.
  -- It needs its own flag now that an unrecognised filter fails closed.
  ((i.f_actionable AND i.f_bucket = 'priority')
    OR (i.f_available AND (i.f_bucket = 'needs_review' OR i.f_needs_review))
    OR (i.f_available AND i.f_bucket = 'follow_up')
    OR (i.f_actionable
        AND i.f_bucket <> ALL (ARRAY['priority','needs_review','waiting','cold','follow_up'])
        AND NOT i.f_needs_review
        AND i.f_direction = 'inbound'
        AND COALESCE(i.last_inbound_at, i.latest_message_at) IS NOT NULL
        AND (i.last_outbound_at IS NULL OR COALESCE(i.last_inbound_at, i.latest_message_at) >= i.last_outbound_at))) AS in_active
FROM i;

COMMENT ON VIEW public.v_inbox_thread_state_buckets IS
  'ONE predicate per Inbox category, in SQL, over inbox_thread_state. Both the count and the list read these flags so a chip can never disagree with the rows beneath it. Mirrors inbox-bucket-predicates.js#resolveInboxBucketFlags; change them together. NOTE: SELECT s.* is expanded at creation, so a new inbox_thread_state column needs this view recreated to appear.';

-- ── 6. Every chip, counted from the flags the list filters on ────────────────
CREATE OR REPLACE VIEW public.v_inbox_bucket_counts AS
SELECT
  count(*) FILTER (WHERE in_priority)      AS priority,
  count(*) FILTER (WHERE in_new_replies)   AS new_replies,
  count(*) FILTER (WHERE in_needs_review)  AS needs_review,
  count(*) FILTER (WHERE in_follow_up)     AS follow_up,
  count(*) FILTER (WHERE in_waiting)       AS waiting,
  count(*) FILTER (WHERE in_cold)          AS cold,
  count(*) FILTER (WHERE in_dead)          AS dead,
  count(*) FILTER (WHERE in_suppressed)    AS suppressed,
  count(*) FILTER (WHERE in_archived)      AS archived,
  count(*) FILTER (WHERE in_snoozed)       AS snoozed,
  count(*) FILTER (WHERE in_all_messages)  AS all_messages,
  count(*) FILTER (WHERE in_all)           AS all,
  count(*) FILTER (WHERE in_unlinked)      AS unlinked,
  count(*) FILTER (WHERE in_active)        AS active,
  count(*) FILTER (WHERE NOT COALESCE(is_read, false) AND in_all) AS unread,
  count(*) FILTER (WHERE f_disposition = 'not_interested' AND in_all) AS not_interested,
  count(*) FILTER (WHERE f_disposition = 'wrong_person') AS wrong_person,
  count(*) FILTER (WHERE f_disposition = 'wrong_number') AS wrong_number,
  -- Scheduled counts canonical send_queue MESSAGES, not threads: the operator
  -- schedules N messages and watches N drain one send at a time. Same predicate
  -- as list-scheduled-followups.js#PENDING_QUEUE_STATUSES.
  ( SELECT count(*) FROM send_queue q
     WHERE lower(q.queue_status) = ANY (ARRAY['scheduled','queued','pending','approved','ready','processing','sending'])
  ) AS scheduled
FROM public.v_inbox_thread_state_buckets;

COMMENT ON VIEW public.v_inbox_bucket_counts IS
  'Every Inbox chip, counted from v_inbox_thread_state_buckets -- the same flags the list filters on. A chip and its rows cannot disagree because there is only one predicate.';

-- ── 7. Inbox corpus search ───────────────────────────────────────────────────
-- Every thread source carries exactly ONE message body (latest_message_body), so
-- searching only matched what the seller said most recently. Measured 2026-09-14:
-- "fair price" (thread +18135909446's latest message) returned 1 thread, while
-- "dirt cheap" -- from that same seller's earlier "Let me guess, you are offering
-- cash for dirt cheap?" -- returned 0.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE INDEX IF NOT EXISTS idx_message_events_body_trgm
  ON public.message_events USING gin (message_body extensions.gin_trgm_ops);
