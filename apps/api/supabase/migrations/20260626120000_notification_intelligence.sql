-- -----------------------------------------------------------------------------
-- LeadCommand Notification Intelligence
-- Canonical notification_events model + operator preferences, mutes, audit.
-- Idempotent: safe to re-run.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type          text        NOT NULL,
  domain              text        NOT NULL,
  severity            text        NOT NULL DEFAULT 'neutral'
    CHECK (severity IN ('positive', 'neutral', 'warning', 'critical')),
  title               text        NOT NULL,
  description         text,
  source_entity_type  text,
  source_entity_id    text,
  property_id         text,
  participant_id      text,
  campaign_id         uuid,
  market_id           text,
  template_id         text,
  sender_number_id    text,
  workflow_id         text,
  deal_id             text,
  closing_id          text,
  metrics_snapshot    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  recommendation      jsonb,
  available_actions   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  action_state        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sound_category      text,
  deduplication_key   text        NOT NULL,
  grouping_key        text,
  group_count         integer     NOT NULL DEFAULT 1,
  status              text        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resolved', 'dismissed')),
  read_at             timestamptz,
  dismissed_at        timestamptz,
  resolved_at         timestamptz,
  snoozed_until       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedup_key
  ON public.notification_events (deduplication_key);

CREATE INDEX IF NOT EXISTS idx_notification_events_domain
  ON public.notification_events (domain);

CREATE INDEX IF NOT EXISTS idx_notification_events_severity
  ON public.notification_events (severity);

CREATE INDEX IF NOT EXISTS idx_notification_events_status
  ON public.notification_events (status);

CREATE INDEX IF NOT EXISTS idx_notification_events_created_at
  ON public.notification_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_events_grouping_key
  ON public.notification_events (grouping_key)
  WHERE grouping_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_events_campaign_id
  ON public.notification_events (campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_events_unread_active
  ON public.notification_events (created_at DESC)
  WHERE status = 'active' AND read_at IS NULL;

COMMENT ON TABLE public.notification_events IS
  'Canonical LeadCommand notification intelligence events for cockpit HUD.';

-- -----------------------------------------------------------------------------
-- Operator notification preferences
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  operator_id   text        PRIMARY KEY,
  preferences   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notification_preferences IS
  'Per-operator notification HUD preferences (severity filters, sound, mutes).';

-- -----------------------------------------------------------------------------
-- Scoped notification mutes
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_mutes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     text        NOT NULL,
  mute_scope      text        NOT NULL,
  mute_target_id  text        NOT NULL,
  muted_until     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_mutes_scope_target_unique
    UNIQUE (operator_id, mute_scope, mute_target_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_mutes_operator
  ON public.notification_mutes (operator_id);

CREATE INDEX IF NOT EXISTS idx_notification_mutes_scope
  ON public.notification_mutes (mute_scope, mute_target_id);

COMMENT ON TABLE public.notification_mutes IS
  'Operator-scoped notification mutes by domain, entity, or event type.';

-- -----------------------------------------------------------------------------
-- Action audit trail
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_action_audit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id   uuid        NOT NULL REFERENCES public.notification_events (id) ON DELETE CASCADE,
  action_type       text        NOT NULL,
  operator_id       text,
  outcome           text        NOT NULL,
  details           jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_action_audit_notification
  ON public.notification_action_audit (notification_id);

CREATE INDEX IF NOT EXISTS idx_notification_action_audit_created_at
  ON public.notification_action_audit (created_at DESC);

COMMENT ON TABLE public.notification_action_audit IS
  'Immutable audit log for notification HUD operator actions.';