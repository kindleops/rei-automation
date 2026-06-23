CREATE INDEX IF NOT EXISTS idx_campaign_targets_property_phone ON public.campaign_targets (property_id, to_phone_number);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_owner_phone ON public.campaign_targets (master_owner_id, to_phone_number);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation_thread_id ON public.workflow_runs (conversation_thread_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_identity ON public.workflow_runs (property_id, master_owner_id, prospect_id);

CREATE OR REPLACE VIEW v_universal_lead_command AS
 WITH property_owner_keys AS NOT MATERIALIZED (
         SELECT g.property_export_id,
            g.property_id,
            g.master_owner_id AS resolved_master_owner_id,
            'campaign_target_graph.master_owner_id'::text AS owner_resolution_source
           FROM campaign_target_graph g
          WHERE g.master_owner_id IS NOT NULL
        UNION ALL
         SELECT p.property_export_id,
            p.property_id,
            p.master_owner_id AS resolved_master_owner_id,
            'properties.master_owner_id'::text AS owner_resolution_source
           FROM campaign_target_graph g
             JOIN properties p ON p.property_export_id = g.property_export_id
          WHERE g.master_owner_id IS NULL AND p.master_owner_id IS NOT NULL
        ), contact_grain_keys AS (
         SELECT pok.property_export_id,
            pok.property_id,
            pok.resolved_master_owner_id,
            pok.owner_resolution_source,
            pr.prospect_id,
            ph.phone_id,
            NULL::text AS email_id,
            'phone'::text AS contact_channel_type,
            ph.canonical_e164 AS contact_channel_value
           FROM property_owner_keys pok
             JOIN prospects pr ON pr.master_owner_id = pok.resolved_master_owner_id
             JOIN phones ph ON ph.master_owner_id = pr.master_owner_id AND ph.linked_prospect_ids_json ? pr.prospect_id AND NULLIF(ph.canonical_e164, ''::text) IS NOT NULL
        UNION ALL
         SELECT pok.property_export_id,
            pok.property_id,
            pok.resolved_master_owner_id,
            pok.owner_resolution_source,
            pr.prospect_id,
            NULL::text AS phone_id,
            em.email_id,
            'email'::text AS contact_channel_type,
            em.email_normalized AS contact_channel_value
           FROM property_owner_keys pok
             JOIN prospects pr ON pr.master_owner_id = pok.resolved_master_owner_id
             JOIN emails em ON em.master_owner_id = pr.master_owner_id AND em.linked_prospect_ids_json ? pr.prospect_id AND NULLIF(em.email_normalized, ''::text) IS NOT NULL
        ), contact_grain AS (
         SELECT cgk.property_export_id AS key_property_export_id,
            cgk.property_id AS key_property_id,
            cgk.resolved_master_owner_id,
            cgk.prospect_id AS key_prospect_id,
            cgk.phone_id AS key_phone_id,
            cgk.email_id AS key_email_id,
            cgk.owner_resolution_source,
            cgk.contact_channel_type,
            cgk.contact_channel_value,
            p.*::properties AS p,
            g.*::campaign_target_graph AS g,
            mo.*::master_owners AS mo,
            pr.*::prospects AS pr,
            ph.*::phones AS ph,
            em.*::emails AS em
           FROM contact_grain_keys cgk
             JOIN properties p ON p.property_export_id = cgk.property_export_id
             LEFT JOIN campaign_target_graph g ON g.property_export_id = cgk.property_export_id
             JOIN master_owners mo ON mo.master_owner_id = cgk.resolved_master_owner_id
             JOIN prospects pr ON pr.prospect_id = cgk.prospect_id
             LEFT JOIN phones ph ON ph.phone_id = cgk.phone_id
             LEFT JOIN emails em ON em.email_id = cgk.email_id
        ), thread_rows AS (
         SELECT its.id,
            its.thread_key,
            its.seller_phone,
            its.canonical_e164,
            its.our_number,
            its.master_owner_id,
            its.prospect_id,
            its.property_id,
            its.market,
            its.stage,
            its.status,
            its.priority,
            its.is_archived,
            its.is_read,
            its.is_pinned,
            its.is_urgent,
            its.last_read_at,
            its.archived_at,
            its.metadata,
            its.created_at,
            its.updated_at,
            its.is_starred,
            its.is_hidden,
            its.is_suppressed,
            its.hidden_at,
            its.suppressed_at,
            its.last_intent,
            its.next_action,
            its.automation_state,
            its.latest_reply_template_id,
            its.message_count,
            its.inbound_count,
            its.outbound_count,
            its.latest_message_event_id,
            its.latest_message_body,
            its.latest_message_at,
            its.latest_direction,
            its.latest_event_type,
            its.latest_delivery_status,
            its.last_inbound_at,
            its.last_outbound_at,
            its.pending_queue_count,
            its.failed_queue_count,
            its.blocked_queue_count,
            its.next_scheduled_for,
            its.is_hot_lead,
            its.follow_up_at,
            its.agent_id,
            its.persona_id,
            its.automation_status,
            COALESCE(NULLIF(its.canonical_e164, ''::text), NULLIF(its.seller_phone, ''::text)) AS contact_e164,
            COALESCE(its.latest_message_at, its.updated_at, its.created_at) AS rank_at
           FROM inbox_thread_state its
        ), thread_by_property_phone AS (
         SELECT DISTINCT ON (tr.property_id, tr.contact_e164) tr.property_id,
            tr.contact_e164,
            tr.id
           FROM thread_rows tr
          WHERE tr.property_id IS NOT NULL AND tr.contact_e164 IS NOT NULL
          ORDER BY tr.property_id, tr.contact_e164, tr.rank_at DESC NULLS LAST, tr.id DESC
        ), thread_by_prospect_phone AS (
         SELECT DISTINCT ON (tr.prospect_id, tr.contact_e164) tr.prospect_id,
            tr.contact_e164,
            tr.id
           FROM thread_rows tr
          WHERE tr.prospect_id IS NOT NULL AND tr.contact_e164 IS NOT NULL
          ORDER BY tr.prospect_id, tr.contact_e164, tr.rank_at DESC NULLS LAST, tr.id DESC
        ), thread_by_owner_phone AS (
         SELECT DISTINCT ON (tr.master_owner_id, tr.contact_e164) tr.master_owner_id,
            tr.contact_e164,
            tr.id
           FROM thread_rows tr
          WHERE tr.master_owner_id IS NOT NULL AND tr.contact_e164 IS NOT NULL
          ORDER BY tr.master_owner_id, tr.contact_e164, tr.rank_at DESC NULLS LAST, tr.id DESC
        ), latest_message_by_thread AS (
         SELECT DISTINCT ON (me.thread_key) me.thread_key,
            me.id
           FROM message_events me
          WHERE me.thread_key IS NOT NULL
          ORDER BY me.thread_key, (COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.delivered_at, me.created_at)) DESC NULLS LAST, me.created_at DESC NULLS LAST, me.id DESC
        ), queue_by_thread AS (
         SELECT DISTINCT ON (sq.thread_key) sq.thread_key,
            sq.id
           FROM send_queue sq
          WHERE sq.thread_key IS NOT NULL
          ORDER BY sq.thread_key, (COALESCE(sq.updated_at, sq.created_at)) DESC NULLS LAST, sq.id DESC
        ), queue_by_property_phone AS (
         SELECT DISTINCT ON (sq.property_id, sq.to_phone_number) sq.property_id,
            sq.to_phone_number,
            sq.id
           FROM send_queue sq
          WHERE sq.property_id IS NOT NULL AND sq.to_phone_number IS NOT NULL
          ORDER BY sq.property_id, sq.to_phone_number, (COALESCE(sq.updated_at, sq.created_at)) DESC NULLS LAST, sq.id DESC
        ), queue_by_owner_phone AS (
         SELECT DISTINCT ON (sq.master_owner_id, sq.to_phone_number) sq.master_owner_id,
            sq.to_phone_number,
            sq.id
           FROM send_queue sq
          WHERE sq.master_owner_id IS NOT NULL AND sq.to_phone_number IS NOT NULL
          ORDER BY sq.master_owner_id, sq.to_phone_number, (COALESCE(sq.updated_at, sq.created_at)) DESC NULLS LAST, sq.id DESC
        ), target_by_property_phone AS (
         SELECT DISTINCT ON (ct.property_id, ct.to_phone_number) ct.property_id,
            ct.to_phone_number,
            ct.id
           FROM campaign_targets ct
          WHERE ct.property_id IS NOT NULL AND ct.to_phone_number IS NOT NULL
          ORDER BY ct.property_id, ct.to_phone_number, (COALESCE(ct.updated_at, ct.created_at)) DESC NULLS LAST, ct.id DESC
        ), target_by_owner_phone AS (
         SELECT DISTINCT ON (ct.master_owner_id, ct.to_phone_number) ct.master_owner_id,
            ct.to_phone_number,
            ct.id
           FROM campaign_targets ct
          WHERE ct.master_owner_id IS NOT NULL AND ct.to_phone_number IS NOT NULL
          ORDER BY ct.master_owner_id, ct.to_phone_number, (COALESCE(ct.updated_at, ct.created_at)) DESC NULLS LAST, ct.id DESC
        ), workflow_by_thread AS (
         SELECT DISTINCT ON (wr.conversation_thread_id) wr.conversation_thread_id,
            wr.id
           FROM workflow_runs wr
          WHERE wr.conversation_thread_id IS NOT NULL
          ORDER BY wr.conversation_thread_id, (COALESCE(wr.updated_at, wr.created_at)) DESC NULLS LAST, wr.id DESC
        ), workflow_by_identity AS (
         SELECT DISTINCT ON (wr.property_id, wr.master_owner_id, wr.prospect_id) wr.property_id,
            wr.master_owner_id,
            wr.prospect_id,
            wr.id
           FROM workflow_runs wr
          WHERE wr.property_id IS NOT NULL AND wr.master_owner_id IS NOT NULL AND wr.prospect_id IS NOT NULL
          ORDER BY wr.property_id, wr.master_owner_id, wr.prospect_id, (COALESCE(wr.updated_at, wr.created_at)) DESC NULLS LAST, wr.id DESC
        ), active_sms_suppression AS (
         SELECT DISTINCT ON (ssl.phone_e164) ssl.phone_e164,
            ssl.id
           FROM sms_suppression_list ssl
          WHERE ssl.is_active = true AND ssl.phone_e164 IS NOT NULL
          ORDER BY ssl.phone_e164, (COALESCE(ssl.suppressed_at, ssl.created_at)) DESC NULLS LAST, ssl.id DESC
        ), outreach_by_owner_phone AS (
         SELECT DISTINCT ON (cos.podio_master_owner_id, cos.canonical_e164) cos.podio_master_owner_id,
            cos.canonical_e164,
            cos.id
           FROM contact_outreach_state cos
          WHERE cos.podio_master_owner_id IS NOT NULL AND cos.canonical_e164 IS NOT NULL
          ORDER BY cos.podio_master_owner_id, cos.canonical_e164, (COALESCE(cos.updated_at, cos.created_at)) DESC NULLS LAST, cos.id DESC
        ), contact_threads_by_property_owner AS (
         SELECT its.property_id,
            its.master_owner_id,
            jsonb_agg(jsonb_strip_nulls(jsonb_build_object('thread_key', its.thread_key, 'conversation_thread_id', its.thread_key, 'prospect_id', its.prospect_id, 'canonical_e164', COALESCE(NULLIF(its.canonical_e164, ''::text), NULLIF(its.seller_phone, ''::text)), 'status', its.status, 'stage', its.stage, 'latest_message_at', its.latest_message_at, 'latest_direction', its.latest_direction, 'message_count', its.message_count, 'is_archived', its.is_archived, 'is_suppressed', its.is_suppressed)) ORDER BY (COALESCE(its.latest_message_at, its.updated_at)) DESC NULLS LAST, its.id DESC) AS threads
           FROM inbox_thread_state its
          WHERE its.property_id IS NOT NULL AND its.master_owner_id IS NOT NULL
          GROUP BY its.property_id, its.master_owner_id
        ), operational_joined AS (
         SELECT cg.key_property_export_id,
            cg.key_property_id,
            cg.resolved_master_owner_id,
            cg.key_prospect_id,
            cg.key_phone_id,
            cg.key_email_id,
            cg.owner_resolution_source,
            cg.contact_channel_type,
            cg.contact_channel_value,
            cg.p,
            cg.g,
            cg.mo,
            cg.pr,
            cg.ph,
            cg.em,
            its.*::inbox_thread_state AS its,
            me.*::message_events AS me,
            dts.*::deal_thread_state AS dts,
            tas.*::thread_ai_state AS tas,
            sq.*::send_queue AS sq,
            ct.*::campaign_targets AS ct,
            c.*::campaigns AS c,
            wr.*::workflow_runs AS wr,
            w.*::workflows AS w,
            ws.*::workflow_steps AS ws,
            ssl.*::sms_suppression_list AS ssl,
            cos.*::contact_outreach_state AS cos,
            COALESCE(cts.threads, '[]'::jsonb) AS contact_threads
           FROM contact_grain cg
             LEFT JOIN thread_by_property_phone tpp ON cg.contact_channel_type = 'phone'::text AND tpp.property_id = (cg.p).property_id AND tpp.contact_e164 = cg.contact_channel_value
             LEFT JOIN thread_by_prospect_phone tpr ON cg.contact_channel_type = 'phone'::text AND tpp.id IS NULL AND tpr.prospect_id = (cg.pr).prospect_id AND tpr.contact_e164 = cg.contact_channel_value
             LEFT JOIN thread_by_owner_phone top ON cg.contact_channel_type = 'phone'::text AND tpp.id IS NULL AND tpr.id IS NULL AND top.master_owner_id = cg.resolved_master_owner_id AND top.contact_e164 = cg.contact_channel_value
             LEFT JOIN inbox_thread_state its ON its.id = COALESCE(tpp.id, tpr.id, top.id)
             LEFT JOIN latest_message_by_thread lmb ON lmb.thread_key = its.thread_key
             LEFT JOIN message_events me ON me.id = COALESCE(its.latest_message_event_id, lmb.id)
             LEFT JOIN deal_thread_state dts ON dts.thread_key = its.thread_key
             LEFT JOIN thread_ai_state tas ON tas.thread_key = its.thread_key
             LEFT JOIN queue_by_thread qbt ON qbt.thread_key = its.thread_key
             LEFT JOIN queue_by_property_phone qbpp ON cg.contact_channel_type = 'phone'::text AND qbt.id IS NULL AND qbpp.property_id = (cg.p).property_id AND qbpp.to_phone_number::text = cg.contact_channel_value
             LEFT JOIN queue_by_owner_phone qbop ON cg.contact_channel_type = 'phone'::text AND qbt.id IS NULL AND qbpp.id IS NULL AND qbop.master_owner_id = cg.resolved_master_owner_id AND qbop.to_phone_number::text = cg.contact_channel_value
             LEFT JOIN send_queue sq ON sq.id = COALESCE(qbt.id, qbpp.id, qbop.id)
             LEFT JOIN target_by_property_phone tbpp ON cg.contact_channel_type = 'phone'::text AND tbpp.property_id = (cg.p).property_id AND tbpp.to_phone_number = cg.contact_channel_value
             LEFT JOIN target_by_owner_phone tbop ON cg.contact_channel_type = 'phone'::text AND tbpp.id IS NULL AND tbop.master_owner_id = cg.resolved_master_owner_id AND tbop.to_phone_number = cg.contact_channel_value
             LEFT JOIN campaign_targets ct ON ct.id = COALESCE(sq.campaign_target_id, tbpp.id, tbop.id)
             LEFT JOIN campaigns c ON c.id = COALESCE(sq.campaign_id, ct.campaign_id)
             LEFT JOIN workflow_by_thread wbt ON wbt.conversation_thread_id = its.thread_key
             LEFT JOIN workflow_by_identity wbi ON wbt.id IS NULL AND wbi.property_id = (cg.p).property_id AND wbi.master_owner_id = cg.resolved_master_owner_id AND wbi.prospect_id = (cg.pr).prospect_id
             LEFT JOIN workflow_runs wr ON wr.id = COALESCE(wbt.id, wbi.id)
             LEFT JOIN workflows w ON w.id = wr.workflow_id
             LEFT JOIN workflow_steps ws ON ws.id = wr.current_step_id
             LEFT JOIN active_sms_suppression ass ON cg.contact_channel_type = 'phone'::text AND ass.phone_e164 = cg.contact_channel_value
             LEFT JOIN sms_suppression_list ssl ON ssl.id = ass.id
             LEFT JOIN outreach_by_owner_phone obop ON cg.contact_channel_type = 'phone'::text AND obop.podio_master_owner_id = cg.resolved_master_owner_id AND obop.canonical_e164 = cg.contact_channel_value
             LEFT JOIN contact_outreach_state cos ON cos.id = obop.id
             LEFT JOIN contact_threads_by_property_owner cts ON cts.property_id = (cg.p).property_id AND cts.master_owner_id = cg.resolved_master_owner_id
        ), resolved AS (
         SELECT oj.key_property_export_id,
            oj.key_property_id,
            oj.resolved_master_owner_id,
            oj.key_prospect_id,
            oj.key_phone_id,
            oj.key_email_id,
            oj.owner_resolution_source,
            oj.contact_channel_type,
            oj.contact_channel_value,
            oj.p,
            oj.g,
            oj.mo,
            oj.pr,
            oj.ph,
            oj.em,
            oj.its,
            oj.me,
            oj.dts,
            oj.tas,
            oj.sq,
            oj.ct,
            oj.c,
            oj.wr,
            oj.w,
            oj.ws,
            oj.ssl,
            oj.cos,
            oj.contact_threads,
            COALESCE((oj.me).event_timestamp, (oj.me).received_at, (oj.me).sent_at, (oj.me).delivered_at, (oj.me).created_at, (oj.its).latest_message_at) AS resolved_latest_message_at,
            COALESCE((oj.me).message_body, (oj.its).latest_message_body) AS resolved_latest_message_body,
            COALESCE((oj.me).direction, (oj.its).latest_direction) AS resolved_latest_direction,
            COALESCE(NULLIF((oj.dts).reply_intent, ''::text), NULLIF((oj.me).detected_intent, ''::text), NULLIF((oj.its).last_intent, ''::text), NULLIF((oj.me).metadata ->> 'intent'::text, ''::text), NULLIF((oj.its).metadata ->> 'reply_intent'::text, ''::text)) AS resolved_reply_intent,
            COALESCE((oj.dts).universal_status, (oj.its).status) AS resolved_universal_status,
            COALESCE((oj.dts).universal_stage, (oj.its).stage, (oj.sq).pipeline_stage, (oj.sq).current_stage) AS resolved_universal_stage,
            COALESCE((oj.dts).lead_temperature, (oj.tas).deal_temperature,
                CASE
                    WHEN COALESCE((oj.its).is_hot_lead, false) THEN 'hot'::text
                    WHEN (oj.its).last_inbound_at IS NOT NULL THEN 'warm'::text
                    ELSE 'cold'::text
                END) AS resolved_lead_temperature,
            COALESCE((oj.dts).inbox_bucket,
                CASE
                    WHEN COALESCE((oj.its).is_suppressed, false) OR (oj.ssl).phone_e164 IS NOT NULL OR COALESCE((oj.cos).dnc, false) THEN 'suppressed'::text
                    WHEN COALESCE((oj.its).is_archived, false) THEN 'archived'::text
                    WHEN COALESCE((oj.its).is_pinned, false) OR COALESCE((oj.its).is_starred, false) THEN 'priority'::text
                    WHEN lower(COALESCE((oj.its).latest_direction, ''::text)) ~~ 'in%'::text THEN 'new_replies'::text
                    ELSE 'cold'::text
                END) AS resolved_inbox_bucket
           FROM operational_joined oj
        ), finalized AS (
         SELECT r.key_property_export_id,
            r.key_property_id,
            r.resolved_master_owner_id,
            r.key_prospect_id,
            r.key_phone_id,
            r.key_email_id,
            r.owner_resolution_source,
            r.contact_channel_type,
            r.contact_channel_value,
            r.p,
            r.g,
            r.mo,
            r.pr,
            r.ph,
            r.em,
            r.its,
            r.me,
            r.dts,
            r.tas,
            r.sq,
            r.ct,
            r.c,
            r.wr,
            r.w,
            r.ws,
            r.ssl,
            r.cos,
            r.contact_threads,
            r.resolved_latest_message_at,
            r.resolved_latest_message_body,
            r.resolved_latest_direction,
            r.resolved_reply_intent,
            r.resolved_universal_status,
            r.resolved_universal_stage,
            r.resolved_lead_temperature,
            r.resolved_inbox_bucket,
            concat_ws('|'::text, r.key_property_export_id, r.resolved_master_owner_id, r.key_prospect_id, r.contact_channel_type, r.contact_channel_value) AS resolved_grain_key,
            r.resolved_reply_intent = 'ownership_confirmed'::text OR ((r.me).metadata ->> 'intent'::text) = 'ownership_confirmed'::text OR ((r.its).metadata ->> 'reply_intent'::text) = 'ownership_confirmed'::text AS resolved_ownership_confirmed,
            r.contact_channel_type = 'phone'::text AND ((r.ph).wrong_number_at IS NOT NULL OR lower(COALESCE((r.ph).phone_contact_status, ''::text)) = 'wrong_number'::text) AS resolved_wrong_number,
            r.contact_channel_type = 'phone'::text AND (r.ssl).phone_e164 IS NOT NULL AND (r.ssl).suppression_type = 'opt_out'::text AS resolved_opt_out,
            r.contact_channel_type = 'phone'::text AND (COALESCE((r.cos).dnc, false) OR (r.ssl).phone_e164 IS NOT NULL) AS resolved_do_not_contact,
            COALESCE(NULLIF((r.its).next_action, ''::text), NULLIF((r.tas).next_best_action, ''::text),
                CASE
                    WHEN COALESCE((r.its).is_suppressed, false) OR (r.ssl).phone_e164 IS NOT NULL OR COALESCE((r.cos).dnc, false) THEN 'none'::text
                    WHEN (r.its).follow_up_at IS NOT NULL THEN 'follow_up'::text
                    WHEN lower(COALESCE(r.resolved_latest_direction, ''::text)) ~~ 'in%'::text THEN 'respond'::text
                    WHEN r.contact_channel_type = 'phone'::text THEN 'start_outreach'::text
                    ELSE 'review_email_outreach'::text
                END) AS resolved_next_action
           FROM resolved r
        )
 SELECT md5(resolved_grain_key) AS command_id,
    resolved_grain_key AS grain_key,
    key_property_export_id AS property_export_id,
    key_property_id AS property_id,
    resolved_master_owner_id AS master_owner_id,
    key_prospect_id AS prospect_id,
    (pr).canonical_prospect_id AS canonical_prospect_id,
    (pr).master_key AS master_key,
    (mo).owner_cluster_key AS owner_cluster_key,
    (mo).household_key AS household_key,
    contact_channel_type,
    contact_channel_value,
    key_phone_id AS phone_id,
    key_email_id AS email_id,
    (its).thread_key AS thread_key,
    (its).thread_key AS conversation_thread_id,
    (ct).id AS campaign_target_id,
    (sq).id AS queue_id,
    COALESCE((me).id, (its).latest_message_event_id) AS latest_message_event_id,
    owner_resolution_source,
    key_prospect_id AS resolved_prospect_id,
    (pr).full_name AS resolved_prospect_name,
    key_phone_id AS resolved_phone_id,
    key_email_id AS resolved_email_id,
        CASE
            WHEN contact_channel_type = 'phone'::text THEN 'phones.linked_prospect_ids_json'::text
            ELSE 'emails.linked_prospect_ids_json'::text
        END AS resolution_source,
    1.00 AS resolution_confidence,
    (pr).full_name AS full_name,
    (pr).first_name AS first_name,
    (pr).language_preference AS language,
    (pr).gender AS gender,
    (pr).marital_status AS marital_status,
    (pr).education_model AS education_model,
    (pr).occupation_group AS occupation_group,
    (pr).occupation_code AS occupation_code,
    (pr).est_household_income AS estimated_household_income,
    (pr).net_asset_value AS net_asset_value,
    (pr).buying_power AS buying_power,
    (pr).mob AS mob,
    NULL::text AS birth_year_month,
    NULL::integer AS calculated_age,
    (pr).matching_flags AS matching_flags,
    (pr).person_flags_text AS person_flags_text,
    (pr).sms_eligible AS sms_eligible,
    (pr).email_eligible AS email_eligible,
    (pr).best_phone AS best_phone,
    (pr).best_email AS best_email,
    (pr).contact_window AS contact_window,
    (pr).timezone AS timezone,
    (p).property_address_full AS property_address_full,
    (p).market AS market,
    (p).property_type AS property_type,
    (p).estimated_value AS estimated_value,
    (p).equity_amount AS equity_amount,
    (p).equity_percent AS equity_percent,
    (p).total_loan_balance AS total_loan_balance,
    (p).total_loan_payment AS total_loan_payment,
    (p).tax_amt AS tax_amount,
    (p).sale_date AS sale_date,
    (p).sale_price AS sale_price,
    (p).units_count AS units_count,
    (p).tax_delinquent AS tax_delinquent,
    (p).tax_delinquent_year AS tax_delinquent_year,
    (p).active_lien AS active_lien,
    (p).ownership_years AS ownership_years,
    (p).last_sale_doc_type AS last_sale_doc_type,
    (p).apn_parcel_id AS apn_parcel_id,
    (p).property_address AS property_address,
    (p).property_address_city AS property_address_city,
    (p).property_address_county_name AS property_address_county_name,
    (p).property_address_state AS property_address_state,
    (p).property_address_zip AS property_address_zip,
    (p).property_class AS property_class,
    NULL::numeric AS total_loan_amount,
    (p).tax_year AS tax_year,
    (p).building_square_feet AS building_square_feet,
    (p).document_type AS document_type,
    (p).recording_date AS recording_date,
    (p).default_date AS default_date,
    (p).year_built AS year_built,
    (p).effective_year_built AS effective_year_built,
    (p).total_baths AS total_baths,
    (p).total_bedrooms AS total_bedrooms,
    (p).lot_acreage AS lot_acreage,
    (p).lot_square_feet AS lot_square_feet,
    (p).latitude AS latitude,
    (p).longitude AS longitude,
    (p).air_conditioning AS air_conditioning,
    (p).basement AS basement,
    (p).building_condition AS building_condition,
    (p).building_quality AS building_quality,
    (p).construction_type AS construction_type,
    (p).exterior_walls AS exterior_walls,
    (p).floor_cover AS floor_cover,
    (p).garage AS garage,
    (p).heating_fuel_type AS heating_fuel_type,
    (p).heating_type AS heating_type,
    (p).interior_walls AS interior_walls,
    (p).pool AS pool,
    (p).porch AS porch,
    (p).patio AS patio,
    (p).deck AS deck,
    (p).driveway AS driveway,
    (p).roof_cover AS roof_cover,
    (p).roof_type AS roof_type,
    (p).sewer AS sewer,
    (p).water AS water,
    (p).zoning AS zoning,
    (p).legal_description AS legal_description,
    (p).school_district_name AS school_district_name,
    (p).subdivision_name AS subdivision_name,
    (p).flood_zone AS flood_zone,
    (p).hoa1_name AS hoa_one_name,
    (p).hoa1_type AS hoa_one_type,
    (p).hoa_fee_amount AS hoa_fee_amount,
    (p).property_flags_text AS property_flags_text,
    (p).search_profile_hash AS search_profile_hash,
    (p).sqft_range AS square_foot_range,
    (p).avg_sqft_per_unit AS average_square_foot_per_unit,
    (p).beds_per_unit AS beds_per_unit,
    (p).rehab_level AS rehab_level,
    (p).structured_motivation_score AS structured_motivation_score,
    (p).deal_strength_score AS deal_strength_score,
    (p).tag_distress_score AS tag_distress_score,
    (p).final_acquisition_score AS final_acquisition_score,
    NULL::integer AS assessment_year,
    (p).calculated_improvement_value AS calculated_improvement_value,
    (p).calculated_land_value AS calculated_land_value,
    (p).calculated_total_value AS calculated_total_value,
    (p).num_of_fireplaces AS number_of_fireplaces,
    (p).past_due_amount AS past_due_amount,
    (p).stories AS stories,
    (p).style AS style,
    (p).topography AS topography,
    (p).sum_buildings_nbr AS sum_buildings,
    (p).sum_commercial_units AS sum_commercial_units,
    (p).sum_garage_sqft AS sum_garage_square_feet,
    (p).estimated_repair_cost AS estimated_repair_cost,
    (p).other_rooms AS other_rooms,
    (mo).display_name AS display_name,
    (mo).primary_owner_address AS primary_owner_address,
    (mo).owner_type_guess AS owner_type_guess,
    (mo).owner_location_text AS owner_location,
    (mo).best_channel AS best_channel,
    (mo).best_language AS best_language,
    (mo).financial_pressure_score AS financial_pressure_score,
    (mo).urgency_score AS urgency_score,
    (mo).priority_score AS priority_score,
    (mo).priority_tier AS priority_tier,
    (mo).best_phone_1 AS best_phone_1,
    (mo).best_phone_2 AS best_phone_2,
    (mo).best_phone_3 AS best_phone_3,
    (mo).best_email_1 AS best_email_1,
    (mo).best_email_2 AS best_email_2,
    (mo).portfolio_total_value AS portfolio_total_value,
    (mo).portfolio_total_equity AS portfolio_total_equity,
    (mo).portfolio_total_loan_balance AS portfolio_total_loan_balance,
    (mo).portfolio_total_loan_payment AS portfolio_total_loan_payment,
    (mo).portfolio_total_tax_amount AS portfolio_total_tax_amount,
    (mo).portfolio_total_units AS portfolio_total_units,
    (mo).property_count AS property_count,
    (mo).tax_delinquent_count AS tax_delinquent_count,
    (mo).oldest_tax_delinquent_year AS oldest_tax_delinquent_year,
    (mo).active_lien_count AS active_lien_count,
    (ph).phone AS phone_number,
    (ph).phone_raw AS phone_raw,
    (ph).canonical_e164 AS canonical_e164,
    (ph).phone_owner AS phone_owner,
    (ph).activity_status AS phone_activity_status,
    (ph).usage_12_months AS usage_12_months,
    (ph).usage_2_months AS usage_2_months,
    (ph).sort_rank AS phone_rank,
    NULL::boolean AS phone_confirmed,
    (ph).phone_contact_status AS phone_status,
        CASE
            WHEN contact_channel_type = 'phone'::text THEN resolved_wrong_number
            ELSE NULL::boolean
        END AS wrong_number,
        CASE
            WHEN contact_channel_type = 'phone'::text THEN resolved_opt_out
            ELSE NULL::boolean
        END AS opt_out,
        CASE
            WHEN contact_channel_type = 'phone'::text THEN resolved_do_not_contact
            ELSE NULL::boolean
        END AS do_not_contact,
    (em).email AS email,
    (em).email_linkage_score_raw AS email_linkage_score_raw,
    (em).email_score_final AS email_score_final,
    (em).email_rank AS email_rank,
    NULL::boolean AS email_confirmed,
    NULL::text AS email_status,
    resolved_inbox_bucket AS inbox_bucket,
    resolved_universal_status AS universal_status,
    resolved_universal_stage AS universal_stage,
    resolved_lead_temperature AS lead_temperature,
    resolved_reply_intent AS reply_intent,
    resolved_ownership_confirmed AS ownership_confirmed,
    COALESCE((its).is_pinned, false) AS is_pinned,
    COALESCE((its).is_starred, false) AS is_starred,
    COALESCE((its).is_archived, false) AS is_archived,
    COALESCE((its).is_suppressed, false) OR resolved_do_not_contact AS is_suppressed,
    (its).last_outbound_at AS last_outbound_at,
    (its).last_inbound_at AS last_inbound_at,
    resolved_latest_message_body AS latest_message_body,
    resolved_latest_message_at AS latest_message_at,
    COALESCE((its).message_count, 0) AS message_count,
    COALESCE((its).inbound_count, 0) AS inbound_count,
    COALESCE((its).outbound_count, 0) AS outbound_count,
    COALESCE((dts).unread_count, 0) AS unread_count,
    resolved_next_action AS next_action,
    (its).follow_up_at AS next_follow_up_at,
    (c).id AS campaign_id,
    COALESCE((c).name, (ct).campaign_name) AS campaign_name,
    (c).status AS campaign_status,
    (ct).target_status AS target_status,
    (sq).queue_status AS queue_status,
    (sq).scheduled_for AS scheduled_for,
    (sq).from_phone_number AS sender_phone,
    (sq).template_id AS template_id,
    (me).message_variant AS message_variant,
    (sq).created_at AS last_queued_at,
    (sq).sent_at AS last_sent_at,
    (sq).delivered_at AS last_delivered_at,
        CASE
            WHEN (sq).queue_status = ANY (ARRAY['failed'::text, 'failed_transport'::text]) THEN (sq).updated_at
            ELSE NULL::timestamp with time zone
        END AS last_failed_at,
    COALESCE(NULLIF((sq).failed_reason, ''::text), NULLIF((sq).blocked_reason, ''::text), NULLIF((sq).guard_reason, ''::text)) AS latest_failure_reason,
    (wr).workflow_id AS assigned_workflow_id,
    (w).name AS assigned_workflow_name,
    COALESCE((ws).label, (ws).step_key) AS workflow_step,
    (wr).status AS workflow_status,
    (me).auto_reply_status AS auto_reply_status,
        CASE
            WHEN (w).workflow_type = 'follow_up'::text THEN (wr).status
            ELSE NULL::text
        END AS follow_up_sequence_status,
    (tas).current_stage AS ai_conversation_state,
    (tas).ai_summary AS ai_summary,
    (tas).next_best_action AS ai_next_action,
    COALESCE((tas).last_ai_analysis_at, (tas).updated_at) AS ai_last_updated_at,
    NULL::text AS offer_status,
    (tas).asking_price AS seller_asking_price,
    (tas).last_offer AS offer_price,
    NULL::text AS contract_status,
    NULL::text AS closing_status,
    NULL::text AS deal_status,
    (sq).pipeline_stage AS pipeline_stage,
    jsonb_strip_nulls(jsonb_build_object('property_export_id', (p).property_export_id, 'property_id', (p).property_id, 'address_full', (p).property_address_full, 'market', (p).market, 'property_type', (p).property_type, 'estimated_value', (p).estimated_value, 'equity_amount', (p).equity_amount, 'latitude', (p).latitude, 'longitude', (p).longitude)) AS property_entity,
    jsonb_strip_nulls(jsonb_build_object('master_owner_id', (mo).master_owner_id, 'master_key', (mo).master_key, 'owner_cluster_key', (mo).owner_cluster_key, 'household_key', (mo).household_key, 'display_name', (mo).display_name, 'priority_score', (mo).priority_score, 'priority_tier', (mo).priority_tier)) AS master_owner_entity,
    jsonb_strip_nulls(jsonb_build_object('prospect_id', (pr).prospect_id, 'canonical_prospect_id', (pr).canonical_prospect_id, 'full_name', (pr).full_name, 'first_name', (pr).first_name, 'language', (pr).language_preference, 'rank_position', (pr).rank_position)) AS prospect_entity,
        CASE
            WHEN contact_channel_type = 'phone'::text THEN jsonb_strip_nulls(jsonb_build_object('phone_id', (ph).phone_id, 'phone_number', (ph).phone, 'canonical_e164', (ph).canonical_e164, 'phone_owner', (ph).phone_owner, 'activity_status', (ph).activity_status, 'phone_rank', (ph).sort_rank, 'wrong_number', resolved_wrong_number, 'opt_out', resolved_opt_out, 'do_not_contact', resolved_do_not_contact))
            ELSE '{}'::jsonb
        END AS phone_entity,
        CASE
            WHEN contact_channel_type = 'email'::text THEN jsonb_strip_nulls(jsonb_build_object('email_id', (em).email_id, 'email', (em).email, 'email_linkage_score_raw', (em).email_linkage_score_raw, 'email_score_final', (em).email_score_final, 'email_rank', (em).email_rank))
            ELSE '{}'::jsonb
        END AS email_entity,
    jsonb_strip_nulls(jsonb_build_object('thread_key', (its).thread_key, 'conversation_thread_id', (its).thread_key, 'status', (its).status, 'stage', (its).stage, 'inbox_bucket', resolved_inbox_bucket, 'universal_status', resolved_universal_status, 'universal_stage', resolved_universal_stage, 'lead_temperature', resolved_lead_temperature, 'reply_intent', resolved_reply_intent, 'message_count', (its).message_count, 'unread_count', (dts).unread_count)) AS thread_entity,
    jsonb_strip_nulls(jsonb_build_object('latest_message_event_id', COALESCE((me).id, (its).latest_message_event_id), 'latest_message_at', resolved_latest_message_at, 'latest_message_body', resolved_latest_message_body, 'direction', resolved_latest_direction, 'event_type', COALESCE((me).event_type, (its).latest_event_type), 'delivery_status', COALESCE((me).delivery_status, (its).latest_delivery_status))) AS message_summary,
    jsonb_strip_nulls(jsonb_build_object('queue_id', (sq).id, 'queue_status', (sq).queue_status, 'scheduled_for', (sq).scheduled_for, 'last_queued_at', (sq).created_at, 'last_sent_at', (sq).sent_at, 'last_delivered_at', (sq).delivered_at, 'failure_reason', COALESCE(NULLIF((sq).failed_reason, ''::text), NULLIF((sq).blocked_reason, ''::text), NULLIF((sq).guard_reason, ''::text)))) AS queue_summary,
    jsonb_strip_nulls(jsonb_build_object('campaign_id', (c).id, 'campaign_name', COALESCE((c).name, (ct).campaign_name), 'campaign_status', (c).status, 'campaign_target_id', (ct).id, 'target_status', (ct).target_status, 'graph_id', (g).graph_id, 'graph_source', (g).graph_source, 'graph_generated_at', (g).generated_at)) AS campaign_summary,
    jsonb_strip_nulls(jsonb_build_object('pipeline_stage', (sq).pipeline_stage, 'seller_asking_price', (tas).asking_price, 'offer_price', (tas).last_offer, 'estimated_value', (p).estimated_value, 'final_acquisition_score', (p).final_acquisition_score, 'deal_strength_score', (p).deal_strength_score)) AS pipeline_summary,
    jsonb_strip_nulls(jsonb_build_object('universal_status', resolved_universal_status, 'universal_stage', resolved_universal_stage, 'lead_temperature', resolved_lead_temperature, 'inbox_bucket', resolved_inbox_bucket, 'priority_score', (mo).priority_score, 'is_pinned', COALESCE((its).is_pinned, false), 'is_starred', COALESCE((its).is_starred, false), 'is_archived', COALESCE((its).is_archived, false), 'is_suppressed', COALESCE((its).is_suppressed, false) OR resolved_do_not_contact, 'next_action', resolved_next_action, 'next_follow_up_at', (its).follow_up_at)) AS universal_state,
    jsonb_build_object('thread_count', jsonb_array_length(contact_threads), 'threads', contact_threads) AS contact_threads,
    jsonb_array_length(contact_threads) AS contact_thread_count,
    GREATEST(COALESCE((p).updated_at, (p).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((mo).updated_at, (mo).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((pr).updated_at, (pr).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((ph).updated_at, (ph).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((em).updated_at, (em).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((its).updated_at, (its).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((sq).updated_at, (sq).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((ct).updated_at, (ct).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((wr).updated_at, (wr).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE((tas).updated_at, (tas).created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE(resolved_latest_message_at, '1970-01-01 00:00:00+00'::timestamp with time zone)) AS command_updated_at
   FROM finalized f;