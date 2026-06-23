-- Migration: 20260525220000_sms_campaign_architecture.sql
-- Description: Implement safe schema additions and functions for campaign architecture matching live db state

-- 1) Safely add columns to sms_campaigns
CREATE TABLE IF NOT EXISTS public.sms_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.sms_campaigns
    ADD COLUMN IF NOT EXISTS campaign_name TEXT,
    ADD COLUMN IF NOT EXISTS source_view TEXT,
    ADD COLUMN IF NOT EXISTS market TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft',
    ADD COLUMN IF NOT EXISTS send_interval_seconds INT DEFAULT 15,
    ADD COLUMN IF NOT EXISTS send_window TEXT DEFAULT '09:00-17:00',
    ADD COLUMN IF NOT EXISTS template_use_case TEXT,
    ADD COLUMN IF NOT EXISTS stage TEXT;

-- 2) Safely add columns to sms_campaign_targets
CREATE TABLE IF NOT EXISTS public.sms_campaign_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.sms_campaign_targets
    ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES public.sms_campaigns(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS master_owner_id TEXT,
    ADD COLUMN IF NOT EXISTS property_id TEXT,
    ADD COLUMN IF NOT EXISTS phone_id TEXT,
    ADD COLUMN IF NOT EXISTS canonical_e164 TEXT,
    ADD COLUMN IF NOT EXISTS property_address_full TEXT,
    ADD COLUMN IF NOT EXISTS property_address_city TEXT,
    ADD COLUMN IF NOT EXISTS property_address_state TEXT,
    ADD COLUMN IF NOT EXISTS property_address_zip TEXT,
    ADD COLUMN IF NOT EXISTS market TEXT,
    ADD COLUMN IF NOT EXISTS timezone TEXT,
    ADD COLUMN IF NOT EXISTS best_language TEXT,
    ADD COLUMN IF NOT EXISTS agent_persona TEXT,
    ADD COLUMN IF NOT EXISTS agent_family TEXT,
    ADD COLUMN IF NOT EXISTS final_acquisition_score NUMERIC,
    ADD COLUMN IF NOT EXISTS cash_offer NUMERIC,
    ADD COLUMN IF NOT EXISTS estimated_value NUMERIC,
    ADD COLUMN IF NOT EXISTS equity_percent NUMERIC,
    ADD COLUMN IF NOT EXISTS target_status TEXT DEFAULT 'ready',
    ADD COLUMN IF NOT EXISTS queue_row_id UUID,
    ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS positive_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS negative_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS wrong_number_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_sms_campaign_targets_campaign_id ON public.sms_campaign_targets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_sms_campaign_targets_status ON public.sms_campaign_targets(target_status);
CREATE INDEX IF NOT EXISTS idx_sms_campaign_targets_canonical_e164 ON public.sms_campaign_targets(canonical_e164);
CREATE INDEX IF NOT EXISTS idx_sms_campaign_targets_queue_row_id ON public.sms_campaign_targets(queue_row_id);

-- Ensure standard updated_at triggers
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sms_campaigns_updated_at') THEN
        CREATE TRIGGER trg_sms_campaigns_updated_at
        BEFORE UPDATE ON public.sms_campaigns
        FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sms_campaign_targets_updated_at') THEN
        CREATE TRIGGER trg_sms_campaign_targets_updated_at
        BEFORE UPDATE ON public.sms_campaign_targets
        FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    END IF;
EXCEPTION WHEN undefined_function THEN
END $$;

-- 3) Target Generation
CREATE OR REPLACE FUNCTION public.build_campaign_targets(p_campaign_id UUID)
RETURNS VOID AS $$
DECLARE
    v_campaign RECORD;
BEGIN
    SELECT * INTO v_campaign FROM public.sms_campaigns WHERE id = p_campaign_id;
    IF NOT FOUND THEN RETURN; END IF;

    -- Insert deduped targets into sms_campaign_targets
    WITH candidates AS (
        SELECT 
            master_owner_id::text, 
            property_id::text, 
            phone_id::text, 
            canonical_e164, 
            property_address_full,
            property_address_city,
            property_address_state,
            property_address_zip,
            market, 
            timezone, 
            best_language, 
            agent_persona,
            agent_family,
            final_acquisition_score,
            cash_offer,
            estimated_value,
            equity_percent,
            pr.matching_flags,
            pr.person_flags_json,
            ROW_NUMBER() OVER(PARTITION BY canonical_e164 ORDER BY final_acquisition_score DESC NULLS LAST) as rn
        FROM public.v_sms_ready_contacts v
        LEFT JOIN public.prospects pr ON pr.prospect_id::text = v.master_owner_id
        WHERE canonical_e164 IS NOT NULL
          AND master_owner_id IS NOT NULL
          AND property_id IS NOT NULL
          -- Filter by campaign market if specified
          AND (v_campaign.market IS NULL OR v_campaign.market = '' OR v.market = v_campaign.market)
          -- Exclude active sms_suppression_list
          AND NOT EXISTS (
              SELECT 1 FROM public.sms_suppression_list s
              WHERE (s.phone_e164 = v.canonical_e164 OR s.phone_number = v.canonical_e164)
                AND s.is_active = true
          )
          -- Exclude phones already queued/scheduled/sent/delivered in an active campaign
          AND NOT EXISTS (
              SELECT 1 FROM public.sms_campaign_targets t
              JOIN public.sms_campaigns c ON c.id = t.campaign_id
              WHERE t.canonical_e164 = v.canonical_e164
                AND c.status = 'active'
                AND t.target_status IN ('scheduled', 'queued', 'sent', 'delivered', 'ready')
          )
          -- Exclude recent send_queue contacts (e.g. within 30 days)
          AND NOT EXISTS (
              SELECT 1 FROM public.send_queue sq
              WHERE sq.to_phone_number = v.canonical_e164
                AND sq.created_at >= now() - interval '30 days'
                AND sq.queue_status NOT IN ('failed', 'cancelled')
          )
    )
    INSERT INTO public.sms_campaign_targets (
        campaign_id, master_owner_id, property_id, phone_id, canonical_e164,
        property_address_full, property_address_city, property_address_state, property_address_zip,
        market, timezone, best_language, agent_persona, agent_family,
        final_acquisition_score, cash_offer, estimated_value, equity_percent, target_status, metadata
    )
    SELECT 
        p_campaign_id, master_owner_id, property_id, phone_id, canonical_e164,
        property_address_full, property_address_city, property_address_state, property_address_zip,
        market, timezone, best_language, agent_persona, agent_family,
        final_acquisition_score, cash_offer, estimated_value, equity_percent, 'ready',
        jsonb_build_object(
            'source', 'v_sms_ready_contacts',
            'matching_flags', matching_flags,
            'person_flags_json', person_flags_json
        )
    FROM candidates
    WHERE rn = 1;
END;
$$ LANGUAGE plpgsql;

-- 4) Schedule Targets (replaces direct queue creation)
CREATE OR REPLACE FUNCTION public.schedule_campaign_targets(p_campaign_id UUID, p_limit INT DEFAULT 50)
RETURNS VOID AS $$
DECLARE
    v_campaign RECORD;
    v_target RECORD;
    v_counter INT := 0;
BEGIN
    SELECT * INTO v_campaign FROM public.sms_campaigns WHERE id = p_campaign_id;
    IF NOT FOUND OR v_campaign.status != 'active' THEN RETURN; END IF;

    -- Schedule targets
    FOR v_target IN (
        SELECT id
        FROM public.sms_campaign_targets
        WHERE campaign_id = p_campaign_id
          AND target_status = 'ready'
        ORDER BY final_acquisition_score DESC NULLS LAST
        LIMIT p_limit
    ) LOOP
        UPDATE public.sms_campaign_targets
        SET target_status = 'scheduled',
            scheduled_for = now() + ((v_counter * COALESCE(v_campaign.send_interval_seconds, 15)) || ' seconds')::interval,
            updated_at = now()
        WHERE id = v_target.id;

        v_counter := v_counter + 1;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- 5) Trigger on send_queue for delivery/failure
CREATE OR REPLACE FUNCTION public.fn_sync_campaign_target_delivery()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.queue_status IS DISTINCT FROM NEW.queue_status THEN
        IF NEW.queue_status IN ('delivered', 'sent') THEN
            UPDATE public.sms_campaign_targets
            SET target_status = CASE WHEN NEW.queue_status = 'delivered' THEN 'delivered' ELSE 'sent' END,
                sent_at = CASE WHEN NEW.queue_status = 'sent' THEN COALESCE(NEW.sent_at, NEW.updated_at, now()) ELSE sent_at END,
                delivered_at = CASE WHEN NEW.queue_status = 'delivered' THEN COALESCE(NEW.delivered_at, NEW.updated_at, now()) ELSE delivered_at END,
                updated_at = now()
            WHERE queue_row_id = NEW.id;
        ELSIF NEW.queue_status IN ('failed', 'blocked', 'carrier_blocked', 'failed_transport', 'invalid_number') THEN
            UPDATE public.sms_campaign_targets
            SET target_status = 'failed',
                failed_at = COALESCE(NEW.updated_at, now()),
                metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{failure_reason}', to_jsonb(COALESCE(NEW.failed_reason, NEW.guard_reason, NEW.queue_status))),
                updated_at = now()
            WHERE queue_row_id = NEW.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_campaign_target_delivery ON public.send_queue;
CREATE TRIGGER trg_sync_campaign_target_delivery
AFTER UPDATE ON public.send_queue
FOR EACH ROW EXECUTE FUNCTION public.fn_sync_campaign_target_delivery();

-- 6) Trigger on message_events for inbound sync
CREATE OR REPLACE FUNCTION public.fn_sync_campaign_target_inbound()
RETURNS TRIGGER AS $$
DECLARE
    v_intent TEXT;
    v_positive BOOLEAN := false;
    v_negative BOOLEAN := false;
    v_optout BOOLEAN := false;
    v_wrong_number BOOLEAN := false;
    v_phone TEXT;
BEGIN
    IF NEW.direction ILIKE 'inbound' THEN
        -- Rely on Node API's existing classified fields
        v_intent := COALESCE(NEW.detected_intent, '');
        v_phone := COALESCE(NEW.from_phone_number, NEW.metadata->>'inbound_from', NEW.metadata->>'from');
        
        IF NEW.is_opt_out = true OR v_intent IN ('opt_out', 'stop') THEN
            v_optout := true;
        ELSIF v_intent IN ('wrong_number') THEN
            v_wrong_number := true;
        ELSIF v_intent IN ('ownership_confirmed', 'property_interest', 'seller_interested', 'asking_price_provided', 'interested', 'condition_disclosed') THEN
            v_positive := true;
        ELSIF v_intent IN ('not_interested', 'wrong_person') THEN
            v_negative := true;
        END IF;

        IF v_optout OR v_wrong_number OR v_positive OR v_negative THEN
            -- Update target matched by queue_id or canonical phone
            UPDATE public.sms_campaign_targets
            SET target_status = CASE 
                    WHEN v_wrong_number THEN 'wrong_number'
                    WHEN v_optout THEN 'opt_out'
                    WHEN v_positive THEN 'replied_positive'
                    WHEN v_negative THEN 'replied_negative'
                    ELSE target_status
                END,
                replied_at = COALESCE(NEW.timestamp, now()),
                positive_at = CASE WHEN v_positive THEN COALESCE(NEW.timestamp, now()) ELSE positive_at END,
                negative_at = CASE WHEN v_negative THEN COALESCE(NEW.timestamp, now()) ELSE negative_at END,
                opted_out_at = CASE WHEN v_optout THEN COALESCE(NEW.timestamp, now()) ELSE opted_out_at END,
                wrong_number_at = CASE WHEN v_wrong_number THEN COALESCE(NEW.timestamp, now()) ELSE wrong_number_at END,
                updated_at = now()
            WHERE id = (
                SELECT id FROM public.sms_campaign_targets
                WHERE (queue_row_id = NEW.queue_id AND NEW.queue_id IS NOT NULL)
                   OR (canonical_e164 = v_phone)
                ORDER BY created_at DESC LIMIT 1
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_campaign_target_inbound ON public.message_events;
CREATE TRIGGER trg_sync_campaign_target_inbound
AFTER INSERT OR UPDATE ON public.message_events
FOR EACH ROW EXECUTE FUNCTION public.fn_sync_campaign_target_inbound();

-- 7) KPI Query View
CREATE OR REPLACE VIEW public.v_sms_campaign_kpis AS
SELECT 
    c.id AS campaign_id,
    c.campaign_name,
    c.status,
    COUNT(t.id) AS total_targets,
    COUNT(*) FILTER (WHERE t.target_status = 'ready') AS ready,
    COUNT(*) FILTER (WHERE t.target_status = 'scheduled') AS scheduled,
    COUNT(*) FILTER (WHERE t.target_status = 'queued') AS queued,
    COUNT(*) FILTER (WHERE t.target_status IN ('sent', 'delivered', 'replied_positive', 'replied_negative', 'opt_out', 'wrong_number')) AS sent,
    COUNT(*) FILTER (WHERE t.target_status IN ('delivered', 'replied_positive', 'replied_negative', 'opt_out', 'wrong_number')) AS delivered,
    COUNT(*) FILTER (WHERE t.target_status = 'failed') AS failed,
    COUNT(*) FILTER (WHERE t.target_status IN ('replied_positive', 'replied_negative')) AS replies,
    COUNT(*) FILTER (WHERE t.target_status = 'replied_positive') AS positive_replies,
    COUNT(*) FILTER (WHERE t.target_status = 'replied_negative') AS negative_replies,
    COUNT(*) FILTER (WHERE t.target_status = 'opt_out') AS opt_outs,
    COUNT(*) FILTER (WHERE t.target_status = 'wrong_number') AS wrong_numbers,
    -- Rates
    ROUND((COUNT(*) FILTER (WHERE t.target_status IN ('delivered', 'replied_positive', 'replied_negative', 'opt_out', 'wrong_number'))::numeric / NULLIF(COUNT(*) FILTER (WHERE t.target_status IN ('sent', 'delivered', 'replied_positive', 'replied_negative', 'opt_out', 'wrong_number')), 0)) * 100, 2) AS delivery_rate,
    ROUND((COUNT(*) FILTER (WHERE t.target_status IN ('replied_positive', 'replied_negative'))::numeric / NULLIF(COUNT(*) FILTER (WHERE t.target_status IN ('delivered', 'replied_positive', 'replied_negative', 'opt_out', 'wrong_number')), 0)) * 100, 2) AS reply_rate,
    ROUND((COUNT(*) FILTER (WHERE t.target_status = 'replied_positive')::numeric / NULLIF(COUNT(*) FILTER (WHERE t.target_status IN ('delivered', 'replied_positive', 'replied_negative', 'opt_out', 'wrong_number')), 0)) * 100, 2) AS positive_reply_rate
FROM public.sms_campaigns c
LEFT JOIN public.sms_campaign_targets t ON c.id = t.campaign_id
GROUP BY c.id, c.campaign_name, c.status;
