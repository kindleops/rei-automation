BEGIN;

SET LOCAL statement_timeout = 0;

CREATE TABLE IF NOT EXISTS public.deal_context_index (
  deal_context_id text PRIMARY KEY,
  context_type text NOT NULL DEFAULT 'property',
  property_id text,
  master_owner_id text,
  prospect_id text,
  canonical_prospect_id text,
  phone_id text,
  email_id text,
  thread_key text,
  canonical_e164 text,
  campaign_id uuid,
  campaign_target_id uuid,
  queue_row_id text,
  latest_message_event_id text,
  latest_message_body text,
  latest_message_direction text,
  latest_message_at timestamptz,
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  owner_name text,
  seller_first_name text,
  property_address_full text,
  property_address_city text,
  property_state text,
  property_zip text,
  property_county_name text,
  market text,
  latitude numeric,
  longitude numeric,
  property_type text,
  property_class text,
  estimated_value numeric,
  estimated_arv numeric,
  equity_percent numeric,
  cash_offer numeric,
  buyer_demand_score numeric,
  buyer_match_score numeric,
  buyer_match_count integer,
  best_buyer_name text,
  best_buyer_grade text,
  universal_status text,
  universal_stage text,
  inbox_bucket text,
  queue_status text,
  queue_scheduled_for timestamptz,
  campaign_name text,
  campaign_status text,
  campaign_target_status text,
  suppression_status text,
  suppression_type text,
  final_acquisition_score numeric,
  priority_score numeric,
  opt_out boolean NOT NULL DEFAULT false,
  wrong_number boolean NOT NULL DEFAULT false,
  not_interested boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,
  property_data jsonb,
  master_owner_data jsonb,
  prospect_data jsonb,
  phone_data jsonb,
  email_data jsonb,
  thread_state_data jsonb,
  campaign_data jsonb,
  queue_data jsonb,
  suppression_data jsonb,
  valuation_data jsonb,
  buyer_match_data jsonb,
  latest_message_event_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deal_context_index_context_type_check
    CHECK (context_type IN ('property', 'unlinked_thread'))
);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_property_id
  ON public.deal_context_index (property_id);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_master_owner_id
  ON public.deal_context_index (master_owner_id);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_prospect_id
  ON public.deal_context_index (prospect_id);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_canonical_prospect_id
  ON public.deal_context_index (canonical_prospect_id);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_phone_id
  ON public.deal_context_index (phone_id);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_canonical_e164
  ON public.deal_context_index (canonical_e164);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_thread_key
  ON public.deal_context_index (thread_key);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_market
  ON public.deal_context_index (market);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_property_state
  ON public.deal_context_index (property_state);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_property_zip
  ON public.deal_context_index (property_zip);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_property_county_name
  ON public.deal_context_index (property_county_name);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_universal_status
  ON public.deal_context_index (universal_status);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_universal_stage
  ON public.deal_context_index (universal_stage);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_inbox_bucket
  ON public.deal_context_index (inbox_bucket);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_latest_message_at
  ON public.deal_context_index (latest_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_final_acquisition_score
  ON public.deal_context_index (final_acquisition_score DESC);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_priority_score
  ON public.deal_context_index (priority_score DESC);

CREATE INDEX IF NOT EXISTS idx_deal_context_index_geo
  ON public.deal_context_index (latitude, longitude);

ALTER TABLE public.deal_context_index ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'deal_context_index'
      AND policyname = 'deal_context_index_anon_select'
  ) THEN
    CREATE POLICY deal_context_index_anon_select
      ON public.deal_context_index
      FOR SELECT
      TO anon
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'deal_context_index'
      AND policyname = 'deal_context_index_authenticated_select'
  ) THEN
    CREATE POLICY deal_context_index_authenticated_select
      ON public.deal_context_index
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END
$$;

REVOKE ALL ON public.deal_context_index FROM anon, authenticated;
GRANT SELECT ON public.deal_context_index TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.deal_context_index TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_deal_context_index()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_batch_size integer := 40000;
  v_batch_start integer := 1;
  v_batch_end integer;
  v_total_properties integer := 0;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);

  TRUNCATE TABLE public.deal_context_index;

  SELECT COUNT(*)::integer
  INTO v_total_properties
  FROM public.properties;

  WHILE v_batch_start <= v_total_properties LOOP
    v_batch_end := v_batch_start + v_batch_size - 1;

    INSERT INTO public.deal_context_index (
    deal_context_id,
    context_type,
    property_id,
    master_owner_id,
    prospect_id,
    canonical_prospect_id,
    phone_id,
    email_id,
    thread_key,
    canonical_e164,
    campaign_id,
    campaign_target_id,
    queue_row_id,
    latest_message_event_id,
    latest_message_body,
    latest_message_direction,
    latest_message_at,
    last_outbound_at,
    last_inbound_at,
    owner_name,
    seller_first_name,
    property_address_full,
    property_address_city,
    property_state,
    property_zip,
    property_county_name,
    market,
    latitude,
    longitude,
    property_type,
    property_class,
    estimated_value,
    estimated_arv,
    equity_percent,
    cash_offer,
    buyer_demand_score,
    buyer_match_score,
    buyer_match_count,
    best_buyer_name,
    best_buyer_grade,
    universal_status,
    universal_stage,
    inbox_bucket,
    queue_status,
    queue_scheduled_for,
    campaign_name,
    campaign_status,
    campaign_target_status,
    suppression_status,
    suppression_type,
    final_acquisition_score,
    priority_score,
    opt_out,
    wrong_number,
    not_interested,
    needs_review,
    property_data,
    master_owner_data,
    prospect_data,
    phone_data,
    email_data,
    thread_state_data,
    campaign_data,
    queue_data,
    suppression_data,
    valuation_data,
    buyer_match_data,
    latest_message_event_data,
    created_at,
    updated_at
  )
  WITH property_rows AS (
    SELECT p_batch.*
    FROM (
      SELECT
        p.*,
        ROW_NUMBER() OVER (ORDER BY p.ctid) AS deal_context_batch_row_num
      FROM public.properties p
    ) p_batch
    WHERE p_batch.deal_context_batch_row_num BETWEEN v_batch_start AND v_batch_end
  ),
  thread_by_property AS (
    SELECT DISTINCT ON (ts.property_id) ts.*
    FROM public.deal_thread_state ts
    WHERE ts.property_id IS NOT NULL
    ORDER BY ts.property_id, COALESCE(ts.latest_message_at, ts.updated_at, ts.created_at) DESC NULLS LAST
  ),
  thread_by_owner AS (
    SELECT DISTINCT ON (ts.master_owner_id) ts.*
    FROM public.deal_thread_state ts
    WHERE ts.master_owner_id IS NOT NULL
    ORDER BY ts.master_owner_id, COALESCE(ts.latest_message_at, ts.updated_at, ts.created_at) DESC NULLS LAST
  ),
  thread_by_thread_key AS (
    SELECT DISTINCT ON (ts.thread_key) ts.*
    FROM public.deal_thread_state ts
    WHERE ts.thread_key IS NOT NULL
    ORDER BY ts.thread_key, COALESCE(ts.latest_message_at, ts.updated_at, ts.created_at) DESC NULLS LAST
  ),
  thread_by_best_phone AS (
    SELECT DISTINCT ON (ts.best_phone) ts.*
    FROM public.deal_thread_state ts
    WHERE ts.best_phone IS NOT NULL
    ORDER BY ts.best_phone, COALESCE(ts.latest_message_at, ts.updated_at, ts.created_at) DESC NULLS LAST
  ),
  message_by_thread AS (
    SELECT DISTINCT ON (me.thread_key)
      me.*,
      COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at) AS event_at
    FROM public.message_events me
    WHERE me.thread_key IS NOT NULL
    ORDER BY me.thread_key, COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at) DESC NULLS LAST, me.created_at DESC NULLS LAST
  ),
  message_by_property AS (
    SELECT DISTINCT ON (me.property_id)
      me.*,
      COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at) AS event_at
    FROM public.message_events me
    WHERE me.property_id IS NOT NULL
    ORDER BY me.property_id, COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at) DESC NULLS LAST, me.created_at DESC NULLS LAST
  ),
  message_stats_by_thread AS (
    SELECT
      me.thread_key,
      MAX(
        CASE
          WHEN LOWER(COALESCE(me.direction, '')) LIKE 'in%' THEN COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at)
          ELSE NULL
        END
      ) AS last_inbound_at,
      MAX(
        CASE
          WHEN LOWER(COALESCE(me.direction, '')) LIKE 'out%' THEN COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at)
          ELSE NULL
        END
      ) AS last_outbound_at
    FROM public.message_events me
    WHERE me.thread_key IS NOT NULL
    GROUP BY me.thread_key
  ),
  target_by_property AS (
    SELECT DISTINCT ON (ct.property_id) ct.*
    FROM public.sms_campaign_targets ct
    WHERE ct.property_id IS NOT NULL
    ORDER BY ct.property_id, COALESCE(ct.updated_at, ct.replied_at, ct.sent_at, ct.delivered_at, ct.queued_at, ct.created_at) DESC NULLS LAST
  ),
  target_by_owner AS (
    SELECT DISTINCT ON (ct.master_owner_id) ct.*
    FROM public.sms_campaign_targets ct
    WHERE ct.master_owner_id IS NOT NULL
    ORDER BY ct.master_owner_id, COALESCE(ct.updated_at, ct.replied_at, ct.sent_at, ct.delivered_at, ct.queued_at, ct.created_at) DESC NULLS LAST
  ),
  target_by_phone AS (
    SELECT DISTINCT ON (ct.canonical_e164) ct.*
    FROM public.sms_campaign_targets ct
    WHERE ct.canonical_e164 IS NOT NULL
    ORDER BY ct.canonical_e164, COALESCE(ct.updated_at, ct.replied_at, ct.sent_at, ct.delivered_at, ct.queued_at, ct.created_at) DESC NULLS LAST
  ),
  queue_by_property AS (
    SELECT DISTINCT ON (sq.property_id) sq.*
    FROM public.send_queue sq
    WHERE sq.property_id IS NOT NULL
    ORDER BY sq.property_id, COALESCE(sq.updated_at, sq.sent_at, sq.delivered_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at) DESC NULLS LAST
  ),
  queue_by_owner AS (
    SELECT DISTINCT ON (sq.master_owner_id) sq.*
    FROM public.send_queue sq
    WHERE sq.master_owner_id IS NOT NULL
    ORDER BY sq.master_owner_id, COALESCE(sq.updated_at, sq.sent_at, sq.delivered_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at) DESC NULLS LAST
  ),
  queue_by_thread AS (
    SELECT DISTINCT ON (sq.thread_key) sq.*
    FROM public.send_queue sq
    WHERE sq.thread_key IS NOT NULL
    ORDER BY sq.thread_key, COALESCE(sq.updated_at, sq.sent_at, sq.delivered_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at) DESC NULLS LAST
  ),
  queue_by_phone AS (
    SELECT DISTINCT ON (sq.to_phone_number) sq.*
    FROM public.send_queue sq
    WHERE sq.to_phone_number IS NOT NULL
    ORDER BY sq.to_phone_number, COALESCE(sq.updated_at, sq.sent_at, sq.delivered_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at) DESC NULLS LAST
  ),
  suppression_by_phone AS (
    SELECT DISTINCT ON (COALESCE(sl.phone_e164, sl.phone_number)) sl.*
    FROM public.sms_suppression_list sl
    WHERE COALESCE(sl.phone_e164, sl.phone_number) IS NOT NULL
    ORDER BY COALESCE(sl.phone_e164, sl.phone_number), COALESCE(sl.suppressed_at, sl.created_at) DESC NULLS LAST
  ),
  valuation_by_property AS (
    SELECT DISTINCT ON (v.property_id) v.*
    FROM public.property_valuation_snapshots v
    WHERE v.property_id IS NOT NULL
    ORDER BY v.property_id, COALESCE(v.updated_at, v.created_at) DESC NULLS LAST
  ),
  cash_snapshot_by_property AS (
    SELECT DISTINCT ON (c.property_id) c.*
    FROM public.property_cash_offer_snapshots c
    WHERE c.property_id IS NOT NULL
    ORDER BY c.property_id, COALESCE(c.updated_at, c.created_at) DESC NULLS LAST
  ),
  comp_summary_by_property AS (
    SELECT
      ranked.property_id,
      COUNT(*)::integer AS comp_count,
      AVG(ranked.price_off_value) AS avg_price_off_value,
      MAX(ranked.comp_confidence_score) AS max_comp_confidence_score,
      jsonb_agg(to_jsonb(ranked) ORDER BY COALESCE(ranked.updated_at, ranked.created_at) DESC NULLS LAST) AS comp_sample
    FROM (
      SELECT
        comp.*,
        ROW_NUMBER() OVER (
          PARTITION BY comp.property_id
          ORDER BY COALESCE(comp.updated_at, comp.created_at) DESC NULLS LAST
        ) AS rn
      FROM public.v_recent_sold_comps comp
      WHERE comp.property_id IS NOT NULL
    ) ranked
    WHERE ranked.rn <= 5
    GROUP BY ranked.property_id
  ),
  buyer_run_by_property AS (
    SELECT DISTINCT ON (br.property_id) br.*
    FROM public.buyer_match_runs br
    WHERE br.property_id IS NOT NULL
    ORDER BY br.property_id, COALESCE(br.updated_at, br.created_at) DESC NULLS LAST
  ),
  best_buyer_by_property AS (
    SELECT ranked.*
    FROM (
      SELECT
        candidate.*,
        ROW_NUMBER() OVER (
          PARTITION BY candidate.property_id
          ORDER BY candidate.match_score DESC NULLS LAST, COALESCE(candidate.updated_at, candidate.created_at) DESC NULLS LAST
        ) AS rn
      FROM public.buyer_match_candidates candidate
      WHERE candidate.property_id IS NOT NULL
    ) ranked
    WHERE ranked.rn = 1
  ),
  buyer_candidates_by_property AS (
    SELECT
      ranked.property_id,
      COUNT(*)::integer AS buyer_match_count,
      jsonb_agg(to_jsonb(ranked) ORDER BY ranked.match_score DESC NULLS LAST, ranked.sort_at DESC NULLS LAST) AS top_candidates
    FROM (
      SELECT
        candidate.*,
        COALESCE(candidate.updated_at, candidate.created_at) AS sort_at,
        ROW_NUMBER() OVER (
          PARTITION BY candidate.property_id
          ORDER BY candidate.match_score DESC NULLS LAST, COALESCE(candidate.updated_at, candidate.created_at) DESC NULLS LAST
        ) AS rn
      FROM public.buyer_match_candidates candidate
      WHERE candidate.property_id IS NOT NULL
    ) ranked
    WHERE ranked.rn <= 5
    GROUP BY ranked.property_id
  ),
  property_base AS (
    SELECT
      p.*,
      to_jsonb(p) AS property_json,
      mo.master_owner_id AS mo_master_owner_id,
      mo.display_name AS mo_display_name,
      mo.best_canonical_prospect_id AS mo_best_canonical_prospect_id,
      mo.priority_score AS mo_priority_score,
      mo.routing_market AS mo_routing_market,
      mo.primary_email_id AS mo_primary_email_id,
      mo.created_at AS mo_created_at,
      mo.updated_at AS mo_updated_at,
      to_jsonb(mo) AS mo_json,
      pr.prospect_id AS pr_prospect_id,
      pr.canonical_prospect_id AS pr_canonical_prospect_id,
      pr.full_name AS pr_full_name,
      pr.first_name AS pr_first_name,
      pr.best_phone AS pr_best_phone,
      pr.best_email AS pr_best_email,
      pr.primary_market AS pr_primary_market,
      pr.master_owner_priority_score AS pr_master_owner_priority_score,
      pr.created_at AS pr_created_at,
      pr.updated_at AS pr_updated_at,
      to_jsonb(pr) AS pr_json,
      ph.phone_id AS ph_phone_id,
      ph.canonical_e164 AS ph_canonical_e164,
      ph.canonical_prospect_id AS ph_canonical_prospect_id,
      ph.primary_display_name AS ph_primary_display_name,
      ph.phone_full_name AS ph_phone_full_name,
      ph.phone_first_name AS ph_phone_first_name,
      ph.primary_market AS ph_primary_market,
      ph.created_at AS ph_created_at,
      ph.updated_at AS ph_updated_at,
      to_jsonb(ph) AS ph_json,
      em.email_id AS em_email_id,
      em.created_at AS em_created_at,
      em.updated_at AS em_updated_at,
      to_jsonb(em) AS em_json
    FROM property_rows p
    LEFT JOIN public.master_owners mo
      ON mo.master_owner_id = p.master_owner_id
    LEFT JOIN LATERAL (
      SELECT pr.*
      FROM public.prospects pr
      WHERE (
        mo.best_prospect_id IS NOT NULL
        AND pr.prospect_id = mo.best_prospect_id
      ) OR (
        mo.best_canonical_prospect_id IS NOT NULL
        AND pr.canonical_prospect_id = mo.best_canonical_prospect_id
      ) OR (
        mo.master_owner_id IS NOT NULL
        AND pr.master_owner_id = mo.master_owner_id
      )
      ORDER BY
        CASE
          WHEN mo.best_prospect_id IS NOT NULL AND pr.prospect_id = mo.best_prospect_id THEN 1
          WHEN mo.best_canonical_prospect_id IS NOT NULL AND pr.canonical_prospect_id = mo.best_canonical_prospect_id THEN 2
          WHEN COALESCE(pr.is_primary_prospect, false) THEN 3
          ELSE 4
        END,
        pr.rank_position NULLS LAST,
        pr.phone_score_final DESC NULLS LAST,
        pr.contact_score_final DESC NULLS LAST,
        COALESCE(pr.updated_at, pr.created_at) DESC NULLS LAST
      LIMIT 1
    ) pr ON true
    LEFT JOIN LATERAL (
      SELECT ph.*
      FROM public.phones ph
      WHERE (
        mo.primary_phone_id IS NOT NULL
        AND ph.phone_id = mo.primary_phone_id
      ) OR (
        pr.best_phone IS NOT NULL
        AND (ph.canonical_e164 = pr.best_phone OR ph.phone = pr.best_phone)
      ) OR (
        mo.master_owner_id IS NOT NULL
        AND ph.master_owner_id = mo.master_owner_id
      ) OR (
        pr.canonical_prospect_id IS NOT NULL
        AND ph.canonical_prospect_id = pr.canonical_prospect_id
      )
      ORDER BY
        CASE
          WHEN mo.primary_phone_id IS NOT NULL AND ph.phone_id = mo.primary_phone_id THEN 1
          WHEN pr.best_phone IS NOT NULL AND (ph.canonical_e164 = pr.best_phone OR ph.phone = pr.best_phone) THEN 2
          WHEN mo.master_owner_id IS NOT NULL
            AND ph.master_owner_id = mo.master_owner_id
            AND COALESCE(ph.is_best_phone_for_owner, false) THEN 3
          WHEN pr.canonical_prospect_id IS NOT NULL AND ph.canonical_prospect_id = pr.canonical_prospect_id THEN 4
          ELSE 5
        END,
        COALESCE(ph.is_best_phone_for_slot, false) DESC,
        COALESCE(ph.is_best_phone_for_owner, false) DESC,
        ph.best_phone_score DESC NULLS LAST,
        COALESCE(ph.updated_at, ph.created_at) DESC NULLS LAST
      LIMIT 1
    ) ph ON true
    LEFT JOIN LATERAL (
      SELECT em.*
      FROM public.emails em
      WHERE (
        mo.primary_email_id IS NOT NULL
        AND em.email_id = mo.primary_email_id
      ) OR (
        pr.best_email IS NOT NULL
        AND (em.email_normalized = pr.best_email OR em.email = pr.best_email)
      ) OR (
        mo.master_owner_id IS NOT NULL
        AND em.master_owner_id = mo.master_owner_id
      ) OR (
        pr.canonical_prospect_id IS NOT NULL
        AND em.canonical_prospect_id = pr.canonical_prospect_id
      )
      ORDER BY
        CASE
          WHEN mo.primary_email_id IS NOT NULL AND em.email_id = mo.primary_email_id THEN 1
          WHEN pr.best_email IS NOT NULL AND (em.email_normalized = pr.best_email OR em.email = pr.best_email) THEN 2
          WHEN mo.master_owner_id IS NOT NULL
            AND em.master_owner_id = mo.master_owner_id
            AND COALESCE(em.is_best_email_for_owner, false) THEN 3
          WHEN pr.canonical_prospect_id IS NOT NULL AND em.canonical_prospect_id = pr.canonical_prospect_id THEN 4
          ELSE 5
        END,
        COALESCE(em.is_best_email_for_slot, false) DESC,
        COALESCE(em.is_best_email_for_owner, false) DESC,
        em.email_score_final DESC NULLS LAST,
        COALESCE(em.updated_at, em.created_at) DESC NULLS LAST
      LIMIT 1
    ) em ON true
  )
  SELECT
    COALESCE(
      NULLIF(base.property_id, ''),
      'property_export:' || COALESCE(NULLIF(base.property_export_id, ''), md5(base.property_json::text))
    ) AS deal_context_id,
    'property'::text AS context_type,
    base.property_id,
    COALESCE(base.mo_master_owner_id, base.master_owner_id) AS master_owner_id,
    base.pr_prospect_id AS prospect_id,
    COALESCE(base.pr_canonical_prospect_id, base.ph_canonical_prospect_id, base.mo_best_canonical_prospect_id) AS canonical_prospect_id,
    base.ph_phone_id AS phone_id,
    base.em_email_id AS email_id,
    COALESCE(ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key, sq_property.thread_key, sq_owner.thread_key, sq_phone.thread_key, me_property.thread_key, base.ph_canonical_e164) AS thread_key,
    COALESCE(base.ph_canonical_e164, ct_property.canonical_e164, ct_owner.canonical_e164, ct_phone.canonical_e164, sq_id.to_phone_number, sq_property.to_phone_number, sq_owner.to_phone_number, sq_phone.to_phone_number, ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key) AS canonical_e164,
    sc.id AS campaign_id,
    COALESCE(ct_property.id, ct_owner.id, ct_phone.id) AS campaign_target_id,
    COALESCE(COALESCE(ct_property.queue_row_id, ct_owner.queue_row_id, ct_phone.queue_row_id)::text, sq_id.id::text, sq_property.id::text, sq_owner.id::text, sq_thread.id::text, sq_phone.id::text) AS queue_row_id,
    COALESCE(me_thread.id::text, me_property.id::text) AS latest_message_event_id,
    COALESCE(ts_property.latest_message_body, ts_owner.latest_message_body, ts_phone.latest_message_body, ts_best.latest_message_body, me_thread.message_body, me_property.message_body) AS latest_message_body,
    COALESCE(ts_property.latest_message_direction, ts_owner.latest_message_direction, ts_phone.latest_message_direction, ts_best.latest_message_direction, me_thread.direction, me_property.direction) AS latest_message_direction,
    COALESCE(ts_property.latest_message_at, ts_owner.latest_message_at, ts_phone.latest_message_at, ts_best.latest_message_at, me_thread.event_at, me_property.event_at) AS latest_message_at,
    COALESCE(ms_thread.last_outbound_at, sq_id.sent_at, sq_property.sent_at, sq_thread.sent_at, sq_owner.sent_at, sq_phone.sent_at) AS last_outbound_at,
    ms_thread.last_inbound_at,
    COALESCE(base.mo_display_name, base.pr_full_name, base.ph_primary_display_name, base.ph_phone_full_name) AS owner_name,
    COALESCE(base.pr_first_name, base.ph_phone_first_name, split_part(COALESCE(base.pr_full_name, base.ph_phone_full_name, base.mo_display_name, ''), ' ', 1), NULL) AS seller_first_name,
    COALESCE(base.property_address_full, base.property_address, COALESCE(ct_property.property_address_full, ct_owner.property_address_full, ct_phone.property_address_full), sq_id.property_address, sq_property.property_address, sq_thread.property_address, sq_owner.property_address, sq_phone.property_address) AS property_address_full,
    COALESCE(base.property_address_city, COALESCE(ct_property.property_address_city, ct_owner.property_address_city, ct_phone.property_address_city), sq_id.property_address_city, sq_property.property_address_city, sq_owner.property_address_city, sq_phone.property_address_city) AS property_address_city,
    COALESCE(base.property_state, base.property_address_state, COALESCE(ct_property.property_address_state, ct_owner.property_address_state, ct_phone.property_address_state), sq_id.property_address_state, sq_property.property_address_state, sq_owner.property_address_state, sq_phone.property_address_state) AS property_state,
    COALESCE(base.property_zip, base.property_address_zip, COALESCE(ct_property.property_address_zip, ct_owner.property_address_zip, ct_phone.property_address_zip), sq_id.property_address_zip, sq_property.property_address_zip, sq_owner.property_address_zip, sq_phone.property_address_zip) AS property_zip,
    COALESCE(base.property_county_name, base.property_address_county_name) AS property_county_name,
    COALESCE(base.market, COALESCE(ct_property.market, ct_owner.market, ct_phone.market), sq_id.market, sq_property.market, sq_thread.market, sq_owner.market, sq_phone.market, base.mo_routing_market, base.pr_primary_market, base.ph_primary_market) AS market,
    base.latitude,
    base.longitude,
    base.property_type,
    base.property_class,
    COALESCE(base.estimated_value, valuation.estimated_value, cash_snapshot.estimated_value, COALESCE(ct_property.estimated_value, ct_owner.estimated_value, ct_phone.estimated_value)) AS estimated_value,
    valuation.estimated_arv,
    base.equity_percent,
    COALESCE(base.cash_offer, valuation.target_offer, cash_snapshot.cash_offer, COALESCE(ct_property.cash_offer, ct_owner.cash_offer, ct_phone.cash_offer)) AS cash_offer,
    COALESCE(valuation.buyer_demand_score, buyer_run.demand_score) AS buyer_demand_score,
    COALESCE(best_buyer.match_score, buyer_run.demand_score) AS buyer_match_score,
    buyer_candidates.buyer_match_count,
    best_buyer.buyer_display_name AS best_buyer_name,
    best_buyer.match_grade AS best_buyer_grade,
    COALESCE(
      NULLIF(COALESCE(ts_property.universal_status, ts_owner.universal_status, ts_phone.universal_status, ts_best.universal_status), ''),
      CASE
        WHEN COALESCE(suppression.is_active, false) OR COALESCE(ts_property.opt_out, ts_owner.opt_out, ts_phone.opt_out, ts_best.opt_out, false) THEN 'suppressed'
        WHEN LOWER(COALESCE(sq_id.queue_status, sq_property.queue_status, sq_thread.queue_status, sq_owner.queue_status, sq_phone.queue_status, '')) IN ('approval', 'queued', 'ready', 'scheduled', 'sending') THEN 'queued'
        WHEN LOWER(COALESCE(ts_property.latest_message_direction, ts_owner.latest_message_direction, ts_phone.latest_message_direction, ts_best.latest_message_direction, me_thread.direction, me_property.direction, '')) LIKE 'in%' THEN 'seller_replied'
        WHEN COALESCE(ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key, sq_property.thread_key, sq_owner.thread_key, sq_phone.thread_key, me_property.thread_key) IS NOT NULL THEN 'awaiting_response'
        ELSE 'not_contacted'
      END
    ) AS universal_status,
    COALESCE(
      NULLIF(COALESCE(ts_property.universal_stage, ts_owner.universal_stage, ts_phone.universal_stage, ts_best.universal_stage), ''),
      NULLIF(COALESCE(sq_id.pipeline_stage, sq_property.pipeline_stage, sq_thread.pipeline_stage, sq_owner.pipeline_stage, sq_phone.pipeline_stage), ''),
      NULLIF(COALESCE(sq_id.current_stage, sq_property.current_stage, sq_thread.current_stage, sq_owner.current_stage, sq_phone.current_stage), ''),
      CASE
        WHEN COALESCE(suppression.is_active, false) OR COALESCE(ts_property.opt_out, ts_owner.opt_out, ts_phone.opt_out, ts_best.opt_out, false) THEN 'suppressed'
        WHEN LOWER(COALESCE(ts_property.latest_message_direction, ts_owner.latest_message_direction, ts_phone.latest_message_direction, ts_best.latest_message_direction, me_thread.direction, me_property.direction, '')) LIKE 'in%' THEN 'seller_replied'
        WHEN COALESCE(ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key, sq_property.thread_key, sq_owner.thread_key, sq_phone.thread_key, me_property.thread_key) IS NOT NULL THEN 'awaiting_response'
        ELSE 'not_contacted'
      END
    ) AS universal_stage,
    COALESCE(
      NULLIF(COALESCE(ts_property.inbox_bucket, ts_owner.inbox_bucket, ts_phone.inbox_bucket, ts_best.inbox_bucket), ''),
      CASE
        WHEN COALESCE(suppression.is_active, false) OR COALESCE(ts_property.opt_out, ts_owner.opt_out, ts_phone.opt_out, ts_best.opt_out, false) THEN 'suppressed'
        WHEN COALESCE(ts_property.needs_review, ts_owner.needs_review, ts_phone.needs_review, ts_best.needs_review, false) THEN 'needs_review'
        WHEN LOWER(COALESCE(ts_property.latest_message_direction, ts_owner.latest_message_direction, ts_phone.latest_message_direction, ts_best.latest_message_direction, me_thread.direction, me_property.direction, '')) LIKE 'in%' THEN 'new_replies'
        WHEN COALESCE(ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key, sq_property.thread_key, sq_owner.thread_key, sq_phone.thread_key, me_property.thread_key) IS NOT NULL THEN 'cold'
        ELSE 'cold'
      END
    ) AS inbox_bucket,
    COALESCE(sq_id.queue_status, sq_property.queue_status, sq_thread.queue_status, sq_owner.queue_status, sq_phone.queue_status) AS queue_status,
    COALESCE(sq_id.scheduled_for_utc, sq_id.scheduled_for, sq_property.scheduled_for_utc, sq_property.scheduled_for, sq_thread.scheduled_for_utc, sq_thread.scheduled_for, sq_owner.scheduled_for_utc, sq_owner.scheduled_for, sq_phone.scheduled_for_utc, sq_phone.scheduled_for, COALESCE(ct_property.scheduled_for, ct_owner.scheduled_for, ct_phone.scheduled_for)) AS queue_scheduled_for,
    sc.campaign_name,
    sc.status AS campaign_status,
    COALESCE(ct_property.target_status, ct_owner.target_status, ct_phone.target_status) AS campaign_target_status,
    CASE
      WHEN COALESCE(suppression.is_active, false) OR COALESCE(ts_property.opt_out, ts_owner.opt_out, ts_phone.opt_out, ts_best.opt_out, false) THEN 'suppressed'
      ELSE NULL
    END AS suppression_status,
    COALESCE(suppression.suppression_type, suppression.suppression_reason) AS suppression_type,
    COALESCE(base.final_acquisition_score, COALESCE(ct_property.final_acquisition_score, ct_owner.final_acquisition_score, ct_phone.final_acquisition_score), cash_snapshot.confidence_score) AS final_acquisition_score,
    COALESCE(base.structured_motivation_score, base.mo_priority_score, base.pr_master_owner_priority_score) AS priority_score,
    COALESCE(ts_property.opt_out, ts_owner.opt_out, ts_phone.opt_out, ts_best.opt_out, false) OR COALESCE(suppression.is_active, false) AS opt_out,
    COALESCE(ts_property.wrong_number, ts_owner.wrong_number, ts_phone.wrong_number, ts_best.wrong_number, false) AS wrong_number,
    COALESCE(ts_property.not_interested, ts_owner.not_interested, ts_phone.not_interested, ts_best.not_interested, false) AS not_interested,
    COALESCE(ts_property.needs_review, ts_owner.needs_review, ts_phone.needs_review, ts_best.needs_review, false) AS needs_review,
    base.property_json AS property_data,
    base.mo_json AS master_owner_data,
    base.pr_json AS prospect_data,
    base.ph_json AS phone_data,
    base.em_json AS email_data,
    CASE
      WHEN ts_property.thread_key IS NOT NULL THEN to_jsonb(ts_property)
      WHEN ts_owner.thread_key IS NOT NULL THEN to_jsonb(ts_owner)
      WHEN ts_phone.thread_key IS NOT NULL THEN to_jsonb(ts_phone)
      WHEN ts_best.thread_key IS NOT NULL THEN to_jsonb(ts_best)
      ELSE NULL
    END AS thread_state_data,
    CASE
      WHEN COALESCE(ct_property.id, ct_owner.id, ct_phone.id) IS NOT NULL OR sc.id IS NOT NULL THEN
        jsonb_strip_nulls(
          jsonb_build_object(
            'campaign_target',
            CASE
              WHEN ct_property.id IS NOT NULL THEN to_jsonb(ct_property)
              WHEN ct_owner.id IS NOT NULL THEN to_jsonb(ct_owner)
              WHEN ct_phone.id IS NOT NULL THEN to_jsonb(ct_phone)
              ELSE NULL
            END,
            'campaign', to_jsonb(sc)
          )
        )
      ELSE NULL
    END AS campaign_data,
    CASE
      WHEN sq_id.id IS NOT NULL THEN to_jsonb(sq_id)
      WHEN sq_property.id IS NOT NULL THEN to_jsonb(sq_property)
      WHEN sq_thread.id IS NOT NULL THEN to_jsonb(sq_thread)
      WHEN sq_owner.id IS NOT NULL THEN to_jsonb(sq_owner)
      WHEN sq_phone.id IS NOT NULL THEN to_jsonb(sq_phone)
      ELSE NULL
    END AS queue_data,
    to_jsonb(suppression) AS suppression_data,
    CASE
      WHEN valuation.property_id IS NOT NULL OR cash_snapshot.property_id IS NOT NULL OR comp_summary.property_id IS NOT NULL THEN
        jsonb_strip_nulls(
          jsonb_build_object(
            'property_valuation_snapshot', to_jsonb(valuation),
            'property_cash_offer_snapshot', to_jsonb(cash_snapshot),
            'recent_comp_summary',
            CASE
              WHEN comp_summary.property_id IS NOT NULL THEN
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'comp_count', comp_summary.comp_count,
                    'avg_price_off_value', comp_summary.avg_price_off_value,
                    'max_comp_confidence_score', comp_summary.max_comp_confidence_score,
                    'sample', COALESCE(comp_summary.comp_sample, '[]'::jsonb)
                  )
                )
              ELSE NULL
            END
          )
        )
      ELSE NULL
    END AS valuation_data,
    CASE
      WHEN buyer_run.property_id IS NOT NULL OR buyer_candidates.property_id IS NOT NULL THEN
        jsonb_strip_nulls(
          jsonb_build_object(
            'buyer_match_run', to_jsonb(buyer_run),
            'best_candidate', to_jsonb(best_buyer),
            'top_candidates', COALESCE(buyer_candidates.top_candidates, '[]'::jsonb)
          )
        )
      ELSE NULL
    END AS buyer_match_data,
    CASE
      WHEN me_thread.id IS NOT NULL THEN to_jsonb(me_thread)
      WHEN me_property.id IS NOT NULL THEN to_jsonb(me_property)
      ELSE NULL
    END AS latest_message_event_data,
    now() AS created_at,
    GREATEST(
      COALESCE(base.updated_at, base.created_at, now()),
      COALESCE(base.mo_updated_at, base.mo_created_at, now()),
      COALESCE(base.pr_updated_at, base.pr_created_at, now()),
      COALESCE(base.ph_updated_at, base.ph_created_at, now()),
      COALESCE(base.em_updated_at, base.em_created_at, now()),
      COALESCE(ts_property.updated_at, ts_property.created_at, ts_owner.updated_at, ts_owner.created_at, ts_phone.updated_at, ts_phone.created_at, ts_best.updated_at, ts_best.created_at, now()),
      COALESCE(sc.created_at, now()),
      COALESCE(ct_property.updated_at, ct_property.created_at, ct_owner.updated_at, ct_owner.created_at, ct_phone.updated_at, ct_phone.created_at, now()),
      COALESCE(sq_id.updated_at, sq_id.created_at, sq_property.updated_at, sq_property.created_at, sq_thread.updated_at, sq_thread.created_at, sq_owner.updated_at, sq_owner.created_at, sq_phone.updated_at, sq_phone.created_at, now()),
      COALESCE(suppression.suppressed_at, suppression.created_at, now()),
      COALESCE(valuation.updated_at, valuation.created_at, now()),
      COALESCE(cash_snapshot.updated_at, cash_snapshot.created_at, now()),
      COALESCE(buyer_run.updated_at, buyer_run.created_at, now()),
      COALESCE(best_buyer.updated_at, best_buyer.created_at, now()),
      COALESCE(me_thread.event_at, me_thread.created_at, me_property.event_at, me_property.created_at, now())
    ) AS updated_at
  FROM property_base base
  LEFT JOIN thread_by_property ts_property
    ON ts_property.property_id = base.property_id
  LEFT JOIN thread_by_owner ts_owner
    ON ts_owner.master_owner_id = base.mo_master_owner_id
  LEFT JOIN thread_by_thread_key ts_phone
    ON ts_phone.thread_key = base.ph_canonical_e164
  LEFT JOIN thread_by_best_phone ts_best
    ON ts_best.best_phone = base.ph_canonical_e164
  LEFT JOIN message_by_thread me_thread
    ON me_thread.thread_key = COALESCE(ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key)
  LEFT JOIN message_by_property me_property
    ON me_property.property_id = base.property_id
  LEFT JOIN message_stats_by_thread ms_thread
    ON ms_thread.thread_key = COALESCE(ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key)
  LEFT JOIN target_by_property ct_property
    ON ct_property.property_id = base.property_id
  LEFT JOIN target_by_owner ct_owner
    ON ct_owner.master_owner_id = base.mo_master_owner_id
  LEFT JOIN target_by_phone ct_phone
    ON ct_phone.canonical_e164 = base.ph_canonical_e164
  LEFT JOIN public.sms_campaigns sc
    ON sc.id = COALESCE(ct_property.campaign_id, ct_owner.campaign_id, ct_phone.campaign_id)
  LEFT JOIN public.send_queue sq_id
    ON sq_id.id = COALESCE(ct_property.queue_row_id, ct_owner.queue_row_id, ct_phone.queue_row_id)
  LEFT JOIN queue_by_property sq_property
    ON sq_property.property_id = base.property_id
  LEFT JOIN queue_by_thread sq_thread
    ON sq_thread.thread_key = COALESCE(ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key)
  LEFT JOIN queue_by_owner sq_owner
    ON sq_owner.master_owner_id = base.mo_master_owner_id
  LEFT JOIN queue_by_phone sq_phone
    ON sq_phone.to_phone_number = base.ph_canonical_e164
  LEFT JOIN suppression_by_phone suppression
    ON COALESCE(suppression.phone_e164, suppression.phone_number) = COALESCE(base.ph_canonical_e164, ct_property.canonical_e164, ct_owner.canonical_e164, ct_phone.canonical_e164, sq_id.to_phone_number, sq_property.to_phone_number, sq_thread.to_phone_number, sq_owner.to_phone_number, sq_phone.to_phone_number, ts_property.thread_key, ts_owner.thread_key, ts_phone.thread_key, ts_best.thread_key)
  LEFT JOIN valuation_by_property valuation
    ON valuation.property_id = base.property_id
  LEFT JOIN cash_snapshot_by_property cash_snapshot
    ON cash_snapshot.property_id = base.property_id
  LEFT JOIN comp_summary_by_property comp_summary
    ON comp_summary.property_id = base.property_id
  LEFT JOIN buyer_run_by_property buyer_run
    ON buyer_run.property_id = base.property_id
  LEFT JOIN best_buyer_by_property best_buyer
    ON best_buyer.property_id = base.property_id
  LEFT JOIN buyer_candidates_by_property buyer_candidates
    ON buyer_candidates.property_id = base.property_id;

    v_batch_start := v_batch_end + 1;
  END LOOP;

  INSERT INTO public.deal_context_index (
    deal_context_id,
    context_type,
    property_id,
    master_owner_id,
    prospect_id,
    canonical_prospect_id,
    phone_id,
    email_id,
    thread_key,
    canonical_e164,
    campaign_id,
    campaign_target_id,
    queue_row_id,
    latest_message_event_id,
    latest_message_body,
    latest_message_direction,
    latest_message_at,
    last_outbound_at,
    last_inbound_at,
    owner_name,
    seller_first_name,
    property_address_full,
    property_address_city,
    property_state,
    property_zip,
    property_county_name,
    market,
    latitude,
    longitude,
    property_type,
    property_class,
    estimated_value,
    estimated_arv,
    equity_percent,
    cash_offer,
    buyer_demand_score,
    buyer_match_score,
    buyer_match_count,
    best_buyer_name,
    best_buyer_grade,
    universal_status,
    universal_stage,
    inbox_bucket,
    queue_status,
    queue_scheduled_for,
    campaign_name,
    campaign_status,
    campaign_target_status,
    suppression_status,
    suppression_type,
    final_acquisition_score,
    priority_score,
    opt_out,
    wrong_number,
    not_interested,
    needs_review,
    property_data,
    master_owner_data,
    prospect_data,
    phone_data,
    email_data,
    thread_state_data,
    campaign_data,
    queue_data,
    suppression_data,
    valuation_data,
    buyer_match_data,
    latest_message_event_data,
    created_at,
    updated_at
  )
  SELECT
    'thread:' || ts.thread_key AS deal_context_id,
    'unlinked_thread'::text AS context_type,
    NULL::text AS property_id,
    COALESCE(mo.master_owner_id, ts.master_owner_id) AS master_owner_id,
    pr.prospect_id,
    COALESCE(pr.canonical_prospect_id, ph.canonical_prospect_id) AS canonical_prospect_id,
    ph.phone_id,
    em.email_id,
    ts.thread_key,
    COALESCE(ph.canonical_e164, sq.to_phone_number, ts.thread_key) AS canonical_e164,
    sc.id AS campaign_id,
    ct.id AS campaign_target_id,
    COALESCE(ct.queue_row_id::text, sq.id::text) AS queue_row_id,
    me.id::text AS latest_message_event_id,
    COALESCE(ts.latest_message_body, me.message_body) AS latest_message_body,
    COALESCE(ts.latest_message_direction, me.direction) AS latest_message_direction,
    COALESCE(ts.latest_message_at, me.event_at) AS latest_message_at,
    message_stats.last_outbound_at,
    message_stats.last_inbound_at,
    COALESCE(mo.display_name, pr.full_name, ph.primary_display_name, ph.phone_full_name) AS owner_name,
    COALESCE(
      pr.first_name,
      ph.phone_first_name,
      split_part(COALESCE(pr.full_name, ph.phone_full_name, mo.display_name, ''), ' ', 1),
      NULL
    ) AS seller_first_name,
    COALESCE(sq.property_address, ct.property_address_full) AS property_address_full,
    COALESCE(ct.property_address_city, sq.property_address_city) AS property_address_city,
    COALESCE(ct.property_address_state, sq.property_address_state) AS property_state,
    COALESCE(ct.property_address_zip, sq.property_address_zip) AS property_zip,
    NULL::text AS property_county_name,
    COALESCE(ct.market, sq.market, mo.routing_market, pr.primary_market, ph.primary_market) AS market,
    NULL::numeric AS latitude,
    NULL::numeric AS longitude,
    NULL::text AS property_type,
    NULL::text AS property_class,
    COALESCE(ct.estimated_value, valuation.estimated_value, cash_snapshot.estimated_value) AS estimated_value,
    valuation.estimated_arv,
    NULL::numeric AS equity_percent,
    COALESCE(valuation.target_offer, cash_snapshot.cash_offer, ct.cash_offer) AS cash_offer,
    COALESCE(valuation.buyer_demand_score, buyer_run.demand_score) AS buyer_demand_score,
    COALESCE(best_buyer.match_score, buyer_run.demand_score) AS buyer_match_score,
    buyer_candidates.buyer_match_count,
    best_buyer.buyer_display_name AS best_buyer_name,
    best_buyer.match_grade AS best_buyer_grade,
    COALESCE(
      NULLIF(ts.universal_status, ''),
      CASE
        WHEN COALESCE(suppression.is_active, false) OR COALESCE(ts.opt_out, false) THEN 'suppressed'
        WHEN LOWER(COALESCE(sq.queue_status, '')) IN ('approval', 'queued', 'ready', 'scheduled', 'sending') THEN 'queued'
        WHEN LOWER(COALESCE(ts.latest_message_direction, me.direction, '')) LIKE 'in%' THEN 'seller_replied'
        ELSE 'awaiting_response'
      END
    ) AS universal_status,
    COALESCE(
      NULLIF(ts.universal_stage, ''),
      NULLIF(sq.pipeline_stage, ''),
      NULLIF(sq.current_stage, ''),
      CASE
        WHEN COALESCE(suppression.is_active, false) OR COALESCE(ts.opt_out, false) THEN 'suppressed'
        WHEN LOWER(COALESCE(ts.latest_message_direction, me.direction, '')) LIKE 'in%' THEN 'seller_replied'
        ELSE 'awaiting_response'
      END
    ) AS universal_stage,
    COALESCE(
      NULLIF(ts.inbox_bucket, ''),
      CASE
        WHEN COALESCE(suppression.is_active, false) OR COALESCE(ts.opt_out, false) THEN 'suppressed'
        WHEN COALESCE(ts.needs_review, false) THEN 'needs_review'
        WHEN LOWER(COALESCE(ts.latest_message_direction, me.direction, '')) LIKE 'in%' THEN 'new_replies'
        ELSE 'unlinked'
      END
    ) AS inbox_bucket,
    sq.queue_status,
    COALESCE(sq.scheduled_for_utc, sq.scheduled_for, ct.scheduled_for) AS queue_scheduled_for,
    sc.campaign_name,
    sc.status AS campaign_status,
    ct.target_status AS campaign_target_status,
    CASE
      WHEN COALESCE(suppression.is_active, false) OR COALESCE(ts.opt_out, false) THEN 'suppressed'
      ELSE NULL
    END AS suppression_status,
    COALESCE(suppression.suppression_type, suppression.suppression_reason) AS suppression_type,
    ct.final_acquisition_score AS final_acquisition_score,
    COALESCE(mo.priority_score, pr.master_owner_priority_score) AS priority_score,
    COALESCE(ts.opt_out, false) OR COALESCE(suppression.is_active, false) AS opt_out,
    COALESCE(ts.wrong_number, false) AS wrong_number,
    COALESCE(ts.not_interested, false) AS not_interested,
    COALESCE(ts.needs_review, false) AS needs_review,
    NULL::jsonb AS property_data,
    to_jsonb(mo) AS master_owner_data,
    to_jsonb(pr) AS prospect_data,
    to_jsonb(ph) AS phone_data,
    to_jsonb(em) AS email_data,
    to_jsonb(ts) AS thread_state_data,
    CASE
      WHEN ct.id IS NOT NULL OR sc.id IS NOT NULL THEN
        jsonb_strip_nulls(
          jsonb_build_object(
            'campaign_target', to_jsonb(ct),
            'campaign', to_jsonb(sc)
          )
        )
      ELSE NULL
    END AS campaign_data,
    to_jsonb(sq) AS queue_data,
    to_jsonb(suppression) AS suppression_data,
    CASE
      WHEN valuation.property_id IS NOT NULL
        OR cash_snapshot.property_id IS NOT NULL
        OR comp_summary.property_id IS NOT NULL THEN
        jsonb_strip_nulls(
          jsonb_build_object(
            'property_valuation_snapshot', to_jsonb(valuation),
            'property_cash_offer_snapshot', to_jsonb(cash_snapshot),
            'recent_comp_summary',
            CASE
              WHEN comp_summary.property_id IS NOT NULL THEN
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'comp_count', comp_summary.comp_count,
                    'avg_price_off_value', comp_summary.avg_price_off_value,
                    'max_comp_confidence_score', comp_summary.max_comp_confidence_score,
                    'sample', COALESCE(comp_summary.comp_sample, '[]'::jsonb)
                  )
                )
              ELSE NULL
            END
          )
        )
      ELSE NULL
    END AS valuation_data,
    CASE
      WHEN buyer_run.buyer_match_run_id IS NOT NULL
        OR buyer_candidates.buyer_match_count IS NOT NULL THEN
        jsonb_strip_nulls(
          jsonb_build_object(
            'buyer_match_run', to_jsonb(buyer_run),
            'best_candidate', to_jsonb(best_buyer),
            'top_candidates', COALESCE(buyer_candidates.top_candidates, '[]'::jsonb)
          )
        )
      ELSE NULL
    END AS buyer_match_data,
    to_jsonb(me) AS latest_message_event_data,
    now() AS created_at,
    GREATEST(
      COALESCE(mo.updated_at, mo.created_at, now()),
      COALESCE(pr.updated_at, pr.created_at, now()),
      COALESCE(ph.updated_at, ph.created_at, now()),
      COALESCE(em.updated_at, em.created_at, now()),
      COALESCE(ts.updated_at, ts.created_at, now()),
      COALESCE(sc.created_at, now()),
      COALESCE(ct.updated_at, ct.created_at, now()),
      COALESCE(sq.updated_at, sq.created_at, now()),
      COALESCE(suppression.suppressed_at, suppression.created_at, now()),
      COALESCE(valuation.updated_at, valuation.created_at, now()),
      COALESCE(cash_snapshot.updated_at, cash_snapshot.created_at, now()),
      COALESCE(buyer_run.updated_at, buyer_run.created_at, now()),
      COALESCE(best_buyer.updated_at, best_buyer.created_at, now()),
      COALESCE(me.event_at, me.created_at, now())
    ) AS updated_at
  FROM public.deal_thread_state ts
  LEFT JOIN public.properties p_existing
    ON p_existing.property_id = ts.property_id
  LEFT JOIN public.master_owners mo
    ON mo.master_owner_id = ts.master_owner_id
  LEFT JOIN LATERAL (
    SELECT ph.*
    FROM public.phones ph
    WHERE (ts.thread_key IS NOT NULL AND ph.canonical_e164 = ts.thread_key)
      OR (ts.best_phone IS NOT NULL AND ph.canonical_e164 = ts.best_phone)
      OR (ts.master_owner_id IS NOT NULL AND ph.master_owner_id = ts.master_owner_id)
    ORDER BY
      CASE
        WHEN ts.thread_key IS NOT NULL AND ph.canonical_e164 = ts.thread_key THEN 1
        WHEN ts.best_phone IS NOT NULL AND ph.canonical_e164 = ts.best_phone THEN 2
        WHEN ts.master_owner_id IS NOT NULL
          AND ph.master_owner_id = ts.master_owner_id
          AND COALESCE(ph.is_best_phone_for_owner, false) THEN 3
        ELSE 4
      END,
      COALESCE(ph.is_best_phone_for_slot, false) DESC,
      ph.best_phone_score DESC NULLS LAST,
      COALESCE(ph.updated_at, ph.created_at) DESC NULLS LAST
    LIMIT 1
  ) ph ON true
  LEFT JOIN LATERAL (
    SELECT pr.*
    FROM public.prospects pr
    WHERE (ph.canonical_prospect_id IS NOT NULL AND pr.canonical_prospect_id = ph.canonical_prospect_id)
      OR (ts.master_owner_id IS NOT NULL AND pr.master_owner_id = ts.master_owner_id)
      OR (ph.primary_prospect_id IS NOT NULL AND pr.prospect_id = ph.primary_prospect_id)
    ORDER BY
      CASE
        WHEN ph.canonical_prospect_id IS NOT NULL AND pr.canonical_prospect_id = ph.canonical_prospect_id THEN 1
        WHEN ph.primary_prospect_id IS NOT NULL AND pr.prospect_id = ph.primary_prospect_id THEN 2
        WHEN COALESCE(pr.is_primary_prospect, false) THEN 3
        ELSE 4
      END,
      pr.rank_position NULLS LAST,
      COALESCE(pr.updated_at, pr.created_at) DESC NULLS LAST
    LIMIT 1
  ) pr ON true
  LEFT JOIN LATERAL (
    SELECT em.*
    FROM public.emails em
    WHERE (mo.primary_email_id IS NOT NULL AND em.email_id = mo.primary_email_id)
      OR (pr.best_email IS NOT NULL AND (em.email_normalized = pr.best_email OR em.email = pr.best_email))
      OR (ts.master_owner_id IS NOT NULL AND em.master_owner_id = ts.master_owner_id)
      OR (pr.canonical_prospect_id IS NOT NULL AND em.canonical_prospect_id = pr.canonical_prospect_id)
    ORDER BY
      CASE
        WHEN mo.primary_email_id IS NOT NULL AND em.email_id = mo.primary_email_id THEN 1
        WHEN pr.best_email IS NOT NULL AND (em.email_normalized = pr.best_email OR em.email = pr.best_email) THEN 2
        WHEN ts.master_owner_id IS NOT NULL
          AND em.master_owner_id = ts.master_owner_id
          AND COALESCE(em.is_best_email_for_owner, false) THEN 3
        ELSE 4
      END,
      COALESCE(em.is_best_email_for_slot, false) DESC,
      em.email_score_final DESC NULLS LAST,
      COALESCE(em.updated_at, em.created_at) DESC NULLS LAST
    LIMIT 1
  ) em ON true
  LEFT JOIN LATERAL (
    SELECT
      me.*,
      COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at) AS event_at
    FROM public.message_events me
    WHERE (ts.thread_key IS NOT NULL AND me.thread_key = ts.thread_key)
      OR (ts.master_owner_id IS NOT NULL AND me.master_owner_id = ts.master_owner_id)
      OR (ph.canonical_e164 IS NOT NULL AND (me.to_phone_number = ph.canonical_e164 OR me.from_phone_number = ph.canonical_e164))
    ORDER BY
      CASE
        WHEN ts.thread_key IS NOT NULL AND me.thread_key = ts.thread_key THEN 1
        WHEN ts.master_owner_id IS NOT NULL AND me.master_owner_id = ts.master_owner_id THEN 2
        WHEN ph.canonical_e164 IS NOT NULL AND (me.to_phone_number = ph.canonical_e164 OR me.from_phone_number = ph.canonical_e164) THEN 3
        ELSE 4
      END,
      COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at) DESC NULLS LAST,
      me.created_at DESC NULLS LAST
    LIMIT 1
  ) me ON true
  LEFT JOIN LATERAL (
    SELECT
      MAX(
        CASE
          WHEN LOWER(COALESCE(me.direction, '')) LIKE 'in%' THEN COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at)
          ELSE NULL
        END
      ) AS last_inbound_at,
      MAX(
        CASE
          WHEN LOWER(COALESCE(me.direction, '')) LIKE 'out%' THEN COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at)
          ELSE NULL
        END
      ) AS last_outbound_at
    FROM public.message_events me
    WHERE (ts.thread_key IS NOT NULL AND me.thread_key = ts.thread_key)
      OR (ts.master_owner_id IS NOT NULL AND me.master_owner_id = ts.master_owner_id)
      OR (ph.canonical_e164 IS NOT NULL AND (me.to_phone_number = ph.canonical_e164 OR me.from_phone_number = ph.canonical_e164))
  ) message_stats ON true
  LEFT JOIN LATERAL (
    SELECT ct.*
    FROM public.sms_campaign_targets ct
    WHERE (ph.canonical_e164 IS NOT NULL AND ct.canonical_e164 = ph.canonical_e164)
      OR (ts.master_owner_id IS NOT NULL AND ct.master_owner_id = ts.master_owner_id)
    ORDER BY
      CASE
        WHEN ph.canonical_e164 IS NOT NULL AND ct.canonical_e164 = ph.canonical_e164 THEN 1
        WHEN ts.master_owner_id IS NOT NULL AND ct.master_owner_id = ts.master_owner_id THEN 2
        ELSE 3
      END,
      COALESCE(ct.updated_at, ct.replied_at, ct.sent_at, ct.delivered_at, ct.queued_at, ct.created_at) DESC NULLS LAST
    LIMIT 1
  ) ct ON true
  LEFT JOIN public.sms_campaigns sc
    ON sc.id = ct.campaign_id
  LEFT JOIN LATERAL (
    SELECT sq.*
    FROM public.send_queue sq
    WHERE (ct.queue_row_id IS NOT NULL AND sq.id = ct.queue_row_id)
      OR (ts.thread_key IS NOT NULL AND sq.thread_key = ts.thread_key)
      OR (ts.master_owner_id IS NOT NULL AND sq.master_owner_id = ts.master_owner_id)
      OR (ph.canonical_e164 IS NOT NULL AND sq.to_phone_number = ph.canonical_e164)
    ORDER BY
      CASE
        WHEN ct.queue_row_id IS NOT NULL AND sq.id = ct.queue_row_id THEN 1
        WHEN ts.thread_key IS NOT NULL AND sq.thread_key = ts.thread_key THEN 2
        WHEN ts.master_owner_id IS NOT NULL AND sq.master_owner_id = ts.master_owner_id THEN 3
        WHEN ph.canonical_e164 IS NOT NULL AND sq.to_phone_number = ph.canonical_e164 THEN 4
        ELSE 5
      END,
      COALESCE(sq.updated_at, sq.sent_at, sq.delivered_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at) DESC NULLS LAST
    LIMIT 1
  ) sq ON true
  LEFT JOIN LATERAL (
    SELECT sl.*
    FROM public.sms_suppression_list sl
    WHERE COALESCE(sl.phone_e164, sl.phone_number) = COALESCE(ph.canonical_e164, sq.to_phone_number, ts.thread_key)
    ORDER BY COALESCE(sl.suppressed_at, sl.created_at) DESC NULLS LAST
    LIMIT 1
  ) suppression ON true
  LEFT JOIN LATERAL (
    SELECT v.*
    FROM public.property_valuation_snapshots v
    WHERE v.property_id = ct.property_id
    ORDER BY COALESCE(v.updated_at, v.created_at) DESC NULLS LAST
    LIMIT 1
  ) valuation ON true
  LEFT JOIN LATERAL (
    SELECT c.*
    FROM public.property_cash_offer_snapshots c
    WHERE c.property_id = ct.property_id
    ORDER BY COALESCE(c.updated_at, c.created_at) DESC NULLS LAST
    LIMIT 1
  ) cash_snapshot ON true
  LEFT JOIN comp_summary_by_property comp_summary
    ON comp_summary.property_id = ct.property_id
  LEFT JOIN LATERAL (
    SELECT br.*
    FROM public.buyer_match_runs br
    WHERE br.property_id = ct.property_id
    ORDER BY COALESCE(br.updated_at, br.created_at) DESC NULLS LAST
    LIMIT 1
  ) buyer_run ON true
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM public.buyer_match_candidates candidate
    WHERE (
      buyer_run.buyer_match_run_id IS NOT NULL
      AND candidate.buyer_match_run_id = buyer_run.buyer_match_run_id
    ) OR (
      buyer_run.buyer_match_run_id IS NULL
      AND ct.property_id IS NOT NULL
      AND candidate.property_id = ct.property_id
    )
    ORDER BY candidate.match_score DESC NULLS LAST, COALESCE(candidate.updated_at, candidate.created_at) DESC NULLS LAST
    LIMIT 1
  ) best_buyer ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::integer AS buyer_match_count,
      jsonb_agg(to_jsonb(candidate) ORDER BY candidate.match_score DESC NULLS LAST, COALESCE(candidate.updated_at, candidate.created_at) DESC NULLS LAST) AS top_candidates
    FROM (
      SELECT candidate.*
      FROM public.buyer_match_candidates candidate
      WHERE (
        buyer_run.buyer_match_run_id IS NOT NULL
        AND candidate.buyer_match_run_id = buyer_run.buyer_match_run_id
      ) OR (
        buyer_run.buyer_match_run_id IS NULL
        AND ct.property_id IS NOT NULL
        AND candidate.property_id = ct.property_id
      )
      ORDER BY candidate.match_score DESC NULLS LAST, COALESCE(candidate.updated_at, candidate.created_at) DESC NULLS LAST
      LIMIT 5
    ) candidate
  ) buyer_candidates ON true
  WHERE p_existing.property_id IS NULL
    AND ts.thread_key IS NOT NULL;

  SELECT COUNT(*)::integer
  INTO v_count
  FROM public.deal_context_index;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_deal_context_index() TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_deal_context_cards
WITH (security_invoker = true) AS
SELECT *
FROM public.deal_context_index;

REVOKE ALL ON public.v_deal_context_cards FROM anon, authenticated;
GRANT SELECT ON public.v_deal_context_cards TO anon, authenticated, service_role;

COMMIT;
