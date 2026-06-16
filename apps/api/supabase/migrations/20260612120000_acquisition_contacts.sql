-- Supabase-native runtime state for the default acquisition automation engine.
-- All runtime switches are seeded disabled and must be explicitly enabled.

CREATE OR REPLACE FUNCTION public.acquisition_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.acquisition_contacts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone                 text        NOT NULL,
  canonical_e164        text        NOT NULL,
  property_id           text,
  master_owner_id       text,
  thread_id             text,
  campaign_id           text,
  current_stage         text        NOT NULL DEFAULT 'ownership_check',
  stage_updated_at      timestamptz NOT NULL DEFAULT now(),
  contact_temperature   text        NOT NULL DEFAULT 'cold',
  priority              text        NOT NULL DEFAULT 'normal',
  ownership_confirmed   boolean     NOT NULL DEFAULT false,
  is_opt_out            boolean     NOT NULL DEFAULT false,
  is_wrong_number       boolean     NOT NULL DEFAULT false,
  is_hostile            boolean     NOT NULL DEFAULT false,
  last_delivered_at     timestamptz,
  last_inbound_at       timestamptz,
  seller_asking_price   bigint,
  internal_target_price bigint,
  offer_ratio           numeric(8, 4),
  property_type         text,
  unit_count            integer,
  condition_summary     text,
  retry_count           integer     NOT NULL DEFAULT 0,
  tried_template_ids    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  next_followup_at      timestamptz,
  automation_status     text        NOT NULL DEFAULT 'active',
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acq_contacts_canonical_phone_check
    CHECK (canonical_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT acq_contacts_stage_check
    CHECK (current_stage IN (
      'ownership_check',
      'consider_selling',
      'asking_price',
      'condition',
      'offer_negotiation'
    )),
  CONSTRAINT acq_contacts_temperature_check
    CHECK (contact_temperature IN ('hot', 'warm', 'cool', 'cold', 'suppressed')),
  CONSTRAINT acq_contacts_priority_check
    CHECK (priority IN ('high', 'normal', 'low')),
  CONSTRAINT acq_contacts_retry_count_check
    CHECK (retry_count >= 0),
  CONSTRAINT acq_contacts_unit_count_check
    CHECK (unit_count IS NULL OR unit_count > 0)
);

-- Upgrade an earlier partial table definition without replacing the table.
ALTER TABLE public.acquisition_contacts
  ADD COLUMN IF NOT EXISTS canonical_e164        text,
  ADD COLUMN IF NOT EXISTS thread_id             text,
  ADD COLUMN IF NOT EXISTS campaign_id           text,
  ADD COLUMN IF NOT EXISTS ownership_confirmed   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_hostile             boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS condition_summary      text,
  ADD COLUMN IF NOT EXISTS next_followup_at       timestamptz,
  ADD COLUMN IF NOT EXISTS automation_status      text        NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS metadata               jsonb       NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.acquisition_contacts
  ALTER COLUMN stage_updated_at SET DEFAULT now();

UPDATE public.acquisition_contacts
SET
  canonical_e164 = COALESCE(NULLIF(canonical_e164, ''), phone),
  current_stage = CASE lower(replace(current_stage, '-', '_'))
    WHEN 'selling_interest' THEN 'consider_selling'
    WHEN 'offer_interest_confirmation' THEN 'consider_selling'
    WHEN 'price_or_offer' THEN 'asking_price'
    WHEN 'seller_price_discovery' THEN 'asking_price'
    WHEN 'seller_asking_price' THEN 'asking_price'
    WHEN 'condition_probe' THEN 'condition'
    WHEN 'price_high_condition_probe' THEN 'condition'
    WHEN 'price_works_confirm_basics' THEN 'condition'
    WHEN 'offer_reveal' THEN 'offer_negotiation'
    WHEN 'negotiation' THEN 'offer_negotiation'
    ELSE lower(replace(current_stage, '-', '_'))
  END,
  stage_updated_at = COALESCE(stage_updated_at, created_at, now()),
  automation_status = COALESCE(NULLIF(automation_status, ''), 'active'),
  metadata = COALESCE(metadata, '{}'::jsonb)
WHERE
  canonical_e164 IS NULL
  OR canonical_e164 = ''
  OR current_stage IN (
    'selling_interest',
    'offer_interest_confirmation',
    'price_or_offer',
    'seller_price_discovery',
    'seller_asking_price',
    'condition_probe',
    'price_high_condition_probe',
    'price_works_confirm_basics',
    'offer_reveal',
    'negotiation'
  )
  OR stage_updated_at IS NULL
  OR automation_status IS NULL
  OR automation_status = ''
  OR metadata IS NULL;

ALTER TABLE public.acquisition_contacts
  ALTER COLUMN canonical_e164 SET NOT NULL,
  ALTER COLUMN stage_updated_at SET NOT NULL,
  ALTER COLUMN automation_status SET NOT NULL,
  ALTER COLUMN metadata SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'acq_contacts_canonical_phone_check'
      AND conrelid = 'public.acquisition_contacts'::regclass
  ) THEN
    ALTER TABLE public.acquisition_contacts
      ADD CONSTRAINT acq_contacts_canonical_phone_check
      CHECK (canonical_e164 ~ '^\+[1-9][0-9]{7,14}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'acq_contacts_stage_check'
      AND conrelid = 'public.acquisition_contacts'::regclass
  ) THEN
    ALTER TABLE public.acquisition_contacts
      ADD CONSTRAINT acq_contacts_stage_check
      CHECK (current_stage IN (
        'ownership_check',
        'consider_selling',
        'asking_price',
        'condition',
        'offer_negotiation'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'acq_contacts_unit_count_check'
      AND conrelid = 'public.acquisition_contacts'::regclass
  ) THEN
    ALTER TABLE public.acquisition_contacts
      ADD CONSTRAINT acq_contacts_unit_count_check
      CHECK (unit_count IS NULL OR unit_count > 0) NOT VALID;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_acq_contacts_phone_property
  ON public.acquisition_contacts (canonical_e164, COALESCE(property_id, ''));
CREATE INDEX IF NOT EXISTS idx_acq_contacts_master_owner
  ON public.acquisition_contacts (master_owner_id)
  WHERE master_owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acquisition_contacts_property_id
  ON public.acquisition_contacts (property_id)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acq_contacts_thread
  ON public.acquisition_contacts (thread_id)
  WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acq_contacts_campaign
  ON public.acquisition_contacts (campaign_id)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acq_contacts_stage_status
  ON public.acquisition_contacts (automation_status, current_stage);
CREATE INDEX IF NOT EXISTS idx_acq_contacts_due_followup
  ON public.acquisition_contacts (next_followup_at)
  WHERE next_followup_at IS NOT NULL
    AND automation_status = 'active'
    AND is_opt_out = false
    AND is_wrong_number = false
    AND is_hostile = false;
CREATE INDEX IF NOT EXISTS idx_acq_contacts_high_priority
  ON public.acquisition_contacts (current_stage, updated_at DESC)
  WHERE priority = 'high';

CREATE TABLE IF NOT EXISTS public.acquisition_events (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type          text        NOT NULL,
  subject_type        text        NOT NULL DEFAULT 'acquisition_contact',
  subject_id          text        NOT NULL,
  provider_message_id text,
  provider_status     text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  outcome             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status              text        NOT NULL DEFAULT 'recorded',
  processed_at        timestamptz,
  last_error          text,
  dedupe_key          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acquisition_events_status_check
    CHECK (status IN ('recorded', 'processing', 'processed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acquisition_events_dedupe_key
  ON public.acquisition_events (dedupe_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acquisition_events_provider_receipt
  ON public.acquisition_events (provider_message_id, provider_status)
  WHERE event_type = 'sms.delivery_receipt_received'
    AND provider_message_id IS NOT NULL
    AND provider_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acquisition_events_subject
  ON public.acquisition_events (subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_events_type_created
  ON public.acquisition_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_events_status
  ON public.acquisition_events (status)
  WHERE status IN ('processing', 'failed');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_acq_contacts_updated_at'
      AND tgrelid = 'public.acquisition_contacts'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_acq_contacts_updated_at
      BEFORE UPDATE ON public.acquisition_contacts
      FOR EACH ROW EXECUTE FUNCTION public.acquisition_touch_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_acquisition_events_updated_at'
      AND tgrelid = 'public.acquisition_events'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_acquisition_events_updated_at
      BEFORE UPDATE ON public.acquisition_events
      FOR EACH ROW EXECUTE FUNCTION public.acquisition_touch_updated_at();
  END IF;
END
$$;

ALTER TABLE public.acquisition_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'acquisition_contacts'
      AND policyname = 'acq_contacts_svc_all'
  ) THEN
    CREATE POLICY acq_contacts_svc_all
      ON public.acquisition_contacts
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'acquisition_events'
      AND policyname = 'acq_events_svc_all'
  ) THEN
    CREATE POLICY acq_events_svc_all
      ON public.acquisition_events
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END
$$;

REVOKE ALL ON TABLE public.acquisition_contacts FROM anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_contacts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_events TO service_role;

INSERT INTO public.system_control (key, value) VALUES
  ('acquisition_engine_enabled', 'false'),
  ('acquisition_retry_enabled', 'false'),
  ('acquisition_followup_enabled', 'false'),
  ('acquisition_inbound_dispatch_enabled', 'false'),
  ('acquisition_offer_engine_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.acquisition_contacts IS
  'Canonical Supabase runtime state for default acquisition automation.';
COMMENT ON COLUMN public.acquisition_contacts.tried_template_ids IS
  'Template IDs used by the current delivery attempt chain; reset after confirmed delivery.';
COMMENT ON TABLE public.acquisition_events IS
  'Acquisition-owned event stream and delivery receipt idempotency ledger. Workflow runtimes may subscribe but are not required.';
