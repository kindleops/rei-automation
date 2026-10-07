-- PROPOSED — NOT APPLIED. Campaign graph: promote new sellers + scheduled full refresh (2026-10-07).
--
-- Why: the campaign target graph is built FROM public.properties, but seller ingests write only seller.*.
-- Sellers ingested on 2026-08-31 (DealMachine contact exports of 2026-08-28) never reached
-- public.properties, and the graph had no scheduled refresh (last run 2026-08-26). Fixed by hand on
-- 2026-10-06/07: 6,808 promoted (export_version compact_v2_20261006_aug28), graph 169,797 -> 176,605.
-- Evidence: ~/DM-Scraper-Data/campaign_graph_20261004/.
--
-- 1. seller_promote_new_properties(): the Aug 6 seller_compact_v2 recipe. Validated to reproduce
--    44,907/44,907 unchanged original rows on all 65 columns. Insert-only, idempotent (ON CONFLICT DO
--    NOTHING); market fields come from trg_properties_canonical_market. Call it at the end of every
--    seller ingest.
-- 2. campaign_target_graph_full_refresh(): the production v4 refresh (stage_start ->
--    refresh_campaign_target_graph_seller_batch per batch -> stage_commit), COMMIT after every batch, so
--    run it with CALL from its own session (pg_cron job). It holds the projection advisory lock during
--    commit and enrichment, so the reconcile and incremental ticks skip ('locked') instead of racing the
--    truncate. Refuses to commit unless stage = eligible properties exactly and graph_ids are distinct.
--    The repo runner scripts/ops/full-campaign-target-graph-refresh.mjs is RUNNER_VERSION 2, never calls
--    seller_batch, and its default launch flow creates a campaign; retire or update it.
-- 3. Schedule: left commented. A full refresh takes about 4.5-5 h at 2,500 rows per batch (about 4 min
--    per batch, inside the 10-min reaper window). Pick a window clear of 05:00-08:59 UTC (reconcile).
--    Before enabling, verify on a branch database that pg_cron runs CALL with transaction control
--    (pg_cron must use libpq sessions, not background workers).

CREATE OR REPLACE FUNCTION public.seller_promote_new_properties(p_export_version text)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_inserted integer;
BEGIN
  IF p_export_version IS NULL OR p_export_version = '' THEN
    RAISE EXCEPTION 'p_export_version is required (it tags the batch for audit and rollback)';
  END IF;
  INSERT INTO public.properties (
    active_lien,
    air_conditioning,
    apn_parcel_id,
    auction_date,
    basement,
    building_condition,
    building_quality,
    building_square_feet,
    construction_type,
    county_land_use_code,
    effective_year_built,
    equity_amount,
    equity_percent,
    estimated_repair_cost,
    estimated_value,
    exterior_walls,
    flood_zone,
    heating_type,
    hoa_fee_amount,
    is_corporate_owner,
    latitude,
    legal_description,
    longitude,
    lot_acreage,
    lot_square_feet,
    out_of_state_owner,
    owner_1_name,
    owner_2_name,
    owner_address_full,
    owner_location,
    owner_name,
    pool,
    property_address_city,
    property_address_county_name,
    property_address_full,
    property_address_state,
    property_address_zip,
    property_class,
    property_id,
    property_type,
    roof_cover,
    school_district_name,
    sewer,
    subdivision_name,
    tax_amt,
    tax_delinquent,
    tax_delinquent_year,
    tax_year,
    total_baths,
    total_bedrooms,
    total_loan_amt,
    total_loan_balance,
    total_loan_payment,
    units_count,
    water,
    year_built,
    zoning,
    property_export_id,
    upsert_key,
    source_system,
    export_version,
    seller_tags_json
  )
  SELECT
    s.active_lien,
    s.air_conditioning,
    s.apn,
    s.auction_date,
    s.basement,
    s.building_condition,
    s.building_quality,
    s.building_sqft,
    s.construction_type,
    s.county_land_use_code,
    s.effective_year_built,
    s.estimated_equity,
    s.equity_percent,
    s.estimated_repair_cost,
    s.estimated_value,
    s.exterior_walls,
    s.flood_zone,
    s.heating_type,
    s.hoa_fee_amount,
    s.is_corporate_owner,
    s.latitude,
    s.legal_description,
    s.longitude,
    s.lot_acreage,
    s.lot_sqft,
    s.out_of_state_owner,
    s.owner_1_name,
    s.owner_2_name,
    s.mail_address_full,
    s.owner_location,
    s.owner_name,
    s.pool,
    s.city,
    s.county_name,
    s.address_full,
    s.state,
    s.zip5,
    s.property_class,
    s.property_id,
    s.property_type,
    s.roof_cover,
    s.school_district,
    s.sewer,
    s.subdivision_name,
    s.tax_amount,
    s.tax_delinquent,
    s.tax_delinquent_year,
    s.tax_year,
    s.baths,
    s.bedrooms,
    s.total_loan_amount,
    s.total_loan_balance,
    s.total_loan_payment,
    s.units_count,
    s.water,
    s.year_built,
    s.zoning,
    'prop_' || left(md5(s.property_id), 24),
    'property|' || s.property_id,
    'seller_compact_v2',
    p_export_version,
    '[]'::jsonb
  FROM seller.property s
  WHERE NOT EXISTS (SELECT 1 FROM public.properties p WHERE p.property_id = s.property_id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$function$;

CREATE OR REPLACE PROCEDURE public.campaign_target_graph_full_refresh(p_batch integer DEFAULT 2500)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $procedure$
DECLARE
  v_run uuid;
  v_offset integer := 0;
  r record;
  v_stage integer; v_distinct integer; v_expected integer;
  v_after text;
  e record;
BEGIN
  PERFORM public.reap_stale_campaign_target_graph_refresh_runs();
  v_run := public.refresh_campaign_target_graph_stage_start();
  UPDATE public.campaign_target_graph_refresh_runs SET metadata = metadata || jsonb_build_object(
    'source', 'campaign_target_graph_full_refresh', 'runner_version', 5, 'graph_path', 'seller_contact_bridge',
    'batch_limit', p_batch) WHERE id = v_run;
  COMMIT;
  LOOP
    SELECT * INTO r FROM public.refresh_campaign_target_graph_seller_batch(v_run, p_batch, v_offset);
    COMMIT;
    EXIT WHEN NOT r.has_more;
    v_offset := v_offset + p_batch;
  END LOOP;
  -- Internal test properties stay out unless they were already in the live graph.
  DELETE FROM public.campaign_target_graph_stage s USING public.properties p
   WHERE p.property_id = s.property_id AND p.source_system = 'INTERNAL_CANARY'
     AND NOT EXISTS (SELECT 1 FROM public.campaign_target_graph g WHERE g.property_id = s.property_id);
  SELECT count(*), count(DISTINCT graph_id) INTO v_stage, v_distinct FROM public.campaign_target_graph_stage;
  SELECT count(*) INTO v_expected FROM public.properties p
   WHERE p.source_system IS DISTINCT FROM 'INTERNAL_CANARY'
      OR EXISTS (SELECT 1 FROM public.campaign_target_graph g WHERE g.property_id = p.property_id);
  IF v_stage <> v_expected OR v_distinct <> v_stage THEN
    UPDATE public.campaign_target_graph_refresh_runs SET status = 'failed', finished_at = now(),
      error_message = format('guard: stage=%s distinct=%s expected=%s', v_stage, v_distinct, v_expected) WHERE id = v_run;
    COMMIT;
    RAISE EXCEPTION 'campaign graph refresh guard failed: stage=% distinct=% expected=%', v_stage, v_distinct, v_expected;
  END IF;
  PERFORM pg_advisory_lock(hashtext('campaign_target_graph_projection'));  -- ticks skip while held
  UPDATE public.campaign_target_graph_refresh_runs SET metadata = metadata || jsonb_build_object(
    'completed_all_batches', true, 'graph_refresh_scope', 'full', 'full_refresh_complete', true) WHERE id = v_run;
  PERFORM * FROM public.refresh_campaign_target_graph_stage_commit(v_run);
  COMMIT;
  -- Re-enrich every row (the reconcile tick's work) so the projection columns are not empty until tomorrow.
  LOOP
    SELECT * INTO e FROM public.campaign_target_graph_enrich_batch(v_after, 400);
    COMMIT;
    v_after := e.next_after_graph_id;
    EXIT WHEN NOT e.has_more;
  END LOOP;
  PERFORM public.campaign_target_graph_measure_coverage('full_refresh', 2);
  PERFORM pg_advisory_unlock(hashtext('campaign_target_graph_projection'));
  COMMIT;
END;
$procedure$;

-- Schedule (enable deliberately; example: Sundays 13:00 UTC, outside the reconcile window):
-- SELECT cron.schedule('campaign_graph_full_refresh', '0 13 * * 0',
--   $$SET statement_timeout = 0; SET lock_timeout = '30s'; CALL public.campaign_target_graph_full_refresh(2500);$$);
